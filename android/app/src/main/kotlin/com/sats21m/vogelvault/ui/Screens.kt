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
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.BudgetSpend
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.IncomeEntry
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.budgetMonthsFor
import com.sats21m.vogelvault.domain.budgetTransactionsFor
import com.sats21m.vogelvault.domain.deriveBudgetSpend
import com.sats21m.vogelvault.domain.inMonth
import com.sats21m.vogelvault.domain.incomeAmount
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
import com.sats21m.vogelvault.ui.components.VaultLazyListScope
import com.sats21m.vogelvault.ui.components.figure
import com.sats21m.vogelvault.ui.components.vaultContent
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

private data class ScreenCollections(
    val visibleTransactions: List<Transaction>,
    val budgetTransactions: List<Transaction>,
    val netWorthAccounts: List<BtcAccount>,
    val netWorthBalance: BtcBalance?,
    val visibleAccounts: List<BtcAccount>,
    val visibleBuys: List<BtcBuy>,
    val visibleBillPays: List<BtcBillPay>,
    val incomeEntries: List<IncomeEntry>,
    val visibleTodos: List<TodoItem>,
)

private data class DashboardProjection(
    val activity: List<Transaction>,
    val accounts: List<BtcAccount>,
    val balance: BtcBalance?,
    val incomeEntries: List<IncomeEntry>,
    val spendCents: Long,
    val incomeCents: Long?,
    val openTodos: Int,
)

private data class BitcoinProjection(
    val accounts: List<BtcAccount>,
    val buys: List<BtcBuy>,
    val billPays: List<BtcBillPay>,
    val balance: BtcBalance?,
    val totalSats: Long,
    val selfCustodySats: Long,
)

private data class NetWorthProjection(
    val accounts: List<BtcAccount>,
    val excludedAccounts: List<BtcAccount>,
    val balance: BtcBalance?,
)

internal fun ReadModel.dashboardIncomeCents(viewer: FamilyMember): Long? {
    val rows = income.value.netWorthScopeFor(viewer)
    return if (incomeFiguresUnavailable || rows.isEmpty()) null else rows.sumOf { it.amountCents }
}

internal fun ReadModel.netWorthBalanceForDisplay(): BtcBalance? =
    btcBalance.value?.takeUnless { netWorthFiguresUnavailable }

