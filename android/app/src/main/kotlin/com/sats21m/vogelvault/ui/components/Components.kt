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
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
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

/**
 * Test-only observation point for measuring how many ledger rows Compose visits.
 *
 * The production default is null and therefore costs no callback. Keeping the
 * observation at the shared row boundary lets a regression test render a real
 * screen and distinguish a lazy viewport from a Column that eagerly visits all
 * 911 production-sized rows.
 */
internal val LocalLedgerRowCompositionObserver =
    staticCompositionLocalOf<(() -> Unit)?> { null }

/**
 * The screen's one vertical lazy list, with spacing between sections but never
 * between rows inside a ledger panel.
 *
 * Keeping the spacing here matters: `Arrangement.spacedBy` applies between
 * every lazy item, which would put a card-sized gap between all 911 transaction
 * rows once they become individual items.
 */
class VaultLazyListScope internal constructor(
    private val delegate: LazyListScope,
) {
    private var hasContent = false
    private var gapIndex = 0

    fun item(
        key: Any? = null,
        contentType: Any? = null,
        content: @Composable () -> Unit,
    ) {
        separateFromPreviousSection()
        delegate.item(key = key, contentType = contentType) {
            content()
        }
    }

    /**
     * A panel whose rows are independent keyed lazy items.
     *
     * [sectionKey] is part of every key so the same domain record may safely
     * appear in Dashboard, Bitcoin, and Net Worth without colliding.
     */
    fun <T> keyedPanel(
        sectionKey: String,
        title: String,
        source: String? = null,
        rows: List<T>,
        rowKey: (T) -> String,
        rowContent: @Composable (T) -> Unit,
    ) {
        separateFromPreviousSection()
        delegate.item(
            key = "$sectionKey:header",
            contentType = "vault-panel-header",
        ) {
            LazyPanelHeader(title, source)
        }
        delegate.itemsIndexed(
            items = rows,
            key = { _, row -> "$sectionKey:row:${rowKey(row)}" },
            contentType = { _, _ -> "vault-panel-row:$sectionKey" },
        ) { index, row ->
            LazyPanelRow(isLast = index == rows.lastIndex) {
                rowContent(row)
            }
        }
    }

    private fun separateFromPreviousSection() {
        if (hasContent) {
            delegate.item(
                key = "vault-section-gap:${gapIndex++}",
                contentType = "vault-section-gap",
            ) {
                Spacer(Modifier.height(VaultSpace.md))
            }
        } else {
            hasContent = true
        }
    }
}

/** Build one screen from a single [LazyListScope]. */
fun LazyListScope.vaultContent(content: VaultLazyListScope.() -> Unit) {
    VaultLazyListScope(this).content()
}

@Composable
private fun LazyPanelHeader(title: String, source: String?) {
    val shape = RoundedCornerShape(topStart = 8.dp, topEnd = 8.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .border(1.dp, VaultLine, shape)
            .background(VaultSurface, shape),
    ) {
        Column(
            Modifier.padding(horizontal = VaultSpace.md, vertical = VaultSpace.sm),
        ) {
            Text(
                title,
                style = MaterialTheme.typography.titleSmall,
                color = VaultCream,
                modifier = Modifier.semantics { heading() },
            )
            if (source != null) {
                Text(source, style = MaterialTheme.typography.labelSmall, color = VaultTextDim)
            }
        }
    }
}

@Composable
private fun LazyPanelRow(
    isLast: Boolean,
    content: @Composable () -> Unit,
) {
    val shape = if (isLast) {
        RoundedCornerShape(bottomStart = 8.dp, bottomEnd = 8.dp)
    } else {
        RoundedCornerShape(0.dp)
    }
    Column(
        Modifier
            .fillMaxWidth()
            .border(1.dp, VaultLine, shape)
            .background(VaultSurface, shape),
    ) {
        content()
    }
}

/** Suppress a figure when the slice it came from did not load. */
fun figure(suppress: Boolean, render: () -> String): String =
    if (suppress) SUPPRESSED else render()

/**
 * How a figure should be spoken.
 *
 * TalkBack announces an em dash as nothing at all, so a suppressed figure would
 * be indistinguishable from a blank one. Suppression exists to say "unknown",
 * and unknown is not zero — that distinction has to survive into speech.
 */
