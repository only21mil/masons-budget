package com.sats21m.vogelvault.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.ui.theme.LedgerMotion
import com.sats21m.vogelvault.ui.theme.LedgerRadii
import com.sats21m.vogelvault.ui.theme.LocalLedgerEffects
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme

/** A tween that snaps when the user asked for reduced motion. */
@Composable
internal fun <T> ledgerControlSpec(millis: Int): AnimationSpec<T> =
    if (LocalLedgerEffects.current.animate) tween(millis, easing = FastOutSlowInEasing) else snap()

private val TOGGLE_WIDTH = 42.dp
private val TOGGLE_HEIGHT = 24.dp
private val TOGGLE_KNOB = 18.dp
private val TOGGLE_INSET = 3.dp

/**
 * The handoff toggle: a 42 by 24 track with a 12dp radius and an 18dp knob.
 *
 * The knob is the only thing that travels (200ms); the track colour settles
 * over 180ms. Both snap under reduce motion. Pass a null [onCheckedChange] when
 * a parent row already owns the switch semantics; the control then adds no
 * accessibility node of its own.
 */
@Composable
fun LedgerToggle(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    contentDescription: String? = null,
) {
    val tokens = LocalLedgerTheme.current
    val colors = tokens.colors
    val trackTarget = if (checked) colors.bitcoinFill else colors.panelRaised
    val borderTarget = if (checked) colors.bitcoinFill else colors.line
    val track by animateColorAsState(
        targetValue = trackTarget,
        animationSpec = ledgerControlSpec(LedgerMotion.toggleCheckboxAndButtonMillis),
        label = "ledger-toggle-track",
    )
    val border by animateColorAsState(
        targetValue = borderTarget,
        animationSpec = ledgerControlSpec(LedgerMotion.toggleCheckboxAndButtonMillis),
        label = "ledger-toggle-border",
    )
    val knobOffset: Dp by animateDpAsState(
        targetValue = if (checked) TOGGLE_WIDTH - TOGGLE_KNOB - TOGGLE_INSET else TOGGLE_INSET,
        animationSpec = ledgerControlSpec(LedgerMotion.toggleKnobMillis),
        label = "ledger-toggle-knob",
    )
    val interactions = remember { MutableInteractionSource() }
    val semanticsModifier = if (onCheckedChange == null) {
        Modifier.clearAndSetSemantics { }
    } else {
        Modifier
            .toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Switch,
                interactionSource = interactions,
                indication = null,
                onValueChange = onCheckedChange,
            )
            .then(
                if (contentDescription != null) {
                    Modifier.semantics { this.contentDescription = contentDescription }
                } else {
                    Modifier
                },
            )
    }
    val shape = RoundedCornerShape(LedgerRadii.toggleTrack)
    Box(
        modifier
            .then(semanticsModifier)
            .size(width = TOGGLE_WIDTH, height = TOGGLE_HEIGHT)
            .background(track.copy(alpha = if (enabled) track.alpha else track.alpha * 0.4f), shape)
            .border(1.dp, border.copy(alpha = if (enabled) border.alpha else border.alpha * 0.4f), shape),
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            Modifier
                .offset(x = knobOffset)
                .size(TOGGLE_KNOB)
                .background(colors.knob.copy(alpha = if (enabled) 1f else 0.4f), CircleShape),
        )
    }
}
