package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.MC2_FILES
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.budgetTransactionsFor
import com.sats21m.vogelvault.domain.deriveBudgetSpend
import com.sats21m.vogelvault.domain.inMonth
import com.sats21m.vogelvault.domain.incomeAmount
import com.sats21m.vogelvault.domain.isDueBy
import com.sats21m.vogelvault.domain.isSpend
import com.sats21m.vogelvault.domain.netWorthScopeFor
import com.sats21m.vogelvault.domain.resolveBudgetMonth
import com.sats21m.vogelvault.domain.visibleTo
import com.sats21m.vogelvault.ui.components.FreshnessTag
import com.sats21m.vogelvault.ui.components.HorizontalHairline
import com.sats21m.vogelvault.ui.components.Kpi
import com.sats21m.vogelvault.ui.components.KpiStrip
import com.sats21m.vogelvault.ui.components.LedgerRow
import com.sats21m.vogelvault.ui.components.Panel
import com.sats21m.vogelvault.ui.components.Provenance
import com.sats21m.vogelvault.ui.components.StateBlock
import com.sats21m.vogelvault.ui.components.StatusBanner
import com.sats21m.vogelvault.ui.components.figure
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultAccentDim
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultLine
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultPositive
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultSurface
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import com.sats21m.vogelvault.ui.theme.VaultTextMuted
import com.sats21m.vogelvault.ui.theme.VaultWarning

@Composable
fun ScreenHost(
    destination: Destination,
    state: VaultUiState,
    onEnableRemoteRows: (String) -> Unit = {},
    displayUnit: DisplayUnit = DisplayUnit.BTC,
    onDisplayUnitChange: (DisplayUnit) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val budgetMonth = state.data.budget.value?.month
    val months = state.budgetMonths
    // The Budget screen's month scope. Held here rather than in the ViewModel
    // because it is view state, and because every row of the list has to agree on
    // it — the KPI strip, the banners and the categories all read the same month.
    // Re-seeded when the profile changes or the state names a month, so a preview
    // or the design packet can render any month without driving a tap.
    var picked by rememberSaveable(state.activeProfile, state.selectedMonth) {
        mutableStateOf(state.activeBudgetMonth)
    }
    // A refresh can retire the picked month. Fall back rather than render a month
    // the ledger no longer contains.
    val month = resolveBudgetMonth(picked, months, budgetMonth)

    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(VaultSpace.md),
        verticalArrangement = Arrangement.spacedBy(VaultSpace.md),
    ) {
        item {
            ScreenHeader(
                destination,
                state,
                month,
                displayUnit,
                onDisplayUnitChange,
            )
        }
        if (
            displayUnit == DisplayUnit.USD &&
            destination in setOf(Destination.DASHBOARD, Destination.BITCOIN, Destination.NET_WORTH)
        ) {
            item { BitcoinFiatNotice(state) }
        }
        when (destination) {
            Destination.DASHBOARD -> dashboard(state, month, displayUnit)
            Destination.ACTIVITY -> activity(state)
            Destination.BUDGET -> budget(state, month, months) { picked = it }
            Destination.BITCOIN -> bitcoin(state, displayUnit)
            Destination.NET_WORTH -> netWorth(state, displayUnit)
            Destination.TODAY -> today(state)
            Destination.FAMILY -> family(state)
            Destination.SETTINGS -> settings(state, onEnableRemoteRows)
        }
    }
}

