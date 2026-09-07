package com.sats21m.vogelvault.ui.components

import androidx.compose.ui.graphics.Color
import com.sats21m.vogelvault.ui.theme.LedgerPalettes
import com.sats21m.vogelvault.ui.theme.VaultInfo
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultPositive
import com.sats21m.vogelvault.ui.theme.VaultTextMuted
import com.sats21m.vogelvault.ui.theme.VaultWarning
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The banner glyph is a status dot. Its mark still follows the semantic tone,
 * so a gain-toned banner reads as gain in both the legacy and ledger palettes.
 */
class StatusBannerIconTest {
    @Test
    fun legacySemanticTonesUseMatchingMarks() {
        assertEquals(LedgerStatusMark.GAIN, statusBannerMark(VaultPositive))
        assertEquals(LedgerStatusMark.LOSS, statusBannerMark(VaultNegative))
        assertEquals(LedgerStatusMark.WARNING, statusBannerMark(VaultWarning))
    }

    @Test
    fun currentLedgerGainAndLossTonesUseMatchingMarks() {
        assertEquals(LedgerStatusMark.GAIN, statusBannerMark(LedgerPalettes.TerminalDark.gain))
        assertEquals(LedgerStatusMark.GAIN, statusBannerMark(LedgerPalettes.DaylightLight.gain))
        assertEquals(LedgerStatusMark.LOSS, statusBannerMark(LedgerPalettes.TerminalDark.loss))
        assertEquals(LedgerStatusMark.LOSS, statusBannerMark(LedgerPalettes.DaylightLight.loss))
    }

    @Test
    fun currentLedgerWarningsUseWarningMarks() {
        assertEquals(LedgerStatusMark.WARNING, statusBannerMark(LedgerPalettes.TerminalDark.warning))
        assertEquals(LedgerStatusMark.WARNING, statusBannerMark(LedgerPalettes.DaylightLight.warning))
    }

    @Test
    fun neutralTonesUseTheNeutralMark() {
        assertEquals(LedgerStatusMark.NEUTRAL, statusBannerMark(VaultInfo))
        assertEquals(LedgerStatusMark.NEUTRAL, statusBannerMark(VaultTextMuted))
        assertEquals(LedgerStatusMark.NEUTRAL, statusBannerMark(Color.Magenta))
    }
}
