package com.sats21m.vogelvault.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ThemeContrastTest {
    @Test
    fun `v2 palettes preserve exact literals and OKLCH inputs`() {
        val dark = LedgerPalettes.TerminalDark
        val light = LedgerPalettes.DaylightLight

        assertEquals(Color(0xFF0A0D0C), dark.background)
        assertEquals(Color(0xFF0C100E), dark.panel)
        assertEquals(Color(0xFF111614), dark.panelRaised)
        assertEquals(Color(0xFFE8EFE9), LedgerPalettes.TerminalDark.foreground)
        assertEquals(Color(0xFFE8EFE9).copy(alpha = 0.56f), dark.foregroundSecondary)
        assertEquals(Color(0xFFE8EFE9).copy(alpha = 0.36f), dark.foregroundTertiary)
        assertEquals(Color(0xFFF7931A), dark.bitcoin)
        assertEquals(LedgerOklch(0.74f, 0.155f, 158f), dark.gainSpec)
        assertEquals(LedgerOklch(0.70f, 0.155f, 28f), dark.lossSpec)

        assertEquals(Color(0xFFF4F3EE), light.background)
        assertEquals(Color(0xFFEDEBE4), light.panel)
        assertEquals(Color.White, light.panelRaised)
        assertEquals(Color(0xFF141715), light.foreground)
        assertEquals(Color(0xFF141715).copy(alpha = 0.60f), light.foregroundSecondary)
        assertEquals(Color(0xFF141715).copy(alpha = 0.42f), light.foregroundTertiary)
        assertEquals(Color(0xFFC96A05), light.bitcoin)
        assertEquals(LedgerOklch(0.52f, 0.13f, 158f), light.gainSpec)
        assertEquals(LedgerOklch(0.52f, 0.15f, 28f), light.lossSpec)
        assertEquals(ColorSpaces.Oklab, dark.gain.colorSpace)
        assertEquals(ColorSpaces.Oklab, light.loss.colorSpace)
    }

    @Test
    fun `v2 treatment density and type remain separate`() {
        val dark = themeTokens(LedgerTreatment.TERMINAL_DARK)
        val light = themeTokens(LedgerTreatment.DAYLIGHT_LIGHT)

        assertEquals(20.dp, dark.density.screenGutter)
        assertEquals(12.dp, dark.density.rowVerticalPadding)
        assertEquals(26.sp, dark.type.screenTitle.fontSize)
        assertEquals(12.5.sp, dark.type.rowPrimary.fontSize)
        assertEquals(LedgerRuleStyle.SOLID, dark.density.ruleStyle)

        assertEquals(22.dp, light.density.screenGutter)
        assertEquals(15.dp, light.density.rowVerticalPadding)
        assertEquals(29.sp, light.type.screenTitle.fontSize)
        assertEquals(13.5.sp, light.type.rowPrimary.fontSize)
        assertEquals(LedgerRuleStyle.DASHED, light.density.ruleStyle)
        assertEquals(9.5.sp, dark.type.rowMeta.fontSize)
        assertEquals(9.5.sp, light.type.rowMeta.fontSize)
    }

    @Test
    fun `primary glyph colors remain opaque and clear AA`() {
        assertEquals(1f, LedgerPalettes.TerminalDark.foreground.alpha)
        assertEquals(1f, LedgerPalettes.TerminalDark.bitcoin.alpha)
        assertEquals(1f, LedgerPalettes.DaylightLight.foreground.alpha)
        assertEquals(1f, LedgerPalettes.DaylightLight.bitcoin.alpha)
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

    @Test
    fun `dark ink clears AA on both Bitcoin primary fills`() {
        val onBitcoin = LedgerPalettes.TerminalDark.background

        assertTrue(contrastRatio(onBitcoin, LedgerPalettes.TerminalDark.bitcoin) >= 4.5)
        assertTrue(contrastRatio(onBitcoin, LedgerPalettes.DaylightLight.bitcoin) >= 4.5)
    }

    @Test
    fun `body and interactive Material content roles clear AA against their ledger fills`() {
        LedgerTreatment.entries.forEach { treatment ->
            val palette = themeTokens(treatment).colors
            val scheme = palette.toMaterialScheme(treatment)
            val pairs = listOf(
                scheme.onPrimary to scheme.primary,
                scheme.onPrimaryContainer to scheme.primaryContainer,
                scheme.onSecondary to scheme.secondary,
                scheme.onSecondaryContainer to scheme.secondaryContainer,
                scheme.onTertiaryContainer to scheme.tertiaryContainer,
                scheme.onBackground to scheme.background,
                scheme.onSurface to scheme.surface,
                scheme.onSurfaceVariant to scheme.surfaceVariant,
                scheme.inverseOnSurface to scheme.inverseSurface,
                scheme.inversePrimary to scheme.inverseSurface,
                scheme.onError to scheme.error,
                scheme.onErrorContainer to scheme.errorContainer,
                scheme.onSurface to scheme.surfaceDim,
                scheme.onSurface to scheme.surfaceBright,
            )

            pairs.forEach { (ink, fill) ->
                val opaqueFill = fill.compositeOver(palette.background)
                assertTrue(
                    contrastRatio(ink, opaqueFill) >= 4.5,
                    "$treatment role pair failed AA: $ink on $fill",
                )
            }
        }
    }
}

private fun contrastRatio(foreground: Color, background: Color): Double {
    val opaqueForeground = foreground.compositeOver(background)
    val lighter = max(opaqueForeground.relativeLuminance(), background.relativeLuminance())
    val darker = min(opaqueForeground.relativeLuminance(), background.relativeLuminance())
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
