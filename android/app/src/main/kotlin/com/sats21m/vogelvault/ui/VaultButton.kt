package com.sats21m.vogelvault.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.ui.theme.LedgerMotion
import com.sats21m.vogelvault.ui.theme.LedgerPalettes
import com.sats21m.vogelvault.ui.theme.LedgerRadii
import com.sats21m.vogelvault.ui.theme.LocalLedgerEffects
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme

/** Container, border, and label ink for one ledger button state. */
@Immutable
internal data class LedgerButtonColors(
    val containerColor: Color,
    val borderColor: Color,
    val labelColor: Color,
)

/**
 * Primary action: the treatment's full-opacity Bitcoin fill under the dark ink.
 * Secondary action: panel fill inside a line border. Disabled actions drop to
 * the line border and tertiary ink so the one filled button on a screen is the
 * one that can be pressed.
 */
@Composable
internal fun vaultButtonColors(
    secondary: Boolean = false,
    enabled: Boolean = true,
): LedgerButtonColors {
    val colors = LocalLedgerTheme.current.colors
    return when {
        !enabled -> LedgerButtonColors(
            containerColor = colors.panel,
            borderColor = colors.line,
            labelColor = colors.foregroundTertiary,
        )
        secondary -> LedgerButtonColors(
            containerColor = colors.panel,
            borderColor = colors.line,
            labelColor = colors.foreground,
        )
        else -> LedgerButtonColors(
            containerColor = colors.bitcoinFill,
            borderColor = colors.bitcoinFill,
            labelColor = LedgerPalettes.TerminalDark.background,
        )
    }
}

/**
 * The ledger button: 3dp radius, uppercase 11sp 600 label at 0.10em.
 *
 * The visible label is uppercase; the semantics carry the caller's casing so
 * TalkBack reads "Save" rather than spelling S-A-V-E. Press feedback is a
 * 180ms container settle, not a ripple, and it snaps under reduce motion.
 */
@Composable
internal fun VaultButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    secondary: Boolean = false,
) {
    val tokens = LocalLedgerTheme.current
    val animate = LocalLedgerEffects.current.animate
    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()
    val resting = vaultButtonColors(secondary = secondary, enabled = enabled)
    val pressedContainer = when {
        !enabled -> resting.containerColor
        secondary -> tokens.colors.panelRaised
        else -> resting.containerColor.copy(alpha = 0.85f)
    }
    val spec = if (animate) {
        tween<Color>(LedgerMotion.toggleCheckboxAndButtonMillis, easing = FastOutSlowInEasing)
    } else {
        snap()
    }
    val container by animateColorAsState(
        targetValue = if (pressed) pressedContainer else resting.containerColor,
        animationSpec = spec,
        label = "ledger-button-container",
    )
    val shape = RoundedCornerShape(LedgerRadii.control)
    Box(
        modifier
            .clickable(
                enabled = enabled,
                role = Role.Button,
                interactionSource = interactions,
                indication = null,
                onClick = onClick,
            )
            .clearAndSetSemantics {
                text = AnnotatedString(label)
                if (!enabled) disabled()
            }
            .background(container, shape)
            .border(1.dp, resting.borderColor, shape)
            .defaultMinSize(minHeight = 34.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label.uppercase(),
            style = tokens.type.button,
            color = resting.labelColor,
            maxLines = 1,
        )
    }
}