@Composable
private fun ScreenHeader(
    destination: Destination,
    state: VaultUiState,
    budgetMonth: String?,
    displayUnit: DisplayUnit,
    onDisplayUnitChange: (DisplayUnit) -> Unit,
) {
    val subtitle = when (destination) {
        Destination.DASHBOARD ->
            if (state.activeProfile.isAdult) "Household command center"
            else "${state.activeProfile.displayName}'s money"
        Destination.ACTIVITY -> "Transactions visible to this profile"
        // The month in scope, not the budget file's month: the two differ while an
        // earlier month is picked, and the header must not contradict the picker.
        // A profile with no budget file still says so — Maddox has none.
        Destination.BUDGET -> state.data.budget.value?.let { monthLabel(budgetMonth ?: it.month) } ?: "No budget"
        Destination.BITCOIN -> "Stack and custody"
        Destination.NET_WORTH -> "Household for adults; self only for children"
        Destination.TODAY -> "Due today or overdue"
        Destination.FAMILY -> "Who can see what"
        Destination.SETTINGS -> "Runtime and boundaries"
    }
    Column {
        Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text(
                destination.label,
                style = MaterialTheme.typography.headlineMedium,
                color = VaultCream,
                modifier = Modifier.weight(1f),
            )
            FreshnessTag(state.worstStatus, state.worstUpdatedAt, state.now)
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = VaultTextMuted,
                modifier = Modifier.weight(1f),
            )
            BitcoinUnitToggle(displayUnit, onDisplayUnitChange)
        }
    }
}

@Composable
private fun BitcoinUnitToggle(
    selected: DisplayUnit,
    onSelect: (DisplayUnit) -> Unit,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(VaultSpace.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DisplayUnit.entries.forEach { unit ->
            SelectionChip(
                label = unit.label,
                selected = unit == selected,
                compact = true,
                onSelect = { onSelect(unit) },
            )
        }
    }
}

@Composable
private fun BitcoinFiatNotice(state: VaultUiState) {
    val asOf = state.data.btcPriceAsOf
    if (state.data.btcPriceCents > 0L && asOf != null) {
        StatusBanner(
            text = "USD estimate",
            detail = "Uses the last recorded Bitcoin buy price from $asOf. This is not a live price.",
            tone = VaultTextMuted,
        )
    } else {
        StatusBanner(
            text = "USD unavailable",
            detail = "No recorded Bitcoin buy price is available. BTC and SATS remain exact.",
            tone = VaultWarning,
        )
    }
}

// ── Dashboard ───────────────────────────────────────────────────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.dashboard(
    state: VaultUiState,
    selectedMonth: String?,
    displayUnit: DisplayUnit,
) {
    val profile = state.activeProfile
    val visible = state.data.transactions.value.visibleTo(profile)
    val budgetTransactions = state.data.transactions.value.budgetTransactionsFor(profile)
    // The headline follows the Budget screen's selected month and narrower budget
    // scope. Adults still see child rows in Recent activity for oversight, but
    // those rows never enter Victor/Rachel's spend or income totals.
    val month = selectedMonth ?: ""
    val transactions = budgetTransactions.inMonth(month)
    val activity = visible.inMonth(month)
    val accounts = state.data.btcAccounts.value.netWorthScopeFor(profile)
    val openTodos = state.data.todos.value.visibleTo(profile).count { !it.done }

    val spend = transactions.sumOf { it.spendAmount }
    val income = transactions.sumOf { it.incomeAmount }
    val stackSats = accounts.sumOf { it.sats }

    item {
        KpiStrip(
            listOf(
                Kpi("Spend", figure(state.data.transactions.suppressFigures) { Money.formatUsd(spend) }, tone = VaultNegative),
                Kpi("Income", figure(state.data.transactions.suppressFigures) { Money.formatUsd(income) }, tone = VaultPositive),
                Kpi(
                    "Stack",
                    figure(state.data.btcAccounts.suppressFigures) {
                        state.formatBitcoin(stackSats, displayUnit)
                    },
                    hint = figure(state.data.btcAccounts.suppressFigures) {
                        if (displayUnit == DisplayUnit.USD) {
                            priceBasis(state)
                        } else {
                            state.formatBitcoin(stackSats, DisplayUnit.USD)
                        }
                    },
                ),
                Kpi("Open tasks", figure(state.data.todos.suppressFigures) { openTodos.toString() }),
            ),
        )
    }
    item { StaleNotice(state.data.transactions.status) }
    item {
        Panel("Recent activity", state.data.transactions.source) {
            if (state.data.transactions.suppressFigures || state.data.transactions.status == Freshness.EMPTY) {
                StateBlock(state.data.transactions.status)
            } else if (activity.isEmpty()) {
                StateBlock(Freshness.EMPTY)
            } else {
                Column {
                    activity.take(6).forEachIndexed { index, transaction ->
                        if (index > 0) HorizontalHairline()
                        TransactionRow(transaction)
                    }
                }
            }
        }
    }
    item {
        Panel("Bitcoin", state.data.btcAccounts.source) {
            AccountList(
                accounts,
                state.data.btcAccounts.status,
                displayUnit,
                state.data.btcPriceCents,
            )
        }
    }
}

