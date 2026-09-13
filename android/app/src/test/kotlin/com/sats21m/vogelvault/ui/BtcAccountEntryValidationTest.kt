package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.BtcAccountDraftStore
import com.sats21m.vogelvault.data.PendingBtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Slice
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import java.time.LocalDate
import org.junit.Assert.*
import org.junit.Test

class BtcAccountEntryValidationTest {
    private val existing = BtcAccount("river", " River ", Custody.EXCHANGE, 0L, 0L, FamilyMember.VICTOR)

    @Test fun `names are required and unique after trimming and folding case`() {
        assertEquals("Enter an account name.", accountNameError("  ", emptyList()))
        assertEquals("An account with this name already exists.", accountNameError("river", listOf(existing)))
        assertNull(accountNameError("Coldcard", listOf(existing)))
        assertNull(accountNameError("river", listOf(existing), pendingKey = "river"))
    }

    @Test fun `retry retains the full original request when household read refreshes`() {
        val store = BtcAccountDraftStore()
        val original = PendingBtcAccount(newAccountKey("Cold card", FamilyMember.RACHEL), "victor",
            "Cold card", "self_custody", "2026-08-01T12:00:00Z", 100L)
        val first = store.stage(FamilyMember.RACHEL, original)
        val retry = store.stage(FamilyMember.VICTOR, original.copy(label = "River",
            asOf = "2026-09-13T12:00:00Z", baseUpdatedAtMs = 200L))
        assertEquals(first.mutation().arguments(), retry.mutation().arguments())
        assertTrue(store.release(FamilyMember.RACHEL, first))
        val next = store.stage(FamilyMember.VICTOR, original.copy(key = "next", baseUpdatedAtMs = 200L))
        assertTrue(store.release(FamilyMember.RACHEL, first))
        assertEquals(next, store.current(FamilyMember.VICTOR))
    }

    @Test fun `existing household document provides its exact revision and as of to either adult`() {
        val document = BtcBalance(FamilyMember.VICTOR, "2026-08-01T12:00:00Z", listOf(existing),
            0L, 0L, 0L, 0L, updatedAtMs = 123L)
        val slice = Slice<BtcBalance?>(Freshness.LIVE, document, 999L, "rows")
        for (adult in listOf(FamilyMember.VICTOR, FamilyMember.RACHEL)) {
            val snapshot = accountWriteSnapshot(adult, slice, FamilyMember.VICTOR).getOrThrow()
            assertEquals(123L, snapshot.baseUpdatedAtMs)
            assertEquals(document.asOf, snapshot.asOf)
            assertEquals(document.accounts, snapshot.accounts)
        }
        assertTrue(accountWriteSnapshot(FamilyMember.MASON, slice, FamilyMember.VICTOR).isFailure)
        assertTrue(accountWriteSnapshot(FamilyMember.RACHEL, slice.copy(value = document.copy(owner = FamilyMember.MASON)), FamilyMember.VICTOR).isFailure)
        assertTrue(accountWriteSnapshot(FamilyMember.VICTOR, slice.copy(value = document.copy(updatedAtMs = null)), FamilyMember.VICTOR).isFailure)
        for (status in listOf(Freshness.LOADING, Freshness.STALE, Freshness.ERROR, Freshness.DEMO)) {
            assertTrue(accountWriteSnapshot(FamilyMember.VICTOR, slice.copy(status = status), FamilyMember.VICTOR).isFailure)
            assertTrue(accountWriteSnapshot(FamilyMember.VICTOR, slice.copy(status = status, value = null), FamilyMember.VICTOR).isFailure)
        }
        assertTrue(accountWriteSnapshot(FamilyMember.VICTOR, slice.copy(value = null), FamilyMember.VICTOR).isFailure)
        assertTrue(accountWriteSnapshot(FamilyMember.VICTOR, slice.copy(status = Freshness.EMPTY, value = null), null).isFailure)
        assertTrue(accountWriteSnapshot(FamilyMember.VICTOR, slice.copy(status = Freshness.EMPTY, value = null), FamilyMember.MASON).isFailure)
        assertNull(accountWriteSnapshot(FamilyMember.VICTOR, slice.copy(status = Freshness.EMPTY, value = null), FamilyMember.VICTOR).getOrThrow().baseUpdatedAtMs)
    }

    @Test fun `only a definite revision refusal releases a request for a fresh draft`() {
        assertTrue(accountRevisionRejected(com.sats21m.vogelvault.data.ConvexResult.Failed("task changed on another device")))
        assertTrue(accountRevisionRejected(com.sats21m.vogelvault.data.ConvexResult.Failed("REVISION_REQUIRED: refresh tasks before retrying")))
        assertFalse(accountRevisionRejected(com.sats21m.vogelvault.data.ConvexResult.Failed("transport failure (IOException)")))
        assertFalse(accountRevisionRejected(com.sats21m.vogelvault.data.ConvexResult.Failed("convex rejection")))
    }

    @Test fun `generated identifiers fit the server contract while retaining household and random suffix`() {
        for (owner in listOf(FamilyMember.VICTOR, FamilyMember.RACHEL)) {
            for (name in listOf("a".repeat(243), "a".repeat(16384), "日本語", "Cold card")) {
                val first = newAccountKey(name, owner)
                assertTrue(first.length <= 256)
                assertTrue(first.matches(Regex("[a-z0-9-]+-victor-[a-f0-9]{6}")))
            }
        }
    }

    @Test fun `only explicit validation refusal permits correction without a new revision`() {
        assertTrue(accountValidationRejected(com.sats21m.vogelvault.data.ConvexResult.Failed("task was rejected as invalid")))
        for (reason in listOf("transport failure (IOException)", "convex rejection", "http 500", "malformed response envelope", "task changed on another device")) {
            assertFalse(accountValidationRejected(com.sats21m.vogelvault.data.ConvexResult.Failed(reason)))
        }
    }

    @Test fun `adding zero account preserves document as of and uses midnight only without a document`() {
        assertEquals("2026-08-01T12:00:00Z", accountAsOf("2026-08-01T12:00:00Z"))
        assertEquals("2026-09-13T00:00:00.000Z", accountAsOf(null, LocalDate.of(2026, 9, 13)))
    }
}
