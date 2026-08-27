package com.sats21m.vogelvault.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ThemeContrastTest {
    @Test
    fun `maintained dark ground text and Bitcoin accent stay exact`() {
        assertEquals(Color(0xFF050505), LedgerPalettes.TerminalDark.background)
        assertEquals(Color(0xFFF5F2EA), LedgerPalettes.TerminalDark.foreground)
        assertEquals(Color(0xFFF7931A), LedgerPalettes.TerminalDark.bitcoin)
        assertEquals(Color(0xFF141715), LedgerPalettes.DaylightLight.foreground)
    }

    @Test
    fun `all ledger text tokens clear AA over every rendered surface`() {
        palettes.forEach { (name, palette) ->
            val textTokens = mapOf(
                "primary" to palette.foreground,
                "secondary" to palette.foregroundSecondary,
                "tertiary-disabled-navigation-meta" to palette.foregroundTertiary,
                "gain" to palette.gain,
                "loss" to palette.loss,
            )
            surfaces(palette).forEach { (surfaceName, surface) ->
                textTokens.forEach { (tokenName, token) ->
                    assertContrastAtLeast(name, tokenName, surfaceName, token, surface, 4.5)
                }
            }
        }
    }

    @Test
    fun `control and separator tokens clear non-text contrast`() {
        palettes.forEach { (name, palette) ->
            val boundaries = mapOf("line" to palette.line, "line-subtle" to palette.lineSubtle)
            surfaces(palette).forEach { (surfaceName, surface) ->
                boundaries.forEach { (tokenName, token) ->
                    assertContrastAtLeast(name, tokenName, surfaceName, token, surface, 3.0)
                }
                assertContrastAtLeast(name, "bitcoin-control", surfaceName, palette.bitcoin, surface, 3.0)
            }
        }
    }
}

private val palettes = mapOf(
    "terminal" to LedgerPalettes.TerminalDark,
    "daylight" to LedgerPalettes.DaylightLight,
)

private fun surfaces(palette: LedgerColors): Map<String, Color> = mapOf(
    "background" to palette.background,
    "panel" to palette.panel,
    "panel-raised" to palette.panelRaised,
)

private fun assertContrastAtLeast(
    treatment: String,
    tokenName: String,
    surfaceName: String,
    foreground: Color,
    background: Color,
    minimum: Double,
) {
    val ratio = contrastRatio(foreground.compositeOver(background), background)
    assertTrue(
        ratio >= minimum,
        "$treatment $tokenName on $surfaceName is ${"%.2f".format(ratio)}:1; expected at least $minimum:1",
    )
}

private fun Color.compositeOver(background: Color): Color {
    val foregroundSrgb = convert(ColorSpaces.Srgb)
    val backgroundSrgb = background.convert(ColorSpaces.Srgb)
    val inverseAlpha = 1f - foregroundSrgb.alpha
    return Color(
        red = foregroundSrgb.red * foregroundSrgb.alpha + backgroundSrgb.red * inverseAlpha,
        green = foregroundSrgb.green * foregroundSrgb.alpha + backgroundSrgb.green * inverseAlpha,
        blue = foregroundSrgb.blue * foregroundSrgb.alpha + backgroundSrgb.blue * inverseAlpha,
        alpha = 1f,
        colorSpace = ColorSpaces.Srgb,
    )
}

private fun contrastRatio(foreground: Color, background: Color): Double {
    val lighter = max(foreground.relativeLuminance(), background.relativeLuminance())
    val darker = min(foreground.relativeLuminance(), background.relativeLuminance())
    return (lighter + 0.05) / (darker + 0.05)
}

private fun Color.relativeLuminance(): Double =
    convert(ColorSpaces.Srgb).let { srgb ->
        0.2126 * srgb.red.linearized() +
            0.7152 * srgb.green.linearized() +
            0.0722 * srgb.blue.linearized()
    }

private fun Float.linearized(): Double {
    val channel = toDouble()
    return if (channel <= 0.04045) channel / 12.92 else ((channel + 0.055) / 1.055).pow(2.4)
}
