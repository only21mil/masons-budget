package com.sats21m.vogelvault.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.theme.LedgerNumeral
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultInfo
import com.sats21m.vogelvault.ui.theme.VaultLine
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultPositive
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultSurface
import com.sats21m.vogelvault.ui.theme.VaultSurfaceSunken
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import com.sats21m.vogelvault.ui.theme.VaultTextMuted
import com.sats21m.vogelvault.ui.theme.VaultWarning

/**
 * Placeholder for a figure that could not be read.
 *
 * Shared so [KpiStrip] can recognise it and drop the tone: a red or green em dash
 * implies a reading that does not exist.
 */
const val SUPPRESSED = "—"

/** Provenance of a figure. The cockpit never lets an estimate look settled. */
enum class Provenance { ACTUAL, PLANNED, ESTIMATED }

data class Kpi(
    val label: String,
    val value: String,
    val hint: String? = null,
    val tone: Color? = null,
    val provenance: Provenance = Provenance.ACTUAL,
)

/** Suppress a figure when the slice it came from did not load. */
fun figure(suppress: Boolean, render: () -> String): String =
    if (suppress) SUPPRESSED else render()

@Composable
fun KpiStrip(items: List<Kpi>, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .border(1.dp, VaultLine, RoundedCornerShape(8.dp)),
    ) {
        items.chunked(2).forEachIndexed { rowIndex, row ->
            if (rowIndex > 0) HorizontalHairline()
            // IntrinsicSize.Min makes both cells adopt the taller one's height,
            // so a cell carrying a hint line cannot leave a stub of bare surface
            // beside its neighbour.
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                row.forEachIndexed { index, item ->
                    if (index > 0) VerticalHairline(Modifier.fillMaxHeight())
                    KpiCell(item, Modifier.weight(1f).fillMaxHeight())
                }
                if (row.size == 1) {
                    VerticalHairline(Modifier.fillMaxHeight())
                    Spacer(Modifier.weight(1f).fillMaxHeight().background(VaultSurface))
                }
            }
        }
    }
}

@Composable
private fun KpiCell(item: Kpi, modifier: Modifier = Modifier) {
    val suppressed = item.value == SUPPRESSED
    Column(
        modifier = modifier
            .background(VaultSurface)
            .padding(horizontal = VaultSpace.md, vertical = VaultSpace.md),
    ) {
        Text(
            item.label.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = VaultTextDim,
        )
        Spacer(Modifier.height(2.dp))
        Text(
            item.value,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
            style = LedgerNumeral.copy(fontSize = 18.sp),
            color = when {
                suppressed -> VaultTextDim
                item.tone != null -> item.tone
                item.provenance == Provenance.PLANNED -> VaultTextMuted
                item.provenance == Provenance.ESTIMATED -> VaultTextDim
                else -> VaultCream
            },
            textAlign = TextAlign.Start,
        )
        if (!suppressed && item.hint != null) {
            Text(item.hint, style = MaterialTheme.typography.labelSmall, color = VaultTextMuted)
        }
    }
}

@Composable
fun Panel(
    title: String? = null,
    source: String? = null,
    modifier: Modifier = Modifier,
    trailing: @Composable (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .border(1.dp, VaultLine, RoundedCornerShape(8.dp))
            .background(VaultSurface, RoundedCornerShape(8.dp)),
    ) {
        if (title != null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = VaultSpace.md, vertical = VaultSpace.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(title, style = MaterialTheme.typography.titleSmall, color = VaultCream)
                    if (source != null) {
                        Text(source, style = MaterialTheme.typography.labelSmall, color = VaultTextDim)
                    }
                }
                trailing?.invoke()
            }
            HorizontalHairline()
        }
        content()
    }
}

@Composable
fun HorizontalHairline(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(VaultLine))
}

@Composable
fun VerticalHairline(modifier: Modifier = Modifier) {
    Box(modifier.width(1.dp).background(VaultLine))
}

/** A ledger row: label on the left, monospace figure hard right. */
@Composable
fun LedgerRow(
    primary: String,
    secondary: String? = null,
    figure: String,
    figureColor: Color = VaultCream,
    badge: String? = null,
    badgeAccented: Boolean = false,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = VaultSpace.md, vertical = VaultSpace.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(primary, style = MaterialTheme.typography.bodyMedium, color = VaultCream)
            if (secondary != null) {
                Text(secondary, style = MaterialTheme.typography.labelSmall, color = VaultTextDim)
            }
        }
        if (badge != null) {
            Badge(badge, accented = badgeAccented)
            Spacer(Modifier.width(VaultSpace.sm))
        }
        Text(figure, style = LedgerNumeral, color = figureColor)
    }
}

