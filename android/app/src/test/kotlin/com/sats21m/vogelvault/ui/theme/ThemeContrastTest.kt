package com.sats21m.vogelvault.ui.theme

import androidx.compose.ui.graphics.Color
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ThemeContrastTest {
    @Test
    fun `sovereign ledger foreground clears AA in both treatments`() {
        assertEquals(Color(0xFFE8EFE9), LedgerPalettes.TerminalDark.foreground)
        assertEquals(Color(0xFF141715), LedgerPalettes.DaylightLight.foreground)
        assertTrue(
            contrastRatio(
                LedgerPalettes.TerminalDark.foreground,
                LedgerPalettes.TerminalDark.background,
            ) >= 4.5,
        )
        assertTrue(
            contrastRatio(
                LedgerPalettes.DaylightLight.foreground,
                LedgerPalettes.DaylightLight.background,
            ) >= 4.5,
        )
    }
}

private fun contrastRatio(foreground: Color, background: Color): Double {
    val lighter = max(foreground.relativeLuminance(), background.relativeLuminance())
    val darker = min(foreground.relativeLuminance(), background.relativeLuminance())
    return (lighter + 0.05) / (darker + 0.05)
}

private fun Color.relativeLuminance(): Double =
    0.2126 * red.linearized() +
        0.7152 * green.linearized() +
        0.0722 * blue.linearized()

private fun Float.linearized(): Double {
    val channel = toDouble()
    return if (channel <= 0.04045) channel / 12.92 else ((channel + 0.055) / 1.055).pow(2.4)
}