// ── Activity ────────────────────────────────────────────────────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.activity(state: VaultUiState) {
    val transactions = state.data.transactions.value.visibleTo(state.activeProfile)
    item { StaleNotice(state.data.transactions.status) }
    if (state.data.transactions.suppressFigures) {
        item { Panel { StateBlock(state.data.transactions.status) } }
        return
    }
    if (transactions.isEmpty()) {
        item { Panel { StateBlock(Freshness.EMPTY) } }
        return
    }
    item {
        Panel(state.data.transactions.source.let { "${transactions.size} records" }, state.data.transactions.source) {
            Column {
                transactions.forEachIndexed { index, transaction ->
                    if (index > 0) HorizontalHairline()
                    TransactionRow(transaction)
                }
            }
        }
    }
}

@Composable
private fun TransactionRow(transaction: Transaction) {
    val isSpend = transaction.isSpend
    val isCreditOrWrongSign = transaction.hasOppositeSpendSign
    val displaySpend = transaction.displaySpendAmount
    LedgerRow(
        primary = transaction.merchant,
        secondary = "${transaction.date} · ${transaction.category}",
        figure = when {
            !isSpend -> Money.formatUsd(transaction.incomeAmount)
            isCreditOrWrongSign -> Money.formatUsd(displaySpend)
            else -> "-${Money.formatUsd(displaySpend)}"
        },
        figureColor = if (isSpend && !isCreditOrWrongSign) VaultNegative else VaultPositive,
    )
}

