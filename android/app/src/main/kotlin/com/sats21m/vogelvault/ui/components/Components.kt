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
import androidx.compose.material.icons.filled.Info
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
import androidx.compose.ui.res.stringResource
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
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.ui.theme.LedgerNumeral
import com.sats21m.vogelvault.ui.theme.LedgerRadii
import com.sats21m.vogelvault.ui.theme.LedgerSpacing
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
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

internal fun String.isUnavailableFigure(): Boolean =
    this == SUPPRESSED || this == Money.PRICE_UNAVAILABLE

internal fun resolvedFigureColor(value: String, requested: Color): Color =
    if (value.isUnavailableFigure()) VaultTextDim else requested

/** Maps the retired cockpit aliases onto the active Terminal or Daylight ledger. */
@Composable
internal fun ledgerColor(requested: Color): Color {
    val colors = LocalLedgerTheme.current.colors
    return when (requested) {
        VaultCream -> colors.foreground
        VaultTextMuted -> colors.foregroundSecondary
        VaultTextDim -> colors.foregroundTertiary
        VaultAccent -> colors.bitcoin
        VaultPositive -> colors.gain
        VaultNegative -> colors.loss
        VaultLine -> colors.line
        VaultSurface -> colors.panel
        VaultSurfaceSunken -> colors.background
        else -> requested
    }
}

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
        val spacing = LedgerSpacing.section
        if (hasContent) {
            delegate.item(
                key = "vault-section-gap:${gapIndex++}",
                contentType = "vault-section-gap",
            ) {
                Spacer(Modifier.height(spacing))
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
    val tokens = LocalLedgerTheme.current
    val shape = RoundedCornerShape(topStart = LedgerRadii.card, topEnd = LedgerRadii.card)
    Column(
        Modifier
            .fillMaxWidth()
            .border(1.dp, tokens.colors.line, shape)
            .background(tokens.colors.panel, shape),
    ) {
        Column(
            Modifier.padding(horizontal = tokens.density.cardPadding, vertical = LedgerSpacing.medium),
        ) {
            Text(
                title,
                style = tokens.type.sectionLabel,
                color = tokens.colors.foreground,
                modifier = Modifier.semantics { heading() },
            )
            if (source != null) {
                Text(source.uppercase(), style = tokens.type.rowMeta, color = tokens.colors.foregroundTertiary)
            }
        }
    }
}

@Composable
private fun LazyPanelRow(
    isLast: Boolean,
    content: @Composable () -> Unit,
) {
    val tokens = LocalLedgerTheme.current
    val shape = if (isLast) {
        RoundedCornerShape(bottomStart = LedgerRadii.card, bottomEnd = LedgerRadii.card)
    } else {
        RoundedCornerShape(0.dp)
    }
    Column(
        Modifier
            .fillMaxWidth()
            .border(1.dp, tokens.colors.line, shape)
            .background(tokens.colors.panel, shape),
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
    val tokens = LocalLedgerTheme.current
    Column(
        modifier = modifier
            .fillMaxWidth()
            .border(1.dp, tokens.colors.line, RoundedCornerShape(LedgerRadii.card))
            .background(tokens.colors.panel, RoundedCornerShape(LedgerRadii.card)),
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
    if (value.isUnavailableFigure()) return@buildString
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

internal fun kpiFigureWraps(value: String): Boolean = value == Money.PRICE_UNAVAILABLE

@Composable
private fun KpiCell(item: Kpi, modifier: Modifier = Modifier) {
    val tokens = LocalLedgerTheme.current
    val unavailable = item.value.isUnavailableFigure()
    val wrapsUnavailablePrice = kpiFigureWraps(item.value)
    val spoken = item.spoken()
    Column(
        modifier = modifier
            .clearAndSetSemantics { contentDescription = spoken }
            .background(tokens.colors.panel)
            .padding(horizontal = tokens.density.cardPadding, vertical = tokens.density.cardPadding),
    ) {
        Text(
            item.label.uppercase(),
            style = tokens.type.kpiLabel,
            color = tokens.colors.foregroundTertiary,
        )
        Spacer(Modifier.height(2.dp))
        Text(
            item.value,
            maxLines = if (wrapsUnavailablePrice) 2 else 1,
            softWrap = wrapsUnavailablePrice,
            overflow = TextOverflow.Ellipsis,
            style = tokens.type.kpiValue,
            color = when {
                unavailable -> tokens.colors.foregroundTertiary
                item.tone != null -> ledgerColor(item.tone)
                item.provenance == Provenance.PLANNED -> tokens.colors.foregroundSecondary
                item.provenance == Provenance.ESTIMATED -> tokens.colors.foregroundTertiary
                else -> tokens.colors.foreground
            },
            textAlign = TextAlign.Start,
        )
        if (!unavailable && item.hint != null) {
            Text(item.hint.uppercase(), style = tokens.type.kpiSub, color = tokens.colors.foregroundSecondary)
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
    val tokens = LocalLedgerTheme.current
    val shape = RoundedCornerShape(LedgerRadii.card)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .border(1.dp, tokens.colors.line, shape)
            .background(tokens.colors.panel, shape),
    ) {
        if (title != null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = tokens.density.cardPadding, vertical = LedgerSpacing.medium),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    // Marked as a heading so TalkBack's heading navigation can jump
                    // panel to panel; a long ledger screen is unusable swipe by swipe.
                    Text(
                        title,
                        style = tokens.type.sectionLabel,
                        color = tokens.colors.foreground,
                        modifier = Modifier.semantics { heading() },
                    )
                    if (source != null) {
                        Text(source.uppercase(), style = tokens.type.rowMeta, color = tokens.colors.foregroundTertiary)
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
    LedgerRule(modifier)
}

@Composable
fun VerticalHairline(modifier: Modifier = Modifier) {
    Box(modifier.width(1.dp).background(LocalLedgerTheme.current.colors.line))
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
    val tokens = LocalLedgerTheme.current
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
            .padding(horizontal = tokens.density.cardPadding, vertical = tokens.density.rowVerticalPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(primary, style = tokens.type.rowPrimary, color = tokens.colors.foreground)
            if (secondary != null) {
                Text(secondary.uppercase(), style = tokens.type.rowMeta, color = tokens.colors.foregroundTertiary)
            }
        }
        if (badge != null) {
            Badge(badge, accented = badgeAccented)
            Spacer(Modifier.width(VaultSpace.sm))
        }
        Text(
            figure,
            style = tokens.type.rowFigure,
            color = if (figure.isUnavailableFigure()) tokens.colors.foregroundTertiary else ledgerColor(figureColor),
        )
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
    val tokens = LocalLedgerTheme.current
    val resolvedTone = tone?.let { ledgerColor(it) }
    val border = resolvedTone ?: if (accented) tokens.colors.bitcoin.copy(alpha = 0.42f) else tokens.colors.line
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
            .border(1.dp, border, RoundedCornerShape(LedgerRadii.control))
            .background(
                if (accented) tokens.colors.bitcoinSoft else tokens.colors.background,
                RoundedCornerShape(LedgerRadii.control),
            )
            .padding(horizontal = 7.dp, vertical = 2.dp),
    ) {
        Text(text, style = tokens.type.chip, color = resolvedTone ?: tokens.colors.foregroundSecondary)
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
    val tokens = LocalLedgerTheme.current
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
            fallbackTitle = stringResource(R.string.convex_read_error_title)
            fallbackDetail = stringResource(R.string.convex_read_error_detail)
            tint = VaultNegative
        }
        Freshness.STALE -> {
            icon = Icons.Filled.WarningAmber
            fallbackTitle = stringResource(R.string.convex_read_stale_title)
            fallbackDetail = stringResource(R.string.convex_read_stale_detail)
            tint = VaultWarning
        }
        Freshness.LOADING -> {
            icon = Icons.Filled.HourglassEmpty
            fallbackTitle = stringResource(R.string.convex_read_loading_title)
            fallbackDetail = stringResource(R.string.convex_read_loading_detail)
            tint = VaultTextDim
        }
        else -> {
            icon = Icons.Filled.Inbox
            fallbackTitle = stringResource(R.string.convex_read_empty_title)
            fallbackDetail = stringResource(R.string.convex_read_empty_detail)
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
        Icon(icon, contentDescription = null, tint = ledgerColor(tint))
        Text(
            title ?: fallbackTitle,
            style = tokens.type.rowPrimary,
            color = tokens.colors.foreground,
            textAlign = TextAlign.Center,
        )
        Text(
            detail ?: fallbackDetail,
            style = tokens.type.body,
            color = tokens.colors.foregroundSecondary,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
fun StatusBanner(text: String, detail: String? = null, tone: Color = VaultInfo) {
    val tokens = LocalLedgerTheme.current
    val resolvedTone = ledgerColor(tone)
    Row(
        Modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }
            .border(1.dp, tokens.colors.line, RoundedCornerShape(LedgerRadii.card))
            .background(tokens.colors.panel, RoundedCornerShape(LedgerRadii.card))
            .padding(tokens.density.cardPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(statusBannerIcon(tone), contentDescription = null, tint = resolvedTone)
        Spacer(Modifier.width(VaultSpace.sm))
        Column {
            Text(text, style = tokens.type.rowPrimary, color = tokens.colors.foreground)
            if (detail != null) {
                Text(detail, style = tokens.type.body, color = tokens.colors.foregroundSecondary)
            }
        }
    }
}

internal fun statusBannerIcon(tone: Color): ImageVector = when (tone) {
    VaultPositive -> Icons.Filled.CheckCircle
    VaultNegative -> Icons.Filled.ErrorOutline
    VaultWarning -> Icons.Filled.WarningAmber
    else -> Icons.Filled.Info
}

@Composable
fun SectionLabel(text: String) {
    val tokens = LocalLedgerTheme.current
    Text(
        text.uppercase(),
        style = tokens.type.sectionLabel,
        color = tokens.colors.foregroundTertiary,
        modifier = Modifier
            .padding(horizontal = tokens.density.cardPadding, vertical = LedgerSpacing.medium)
            // Speak the original casing: TalkBack spells short all-caps strings out
            // letter by letter, so "BTC" and "CASH" arrive as initialisms.
            .clearAndSetSemantics {
                contentDescription = text
                heading()
            },
    )
}