@Composable
fun Badge(
    text: String,
    accented: Boolean = false,
    tone: Color? = null,
    onClick: (() -> Unit)? = null,
) {
    val border = tone ?: if (accented) VaultAccent.copy(alpha = 0.42f) else VaultLine
    Box(
        Modifier
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .border(1.dp, border, RoundedCornerShape(99.dp))
            .background(
                if (accented) VaultAccent.copy(alpha = 0.16f) else VaultSurfaceSunken,
                RoundedCornerShape(99.dp),
            )
            .padding(horizontal = 7.dp, vertical = 2.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelSmall, color = tone ?: VaultTextMuted)
    }
}

/** Freshness marker. A figure is never shown without saying how much to trust it. */
@Composable
fun FreshnessTag(status: Freshness, updatedAt: Long?, now: Long) {
    val (label, tone) = when (status) {
        Freshness.LIVE -> relativeTime(updatedAt, now) to VaultPositive
        Freshness.STALE -> "Stale · ${relativeTime(updatedAt, now)}" to VaultWarning
        Freshness.ERROR -> "Read failed" to VaultNegative
        Freshness.LOADING -> "Loading" to VaultInfo
        Freshness.EMPTY -> "No data" to VaultTextMuted
    }
    Badge(label, tone = tone)
}

private fun relativeTime(updatedAt: Long?, now: Long): String {
    if (updatedAt == null) return "never"
    val delta = now - updatedAt
    if (delta < 60_000) return "just now"
    val minutes = delta / 60_000
    if (minutes < 60) return "${minutes}m ago"
    val hours = minutes / 60
    if (hours < 24) return "${hours}h ago"
    return "${hours / 24}d ago"
}

/**
 * The four non-normal states. Rendered identically everywhere so a half-loaded
 * screen can never be mistaken for a complete one.
 */
@Composable
fun StateBlock(
    status: Freshness,
    title: String? = null,
    detail: String? = null,
) {
    val icon: ImageVector
    val fallbackTitle: String
    val fallbackDetail: String
    val tint: Color

    when (status) {
        Freshness.ERROR -> {
            icon = Icons.Filled.ErrorOutline
            fallbackTitle = "Could not load"
            fallbackDetail = "The last read from MC2 failed. Showing nothing rather than something wrong."
            tint = VaultNegative
        }
        Freshness.STALE -> {
            icon = Icons.Filled.WarningAmber
            fallbackTitle = "Showing stale data"
            fallbackDetail = "The bridge has not refreshed recently. Treat these figures as out of date."
            tint = VaultWarning
        }
        Freshness.LOADING -> {
            icon = Icons.Filled.HourglassEmpty
            fallbackTitle = "Loading"
            fallbackDetail = "Reading from the local bridge."
            tint = VaultTextDim
        }
        else -> {
            icon = Icons.Filled.Inbox
            fallbackTitle = "Nothing here yet"
            fallbackDetail = "No records have synced into this view."
            tint = VaultTextDim
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = VaultSpace.xxl, horizontal = VaultSpace.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(VaultSpace.xs),
    ) {
        Icon(icon, contentDescription = null, tint = tint)
        Text(
            title ?: fallbackTitle,
            style = MaterialTheme.typography.bodyMedium,
            color = VaultCream,
            textAlign = TextAlign.Center,
        )
        Text(
            detail ?: fallbackDetail,
            style = MaterialTheme.typography.bodySmall,
            color = VaultTextMuted,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
fun StatusBanner(text: String, detail: String? = null, tone: Color = VaultInfo) {
    Row(
        Modifier
            .fillMaxWidth()
            .border(1.dp, VaultLine, RoundedCornerShape(6.dp))
            .background(VaultSurface, RoundedCornerShape(6.dp))
            .padding(VaultSpace.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = tone)
        Spacer(Modifier.width(VaultSpace.sm))
        Column {
            Text(text, style = MaterialTheme.typography.bodySmall, color = VaultCream)
            if (detail != null) {
                Text(detail, style = MaterialTheme.typography.labelSmall, color = VaultTextMuted)
            }
        }
    }
}

@Composable
fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = VaultTextDim,
        modifier = Modifier.padding(horizontal = VaultSpace.md, vertical = VaultSpace.sm),
    )
}
