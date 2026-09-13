package com.sats21m.vogelvault.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme

val LocalStateBlockRetry = staticCompositionLocalOf<() -> Unit> { {} }
val LocalFigureUnitCycle = staticCompositionLocalOf<(() -> Unit)?> { null }

@Composable
fun StateBlockRetry() {
    TextButton(onClick = LocalStateBlockRetry.current) { Text("Retry") }
}

/** Higher priority conditions appear first; ties keep the caller's order. */
data class LedgerCondition(
    val id: String,
    val title: String,
    val detail: String? = null,
    val priority: Int = 0,
    val retry: (() -> Unit)? = null,
)

internal fun orderedConditions(conditions: List<LedgerCondition>): List<LedgerCondition> =
    conditions.distinctBy { it.id }.sortedByDescending { it.priority }

/** An accepted write with a local lease-cleanup warning must never gain a retry action. */
@Composable
internal fun WriteRefusalLine(message: String?, retry: () -> Unit, enabled: Boolean, accepted: Boolean) {
    if (message == null) return
    LedgerStatusLine(listOf(LedgerCondition("bitcoin-write", message, priority = 100,
        retry = retry.takeIf { enabled && !accepted })))
}

@Composable
fun LedgerStatusLine(conditions: List<LedgerCondition>, modifier: Modifier = Modifier) {
    val ordered = orderedConditions(conditions)
    if (ordered.isEmpty()) return
    var expanded by rememberSaveable(ordered.first().id, ordered.first().title) { mutableStateOf(false) }
    val colors = LocalLedgerTheme.current.colors
    val type = LocalLedgerTheme.current.type
    Column(modifier.fillMaxWidth().testTag("ledger-status-line")
        .semantics { liveRegion = LiveRegionMode.Polite }) {
        ordered.take(if (expanded) ordered.size else 1).forEachIndexed { index, condition ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Column(Modifier.weight(1f).clickable(role = Role.Button) { expanded = !expanded }
                    .heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 8.dp)
                    .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }) {
                    Row {
                        Text(condition.title, modifier = Modifier.weight(1f), style = type.rowMeta, color = colors.loss)
                        if (index == 0) Text(if (expanded) "▴" else "▾", style = type.rowMeta, color = colors.foregroundSecondary)
                    }
                    if (expanded) condition.detail?.let { Text(it, style = type.rowMeta, color = colors.foregroundSecondary) }
                }
                condition.retry?.let { retry -> TextButton(onClick = retry) { Text("Retry") } }
            }
        }
    }
}

/** Fit the full formatted amount to the actual cell, including the user's font scale. */
@Composable
internal fun FittingFigure(value: String, style: TextStyle, color: Color) {
    val measurer = rememberTextMeasurer()
    var availableWidth by remember { mutableIntStateOf(0) }
    val measured = measurer.measure(value, style = style, softWrap = false).size.width
    val ratio = if (measured > 0 && availableWidth > 0) (availableWidth.toFloat() / measured).coerceAtMost(1f) else 1f
    Text(value, modifier = Modifier.fillMaxWidth().onSizeChanged { availableWidth = it.width },
        style = style.copy(fontSize = style.fontSize * ratio), color = color,
        maxLines = 1, softWrap = false)
}
