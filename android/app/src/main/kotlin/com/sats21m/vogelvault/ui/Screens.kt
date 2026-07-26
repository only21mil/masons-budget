package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.MC2_FILES
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.deriveBudgetSpend
import com.sats21m.vogelvault.domain.inMonth
import com.sats21m.vogelvault.domain.incomeAmount
import com.sats21m.vogelvault.domain.isDueBy
import com.sats21m.vogelvault.domain.monthsPresent
import com.sats21m.vogelvault.domain.netWorthScopeFor
import com.sats21m.vogelvault.domain.spendAmount
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
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultPositive
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import com.sats21m.vogelvault.ui.theme.VaultTextMuted
import com.sats21m.vogelvault.ui.theme.VaultWarning

@Composable
fun ScreenHost(destination: Destination, state: VaultUiState, modifier: Modifier = Modifier) {
    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(VaultSpace.md),
        verticalArrangement = Arrangement.spacedBy(VaultSpace.md),
    ) {
        item { ScreenHeader(destination, state) }
        when (destination) {
            Destination.DASHBOARD -> dashboard(state)
            Destination.ACTIVITY -> activity(state)
            Destination.BUDGET -> budget(state)
            Destination.BITCOIN -> bitcoin(state)
            Destination.NET_WORTH -> netWorth(state)
            Destination.TODAY -> today(state)
            Destination.FAMILY -> family(state)
            Destination.SETTINGS -> settings(state)
        }
    }
}

@Composable
private fun ScreenHeader(destination: Destination, state: VaultUiState) {
    val subtitle = when (destination) {
        Destination.DASHBOARD ->
            if (state.activeProfile.isAdult) "Household command center"
            else "${state.activeProfile.displayName}'s money"
        Destination.ACTIVITY -> "Transactions visible to this profile"
        Destination.BUDGET -> state.data.budget.value?.month ?: "No budget"
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
        Text(subtitle, style = MaterialTheme.typography.bodySmall, color = VaultTextMuted)
    }
}

// ── Dashboard ───────────────────────────────────────────────────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.dashboard(state: VaultUiState) {
    val profile = state.activeProfile
    val visible = state.data.transactions.value.visibleTo(profile)
    // Scoped to the budget's month so the headline agrees with the Budget
    // screen. An all-time total beside a monthly budget is just confusing.
    val month = state.data.budget.value?.month ?: visible.monthsPresent().firstOrNull() ?: ""
    val transactions = visible.inMonth(month)
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
                    figure(state.data.btcAccounts.suppressFigures) { Money.formatBtc(stackSats) },
                    hint = figure(state.data.btcAccounts.suppressFigures) {
                        Money.formatUsd(Money.satsToUsdCents(stackSats, state.data.btcPriceCents))
                    },
                    tone = VaultAccent,
                ),
                Kpi("Open tasks", figure(state.data.todos.suppressFigures) { openTodos.toString() }),
            ),
        )
    }
    item { StaleNotice(state.data.transactions.status) }
    item {
        Panel("Recent activity", state.data.transactions.source) {
            if (state.data.transactions.status != Freshness.LIVE && state.data.transactions.status != Freshness.STALE) {
                StateBlock(state.data.transactions.status)
            } else if (transactions.isEmpty()) {
                StateBlock(Freshness.EMPTY)
            } else {
                Column {
                    transactions.take(6).forEachIndexed { index, transaction ->
                        if (index > 0) HorizontalHairline()
                        TransactionRow(transaction)
                    }
                }
            }
        }
    }
    item {
        Panel("Bitcoin", state.data.btcAccounts.source) {
            AccountList(accounts, state.data.btcAccounts.status)
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
    // Colour by spend/income semantics, never by the raw sign: adult files sign
    // spending negative, child files store a positive magnitude, so the sign alone
    // renders a child's spending as income.
    val spend = transaction.spendAmount
    val isSpend = spend > 0L
    LedgerRow(
        primary = transaction.merchant,
        secondary = "${transaction.date} · ${transaction.category}",
        figure = if (isSpend) "-${Money.formatUsd(spend)}" else Money.formatUsd(transaction.incomeAmount),
        figureColor = if (isSpend) VaultNegative else VaultPositive,
    )
}

// ── Budget ──────────────────────────────────────────────────────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.budget(state: VaultUiState) {
    val slice = state.data.budget
    val budget = slice.value
    // Spend is DERIVED from this month's transactions, never read from the
    // reported category total: a July budget counts only July transactions.
    // Matches what iOS has always done (BudgetView.monthTransactions).
    val spend = budget?.let {
        deriveBudgetSpend(it, state.data.transactions.value.visibleTo(state.activeProfile))
    }

    if (budget == null) {
        item {
            Panel {
                StateBlock(
                    if (slice.status == Freshness.LIVE) Freshness.EMPTY else slice.status,
                    title = if (slice.status == Freshness.LIVE) "No budget for this profile" else null,
                    detail = if (slice.status == Freshness.LIVE) {
                        "This profile has no dedicated budget file in MC2."
                    } else {
                        null
                    },
                )
            }
        }
        return
    }

    val derived = spend ?: return
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

// ── Bitcoin ─────────────────────────────────────────────────────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.bitcoin(state: VaultUiState) {
    val profile = state.activeProfile
    val slice = state.data.btcAccounts
    val inScope = slice.value.netWorthScopeFor(profile)
    val totalSats = inScope.sumOf { it.sats }
    val selfCustody = inScope.filter { it.custody.key == "self_custody" }.sumOf { it.sats }

    item {
        KpiStrip(
            listOf(
                Kpi("Total stack", figure(slice.suppressFigures) { Money.formatBtc(totalSats) }, tone = VaultAccent),
                Kpi(
                    "Value",
                    figure(slice.suppressFigures) { Money.formatUsd(Money.satsToUsdCents(totalSats, state.data.btcPriceCents)) },
                    provenance = Provenance.ESTIMATED,
                ),
                Kpi(
                    "Self custody",
                    figure(slice.suppressFigures) { "${Money.basisPoints(selfCustody, totalSats) / 100}%" },
                    hint = figure(slice.suppressFigures) { Money.formatSats(selfCustody) },
                ),
                Kpi("Accounts", figure(slice.suppressFigures) { inScope.size.toString() }),
            ),
        )
    }
    item { StaleNotice(slice.status) }
    item {
        Panel("Accounts in net worth", slice.source) { AccountList(inScope, slice.status) }
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
                            figure = Money.formatSats(buy.sats),
                            figureColor = VaultCream,
                        )
                    }
                }
            }
        }
    }
}

