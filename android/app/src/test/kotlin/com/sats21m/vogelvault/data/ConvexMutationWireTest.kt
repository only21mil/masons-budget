package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.fail
import org.junit.Test

class ConvexMutationWireTest {
    @Test
    fun `Bitcoin buy fee is exact explicit and nonnegative on the wire`() {
        val input = BtcBuyInput(
            id = "buy-fee",
            date = "2026-08-25",
            source = "River",
            sats = 1L,
            priceUsdCents = 1L,
            usdCents = 1L,
            feeUsdCents = 25L,
        )

        assertTagged(input.toJson(), "feeUsdCents", "GQAAAAAAAAA=")
        assertFailsWith<IllegalArgumentException> { input.copy(feeUsdCents = -1L) }
    }

    @Test
    fun `device bitcoin buy can atomically carry a linked income with matching identity`() {
        val buy = BtcBuyInput(
            id = "income-buy-1",
            date = "2026-08-01",
            source = "River",
            sats = 100_000L,
            priceUsdCents = 6_500_000L,
            usdCents = 6_500L,
            feeUsdCents = 25L,
            owner = FamilyMember.VICTOR,
            note = "paycheck DCA",
            loggedBy = "android",
        )
        val income = LinkedIncomeInput(
            id = "income-buy-1",
            owner = FamilyMember.VICTOR,
            date = "2026-08-01",
            amountCents = 6_500L,
            source = "Payroll",
            note = "August paycheck",
            loggedBy = "android",
        )

        val mutation = ConvexMutation.UpsertBtcBuyFromDevice(
            owner = FamilyMember.VICTOR,
            sourceFile = "bitcoin-buys",
            buy = buy,
            linkedIncome = income,
        )

        assertEquals("tables:upsertBtcBuyFromDevice", mutation.path)
        val args = mutation.arguments()
        assertEquals("victor", args["owner"]?.jsonPrimitive?.content)
        assertEquals("bitcoin-buys", args["sourceFile"]?.jsonPrimitive?.content)
        assertEquals("income-buy-1", args["buy"]!!.jsonObject["id"]?.jsonPrimitive?.content)
        val linkedIncome = args["linkedIncome"]!!.jsonObject
        assertEquals(
            setOf("id", "owner", "date", "amountCents", "source", "sourceFile", "note", "loggedBy"),
            linkedIncome.keys,
        )
        assertEquals("income", linkedIncome["sourceFile"]?.jsonPrimitive?.content)
        assertEquals("income-buy-1", linkedIncome["id"]?.jsonPrimitive?.content)
        assertEquals("victor", linkedIncome["owner"]?.jsonPrimitive?.content)
        assertTagged(args["buy"]!!.jsonObject, "usdCents", "ZBkAAAAAAAA=")
        assertTagged(args["buy"]!!.jsonObject, "feeUsdCents", "GQAAAAAAAAA=")
        assertTagged(linkedIncome, "amountCents", "ZBkAAAAAAAA=")
    }

    @Test
    fun `device bitcoin buy rejects an unmatched linked income`() {
        assertFailsWith<IllegalArgumentException> {
            ConvexMutation.UpsertBtcBuyFromDevice(
                owner = FamilyMember.VICTOR,
                sourceFile = "bitcoin-buys",
                buy = BtcBuyInput(
                    id = "buy-1",
                    date = "2026-08-01",
                    source = "River",
                    sats = 100_000L,
                    priceUsdCents = 6_500_000L,
                    usdCents = 6_500L,
                    owner = FamilyMember.VICTOR,
                ),
                linkedIncome = LinkedIncomeInput(
                    id = "other-id",
                    owner = FamilyMember.VICTOR,
                    date = "2026-08-01",
                    amountCents = 6_500L,
                    source = "Payroll",
                ),
            )
        }
    }

    @Test
    fun `refunds must be negative and are never corrected`() {
        assertFailsWith<IllegalArgumentException> {
            transaction(amountCents = 1L, kind = TransactionKind.CREDIT)
        }

        val refund = transaction(amountCents = -1L, kind = TransactionKind.CREDIT)
        val encoded = refund.toJson()["amountCents"]!!.jsonObject["\$integer"]
        assertEquals("//////////8=", encoded?.jsonPrimitive?.content)
    }

    @Test
    fun `purchases must be positive for every owner`() {
        FamilyMember.entries.forEach { owner ->
            assertFailsWith<IllegalArgumentException>(owner.key) {
                transaction(amountCents = -1L, owner = owner)
            }
        }
    }

    @Test
    fun `income must be a positive credit`() {
        assertFailsWith<IllegalArgumentException> {
            transaction(category = "Income", kind = TransactionKind.SPEND)
        }
        assertFailsWith<IllegalArgumentException> {
            transaction(
                category = "Income",
                kind = TransactionKind.CREDIT,
                amountCents = -1L,
            )
        }

        transaction(category = "Income", kind = TransactionKind.CREDIT, amountCents = 1L)
    }

    private fun transaction(
        amountCents: Long = 1L,
        category: String = "Groceries",
        kind: TransactionKind = TransactionKind.SPEND,
        amountSats: Long? = null,
        owner: FamilyMember? = FamilyMember.VICTOR,
    ) = TransactionInput(
        id = "tx-1",
        date = "2026-07-29",
        merchant = "Neighborhood Market",
        amountCents = amountCents,
        category = category,
        kind = kind,
        amountSats = amountSats,
        owner = owner,
    )

    private fun assertTagged(
        parent: JsonObject,
        key: String,
        encoded: String,
    ) {
        val tagged = parent[key]?.jsonObject ?: fail("$key was not a tagged int64")
        assertEquals(setOf("\$integer"), tagged.keys)
        assertEquals(encoded, tagged["\$integer"]?.jsonPrimitive?.content)
    }
}
