package com.sats21m.vogelvault.ui

import androidx.compose.ui.unit.dp
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LedgerPanePlanTest {
    @Test fun `audited hinge retains glyph rail and cover width list`() {
        val plan = ledgerPanePlan(841.dp, 945.dp, true, true, LedgerHinge(420.dp, 421.dp, false))
        assertEquals(72.dp, plan.railWidth)
        assertEquals(348.dp, plan.listWidth)
        assertEquals(420.dp, plan.detailWidth)
        assertEquals(1.dp, plan.gap)
    }
    @Test fun `narrow expanded window uses bottom navigation to preserve readable panes`() {
        val plan = ledgerPanePlan(700.dp, 945.dp, true, true, null)
        assertEquals(0.dp, plan.railWidth)
        assertTrue(plan.split)
        assertEquals(350.dp, plan.listWidth)
    }
    @Test fun `cover widths use a single full width pane`() {
        listOf(411.dp, 345.dp).forEach { width ->
            val plan = ledgerPanePlan(width, 870.dp, false, true, null)
            assertFalse(plan.split)
            assertEquals(width, plan.listWidth)
            assertEquals(0.dp, plan.railWidth)
        }
    }
    @Test fun `insufficient region falls back without crossing separating hinge`() {
        val plan = ledgerPanePlan(700.dp, 945.dp, true, true, LedgerHinge(300.dp, 310.dp, false))
        assertFalse(plan.split)
        assertEquals(390.dp, plan.listWidth)
        assertEquals(310.dp, plan.leadingInset)
    }
    @Test fun `horizontal hinge separates vertical panes`() {
        val plan = ledgerPanePlan(841.dp, 945.dp, true, true, LedgerHinge(470.dp, 475.dp, true))
        assertTrue(plan.horizontalHinge)
        assertTrue(plan.split)
        assertEquals(470.dp, plan.listHeight)
        assertEquals(470.dp, plan.detailHeight)
        assertEquals(5.dp, plan.gap)
    }
}
