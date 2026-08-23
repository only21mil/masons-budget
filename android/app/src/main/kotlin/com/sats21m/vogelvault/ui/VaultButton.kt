package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.RowScope
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultSurfaceRaised

/** Primary action without consuming the orange accent as a body fill. */
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
internal fun vaultButtonColors(): ButtonColors = ButtonDefaults.buttonColors(
    containerColor = VaultSurfaceRaised,
    contentColor = VaultCream,
)
