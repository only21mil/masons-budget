package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.ui.components.LedgerRevealMarks
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class TodayRowRevealTest {
    @Test fun `changed refresh revision does not start another Today arrival for the same profile`() {
        val profile = UUID.randomUUID().toString()
        val otherProfile = UUID.randomUUID().toString()
        val initial = requireNotNull(todayRowRevealKey(1_000L))
        val refreshed = requireNotNull(todayRowRevealKey(2_000L))
        assertTrue(LedgerRevealMarks.staggers(profile to initial, 0L))
        assertFalse(LedgerRevealMarks.staggers(profile to refreshed, 10_000L))
        assertTrue(LedgerRevealMarks.staggers(otherProfile to refreshed, 10_000L))
        assertFalse(LedgerRevealMarks.staggers(profile to todayRowRevealKey(3_000L), 20_000L))
    }

    @Test fun `missing revision disables arrival before and after a live refresh`() {
        assertNull(todayRowRevealKey(null))
        assertNotNull(todayRowRevealKey(1_000L))
        assertNull(todayRowRevealKey(null))
        assertEquals(todayRowRevealKey(1_000L), todayRowRevealKey(2_000L))
    }
}
