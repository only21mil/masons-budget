package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.isSpend
import com.sats21m.vogelvault.domain.visibleTo
import com.sats21m.vogelvault.ui.components.HorizontalHairline
import com.sats21m.vogelvault.ui.components.SectionLabel
import com.sats21m.vogelvault.ui.components.StateBlock
import com.sats21m.vogelvault.ui.components.isUnavailableFigure
import com.sats21m.vogelvault.ui.components.ledgerColor
import com.sats21m.vogelvault.ui.components.ledgerRowContentDescription
import com.sats21m.vogelvault.ui.theme.LedgerSpacing
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultSpace
import java.time.Instant
import java.time.ZoneId

/**
 * The unfolded right sidebar.
 *
 * The handoff's point for the Fold: extra width carries more information, not
 * stretched rows. Dashboard and Budget get a 296dp column with the seven most
 * recent ledger rows and today's tasks at the dense 11dp row padding. It reads
 * the same state the main screens already project; nothing here fetches.
 */
const val LEDGER_SIDEBAR_WIDTH_DP = 296
internal const val LEDGER_SIDEBAR_TEST_TAG = "vault-ledger-sidebar"
internal const val SIDEBAR_RECENT_ACTIVITY_LIMIT = 7
internal const val SIDEBAR_TASK_TAG_TODAY = "TODAY"
internal const val SIDEBAR_TASK_TAG_OVERDUE = "OVERDUE"

internal val SIDEBAR_DESTINATIONS: Set<Destination> = setOf(Destination.DASHBOARD, Destination.BUDGET)

/** Only the two ledger screens split; every other destination keeps its width. */
internal fun showsLedgerSidebar(destination: Destination, unfolded: Boolean): Boolean =
    unfolded && destination in SIDEBAR_DESTINATIONS

/** Newest first, scoped to the viewer exactly as the Activity screen scopes it. */
internal fun sidebarRecentActivity(state: VaultUiState): List<Transaction> =
    state.data.transactions.value
        .visibleTo(state.activeProfile)
        .sortedByDescending { it.date }
        .take(SIDEBAR_RECENT_ACTIVITY_LIMIT)

/** The Today screen's list, unchanged: open and due on or before today. */
internal fun sidebarTodaysTasks(
    state: VaultUiState,
    zoneId: ZoneId = ZoneId.systemDefault(),
): List<TodoItem> = todosDueToday(state, zoneId)

internal fun sidebarTaskTag(task: TodoItem, today: String): String {
    val due = task.due
    return if (due != null && due < today) SIDEBAR_TASK_TAG_OVERDUE else SIDEBAR_TASK_TAG_TODAY
}

internal fun sidebarLocalDay(epochMillis: Long, zoneId: ZoneId = ZoneId.systemDefault()): String =
    Instant.ofEpochMilli(epochMillis).atZone(zoneId).toLocalDate().toString()

@Composable
internal fun LedgerSidebar(
    state: VaultUiState,
    displayUnit: DisplayUnit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalLedgerTheme.current
    val quote = state.operationalBitcoinQuote()
    val profile = state.activeProfile
    val transactionsInput = state.data.transactions.value
    val todosInput = state.data.todos.value
    val activity = remember(profile, transactionsInput) { sidebarRecentActivity(state) }
    val tasks = remember(profile, todosInput, state.now) { sidebarTodaysTasks(state) }
    val today = remember(state.now) { sidebarLocalDay(state.now) }

    Column(
        modifier
            .fillMaxHeight()
            .width(LEDGER_SIDEBAR_WIDTH_DP.dp)
            .verticalScroll(rememberScrollState())
            .testTag(LEDGER_SIDEBAR_TEST_TAG),
    ) {
        SidebarSection("Recent activity") {
            when {
                state.data.transactions.suppressFigures -> StateBlock(state.data.transactions.status)
                activity.isEmpty() -> SidebarEmptyLine("nothing here. clear.")
                else -> activity.forEachIndexed { index, transaction ->
                    if (index > 0) HorizontalHairline()
                    SidebarRow(
                        primary = transaction.merchant,
                        secondary = "${transaction.date} · ${transaction.category}",
                        figure = formatTransactionAmount(transaction, displayUnit, quote),
                        figureColor = if (transaction.isSpend && !transaction.hasOppositeSpendSign) {
                            tokens.colors.loss
                        } else {
                            tokens.colors.gain
                        },
                    )
                }
            }
        }
        SidebarSection("Today") {
            when {
                state.data.todos.suppressFigures -> StateBlock(state.data.todos.status)
                tasks.isEmpty() -> SidebarEmptyLine("Nothing is due today.")
                else -> tasks.forEachIndexed { index, task ->
                    if (index > 0) HorizontalHairline()
                    val tag = sidebarTaskTag(task, today)
                    SidebarRow(
                        primary = task.title,
                        secondary = task.area ?: task.project,
                        figure = tag,
                        figureColor = if (tag == SIDEBAR_TASK_TAG_OVERDUE) tokens.colors.loss else tokens.colors.bitcoin,
                    )
                }
            }
        }
        Spacer(Modifier.height(tokens.density.screenGutter))
    }
}

/** Section label block: 22dp above, 9dp below, then a rule. The label carries 9dp itself. */
@Composable
private fun SidebarSection(label: String, content: @Composable ColumnScope.() -> Unit) {
    val tokens = LocalLedgerTheme.current
    Spacer(Modifier.height(tokens.density.sectionTopSpace - LedgerSpacing.medium))
    SectionLabel(label)
    HorizontalHairline()
    Column(content = content)
}

@Composable
private fun SidebarEmptyLine(text: String) {
    val tokens = LocalLedgerTheme.current
    Text(
        text,
        style = tokens.type.rowMeta,
        color = tokens.colors.foregroundTertiary,
        modifier = Modifier.padding(
            horizontal = tokens.density.cardPadding,
            vertical = tokens.density.denseRowVerticalPadding,
        ),
    )
}

/** A ledger row at the dense sidebar padding; one spoken stop per row like [com.sats21m.vogelvault.ui.components.LedgerRow]. */
@Composable
private fun SidebarRow(
    primary: String,
    secondary: String?,
    figure: String,
    figureColor: Color,
) {
    val tokens = LocalLedgerTheme.current
    val spoken = ledgerRowContentDescription(primary, secondary, figure, badge = null)
    Row(
        Modifier
            .fillMaxWidth()
            .clearAndSetSemantics { contentDescription = spoken }
            .padding(
                horizontal = tokens.density.cardPadding,
                vertical = tokens.density.denseRowVerticalPadding,
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                primary,
                style = tokens.type.rowPrimary,
                color = tokens.colors.foreground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (secondary != null) {
                Text(
                    secondary.uppercase(),
                    style = tokens.type.rowMeta,
                    color = tokens.colors.foregroundTertiary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Spacer(Modifier.width(VaultSpace.sm))
        Text(
            figure,
            style = tokens.type.rowFigure,
            color = if (figure.isUnavailableFigure()) tokens.colors.foregroundTertiary else ledgerColor(figureColor),
        )
    }
}
