package com.sats21m.vogelvault.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.ui.components.LedgerGlyphs
import com.sats21m.vogelvault.ui.theme.LedgerMotion
import com.sats21m.vogelvault.ui.theme.LocalLedgerEffects
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme

/** The handoff's stroke glyph for each destination, from `Design/icons.jsx`. */
internal fun Destination.ledgerGlyph(): ImageVector = when (this) {
    Destination.HOME -> LedgerGlyphs.Bars
    Destination.ACTIVITY -> LedgerGlyphs.Stack
    Destination.BUDGET -> LedgerGlyphs.Wallet
    Destination.BITCOIN -> LedgerGlyphs.Btc
    Destination.BTC_BUYS -> LedgerGlyphs.ArrowDown
    Destination.BTC_BILL_PAYS -> LedgerGlyphs.Chain
    Destination.EXPORT -> LedgerGlyphs.Doc
    Destination.TASKS -> LedgerGlyphs.CheckCircle
    Destination.FAMILY -> LedgerGlyphs.People
    Destination.SETTINGS -> LedgerGlyphs.Cog
}

/** Short tab label. The full destination name stays in the semantics. */
internal fun Destination.tabLabel(): String = label

private val TAB_GLYPH_SIZE = 20.dp

/**
 * One item in the folded bottom bar.
 *
 * Glyph and label share one tint: Bitcoin orange when active, tertiary ink at
 * rest, settling over 160ms. There is no pill and no ripple. The node reads as
 * a tab with [semanticLabel] in the caller's casing, so `More (9)` is still
 * found by name while the drawn label is uppercase.
 */
@Composable
internal fun LedgerTabItem(
    glyph: ImageVector,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    semanticLabel: String = label,
    showLabel: Boolean = true,
) {
    val tokens = LocalLedgerTheme.current
    val animate = LocalLedgerEffects.current.animate
    val spec = if (animate) {
        tween<Color>(LedgerMotion.chipAndNavigationMillis, easing = FastOutSlowInEasing)
    } else {
        snap()
    }
    val tint by animateColorAsState(
        targetValue = if (selected) tokens.colors.bitcoin else tokens.colors.foregroundTertiary,
        animationSpec = spec,
        label = "ledger-tab-tint",
    )
    val interactions = remember { MutableInteractionSource() }
    Column(
        modifier
            .selectable(
                selected = selected,
                role = Role.Tab,
                interactionSource = interactions,
                indication = null,
                onClick = onClick,
            )
            .clearAndSetSemantics {
                contentDescription = semanticLabel
                text = AnnotatedString(semanticLabel)
            }
            .heightIn(min = tokens.density.minimumHitTarget)
            .padding(top = 8.dp, bottom = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(glyph, contentDescription = null, tint = tint, modifier = Modifier.size(TAB_GLYPH_SIZE))
        if (showLabel) Text(label.uppercase(), modifier = Modifier.fillMaxWidth(), textAlign = androidx.compose.ui.text.style.TextAlign.Center, style = tokens.type.tabLabel, color = tint, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
    }
}

/** The hairline-topped folded bar. The caller draws the rule above it. */
@Composable
internal fun LedgerTabBar(
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit,
) {
    val tokens = LocalLedgerTheme.current
    Row(
        Modifier
            .background(tokens.colors.panel)
            .then(modifier)
            .fillMaxWidth()
            .selectableGroup(),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
internal fun LedgerMenuItem(label: String, onClick: () -> Unit, enabled: Boolean = true) {
    androidx.compose.material3.DropdownMenuItem(
        text = { Text(label, color = LocalLedgerTheme.current.colors.foreground) },
        enabled = enabled,
        onClick = onClick,
    )
}
