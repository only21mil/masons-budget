package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.DraftIdWriteOutcome
import com.sats21m.vogelvault.TransactionDraftIdStore
import com.sats21m.vogelvault.data.BtcTransferInput
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcTransfer
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class BtcTransferWriteTest {
    private val householdAccounts = listOf(
        BtcAccount(
            key = "cold",
            label = "Cold storage",
            custody = Custody.SELF_CUSTODY,
            sats = 2_000L,
            fiatCents = 100L,
            owner = FamilyMember.VICTOR,
        ),
        BtcAccount(
            key = "hot",
            label = "Hot wallet",
            custody = Custody.SELF_CUSTODY,
            sats = 500L,
            fiatCents = 25L,
            owner = FamilyMember.VICTOR,
        ),
        BtcAccount(
            key = "mason-stack",
            label = "Mason's stack",
            custody = Custody.EXCHANGE,
            sats = 100L,
            fiatCents = 5L,
            owner = FamilyMember.MASON,
        ),
    )

    @Test
    fun `accepted transfer with a stale draft id reports local recovery`() {
        assertEquals(
            "Household sync accepted this Bitcoin transfer, but this device could not retire its draft id. " +
                "Do not submit another transfer until local storage is repaired.",
            btcTransferWriteFailureMessage(DraftIdWriteOutcome.AcceptedLeaseResetFailed),
        )
    }

    @Test
    fun `adult transfer uses canonical household owner and preserves optional note`() {
        val transfer = btcTransferWriteRequest(
            viewer = FamilyMember.RACHEL,
            stableTransferId = "android-transfer-1",
            date = "2026-08-20",
            fromAccountKey = "cold",
            toAccountKey = "hot",
            satsText = "1,250",
            feeSatsText = "21",
            note = "move to spending wallet",
            accounts = householdAccounts,
        ).getOrThrow()

        assertEquals(
            BtcTransfer(
                id = "android-transfer-1",
                owner = FamilyMember.VICTOR,
                date = "2026-08-20",
                fromAccountKey = "cold",
                toAccountKey = "hot",
                sats = 1_250L,
                feeSats = 21L,
                note = "move to spending wallet",
            ),
            transfer,
        )
        assertEquals("btc-transfers", BTC_TRANSFER_SOURCE_FILE)
    }

    @Test
    fun `transfer rejects child actor, same account, non-positive principal, negative fee, and foreign account`() {
        val cases = listOf(
            Triple(FamilyMember.MASON, "cold", "hot"),
            Triple(FamilyMember.VICTOR, "cold", "cold"),
            Triple(FamilyMember.VICTOR, "cold", "hot"),
            Triple(FamilyMember.VICTOR, "cold", "hot"),
            Triple(FamilyMember.VICTOR, "mason-stack", "hot"),
        )
        val inputs = listOf(
            "21" to "0",
            "21" to "0",
            "0" to "0",
            "21" to "-1",
            "21" to "0",
        )

        cases.zip(inputs).forEach { (case, amounts) ->
            assertTrue(
                btcTransferWriteRequest(
                    viewer = case.first,
                    stableTransferId = "android-invalid-${case.second}-${case.third}",
                    date = "2026-08-20",
                    fromAccountKey = case.second,
                    toAccountKey = case.third,
                    satsText = amounts.first,
                    feeSatsText = amounts.second,
                    note = null,
                    accounts = householdAccounts,
                ).isFailure,
                "expected invalid transfer for $case / $amounts",
            )
        }
    }

    @Test
    fun `transfer impact keeps principal but subtracts fee without income or spend`() {
        val transfer = BtcTransfer(
            id = "transfer",
            owner = FamilyMember.VICTOR,
            date = "2026-08-20",
            fromAccountKey = "cold",
            toAccountKey = "hot",
            sats = 1_250L,
            feeSats = 21L,
        )

        assertEquals(1_250L, transfer.principalSats)
        assertEquals(-21L, transfer.totalBtcDeltaSats)
        assertEquals(-21L, transfer.netWorthDeltaSats)
        assertEquals(0L, transfer.incomeCentsDelta)
        assertEquals(0L, transfer.spendCentsDelta)
        assertFalse(transfer.affectsIncomeOrSpend)
    }

    @Test
    fun `transfer id stays stable through retry and rotates only after acceptance`() {
        val ids = TransactionDraftIdStore()
        val first = ids.currentId(BTC_TRANSFER_SOURCE_FILE)
        assertEquals(first, ids.currentId(BTC_TRANSFER_SOURCE_FILE))

        assertTrue(ids.rotateAfterAcceptance(BTC_TRANSFER_SOURCE_FILE, "not-the-current-id"))
        assertEquals(first, ids.currentId(BTC_TRANSFER_SOURCE_FILE))

        assertTrue(ids.rotateAfterAcceptance(BTC_TRANSFER_SOURCE_FILE, first))
        val next = ids.currentId(BTC_TRANSFER_SOURCE_FILE)
        assertFalse(first == next)
    }

    @Test
    fun `device transfer mutation sends exact source file and tagged sats`() {
        val mutation = ConvexMutation.UpsertBtcTransferFromDevice(
            owner = FamilyMember.VICTOR,
            transfer = BtcTransferInput(
                id = "android-transfer-1",
                owner = FamilyMember.VICTOR,
                date = "2026-08-20",
                fromAccountKey = "cold",
                toAccountKey = "hot",
                sats = 1_250L,
                feeSats = 21L,
                note = null,
            ),
            baseUpdatedAtMs = null,
        )

        val args = mutation.arguments().jsonObject
        assertEquals("tables:upsertBtcTransferFromDevice", mutation.path)
        assertEquals("btc-transfers", args.getValue("sourceFile").jsonPrimitive.content)
        assertEquals("victor", args.getValue("owner").jsonPrimitive.content)
        val row = args.getValue("transfer").jsonObject
        assertEquals("android-transfer-1", row.getValue("id").jsonPrimitive.content)
        assertEquals("cold", row.getValue("fromAccountKey").jsonPrimitive.content)
        assertTrue("$integer" in row.getValue("sats").toString())
    }

    @Test
    fun `invalid transfer input result exposes a useful validation error`() {
        val error = btcTransferWriteRequest(
            viewer = FamilyMember.VICTOR,
            stableTransferId = "android-transfer-1",
            date = "2026-08-20",
            fromAccountKey = "cold",
            toAccountKey = "hot",
            satsText = "not sats",
            feeSatsText = "0",
            note = null,
            accounts = householdAccounts,
        ).exceptionOrNull()

        assertFailsWith<IllegalArgumentException> { throw requireNotNull(error) }
        assertTrue(requireNotNull(error).message.orEmpty().contains("sats"))
    }

    private companion object {
        const val integer = "\$integer"
    }
}
