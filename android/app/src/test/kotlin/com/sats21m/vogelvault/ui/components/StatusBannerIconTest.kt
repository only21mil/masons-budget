package com.sats21m.vogelvault.ui.components

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.ui.graphics.Color
import com.sats21m.vogelvault.ui.theme.VaultInfo
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultPositive
import com.sats21m.vogelvault.ui.theme.VaultTextMuted
import com.sats21m.vogelvault.ui.theme.VaultWarning
import org.junit.Assert.assertSame
import org.junit.Test

class StatusBannerIconTest {
    @Test
    fun semanticTonesUseMatchingIcons() {
        assertSame(Icons.Filled.CheckCircle, statusBannerIcon(VaultPositive))
        assertSame(Icons.Filled.ErrorOutline, statusBannerIcon(VaultNegative))
        assertSame(Icons.Filled.WarningAmber, statusBannerIcon(VaultWarning))
    }

    @Test
    fun neutralTonesUseInfoIcon() {
        assertSame(Icons.Filled.Info, statusBannerIcon(VaultInfo))
        assertSame(Icons.Filled.Info, statusBannerIcon(VaultTextMuted))
        assertSame(Icons.Filled.Info, statusBannerIcon(Color.Magenta))
    }
}
