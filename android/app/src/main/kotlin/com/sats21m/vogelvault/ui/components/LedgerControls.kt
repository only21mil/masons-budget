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
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.VisualTransformation
import com.sats21m.vogelvault.ui.theme.LedgerSpacing
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

/**
 * The handoff text field: panel fill, line border, 3dp radius, an optional
 * prefix glyph (`/` for search, `$` or the unit for amounts), no floating
 * label, 15sp input.
 *
 * [label] is drawn as an uppercase caption above the box and stays inside the
 * field's semantics in the caller's casing, so `hasText(label)` still finds the
 * editable node. [placeholder] shows while the value is empty. The border
 * settles to Bitcoin orange on focus over 160ms and snaps under reduce motion.
 */
@Composable
fun LedgerTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String? = null,
    prefix: String? = null,
    prefixGlyph: ImageVector? = null,
    prefixTint: Color? = null,
    supporting: String? = null,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    textStyle: TextStyle? = null,
) {
    val tokens = LocalLedgerTheme.current
    val colors = tokens.colors
    val interactions = remember { MutableInteractionSource() }
    val focused by interactions.collectIsFocusedAsState()
    val border by animateColorAsState(
        targetValue = if (focused && enabled) colors.bitcoin else colors.line,
        animationSpec = ledgerControlSpec(LedgerMotion.chipAndNavigationMillis),
        label = "ledger-field-border",
    )
    val inputStyle = (textStyle ?: tokens.type.textInput).copy(
        color = if (enabled) colors.foreground else colors.foregroundTertiary,
    )
    val shape = RoundedCornerShape(LedgerRadii.control)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier,
        enabled = enabled,
        textStyle = inputStyle,
        cursorBrush = SolidColor(colors.bitcoin),
        keyboardOptions = keyboardOptions,
        visualTransformation = visualTransformation,
        singleLine = singleLine,
        minLines = minLines,
        maxLines = maxLines,
        interactionSource = interactions,
        decorationBox = { innerField ->
            Column {
                if (label != null) {
                    Text(
                        label.uppercase(),
                        style = tokens.type.kpiLabel,
                        color = colors.foregroundSecondary,
                        modifier = Modifier
                            .padding(bottom = LedgerSpacing.small)
                            .clearAndSetSemantics { text = AnnotatedString(label) },
                    )
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(colors.panel, shape)
                        .border(1.dp, border, shape)
                        .heightIn(min = 48.dp)
                        .padding(horizontal = LedgerSpacing.large, vertical = LedgerSpacing.medium),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val tint = prefixTint ?: colors.foregroundTertiary
                    if (prefixGlyph != null) {
                        Icon(
                            prefixGlyph,
                            contentDescription = null,
                            tint = tint,
                            modifier = Modifier.size(16.dp).padding(end = 0.dp),
                        )
                        Spacer(Modifier.width(LedgerSpacing.medium))
                    } else if (prefix != null) {
                        Text(
                            prefix,
                            style = inputStyle,
                            color = tint,
                            modifier = Modifier.clearAndSetSemantics { },
                        )
                        Spacer(Modifier.width(LedgerSpacing.medium))
                    }
                    Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                        if (value.isEmpty() && placeholder != null) {
                            Text(placeholder, style = inputStyle, color = colors.foregroundTertiary, maxLines = 1)
                        }
                        innerField()
                    }
                }
                if (supporting != null) {
                    Text(
                        supporting,
                        style = tokens.type.rowMeta,
                        color = colors.foregroundTertiary,
                        modifier = Modifier.padding(top = LedgerSpacing.small),
                    )
                }
            }
        },
    )
}
