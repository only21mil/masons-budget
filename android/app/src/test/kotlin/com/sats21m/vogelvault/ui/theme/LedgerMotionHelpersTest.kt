package com.sats21m.vogelvault.ui.theme

import androidx.compose.animation.core.SnapSpec
import androidx.compose.animation.core.TweenSpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class LedgerMotionHelpersTest {
    @Test
    fun `motion on selects a tween with the requested duration and delay`() {
        val spec = ledgerMotionSpec<Float>(animate = true, durationMillis = 300, delayMillis = 40)
        val tween = assertIs<TweenSpec<Float>>(spec)
        assertEquals(300, tween.durationMillis)
        assertEquals(40, tween.delay)
    }

    @Test
    fun `reduce motion selects snap and drops the stagger delay`() {
        val spec = ledgerMotionSpec<Float>(animate = false, durationMillis = 160, delayMillis = 140)
        val snap = assertIs<SnapSpec<Float>>(spec)
        assertEquals(0, snap.delay)
    }

    @Test
    fun `the reduce motion preference turns animate off in every treatment`() {
        val reduced = LedgerAccessibilityPreferences(reduceMotion = true)
        assertFalse(LedgerEffectSettings().resolve(LedgerTreatment.TERMINAL_DARK, reduced).animate)
        assertFalse(LedgerEffectSettings().resolve(LedgerTreatment.DAYLIGHT_LIGHT, reduced).animate)
        assertTrue(
            LedgerEffectSettings().resolve(LedgerTreatment.TERMINAL_DARK, LedgerAccessibilityPreferences()).animate,
        )
    }

    @Test
    fun `settle interpolates whole cents between readings`() {
        assertEquals(9_425_012L, settleCents(9_425_012L, 9_525_012L, 0f))
        assertEquals(9_475_012L, settleCents(9_425_012L, 9_525_012L, 0.5f))
        assertEquals(9_525_012L, settleCents(9_425_012L, 9_525_012L, 1f))
    }

    @Test
    fun `settle clamps the fraction and runs downward`() {
        assertEquals(100L, settleCents(200L, 100L, 1.5f))
        assertEquals(200L, settleCents(200L, 100L, -0.2f))
        assertEquals(150L, settleCents(200L, 100L, 0.5f))
    }

    @Test
    fun `settle rounds rather than truncating`() {
        // 0.25 of 3 cents is 0.75, which rounds up to one whole cent.
        assertEquals(1L, settleCents(0L, 3L, 0.25f))
    }

    @Test
    fun `reveal delay steps 20ms per row and caps at index seven`() {
        assertEquals(0, revealDelayMillis(0))
        assertEquals(60, revealDelayMillis(3))
        assertEquals(140, revealDelayMillis(7))
        assertEquals(140, revealDelayMillis(8))
        assertEquals(140, revealDelayMillis(40))
        assertEquals(0, revealDelayMillis(-1))
    }

    @Test
    fun `pulse token and keyframes cover one 600ms breath`() {
        assertEquals(600, LedgerMotion.pulseMillis)
        assertEquals(600, phosphorPulseSpec().config.durationMillis)
        assertEquals(18f, LedgerPhosphorGlow.restingBlurPx)
        assertEquals(32f, LedgerPhosphorGlow.pulseBlurPx)
    }
}