// ── Net Worth ───────────────────────────────────────────────────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.netWorth(state: VaultUiState) {
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
                    figure(slice.suppressFigures) { Money.formatUsd(Money.satsToUsdCents(stackSats, state.data.btcPriceCents)) },
                    tone = VaultAccent,
                    provenance = Provenance.ESTIMATED,
                ),
                Kpi("Stack", figure(slice.suppressFigures) { Money.formatBtc(stackSats) }),
            ),
        )
    }
    item { StaleNotice(slice.status) }
    item { Panel("In scope", slice.source) { AccountList(inScope, slice.status) } }
    if (excluded.isNotEmpty()) {
        item {
            StatusBanner(
                "${excluded.size} account(s) visible but excluded",
                "Children's stacks are shown for oversight but never roll into adult totals.",
                tone = VaultTextMuted,
            )
        }
        item {
            Panel("Visible but excluded") { AccountList(excluded, slice.status) }
        }
    }
}

@Composable
private fun AccountList(accounts: List<BtcAccount>, status: Freshness) {
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
                figure = Money.formatSats(account.sats),
                figureColor = VaultCream,
                badge = account.custody.label,
                badgeAccented = account.custody.key == "self_custody",
            )
        }
    }
}

// ── Today ───────────────────────────────────────────────────────────────────

private const val TODAY_DATE = "2026-07-26"

private fun androidx.compose.foundation.lazy.LazyListScope.today(state: VaultUiState) {
    val slice = state.data.todos
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
                            secondary = listOfNotNull(todo.project ?: todo.area, todo.due).joinToString(" · "),
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

private fun androidx.compose.foundation.lazy.LazyListScope.settings(state: VaultUiState) {
    item {
        StatusBanner(
            "This build reads sanitized fixtures",
            "No live Convex connection, no writeback, no network permission. Figures are sample data.",
            tone = VaultWarning,
        )
    }
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
        Panel("Known MC2 files", "${MC2_FILES.size} in the read model") {
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

// ── shared ──────────────────────────────────────────────────────────────────

@Composable
private fun StaleNotice(status: Freshness) {
    if (status != Freshness.STALE) return
    StatusBanner(
        "These figures are stale",
        "The bridge has not refreshed recently. Do not act on these numbers until sync is healthy.",
        tone = VaultWarning,
    )
}
