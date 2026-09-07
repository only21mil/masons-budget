package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.ui.components.LedgerStatusMark
import com.sats21m.vogelvault.ui.components.statusBannerMark
import com.sats21m.vogelvault.ui.theme.LedgerPalettes
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Guard the production caller inputs, which classifier-only tests cannot cover.
 * These are source contracts; they do not claim rendered-pixel coverage.
 */
class StatusBannerCallerTest {
    private val source = Files.readAllLines(
        Path.of("src/main/kotlin/com/sats21m/vogelvault/ui/Screens.kt"),
    ).joinToString("\n")

    @Test
    fun `stale data notice sends warning to the banner in both treatments`() {
        val caller = blockAfter(source, "private fun StaleNotice(status: Freshness)")
        assertTrue(caller.contains("if (status != Freshness.STALE) return"))
        val banner = caller.substringAfter("StatusBanner(", missingDelimiterValue = "")
        assertWarningRole(roleAfter(banner, "tone ="))
    }

    @Test
    fun `stale Bitcoin quote sends warning to the banner in both treatments`() {
        val caller = blockAfter(source, "internal fun BitcoinConversionNotice(state: VaultUiState)")
        val staleTone = blockAfter(caller, "tone = if (quote.status == MarketQuoteStatus.STALE)")
        assertWarningRole(roleAfter(staleTone, ""))
    }

    @Test
    fun `fresh and unavailable Bitcoin conversion retain neutral and loss roles`() {
        val caller = blockAfter(source, "internal fun BitcoinConversionNotice(state: VaultUiState)")
        val toneChoice = caller.substringAfter("tone = if (quote.status == MarketQuoteStatus.STALE)")
        val freshTone = blockAfter(toneChoice, "else")
        assertEquals("foregroundSecondary", roleAfter(freshTone, ""))

        val unavailable = caller.substringAfter("text = \"BTC conversion unavailable\"", missingDelimiterValue = "")
        assertEquals("loss", roleAfter(unavailable, "tone ="))
        for (palette in listOf(LedgerPalettes.TerminalDark, LedgerPalettes.DaylightLight)) {
            assertEquals(LedgerStatusMark.NEUTRAL, statusBannerMark(palette.foregroundSecondary))
            assertEquals(LedgerStatusMark.LOSS, statusBannerMark(palette.loss))
        }
    }

    private fun assertWarningRole(role: String) {
        assertEquals("warning", role, "Stale callers must select the warning role")
        for (palette in listOf(LedgerPalettes.TerminalDark, LedgerPalettes.DaylightLight)) {
            assertEquals(LedgerStatusMark.WARNING, statusBannerMark(palette.warning))
        }
    }

    private fun roleAfter(text: String, marker: String): String {
        val expression = text.substringAfter(marker, missingDelimiterValue = "").trimStart()
        return Regex("^LocalLedgerTheme\\.current\\.colors\\.(\\w+)")
            .find(expression)?.groupValues?.get(1)
            ?: error("Expected a direct ledger color after '$marker'")
    }

    private fun blockAfter(text: String, marker: String): String {
        val markerStart = text.indexOf(marker)
        check(markerStart >= 0) { "Missing caller or branch: $marker" }
        val start = text.indexOf('{', markerStart + marker.length)
        check(start >= 0) { "Missing block after: $marker" }
        var depth = 1
        for (index in start + 1 until text.length) {
            when (text[index]) {
                '{' -> depth++
                '}' -> if (--depth == 0) return text.substring(start + 1, index)
            }
        }
        error("Unclosed block after: $marker")
    }
}