private fun spokenFigure(value: String): String =
    if (value == SUPPRESSED) "unavailable" else value

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

/**
 * One announcement per cell, in reading order.
 *
 * Split across three Text nodes a cell costs three swipes and still never says
 * whether the number is settled: provenance is drawn in colour only (planned is
 * muted, estimated is dim), which is nothing to a screen reader.
 */
private fun Kpi.spoken(): String = buildString {
    append(label)
    append(", ")
    append(spokenFigure(value))
    // Nothing after this point describes a figure that was not read.
    if (value == SUPPRESSED) return@buildString
    when (provenance) {
        Provenance.PLANNED -> append(", planned figure")
        Provenance.ESTIMATED -> append(", estimated figure")
        Provenance.ACTUAL -> Unit
    }
    hint?.let {
        append(", ")
        append(it)
    }
}

@Composable
private fun KpiCell(item: Kpi, modifier: Modifier = Modifier) {
    val suppressed = item.value == SUPPRESSED
    val spoken = item.spoken()
    Column(
        modifier = modifier
            .clearAndSetSemantics { contentDescription = spoken }
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
                    // Marked as a heading so TalkBack's heading navigation can jump
                    // panel to panel; a long ledger screen is unusable swipe by swipe.
                    Text(
                        title,
                        style = MaterialTheme.typography.titleSmall,
                        color = VaultCream,
                        modifier = Modifier.semantics { heading() },
                    )
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
    LocalLedgerRowCompositionObserver.current?.invoke()
    // One stop per row rather than four, and the figure keeps the label that gives
    // it meaning — a bare "-412.30" swiped in isolation says nothing.
    val spoken = buildString {
        append(primary)
        secondary?.let {
            append(", ")
            append(it)
        }
        badge?.let {
            append(", ")
            append(it)
        }
        append(", ")
        append(spokenFigure(figure))
    }
    Row(
        Modifier
            .fillMaxWidth()
            .clearAndSetSemantics { contentDescription = spoken }
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
    /** What the pill means, when the visible text is not the whole story. */
    spoken: String = text,
) {
    val border = tone ?: if (accented) VaultAccent.copy(alpha = 0.42f) else VaultLine
    Box(
        Modifier
            // role = Role.Button: a bare clickable() announces as static text with
            // no hint that it can be tapped, and these pills switch profile.
            .then(
                if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick)
                else Modifier,
            )
            // Merged rather than cleared so the click action above survives.
            .semantics(mergeDescendants = true) { contentDescription = spoken }
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
    val age = relativeTime(updatedAt, now)
    val (label, tone) = when (status) {
        Freshness.DEMO -> "DEMO DATA" to VaultInfo
        Freshness.LIVE -> age to VaultPositive
        Freshness.STALE -> "Stale · $age" to VaultWarning
        Freshness.ERROR -> "Read failed" to VaultNegative
        Freshness.LOADING -> "Loading" to VaultInfo
        Freshness.EMPTY -> "No data" to VaultTextMuted
    }
    // A live tag shows only a timestamp; that it means "synced" rides on the green
    // pill alone. The middot in the stale label reads as noise, so spell it out.
    val spoken = when (status) {
        Freshness.DEMO -> "Demo sample data, not synced"
        Freshness.LIVE -> "Synced $age"
        Freshness.STALE -> "Stale, updated $age"
        else -> label
    }
    Badge(label, tone = tone, spoken = spoken)
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
 * Non-live states rendered consistently so incomplete or sample data cannot be
 * mistaken for a successful remote read.
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
        Freshness.DEMO -> {
            icon = Icons.Filled.WarningAmber
            fallbackTitle = "Demo data"
            fallbackDetail = "These are sample figures for preview only. They have never been synced."
            tint = VaultInfo
        }
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
            // A screen swapping to "could not load" is a state change a sighted user
            // sees instantly; announce it rather than leaving it to be discovered.
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }
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
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }
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
        modifier = Modifier
            .padding(horizontal = VaultSpace.md, vertical = VaultSpace.sm)
            // Speak the original casing: TalkBack spells short all-caps strings out
            // letter by letter, so "BTC" and "CASH" arrive as initialisms.
            .clearAndSetSemantics {
                contentDescription = text
                heading()
            },
    )
}
