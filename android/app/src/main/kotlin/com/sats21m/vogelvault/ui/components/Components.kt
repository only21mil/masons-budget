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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
import com.sats21m.vogelvault.ui.theme.LedgerPalettes
import com.sats21m.vogelvault.ui.theme.LedgerRadii
import com.sats21m.vogelvault.ui.theme.LedgerSpacing
import com.sats21m.vogelvault.ui.theme.LocalLedgerEffects
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
import com.sats21m.vogelvault.ui.theme.withLedgerPhosphorGlow

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
        VaultWarning -> colors.loss
        VaultInfo -> colors.foregroundSecondary
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
        /** The slice revision the rows came from; a change reveals them. Null prints cold. */
        revealKey: Any? = null,
        onHeaderClick: (() -> Unit)? = null,
        rowContent: @Composable (T) -> Unit,
    ) {
        separateFromPreviousSection()
        delegate.item(
            key = "$sectionKey:header",
            contentType = "vault-panel-header",
        ) {
            Box(Modifier.then(if (onHeaderClick != null) Modifier.clickable(role = Role.Button, onClick = onHeaderClick) else Modifier)) {
                LazyPanelHeader(title, source)
            }
        }
        delegate.itemsIndexed(
            items = rows,
            key = { _, row -> "$sectionKey:row:${rowKey(row)}" },
            contentType = { _, _ -> "vault-panel-row:$sectionKey" },
        ) { index, row ->
            LazyPanelRow(
                isLast = index == rows.lastIndex,
                modifier = Modifier.ledgerRowReveal(index, revealKey?.let { "$sectionKey:$it" }),
            ) {
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
    Column(Modifier.fillMaxWidth()) {
        SectionHeading(title, source, trailing = null)
        LedgerRule()
    }
}

/** Rows sit between subtle rules with no outer box; the section rule above opens the first. */
@Composable
private fun LazyPanelRow(
    isLast: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Column(modifier.fillMaxWidth()) {
        content()
        if (!isLast) LedgerRule(subtle = true)
    }
}

/**
 * A section label with its source line: 11sp 600 uppercase over 11sp meta,
 * 9dp above the rule the caller draws beneath it.
 */
@Composable
private fun SectionHeading(
    title: String,
    source: String?,
    trailing: @Composable (() -> Unit)?,
) {
    val tokens = LocalLedgerTheme.current
    Row(
        Modifier
            .fillMaxWidth()
            .padding(bottom = tokens.density.sectionLabelBottomSpace),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            // Marked as a heading so TalkBack's heading navigation can jump
            // section to section; a long ledger screen is unusable swipe by swipe.
            Text(
                title.uppercase(),
                style = tokens.type.sectionLabel,
                color = tokens.colors.foregroundSecondary,
                modifier = Modifier.clearAndSetSemantics {
                    contentDescription = title
                    heading()
                },
            )
            userFacingSource(source)?.let {
                Text(it.uppercase(), style = tokens.type.rowMeta, color = tokens.colors.foregroundTertiary)
            }
        }
        trailing?.invoke()
    }
}

/**
 * A slice source as the household sees it: "Convex rows · transactions" reads
 * as "transactions". Backend nouns stay in Settings, where they are diagnostics.
 * Returns null when nothing user-facing is left.
 */
internal fun userFacingSource(source: String?): String? {
    if (source == null) return null
    val stripped = source
        .replace(Regex("^Convex finance document(\\s*·\\s*)?"), "")
        .replace(Regex("^Convex rows(\\s*·\\s*)?"), "")
        .trim()
    return stripped.takeIf { it.isNotEmpty() }
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

/**
 * The hairline KPI grid: rules on the grid's top and left and on each cell's
 * right and bottom, no fill, no card. An odd last figure spans its row.
 */
@Composable
fun KpiStrip(items: List<Kpi>, modifier: Modifier = Modifier) {
    androidx.compose.foundation.layout.BoxWithConstraints(modifier.fillMaxWidth()) {
        val columns = when {
            maxWidth < 400.dp -> 1
            maxWidth >= 680.dp -> 4
            else -> 2
        }
        Column(Modifier.fillMaxWidth()) {
            LedgerRule()
            items.chunked(columns).forEach { row ->
                // IntrinsicSize.Min makes both cells adopt the taller one's height,
                // so a cell carrying a hint line cannot leave a short rule beside it.
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                    VerticalHairline(Modifier.fillMaxHeight())
                    row.forEach { item ->
                        KpiCell(item, Modifier.weight(1f).fillMaxHeight())
                        VerticalHairline(Modifier.fillMaxHeight())
                    }
                }
                LedgerRule()
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

@Composable
private fun KpiCell(item: Kpi, modifier: Modifier = Modifier) {
    val tokens = LocalLedgerTheme.current
    val effects = LocalLedgerEffects.current
    val unavailable = item.value.isUnavailableFigure()
    val spoken = item.spoken()
    val figureColor = when {
        unavailable -> tokens.colors.foregroundTertiary
        item.tone != null -> ledgerColor(item.tone)
        item.provenance == Provenance.PLANNED -> tokens.colors.foregroundSecondary
        item.provenance == Provenance.ESTIMATED -> tokens.colors.foregroundTertiary
        else -> tokens.colors.foreground
    }
    Column(
        modifier = modifier
            .then(LocalFigureUnitCycle.current?.let { Modifier.clickable(role = Role.Button, onClick = it) } ?: Modifier)
            .semantics(mergeDescendants = true) { contentDescription = spoken }
            .padding(LedgerSpacing.large),
    ) {
        Text(
            item.label.uppercase(),
            style = tokens.type.kpiLabel,
            color = tokens.colors.foregroundTertiary,
        )
        Spacer(Modifier.height(2.dp))
        FittingFigure(
            item.value,
            style = tokens.type.kpiValue.withLedgerPhosphorGlow(
                enabled = effects.showPhosphorGlow && figureColor == tokens.colors.bitcoin,
            ),
            color = figureColor,
        )
        if (!unavailable && item.hint != null) {
            Text(item.hint.uppercase(), style = tokens.type.kpiSub, color = tokens.colors.foregroundTertiary)
        }
    }
}

/**
 * A section: label, rule, rows. No border and no fill unless [raised], which
 * is reserved for the two cards the handoff draws (the Bitcoin projection and
 * the retirement scenario).
 */
@Composable
fun Panel(
    title: String? = null,
    source: String? = null,
    modifier: Modifier = Modifier,
    raised: Boolean = false,
    trailing: @Composable (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val tokens = LocalLedgerTheme.current
    val shape = RoundedCornerShape(LedgerRadii.card)
    val container = if (raised) {
        modifier
            .fillMaxWidth()
            .border(1.dp, tokens.colors.line, shape)
            .background(tokens.colors.panel, shape)
            .padding(tokens.density.cardPadding)
    } else {
        modifier.fillMaxWidth()
    }
    Column(container) {
        if (title != null) {
            SectionHeading(title, source, trailing)
            LedgerRule()
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
    val spoken = ledgerRowContentDescription(primary, secondary, figure, badge)
    Row(
        Modifier
            .fillMaxWidth()
            .clearAndSetSemantics { contentDescription = spoken }
            .padding(vertical = tokens.density.rowVerticalPadding),
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

internal fun ledgerRowContentDescription(
    primary: String,
    secondary: String?,
    figure: String,
    badge: String?,
): String = buildString {
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
    // An accented tag is a meta tag in Bitcoin ink with no box: one orange
    // rectangle per row was competing with the tab and the hero.
    val border = if (accented) Color.Transparent else tokens.colors.line
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
            .padding(horizontal = 7.dp, vertical = 2.dp),
    ) {
        Text(
            text,
            style = tokens.type.chip,
            color = resolvedTone ?: if (accented) tokens.colors.bitcoin else tokens.colors.foregroundSecondary,
            maxLines = 1,
        )
    }
}

/** Freshness marker. A figure is never shown without saying how much to trust it. */
@Composable
fun FreshnessTag(status: Freshness, updatedAt: Long?, now: Long, provenance: String? = null) {
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
    val tokens = LocalLedgerTheme.current
    Row(
        Modifier.semantics(mergeDescendants = true) { contentDescription = listOfNotNull(spoken, provenance).joinToString(", ") },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LedgerStatusDot(ledgerColor(tone))
        Spacer(Modifier.width(LedgerSpacing.small))
        Text(listOfNotNull(label, provenance).joinToString(" · "), style = tokens.type.chip, color = tokens.colors.foregroundSecondary)
    }
}

/**
 * A 6dp status dot in the tone it reports. It is the only place a status tone
 * is drawn as a shape; the text beside it carries the meaning for a reader
 * who cannot see the colour.
 */
@Composable
fun LedgerStatusDot(tone: Color, modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(6.dp)
            .clearAndSetSemantics { }
            .background(tone, CircleShape),
    )
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
    action: (@Composable () -> Unit)? = null,
) {
    if (status == Freshness.LOADING) {
        // Ghost rows breathe in the section's own geometry; a static hourglass
        // does nothing for loading anxiety. The top bar keeps its progress ring.
        LedgerSkeletonRows()
        return
    }
    val tokens = LocalLedgerTheme.current
    val fallbackTitle: String
    val fallbackDetail: String
    val tone: Color

    when (status) {
        Freshness.DEMO -> {
            fallbackTitle = "Demo data"
            fallbackDetail = "These are sample figures for preview only. They have never been synced."
            tone = tokens.colors.foregroundSecondary
        }
        Freshness.ERROR -> {
            fallbackTitle = stringResource(R.string.convex_read_error_title)
            fallbackDetail = stringResource(R.string.convex_read_error_detail)
            tone = tokens.colors.loss
        }
        Freshness.STALE -> {
            fallbackTitle = stringResource(R.string.convex_read_stale_title)
            fallbackDetail = stringResource(R.string.convex_read_stale_detail)
            tone = tokens.colors.loss
        }
        else -> {
            fallbackTitle = stringResource(R.string.convex_read_empty_title)
            fallbackDetail = stringResource(R.string.convex_read_empty_detail)
            tone = tokens.colors.foregroundTertiary
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            // A screen swapping to "could not load" is a state change a sighted user
            // sees instantly; announce it rather than leaving it to be discovered.
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }
            .padding(vertical = VaultSpace.xl, horizontal = VaultSpace.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(VaultSpace.xs),
    ) {
        LedgerStatusDot(tone, Modifier.padding(bottom = VaultSpace.xs))
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
        action?.invoke()
    }
}

@Composable
fun StatusBanner(text: String, detail: String? = null, tone: Color = VaultInfo) {
    val tokens = LocalLedgerTheme.current
    val dotTone = when (statusBannerMark(tone)) {
        LedgerStatusMark.GAIN -> tokens.colors.gain
        LedgerStatusMark.LOSS -> tokens.colors.loss
        LedgerStatusMark.NEUTRAL -> tokens.colors.foregroundTertiary
    }
    Row(
        Modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }
            .border(1.dp, tokens.colors.line, RoundedCornerShape(LedgerRadii.card))
            .background(tokens.colors.panel, RoundedCornerShape(LedgerRadii.card))
            .padding(tokens.density.cardPadding),
        verticalAlignment = Alignment.Top,
    ) {
        // Optically centred on the first line of the title.
        LedgerStatusDot(dotTone, Modifier.padding(top = 6.dp))
        Spacer(Modifier.width(LedgerSpacing.medium))
        Column {
            Text(text, style = tokens.type.rowPrimary, color = tokens.colors.foreground)
            if (detail != null) {
                Text(detail, style = tokens.type.body, color = tokens.colors.foregroundSecondary)
            }
        }
    }
}

/** What a banner's dot reports. Warning collapses into loss, as [ledgerColor] already does. */
enum class LedgerStatusMark { GAIN, LOSS, NEUTRAL }

internal fun statusBannerMark(tone: Color): LedgerStatusMark = when (tone) {
    VaultPositive,
    LedgerPalettes.TerminalDark.gain,
    LedgerPalettes.DaylightLight.gain,
    -> LedgerStatusMark.GAIN
    VaultNegative,
    VaultWarning,
    LedgerPalettes.TerminalDark.loss,
    LedgerPalettes.DaylightLight.loss,
    -> LedgerStatusMark.LOSS
    else -> LedgerStatusMark.NEUTRAL
}

@Composable
fun SectionLabel(text: String) {
    val tokens = LocalLedgerTheme.current
    Text(
        text.uppercase(),
        style = tokens.type.sectionLabel,
        color = tokens.colors.foregroundSecondary,
        modifier = Modifier
            .padding(vertical = LedgerSpacing.medium)
            // Speak the original casing: TalkBack spells short all-caps strings out
            // letter by letter, so "BTC" and "CASH" arrive as initialisms.
            .clearAndSetSemantics {
                contentDescription = text
                heading()
            },
    )
}
