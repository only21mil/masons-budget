package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.TransactionDraftIdStore
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

    @Test fun `account key is stable across a retry after the draft name changes`() {
        val store = TransactionDraftIdStore()
        val key = store.currentId("account:victor") { newAccountKey(" Cold card ", FamilyMember.RACHEL) }
        assertTrue(key.matches(Regex("cold-card-victor-[a-f0-9]{6}")))
        assertEquals(key, store.currentId("account:victor") { newAccountKey("River", FamilyMember.RACHEL) })
        assertTrue(store.rotateAfterAcceptance("account:victor", key))
        assertNotEquals(key, store.currentId("account:victor") { newAccountKey("River", FamilyMember.RACHEL) })
    }

    @Test fun `adding zero account preserves document as of and uses midnight only without a document`() {
        assertEquals("2026-08-01T12:00:00Z", accountAsOf("2026-08-01T12:00:00Z"))
        assertEquals("2026-09-13T00:00:00.000Z", accountAsOf(null, LocalDate.of(2026, 9, 13)))
    }
}