internal fun ReadModel.billPaysAvailableTo(viewer: FamilyMember): Boolean =
    !billPayLedgerUnavailable && btcBillPays.value.visibleTo(viewer).isNotEmpty()

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
    val profile = state.activeProfile
    val transactionsInput = state.data.transactions.value
    val accountsInput = state.data.btcAccounts.value
    val buysInput = state.data.btcBuys.value
    val billPaysInput = state.data.btcBillPays.value
    val incomeInput = state.data.income.value
    val todosInput = state.data.todos.value
    val incomeFiguresUnavailable = state.data.incomeFiguresUnavailable
    val netWorthBalance = state.data.netWorthBalanceForDisplay()
    val months = remember(profile, transactionsInput, budgetMonth) {
        transactionsInput.budgetMonthsFor(profile, budgetMonth)
    }
    val initialMonth = remember(state.selectedMonth, months, budgetMonth) {
        resolveBudgetMonth(state.selectedMonth, months, budgetMonth)
    }
    // The Budget screen's month scope. Held here rather than in the ViewModel
    // because it is view state, and because every row of the list has to agree on
    // it — the KPI strip, the banners and the categories all read the same month.
    // Re-seeded when the profile changes or the state names a month, so a preview
    // or the design packet can render any month without driving a tap.
    var picked by rememberSaveable(state.activeProfile, state.selectedMonth) {
        mutableStateOf(initialMonth)
    }
    // A refresh can retire the picked month. Fall back rather than render a month
    // the ledger no longer contains.
    val month = resolveBudgetMonth(picked, months, budgetMonth)
    val collections = remember(
        profile,
        transactionsInput,
        accountsInput,
        buysInput,
        billPaysInput,
        incomeInput,
        todosInput,
        netWorthBalance,
    ) {
        ScreenCollections(
            visibleTransactions = transactionsInput.visibleTo(profile),
            budgetTransactions = transactionsInput.budgetTransactionsFor(profile),
            netWorthAccounts = netWorthBalance?.accounts.orEmpty(),
            netWorthBalance = netWorthBalance,
            visibleAccounts = accountsInput.visibleTo(profile),
            visibleBuys = buysInput.visibleTo(profile),
            visibleBillPays = billPaysInput.visibleTo(profile),
            incomeEntries = incomeInput.netWorthScopeFor(profile),
            visibleTodos = todosInput.visibleTo(profile),
        )
    }
    val dashboardProjection = remember(month, collections, incomeFiguresUnavailable) {
        val budgetTransactions = collections.budgetTransactions.inMonth(month ?: "")
        val activity = collections.visibleTransactions.inMonth(month ?: "").take(6)
        DashboardProjection(
            activity = activity,
            accounts = collections.netWorthAccounts,
            balance = collections.netWorthBalance,
            incomeEntries = collections.incomeEntries,
            spendCents = budgetTransactions.sumOf { it.spendAmount },
            incomeCents = collections.incomeEntries
                .takeUnless { incomeFiguresUnavailable || it.isEmpty() }
                ?.sumOf { it.amountCents },
            openTodos = collections.visibleTodos.count { !it.done },
        )
    }
    val budgetSpend = remember(state.data.budget.value, month, collections.budgetTransactions) {
        state.data.budget.value?.let { budget ->
            val scoped = if (month == null || month == budget.month) budget else budget.copy(month = month)
            deriveBudgetSpend(scoped, collections.budgetTransactions)
        }
    }
    val bitcoinProjection = remember(
        collections.netWorthAccounts,
        collections.visibleBuys,
        collections.visibleBillPays,
        collections.netWorthBalance,
    ) {
        BitcoinProjection(
            accounts = collections.netWorthAccounts,
            buys = collections.visibleBuys,
            billPays = collections.visibleBillPays,
            balance = collections.netWorthBalance,
            totalSats = collections.netWorthBalance?.totalSats ?: 0L,
            selfCustodySats = collections.netWorthBalance?.selfCustodySats ?: 0L,
        )
    }
    val netWorthProjection = remember(profile, collections.netWorthAccounts, collections.visibleAccounts) {
        NetWorthProjection(
            accounts = collections.netWorthAccounts,
            excludedAccounts = collections.visibleAccounts.filterNot {
                profile.sharesNetWorth(it.owner)
            },
            balance = collections.netWorthBalance,
        )
    }
    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(VaultSpace.md),
    ) {
        vaultContent {
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
                Destination.DASHBOARD -> dashboard(state, dashboardProjection, displayUnit)
                Destination.ACTIVITY -> activity(state, collections.visibleTransactions)
                Destination.BUDGET -> budget(state, months, budgetSpend) { picked = it }
                Destination.BITCOIN -> bitcoin(state, bitcoinProjection, displayUnit)
                Destination.NET_WORTH -> netWorth(state, netWorthProjection, displayUnit)
                Destination.TODAY -> item { TaskListsScreen(state, todosInput) }
                Destination.FAMILY -> family(state)
                Destination.SETTINGS -> settings(state, onEnableRemoteRows)
            }
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
        Destination.TODAY -> "Projects, areas and smart lists"
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

private fun VaultLazyListScope.dashboard(
    state: VaultUiState,
    projection: DashboardProjection,
    displayUnit: DisplayUnit,
) {
    val incomeUnavailable = projection.incomeCents == null
    val balanceUnavailable = projection.balance == null

    item {
        KpiStrip(
            listOf(
                Kpi(
                    "Spend",
                    figure(state.data.transactions.requiredProjectionUnavailable) {
                        Money.formatUsd(projection.spendCents)
                    },
                    tone = VaultNegative,
                ),
                Kpi(
                    "Income",
                    figure(incomeUnavailable) {
                        Money.formatUsd(requireNotNull(projection.incomeCents))
                    },
                    tone = VaultPositive,
                ),
                Kpi(
                    "Stack",
                    figure(balanceUnavailable) {
                        state.formatBalance(requireNotNull(projection.balance), displayUnit)
                    },
                    hint = figure(balanceUnavailable) {
                        if (displayUnit == DisplayUnit.USD) {
                            balanceSnapshotBasis(requireNotNull(projection.balance))
                        } else {
                            state.formatBalance(requireNotNull(projection.balance), DisplayUnit.USD)
                        }
                    },
                ),
                Kpi(
                    "Open tasks",
                    figure(state.data.todos.suppressFigures) {
                        projection.openTodos.toString()
                    },
                ),
            ),
        )
    }
    item { StaleNotice(state.data.transactions.status) }
    if (state.data.transactions.suppressFigures) {
        item {
            Panel("Recent activity", state.data.transactions.source) {
                StateBlock(state.data.transactions.status)
            }
        }
    } else if (projection.activity.isEmpty()) {
        item {
            Panel("Recent activity", state.data.transactions.source) {
                StateBlock(Freshness.EMPTY)
            }
        }
    } else {
        keyedPanel(
            sectionKey = "dashboard-activity",
            title = "Recent activity",
            source = state.data.transactions.source,
            rows = projection.activity,
            rowKey = Transaction::id,
            rowContent = { TransactionRow(it) },
        )
    }
    if (incomeUnavailable) {
        item {
            Panel("Income", state.data.income.source) {
                StateBlock(state.data.income.status)
            }
        }
    } else {
        keyedPanel(
            sectionKey = "dashboard-income",
            title = "Income",
            source = state.data.income.source,
            rows = projection.incomeEntries.take(6),
            rowKey = IncomeEntry::id,
        ) { entry ->
            LedgerRow(
                primary = entry.sourceName,
                secondary = entry.date,
                figure = Money.formatUsd(entry.amountCents),
                figureColor = VaultPositive,
            )
        }
    }
    accountList(
        sectionKey = "dashboard-bitcoin",
        title = "Bitcoin",
        source = state.data.btcBalance.source,
        accounts = projection.accounts,
        status = state.data.btcBalance.status,
        displayUnit = displayUnit,
        btcPriceCents = state.data.btcPriceCents,
    )
}

// ── Activity ────────────────────────────────────────────────────────────────

private fun VaultLazyListScope.activity(
    state: VaultUiState,
    transactions: List<Transaction>,
) {
    item { StaleNotice(state.data.transactions.status) }
    if (state.data.transactions.suppressFigures) {
        item { Panel { StateBlock(state.data.transactions.status) } }
        return
    }
    if (transactions.isEmpty()) {
        item { Panel { StateBlock(Freshness.EMPTY) } }
        return
    }
    keyedPanel(
        sectionKey = "activity-transactions",
        title = "${transactions.size} records",
        source = state.data.transactions.source,
        rows = transactions,
        rowKey = Transaction::id,
        rowContent = { TransactionRow(it) },
    )
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

private fun VaultLazyListScope.budget(
    state: VaultUiState,
    months: List<String>,
    spend: BudgetSpend?,
    onSelectMonth: (String) -> Unit,
) {
    val slice = state.data.budget
    val budget = slice.value
    // Spend is DERIVED from the scoped month's transactions, never read from the
    // reported category total: a July budget counts only July transactions.
    // Matches what iOS has always done (BudgetView.monthTransactions).
    //
    // The compatibility budget document carries the current
    // month's targets, so an earlier month reuses those targets and re-derives
    // its own actuals. The banner below says so rather than letting the planned
    // column imply Convex stored a June budget.
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
    val plannedUnavailable = slice.requiredProjectionUnavailable
    val actualsUnavailable =
        plannedUnavailable || state.data.transactions.requiredProjectionUnavailable
    val actualsStatus =
        if (plannedUnavailable) slice.status else state.data.transactions.status

    // Hidden when the read failed: the month list is derived from the same
    // transactions the screen has just been told not to trust, so offering a
    // choice between them would be a control over nothing. One month is not a
    // choice either — a lone chip reads as a button that does nothing.
    val pickable = months.size > 1 && !actualsUnavailable
    if (pickable) {
        item { MonthPicker(months, derived.month, onSelectMonth) }
    }

    item {
        KpiStrip(
            listOf(
                Kpi("Planned", figure(plannedUnavailable) { Money.formatUsd(derived.plannedCents) }, provenance = Provenance.PLANNED),
                Kpi("Actual", figure(actualsUnavailable) { Money.formatUsd(derived.actualCents) }),
                Kpi(
                    "Remaining",
                    figure(actualsUnavailable) { Money.formatUsd(derived.remainingCents) },
                    tone = if (derived.remainingCents < 0L) VaultNegative else VaultPositive,
                ),
                Kpi(
                    "Over budget",
                    figure(actualsUnavailable) { derived.overBudgetCount.toString() },
                    hint = if (derived.overBudgetCount == 1) "1 category" else "${derived.overBudgetCount} categories",
                    tone = if (derived.overBudgetCount > 0) VaultNegative else null,
                ),
            ),
        )
    }
    item { StaleNotice(slice.status) }
    if (derived.month != budget.month && !actualsUnavailable) {
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
    if (derived.uncategorisedCents > 0L && !actualsUnavailable) {
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
    if (actualsUnavailable) {
        item {
            Panel("Categories", "${slice.source} · ${derived.month} transactions") {
                StateBlock(actualsStatus)
            }
        }
    } else {
        keyedPanel(
            sectionKey = "budget-categories",
            title = "Categories",
            source = "${slice.source} · ${derived.month} transactions",
            rows = derived.categories,
            rowKey = { it.name },
        ) { category ->
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
 * A fixed table rather than a date formatter: ledger month keys are already
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

private fun VaultLazyListScope.bitcoin(
    state: VaultUiState,
    projection: BitcoinProjection,
    displayUnit: DisplayUnit,
) {
    val slice = state.data.btcBalance
    val unavailable = projection.balance == null

    item {
        KpiStrip(
            listOf(
                Kpi(
                    "Total stack",
                    figure(unavailable) {
                        state.formatBalance(requireNotNull(projection.balance), displayUnit)
                    },
                ),
                Kpi(
                    "Reference price",
                    figure(unavailable) {
                        state.data.btcPriceCents
                            .takeIf { it > 0L }
                            ?.let { Money.formatUsd(it) }
                            ?: Money.PRICE_UNAVAILABLE
                    },
                    hint = figure(unavailable) { priceBasis(state) },
                    provenance = Provenance.ESTIMATED,
                ),
                Kpi(
                    "Self custody",
                    figure(unavailable) {
                        "${Money.basisPoints(projection.selfCustodySats, projection.totalSats) / 100}%"
                    },
                    hint = figure(unavailable) {
                        state.formatBitcoin(projection.selfCustodySats, displayUnit)
                    },
                ),
                Kpi(
                    "Accounts",
                    figure(unavailable) { projection.accounts.size.toString() },
                ),
            ),
        )
    }
    item { StaleNotice(slice.status) }
    accountList(
        sectionKey = "bitcoin-accounts",
        title = "Accounts in net worth",
        source = slice.source,
        accounts = projection.accounts,
        status = slice.status,
        displayUnit = displayUnit,
        btcPriceCents = state.data.btcPriceCents,
    )
    if (state.data.btcBuys.suppressFigures) {
        item {
            Panel("Recent buys", state.data.btcBuys.source) {
                StateBlock(state.data.btcBuys.status)
            }
        }
    } else if (projection.buys.isEmpty()) {
        item {
            Panel("Recent buys", state.data.btcBuys.source) {
                StateBlock(Freshness.EMPTY)
            }
        }
    } else {
        keyedPanel(
            sectionKey = "bitcoin-buys",
            title = "Recent buys",
            source = state.data.btcBuys.source,
            rows = projection.buys,
            rowKey = BtcBuy::id,
        ) { buy ->
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
    if (!state.data.billPaysAvailableTo(state.activeProfile)) {
        item {
            Panel("Bitcoin bill pays", state.data.btcBillPays.source) {
                StateBlock(state.data.btcBillPays.status)
            }
        }
    } else {
        keyedPanel(
            sectionKey = "bitcoin-bill-pays",
            title = "Bitcoin bill pays",
            source = state.data.btcBillPays.source,
            rows = projection.billPays,
            rowKey = BtcBillPay::id,
        ) { payment ->
            LedgerRow(
                primary = payment.merchant,
                secondary = "${payment.date} · ${payment.category}",
                figure = "-${Money.formatUsd(payment.amountUsdCents)}",
                figureColor = VaultNegative,
                badge = payment.platform,
            )
        }
    }
}

// ── Net Worth ───────────────────────────────────────────────────────────────

private fun VaultLazyListScope.netWorth(
    state: VaultUiState,
    projection: NetWorthProjection,
    displayUnit: DisplayUnit,
) {
    val slice = state.data.btcBalance
    val unavailable = projection.balance == null

    item {
        KpiStrip(
            listOf(
                Kpi(
                    "Bitcoin",
                    figure(unavailable) {
                        state.formatBalance(requireNotNull(projection.balance), displayUnit)
                    },
                ),
                Kpi(
                    "Fiat estimate",
                    figure(unavailable) {
                        Money.formatUsd(requireNotNull(projection.balance).fiatCents)
                    },
                    hint = figure(unavailable) {
                        balanceSnapshotBasis(requireNotNull(projection.balance))
                    },
                ),
            ),
        )
    }
    item { StaleNotice(slice.status) }
    accountList(
        sectionKey = "net-worth-in-scope",
        title = "In scope",
        source = slice.source,
        accounts = projection.accounts,
        status = slice.status,
        displayUnit = displayUnit,
        btcPriceCents = state.data.btcPriceCents,
    )
    if (projection.excludedAccounts.isNotEmpty()) {
        item {
            StatusBanner(
                "${projection.excludedAccounts.size} account(s) visible but excluded",
                "Children's stacks are shown for oversight but never roll into adult totals.",
                tone = VaultTextMuted,
            )
        }
        accountList(
            sectionKey = "net-worth-excluded",
            title = "Visible but excluded",
            source = null,
            accounts = projection.excludedAccounts,
            status = slice.status,
            displayUnit = displayUnit,
            btcPriceCents = state.data.btcPriceCents,
        )
    }
}

private fun VaultLazyListScope.accountList(
    sectionKey: String,
    title: String,
    source: String?,
    accounts: List<BtcAccount>,
    status: Freshness,
    displayUnit: DisplayUnit,
    btcPriceCents: Long,
) {
    if (status == Freshness.ERROR || status == Freshness.LOADING) {
        item {
            Panel(title, source) {
                StateBlock(status)
            }
        }
        return
    }
    if (accounts.isEmpty()) {
        item {
            Panel(title, source) {
                StateBlock(
                    Freshness.EMPTY,
                    title = "No accounts in scope",
                    detail = "This profile has no Bitcoin accounts counting toward its net worth.",
                )
            }
        }
        return
    }
    keyedPanel(
        sectionKey = sectionKey,
        title = title,
        source = source,
        rows = accounts,
        rowKey = { "${it.owner.key}:${it.key}" },
    ) { account ->
        LedgerRow(
            primary = account.label,
            secondary = account.owner.displayName,
            figure = if (displayUnit == DisplayUnit.USD) {
                Money.formatUsd(account.fiatCents)
            } else {
                Money.formatBitcoin(account.sats, displayUnit, btcPriceCents)
            },
            figureColor = VaultCream,
            badge = account.custody.label,
            badgeAccented = account.custody.key == "self_custody",
        )
    }
}

private fun VaultUiState.formatBitcoin(sats: Long, unit: DisplayUnit): String =
    Money.formatBitcoin(sats, unit, data.btcPriceCents)

private fun VaultUiState.formatBalance(balance: BtcBalance, unit: DisplayUnit): String =
    if (unit == DisplayUnit.USD) {
        Money.formatUsd(balance.fiatCents)
    } else {
        Money.formatBitcoin(balance.totalSats, unit, data.btcPriceCents)
    }

private fun balanceSnapshotBasis(balance: BtcBalance): String = "Snapshot · ${balance.asOf}"

private fun priceBasis(state: VaultUiState): String =
    state.data.btcPriceAsOf?.let { "Last buy · $it" } ?: "No recorded price"

// ── Today ───────────────────────────────────────────────────────────────────

/**
 * The canonical project for a todo nobody filed.
 *
 * `Todo.normalize` defaults `project` to this string, mirroring the Convex
 * emitter, so once the todo boundary is wired through the contract the read
 * model will never hand this screen a null project. "Inbox" means the absence of
 * a filing, not a project a human made, and a row that prints it verbatim reads
 * as though every unsorted task were filed. See DOMAIN_ADOPTION.md in this app's
 * package root for where the interpretation is allowed to live.
 */
private const val UNFILED_TODO_PROJECT = "Inbox"

/** Where a todo is filed: its project, else its area, else nowhere. */
private fun filing(todo: TodoItem): String? =
    todo.project?.takeIf { it != UNFILED_TODO_PROJECT } ?: todo.area

private fun VaultLazyListScope.today(
    state: VaultUiState,
    todos: List<TodoItem>,
) {
    val slice = state.data.todos

    item { StaleNotice(slice.status) }
    if (slice.suppressFigures) {
        item {
            Panel("Due", slice.source) {
                StateBlock(slice.status)
            }
        }
    } else if (todos.isEmpty()) {
        item {
            Panel("Due", slice.source) {
                StateBlock(Freshness.EMPTY, title = "Nothing due today")
            }
        }
    } else {
        keyedPanel(
            sectionKey = "today-due",
            title = "Due",
            source = slice.source,
            rows = todos,
            rowKey = TodoItem::id,
        ) { todo ->
            LedgerRow(
                primary = todo.title,
                secondary = listOfNotNull(filing(todo), todo.due).joinToString(" · "),
                figure = "",
                badge = if (todo.flagged) "flagged" else null,
            )
        }
    }
}

// ── Family ──────────────────────────────────────────────────────────────────

private fun VaultLazyListScope.family(state: VaultUiState) {
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

private fun VaultLazyListScope.settings(
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
    item { Spacer(Modifier.height(VaultSpace.lg)) }
}

@Composable
private fun RemoteRowsConfiguration(onEnable: (String) -> Unit) {
    // Deliberately not saveable: the plaintext token must not enter saved
    // instance state. Submission immediately hands it to encrypted storage.
    var token by remember { mutableStateOf("") }
    val application =
        androidx.compose.ui.platform.LocalContext.current.applicationContext
            as? com.sats21m.vogelvault.VaultApplication
    val storedConfigSource =
        remember(application) {
            application?.let { com.sats21m.vogelvault.data.SecureConvexConfigSource(it) }
        }
    var hasStoredToken by remember(storedConfigSource) {
        mutableStateOf(storedConfigSource?.current()?.hasReadToken == true)
    }
    var removalFailed by remember { mutableStateOf(false) }

    Panel("Configure authenticated row reads") {
        Column(
            Modifier.padding(VaultSpace.md),
            verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
        ) {
            Text(
                text =
                    stringResource(
                        if (hasStoredToken) {
                            R.string.convex_read_token_configured
                        } else {
                            R.string.convex_read_token_unconfigured
                        },
                    ),
                color = VaultTextDim,
                style = MaterialTheme.typography.bodySmall,
            )
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
                    hasStoredToken = storedConfigSource?.current()?.hasReadToken == true
                    removalFailed = false
                    token = ""
                },
            ) {
                Text("Save and refresh")
            }
            if (hasStoredToken && storedConfigSource != null && application != null) {
                androidx.compose.material3.OutlinedButton(
                    onClick = {
                        runCatching {
                            clearRemoteRowsConfiguration(
                                stored = storedConfigSource,
                                effective = application.convexConfigSource,
                            )
                        }.onSuccess {
                            token = ""
                            hasStoredToken = false
                            removalFailed = false
                        }.onFailure {
                            removalFailed = true
                        }
                    },
                    border =
                        androidx.compose.foundation.BorderStroke(
                            width = 1.dp,
                            color = VaultLine,
                        ),
                    colors =
                        androidx.compose.material3.ButtonDefaults.outlinedButtonColors(
                            contentColor = VaultCream,
                        ),
                ) {
                    Text(stringResource(R.string.convex_read_token_remove))
                }
            }
            if (removalFailed) {
                Text(
                    text = stringResource(R.string.convex_read_token_remove_failed),
                    color = VaultWarning,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

internal fun clearRemoteRowsConfiguration(
    stored: com.sats21m.vogelvault.data.SecureConvexConfigSource,
    effective: com.sats21m.vogelvault.data.MutableConvexConfigSource,
) {
    stored.clear()
    effective.update(com.sats21m.vogelvault.data.ConvexConfig())
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