// ── Budget ──────────────────────────────────────────────────────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.budget(
    state: VaultUiState,
    month: String?,
    months: List<String>,
    onSelectMonth: (String) -> Unit,
) {
    val slice = state.data.budget
    val budget = slice.value
    val scopedMonth = month ?: budget?.month

    // Spend is DERIVED from the scoped month's transactions, never read from the
    // reported category total: a July budget counts only July transactions.
    // Matches what iOS has always done (BudgetView.monthTransactions).
    //
    // MC2 publishes one budget file per profile and it carries the current
    // month's targets, so an earlier month reuses those targets and re-derives
    // its own actuals. The banner below says so rather than letting the planned
    // column imply MC2 had a June budget.
    val spend = budget?.let {
        val scoped = if (scopedMonth == null || scopedMonth == it.month) it else it.copy(month = scopedMonth)
        deriveBudgetSpend(scoped, state.data.transactions.value.budgetTransactionsFor(state.activeProfile))
    }

    if (budget == null) {
        val readable = slice.status == Freshness.LIVE || slice.status == Freshness.DEMO
        item {
            Panel {
                StateBlock(
                    if (readable) Freshness.EMPTY else slice.status,
                    title = if (readable) "No budget for this profile" else null,
                    detail = if (slice.status == Freshness.DEMO) {
                        "This demo profile has no sample budget."
                    } else if (slice.status == Freshness.LIVE) {
                        "This profile has no dedicated budget file in the remote data."
                    } else {
                        null
                    },
                )
            }
        }
        return
    }

    val derived = spend ?: return

    // Hidden when the read failed: the month list is derived from the same
    // transactions the screen has just been told not to trust, so offering a
    // choice between them would be a control over nothing. One month is not a
    // choice either — a lone chip reads as a button that does nothing.
    val pickable = months.size > 1 && !slice.suppressFigures && !state.data.transactions.suppressFigures
    if (pickable) {
        item { MonthPicker(months, derived.month, onSelectMonth) }
    }

    item {
        KpiStrip(
            listOf(
                Kpi("Planned", figure(slice.suppressFigures) { Money.formatUsd(derived.plannedCents) }, provenance = Provenance.PLANNED),
                Kpi("Actual", figure(slice.suppressFigures) { Money.formatUsd(derived.actualCents) }),
                Kpi(
                    "Remaining",
                    figure(slice.suppressFigures) { Money.formatUsd(derived.remainingCents) },
                    tone = if (derived.remainingCents < 0L) VaultNegative else VaultPositive,
                ),
                Kpi(
                    "Over budget",
                    figure(slice.suppressFigures) { derived.overBudgetCount.toString() },
                    hint = if (derived.overBudgetCount == 1) "1 category" else "${derived.overBudgetCount} categories",
                    tone = if (derived.overBudgetCount > 0) VaultNegative else null,
                ),
            ),
        )
    }
    item { StaleNotice(slice.status) }
    if (derived.month != budget.month && !slice.suppressFigures) {
        item {
            StatusBanner(
                "Planned figures are ${monthLabel(budget.month)} targets",
                stringResource(
                    R.string.convex_budget_period_mismatch_detail,
                    monthLabel(budget.month),
                    monthLabel(derived.month),
                ),
                tone = VaultWarning,
            )
        }
    }
    if (derived.uncategorisedCents > 0L && !slice.suppressFigures) {
        // Spend that matched no category is surfaced, never dropped: silently
        // discarding it would make this screen disagree with Activity for no
        // visible reason, and picking an older month makes that far more likely.
        item {
            StatusBanner(
                "${Money.formatUsd(derived.uncategorisedCents)} spent outside any budget category",
                stringResource(R.string.convex_uncategorized_spend_detail),
            )
        }
    }
    item {
        Panel("Categories", "${slice.source} · ${derived.month} transactions") {
            if (slice.suppressFigures) {
                StateBlock(slice.status)
            } else {
                Column {
                    derived.categories.forEachIndexed { index, category ->
                        if (index > 0) HorizontalHairline()
                        LedgerRow(
                            primary = category.name,
                            secondary = "planned ${Money.formatUsd(category.budgetCents)}",
                            figure = Money.formatUsd(category.spentCents),
                            figureColor = if (category.isOverBudget) VaultNegative else VaultCream,
                            badge = if (category.isOverBudget) "over" else null,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Month scope control.
 *
 * One scrolling row rather than a wrapped grid: folded, the Fold is 411dp wide,
 * and a year of months either overflows that or pushes the figures off the first
 * screen. A row that scrolls stays one line tall in both postures, and months are
 * newest first so the default sits under the thumb rather than off-screen.
 */
@Composable
private fun MonthPicker(months: List<String>, selected: String, onSelect: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(VaultSpace.sm)) {
        Text(
            "MONTH",
            style = MaterialTheme.typography.labelSmall,
            color = VaultTextDim,
        )
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            months.forEach { month ->
                MonthChip(month, month == selected) { onSelect(month) }
            }
        }
    }
}

@Composable
private fun MonthChip(month: String, selected: Boolean, onSelect: () -> Unit) {
    SelectionChip(
        label = monthLabel(month),
        selected = selected,
        onSelect = onSelect,
    )
}

/**
 * Existing ledger choice-chip language shared by month and display-unit
 * pickers. Orange marks selection only in the border/fill; text stays cream.
 */
@Composable
private fun SelectionChip(
    label: String,
    selected: Boolean,
    compact: Boolean = false,
    onSelect: () -> Unit,
) {
    val shape = RoundedCornerShape(99.dp)
    Box(
        Modifier
            .heightIn(min = if (compact) 32.dp else 40.dp)
            .clip(shape)
            // selectable, not clickable: this is one choice out of a set, and a
            // screen reader should say so.
            .selectable(selected = selected, role = Role.RadioButton, onClick = onSelect)
            .background(if (selected) VaultAccentDim else VaultSurface, shape)
            .border(1.dp, if (selected) VaultAccent.copy(alpha = 0.42f) else VaultLine, shape)
            .padding(
                horizontal = if (compact) VaultSpace.sm else VaultSpace.md,
                vertical = if (compact) VaultSpace.xs else VaultSpace.sm,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            // Orange marks the selection through the fill and border only. It is
            // never a text colour — the selected label just goes to full cream.
            color = if (selected) VaultCream else VaultTextMuted,
            maxLines = 1,
        )
    }
}

private val MONTH_NAMES =
    listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/**
 * `2026-07` → `Jul 2026`.
 *
 * A fixed table rather than a date formatter: MC2 month keys are already
 * unambiguous, and a locale-dependent format would make the design packet render
 * differently from the device. Anything unexpected falls through to the raw key
 * instead of throwing.
 */
private fun monthLabel(month: String): String {
    val parts = month.split("-")
    val name = parts.getOrNull(1)?.toIntOrNull()?.let { MONTH_NAMES.getOrNull(it - 1) } ?: return month
    return "$name ${parts[0]}"
}

// ── Bitcoin ─────────────────────────────────────────────────────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.bitcoin(
    state: VaultUiState,
    displayUnit: DisplayUnit,
) {
    val profile = state.activeProfile
    val slice = state.data.btcAccounts
    val inScope = slice.value.netWorthScopeFor(profile)
    val totalSats = inScope.sumOf { it.sats }
    val selfCustody = inScope.filter { it.custody.key == "self_custody" }.sumOf { it.sats }

    item {
        KpiStrip(
            listOf(
                Kpi(
                    "Total stack",
                    figure(slice.suppressFigures) { state.formatBitcoin(totalSats, displayUnit) },
                ),
                Kpi(
                    "Reference price",
                    figure(slice.suppressFigures) {
                        state.data.btcPriceCents
                            .takeIf { it > 0L }
                            ?.let { Money.formatUsd(it) }
                            ?: Money.PRICE_UNAVAILABLE
                    },
                    hint = figure(slice.suppressFigures) { priceBasis(state) },
                    provenance = Provenance.ESTIMATED,
                ),
                Kpi(
                    "Self custody",
                    figure(slice.suppressFigures) { "${Money.basisPoints(selfCustody, totalSats) / 100}%" },
                    hint = figure(slice.suppressFigures) {
                        state.formatBitcoin(selfCustody, displayUnit)
                    },
                ),
                Kpi("Accounts", figure(slice.suppressFigures) { inScope.size.toString() }),
            ),
        )
    }
    item { StaleNotice(slice.status) }
    item {
        Panel("Accounts in net worth", slice.source) {
            AccountList(inScope, slice.status, displayUnit, state.data.btcPriceCents)
        }
    }
    item {
        val buys = state.data.btcBuys.value.visibleTo(profile)
        Panel("Recent buys", state.data.btcBuys.source) {
            if (state.data.btcBuys.suppressFigures) {
                StateBlock(state.data.btcBuys.status)
            } else if (buys.isEmpty()) {
                StateBlock(Freshness.EMPTY)
            } else {
                Column {
                    buys.forEachIndexed { index, buy ->
                        if (index > 0) HorizontalHairline()
                        LedgerRow(
                            primary = buy.source,
                            secondary = "${buy.date} · ${Money.formatUsd(buy.priceUsdCents)}",
                            figure = Money.formatBitcoin(
                                buy.sats,
                                displayUnit,
                                buy.priceUsdCents,
                            ),
                            figureColor = VaultCream,
                        )
                    }
                }
            }
        }
    }
}

// ── Net Worth ───────────────────────────────────────────────────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.netWorth(
    state: VaultUiState,
    displayUnit: DisplayUnit,
) {
    val profile = state.activeProfile
    val slice = state.data.btcAccounts
    val inScope = slice.value.netWorthScopeFor(profile)
    val excluded = slice.value.visibleTo(profile).filterNot { it in inScope }
    val stackSats = inScope.sumOf { it.sats }

    item {
        KpiStrip(
            listOf(
                Kpi(
                    "Bitcoin",
                    figure(slice.suppressFigures) { state.formatBitcoin(stackSats, displayUnit) },
                ),
                Kpi(
                    "Fiat estimate",
                    figure(slice.suppressFigures) {
                        state.formatBitcoin(stackSats, DisplayUnit.USD)
                    },
                    hint = figure(slice.suppressFigures) { priceBasis(state) },
                    provenance = Provenance.ESTIMATED,
                ),
            ),
        )
    }
    item { StaleNotice(slice.status) }
    item {
        Panel("In scope", slice.source) {
            AccountList(inScope, slice.status, displayUnit, state.data.btcPriceCents)
        }
    }
    if (excluded.isNotEmpty()) {
        item {
            StatusBanner(
                "${excluded.size} account(s) visible but excluded",
                "Children's stacks are shown for oversight but never roll into adult totals.",
                tone = VaultTextMuted,
            )
        }
        item {
            Panel("Visible but excluded") {
                AccountList(excluded, slice.status, displayUnit, state.data.btcPriceCents)
            }
        }
    }
}

@Composable
private fun AccountList(
    accounts: List<BtcAccount>,
    status: Freshness,
    displayUnit: DisplayUnit,
    btcPriceCents: Long,
) {
    if (status == Freshness.ERROR || status == Freshness.LOADING) {
        StateBlock(status)
        return
    }
    if (accounts.isEmpty()) {
        StateBlock(
            Freshness.EMPTY,
            title = "No accounts in scope",
            detail = "This profile has no Bitcoin accounts counting toward its net worth.",
        )
        return
    }
    Column {
        accounts.forEachIndexed { index, account ->
            if (index > 0) HorizontalHairline()
            LedgerRow(
                primary = account.label,
                secondary = account.owner.displayName,
                figure = Money.formatBitcoin(account.sats, displayUnit, btcPriceCents),
                figureColor = VaultCream,
                badge = account.custody.label,
                badgeAccented = account.custody.key == "self_custody",
            )
        }
    }
}

private fun VaultUiState.formatBitcoin(sats: Long, unit: DisplayUnit): String =
    Money.formatBitcoin(sats, unit, data.btcPriceCents)

private fun priceBasis(state: VaultUiState): String =
    state.data.btcPriceAsOf?.let { "Last buy · $it" } ?: "No recorded price"

// ── Today ───────────────────────────────────────────────────────────────────

private const val TODAY_DATE = "2026-07-26"

/**
 * MC2's project for a todo nobody filed.
 *
 * `Todo.normalize` defaults `project` to this string, mirroring the Convex
 * emitter, so once the todo boundary is wired through the contract the read
 * model will never hand this screen a null project. "Inbox" means the absence of
 * a filing, not a project a human made, and a row that prints it verbatim reads
 * as though every unsorted task were filed. See DOMAIN_ADOPTION.md in this app's
 * package root for where the interpretation is allowed to live.
 */
private const val MC2_DEFAULT_PROJECT = "Inbox"

/** Where a todo is filed: its project, else its area, else nowhere. */
private fun filing(todo: TodoItem): String? =
    todo.project?.takeIf { it != MC2_DEFAULT_PROJECT } ?: todo.area

private fun androidx.compose.foundation.lazy.LazyListScope.today(state: VaultUiState) {
    val slice = state.data.todos
    // isDueBy is the contract's own open-and-due rule, not a re-reading of the
    // done/due fields here. This screen deliberately knows nothing about MC2's
    // field aliases — that is Todo.normalize's job, once and at the boundary.
    val todos = slice.value.visibleTo(state.activeProfile)
        .filter { it.isDueBy(TODAY_DATE) }

    item { StaleNotice(slice.status) }
    item {
        Panel("Due", slice.source) {
            if (slice.suppressFigures) {
                StateBlock(slice.status)
            } else if (todos.isEmpty()) {
                StateBlock(Freshness.EMPTY, title = "Nothing due today")
            } else {
                Column {
                    todos.forEachIndexed { index, todo ->
                        if (index > 0) HorizontalHairline()
                        LedgerRow(
                            primary = todo.title,
                            secondary = listOfNotNull(filing(todo), todo.due).joinToString(" · "),
                            figure = "",
                            badge = if (todo.flagged) "flagged" else null,
                        )
                    }
                }
            }
        }
    }
}

// ── Family ──────────────────────────────────────────────────────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.family(state: VaultUiState) {
    item {
        StatusBanner(
            "Victor and Rachel are one household",
            "They see identical finance data. Mason and Maddox are isolated and see only their own records.",
            tone = VaultTextMuted,
        )
    }
    item {
        Panel("Profiles") {
            Column {
                FamilyMember.entries.forEachIndexed { index, member ->
                    if (index > 0) HorizontalHairline()
                    LedgerRow(
                        primary = member.displayName,
                        secondary = member.profileDescription,
                        figure = if (member.isAdult) "adult" else "child",
                        figureColor = VaultTextMuted,
                        badge = if (member == state.activeProfile) "active" else null,
                        badgeAccented = member == state.activeProfile,
                    )
                }
            }
        }
    }
    item {
        Panel("Can this profile switch?", "Derived from allowedSwitchTargets") {
            Column {
                FamilyMember.entries.forEachIndexed { index, member ->
                    if (index > 0) HorizontalHairline()
                    LedgerRow(
                        primary = member.displayName,
                        figure = if (member.allowedSwitchTargets.size > 1) "all" else "self only",
                        figureColor = VaultTextMuted,
                    )
                }
            }
        }
    }
}

// ── Settings ────────────────────────────────────────────────────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.settings(
    state: VaultUiState,
    onEnableRemoteRows: (String) -> Unit,
) {
    val readsConvexRows = state.data.transactions.source.startsWith("Convex")
    item {
        if (readsConvexRows) {
            StatusBanner(
                "Convex row reads are enabled",
                "Every query is authenticated. This client remains read-only.",
                tone = VaultTextMuted,
            )
        } else {
            StatusBanner(
                stringResource(R.string.convex_rows_inactive_title),
                stringResource(R.string.convex_rows_inactive_detail),
                tone = VaultWarning,
            )
        }
    }
    state.remoteConfigurationError?.let { detail ->
        item {
            StatusBanner(
                "Could not enable Convex row reads",
                detail,
                tone = VaultWarning,
            )
        }
    }
    item { RemoteRowsConfiguration(onEnableRemoteRows) }
    item {
        Panel("Slices") {
            Column {
                listOf(
                    "transactions" to state.data.transactions.status,
                    "budget" to state.data.budget.status,
                    "btc-balance-snapshot" to state.data.btcAccounts.status,
                    "bitcoin-buys" to state.data.btcBuys.status,
                    "todos" to state.data.todos.status,
                ).forEachIndexed { index, (name, status) ->
                    if (index > 0) HorizontalHairline()
                    LedgerRow(
                        primary = name,
                        figure = status.name.lowercase(),
                        figureColor = VaultTextMuted,
                    )
                }
            }
        }
    }
    item {
        Panel(
            stringResource(R.string.legacy_compatibility_keys_title),
            stringResource(R.string.legacy_compatibility_keys_hint, MC2_FILES.size),
        ) {
            Column(Modifier.padding(VaultSpace.md)) {
                Text(
                    MC2_FILES.joinToString(", "),
                    style = MaterialTheme.typography.bodySmall,
                    color = VaultTextDim,
                )
            }
        }
    }
    item { Spacer(Modifier.height(VaultSpace.lg)) }
}

@Composable
private fun RemoteRowsConfiguration(onEnable: (String) -> Unit) {
    // Deliberately not saveable: the plaintext token must not enter saved
    // instance state. Submission immediately hands it to encrypted storage.
    var token by remember { mutableStateOf("") }
    Panel("Configure authenticated row reads") {
        Column(
            Modifier.padding(VaultSpace.md),
            verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
        ) {
            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text("Convex read token") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
            )
            Button(
                enabled = token.isNotBlank(),
                onClick = {
                    onEnable(token)
                    token = ""
                },
            ) {
                Text("Save and refresh")
            }
        }
    }
}

// ── shared ──────────────────────────────────────────────────────────────────

@Composable
private fun StaleNotice(status: Freshness) {
    if (status != Freshness.STALE) return
    StatusBanner(
        stringResource(R.string.convex_read_stale_title),
        stringResource(R.string.convex_read_stale_detail),
        tone = VaultWarning,
    )
}
