package com.sats21m.vogelvault.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
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

        assertEquals(Color(0xFF050505), dark.background)
        assertEquals(Color(0xFF0E0E0E), dark.panel)
        assertEquals(Color(0xFF161616), dark.panelRaised)
        assertEquals(Color(0xFFF5F2EA).copy(alpha = 0.10f), dark.line)
        assertEquals(Color(0xFFF5F2EA).copy(alpha = 0.06f), dark.lineSubtle)
        assertEquals(Color(0xFFF5F2EA), dark.knob)
        assertEquals(Color(0xFFF5F2EA), LedgerPalettes.TerminalDark.foreground)
        assertEquals(Color(0xFFABA8A1), dark.foregroundSecondary)
        assertEquals(Color(0xFF95928C), dark.foregroundTertiary)
        assertEquals(Color(0xFFF7931A), dark.bitcoin)
        assertEquals(Color(0xFFF7931A), dark.bitcoinFill)
        assertEquals(Color(0xFFF7931A).copy(alpha = 0.12f), dark.bitcoinSoft)
        assertEquals(Color(0xFFF7931A).copy(alpha = 0.75f), dark.priceDecimals)
        assertEquals(LedgerOklch(0.74f, 0.155f, 158f), dark.gainSpec)
        assertEquals(LedgerOklch(0.70f, 0.155f, 28f), dark.lossSpec)

        assertEquals(Color(0xFFF4F3EE), light.background)
        assertEquals(Color(0xFFEDEBE4), light.panel)
        assertEquals(Color.White, light.panelRaised)
        assertEquals(Color(0xFF141715), light.foreground)
        assertEquals(Color(0xFF505452), light.foregroundSecondary)
        assertEquals(Color(0xFF5C605D), light.foregroundTertiary)
        assertEquals(Color(0xFF954C04), light.bitcoin)
        assertEquals(Color(0xFFF7931A), light.bitcoinFill)
        assertEquals(Color(0xFF9E5104).copy(alpha = 0.10f), light.bitcoinSoft)
        assertEquals(Color(0xFF9E5104), light.priceDecimals)
        assertEquals(LedgerOklch(0.47f, 0.10f, 158f), light.gainSpec)
        assertEquals(LedgerOklch(0.50f, 0.15f, 28f), light.lossSpec)
        assertEquals(ColorSpaces.Oklab, dark.gain.colorSpace)
        assertEquals(ColorSpaces.Oklab, light.loss.colorSpace)
    }

    @Test
    fun `ink tiers are opaque so nothing composites at draw time`() {
        listOf(LedgerPalettes.TerminalDark, LedgerPalettes.DaylightLight).forEach { palette ->
            assertEquals(1f, palette.foregroundSecondary.alpha)
            assertEquals(1f, palette.foregroundTertiary.alpha)
            assertEquals(1f, palette.bitcoinFill.alpha)
        }
        assertEquals(1f, LedgerPalettes.DaylightLight.priceDecimals.alpha)
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
        assertEquals(11.sp, dark.type.rowMeta.fontSize)
        assertEquals(11.sp, light.type.rowMeta.fontSize)
    }

    @Test
    fun `type floor keeps every tier-ink role at 11sp and weight 500 or more`() {
        LedgerTreatment.entries.forEach { treatment ->
            val type = themeTokens(treatment).type
            val tierRoles = mapOf(
                "tabLabel" to type.tabLabel,
                "kpiLabel" to type.kpiLabel,
                "kpiSub" to type.kpiSub,
                "rowMeta" to type.rowMeta,
                "screenSubtitle" to type.screenSubtitle,
                "sectionLabel" to type.sectionLabel,
                "chip" to type.chip,
            )
            tierRoles.forEach { (name, style) ->
                assertTrue(style.fontSize.isSp && style.fontSize.value >= 11f, "$treatment $name is under 11sp")
                assertTrue(style.weight() >= FontWeight.Medium.weight, "$treatment $name is under weight 500")
            }
            // Body is running text at 12sp, where 400 reads; the 500 floor is for the 11sp labels.
            assertEquals(12.sp, type.body.fontSize)
            assertEquals(18.sp, type.body.lineHeight)
            assertEquals(FontWeight.Normal, type.body.fontWeight)
            assertEquals(11.sp, type.button.fontSize)
            assertEquals(FontWeight.SemiBold, type.button.fontWeight)
        }
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
    fun `every ink clears AA on every ledger fill including bitcoinSoft composites`() {
        listOf(LedgerPalettes.TerminalDark, LedgerPalettes.DaylightLight).forEach { palette ->
            val inks = mapOf(
                "foreground" to palette.foreground,
                "secondary" to palette.foregroundSecondary,
                "tertiary" to palette.foregroundTertiary,
                "bitcoin" to palette.bitcoin,
                "gain" to palette.gain,
                "loss" to palette.loss,
                "warning" to palette.warning,
            )
            inks.forEach { (name, ink) ->
                palette.fills().forEach { (fillName, fill) ->
                    assertTrue(
                        contrastRatio(ink, fill) >= 4.5,
                        "$name on $fillName is ${contrastRatio(ink, fill)}",
                    )
                }
            }
        }
    }

    @Test
    fun `secondary and tertiary ink clear the accepted contrast floors on opaque ledger surfaces`() {
        listOf(LedgerPalettes.TerminalDark, LedgerPalettes.DaylightLight).forEach { palette ->
            palette.opaqueFills().forEach { (fillName, fill) ->
                assertTrue(
                    contrastRatio(palette.foregroundSecondary, fill) >= 6.0,
                    "secondary on $fillName is ${contrastRatio(palette.foregroundSecondary, fill)}",
                )
            }
        }
        // Approved Sats black tertiary measures 5.83:1 on the raised panel.
        LedgerPalettes.TerminalDark.opaqueFills().forEach { (fillName, fill) ->
            assertTrue(
                contrastRatio(LedgerPalettes.TerminalDark.foregroundTertiary, fill) >= 5.8,
                "dark tertiary on $fillName is ${contrastRatio(LedgerPalettes.TerminalDark.foregroundTertiary, fill)}",
            )
        }
        // The audit's light tertiary #5C605D measures 5.75, 5.36, and 6.39; a 6.0 floor on panel
        // needs #555754, which no longer reads as a second level against #505452.
        LedgerPalettes.DaylightLight.opaqueFills().forEach { (fillName, fill) ->
            assertTrue(
                contrastRatio(LedgerPalettes.DaylightLight.foregroundTertiary, fill) >= 5.0,
                "light tertiary on $fillName is ${contrastRatio(LedgerPalettes.DaylightLight.foregroundTertiary, fill)}",
            )
        }
    }

    @Test
    fun `bitcoin text clears AA on panel and the decimals pair clears AA in both treatments`() {
        listOf(LedgerPalettes.TerminalDark, LedgerPalettes.DaylightLight).forEach { palette ->
            assertTrue(
                contrastRatio(palette.bitcoin, palette.panel) >= 4.5,
                "bitcoin text on panel is ${contrastRatio(palette.bitcoin, palette.panel)}",
            )
            assertTrue(
                contrastRatio(palette.bitcoin, palette.background) >= 4.5,
                "bitcoin text on background is ${contrastRatio(palette.bitcoin, palette.background)}",
            )
            // Accented Badge: bitcoin text over bitcoinSoft on the background.
            val softOverBackground = palette.bitcoinSoft.compositeOver(palette.background)
            assertTrue(
                contrastRatio(palette.bitcoin, softOverBackground) >= 4.5,
                "bitcoin text on bitcoinSoft over background is ${contrastRatio(palette.bitcoin, softOverBackground)}",
            )
            listOf("panel" to palette.panel, "background" to palette.background).forEach { (fillName, fill) ->
                assertTrue(
                    contrastRatio(palette.priceDecimals, fill) >= 4.5,
                    "price decimals on $fillName is ${contrastRatio(palette.priceDecimals, fill)}",
                )
            }
        }
    }

    @Test
    fun `warnings remain amber and distinct from errors in both treatments`() {
        listOf(LedgerPalettes.TerminalDark, LedgerPalettes.DaylightLight).forEach { palette ->
            assertTrue(palette.warning != palette.loss)
            assertEquals(1f, palette.warning.alpha)
            assertTrue(palette.warning.red > palette.warning.green)
            assertTrue(palette.warning.green > palette.warning.blue)
        }
    }

    @Test
    fun `dark ink clears AA on the Bitcoin fill in both treatments`() {
        val onBitcoin = LedgerPalettes.TerminalDark.background

        assertTrue(contrastRatio(onBitcoin, LedgerPalettes.TerminalDark.bitcoinFill) >= 4.5)
        assertTrue(contrastRatio(onBitcoin, LedgerPalettes.DaylightLight.bitcoinFill) >= 4.5)
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
                scheme.onTertiary to scheme.tertiary,
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

private fun TextStyle.weight(): Int = requireNotNull(fontWeight) { "role has no weight" }.weight

private fun LedgerColors.opaqueFills(): List<Pair<String, Color>> = listOf(
    "background" to background,
    "panel" to panel,
    "panelRaised" to panelRaised,
)

private fun LedgerColors.fills(): List<Pair<String, Color>> = opaqueFills() + listOf(
    "bitcoinSoft over panel" to bitcoinSoft.compositeOver(panel),
    "bitcoinSoft over background" to bitcoinSoft.compositeOver(background),
)

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
