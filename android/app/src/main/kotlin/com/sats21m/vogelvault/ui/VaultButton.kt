package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.RowScope
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.sats21m.vogelvault.ui.theme.LedgerPalettes
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme

/** Primary action uses the treatment's full-opacity Bitcoin fill. */
@Composable
internal fun VaultButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    Button(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        colors = vaultButtonColors(),
        content = content,
    )
}

@Composable
internal fun vaultButtonColors(): ButtonColors {
    val colors = LocalLedgerTheme.current.colors
    return ButtonDefaults.buttonColors(
        containerColor = colors.bitcoinFill,
        contentColor = LedgerPalettes.TerminalDark.background,
    )
}
