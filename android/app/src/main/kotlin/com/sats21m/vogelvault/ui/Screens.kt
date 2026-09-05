package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.MaterialTheme
import com.sats21m.vogelvault.ui.components.LedgerTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.BillPayBudgetEffect
import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.BudgetSpend
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.IncomeEntry
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.budgetCategoryTransactionsFor
import com.sats21m.vogelvault.domain.budgetBillPaysFor
import com.sats21m.vogelvault.domain.budgetCategoryBillPaysFor
import com.sats21m.vogelvault.domain.budgetMonthsFor
import com.sats21m.vogelvault.domain.budgetTransactionsFor
import com.sats21m.vogelvault.domain.deriveBudgetSpend
import com.sats21m.vogelvault.domain.inMonth
import com.sats21m.vogelvault.domain.incomeAmount
import com.sats21m.vogelvault.domain.isSpend
import com.sats21m.vogelvault.domain.netWorthScopeFor
import com.sats21m.vogelvault.domain.resolveBudgetMonth
import com.sats21m.vogelvault.domain.todosFor
import com.sats21m.vogelvault.domain.visibleTo
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
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.LocalLedgerEffects
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.withLedgerPhosphorGlow

private data class ScreenCollections(
    val visibleTransactions: List<Transaction>,
    val budgetTransactions: List<Transaction>,
    val netWorthAccounts: List<BtcAccount>,
    val netWorthBalance: BtcBalance?,
    val visibleAccounts: List<BtcAccount>,
    val visibleBuys: List<BtcBuy>,
    val visibleBillPays: List<BtcBillPay>,
    val visibleTodos: List<TodoItem>,
)

internal const val BITCOIN_UNIT_TOGGLE_TEST_TAG = "bitcoin-unit-toggle"

internal data class DashboardProjection(
    val activity: List<Transaction>,
    val accounts: List<BtcAccount>,
    val balance: BtcBalance?,
    val incomeEntries: List<IncomeEntry>,
    val spendCents: Long?,
    val incomeCents: Long?,
    val openTodos: Int,
)

private data class BitcoinProjection(
    val accounts: List<BtcAccount>,
    val transferAccounts: List<BtcAccount>,
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

internal data class BudgetCategoryDrilldownScope(
    val month: String,
    val category: String,
)

internal fun ReadModel.dashboardIncomeEntries(
    viewer: FamilyMember,
    month: String?,
): List<IncomeEntry> =
    month?.let { selected ->
        income.value.netWorthScopeFor(viewer).filter { it.month == selected }
    }.orEmpty()

internal fun ReadModel.dashboardIncomeCents(
    viewer: FamilyMember,
    month: String?,
): Long? {
    val rows = dashboardIncomeEntries(viewer, month)
    return if (incomeFiguresUnavailable || rows.isEmpty()) null else rows.sumLongOrNull { it.amountCents }
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
    onRemoteRowsConnected: () -> Unit = {},
    onWriteSucceeded: () -> Unit = {},
    onStartRiverBillPay: (BillPayPrefill) -> Unit = {},
    displayUnit: DisplayUnit = DisplayUnit.BTC,
    onDisplayUnitChange: (DisplayUnit) -> Unit = {},
    ledgerSettings: LedgerUiSettings = LedgerUiSettings(),
    onLedgerSettingsChange: (LedgerUiSettings) -> Unit = {},
    modifier: Modifier = Modifier,
    taskListsContent: @Composable (VaultUiState, List<TodoItem>) -> Unit = { taskState, todos ->
        TaskListsScreen(
            state = taskState,
            todos = todos,
            onWriteSucceeded = onWriteSucceeded,
        )
    },
) {
    val ledgerTokens = LocalLedgerTheme.current
    var addingTransaction by rememberSaveable { mutableStateOf(false) }
    var incomeBitcoinBuySeed by remember(state.activeProfile) { mutableStateOf<IncomeEntry?>(null) }
    var selectedTransactionKey by rememberSaveable(state.activeProfile) {
        mutableStateOf<String?>(null)
    }
    // The write surface owns its own client, per the house write pattern: nothing
    // threads suspend write callbacks through MainActivity -> VaultApp -> ScreenHost.
    val vaultApplication = LocalContext.current.applicationContext as? VaultApplication
    val remoteReadReady by
        vaultApplication?.effectiveReadReady?.collectAsStateWithLifecycle()
            ?: remember { mutableStateOf(false) }
    val transactionActions = remember(vaultApplication) { vaultApplication?.transactionActions }
    val budgetMonth = state.data.budget.value?.month
    val profile = state.activeProfile
    val transactionsInput = state.data.transactions.value
    val accountsInput = state.data.btcAccounts.value
    val buysInput = state.data.btcBuys.value
    val billPaysInput = state.data.btcBillPays.value
    val budgetBillPays = remember(profile, billPaysInput) {
        billPaysInput.budgetBillPaysFor(profile)
    }
    val incomeInput = state.data.income.value
    val todosInput = state.data.todos.value
    val incomeFiguresUnavailable = state.data.incomeFiguresUnavailable
    val netWorthBalance = state.data.netWorthBalanceForDisplay()
    val btcBuysTitle = stringResource(R.string.btc_buys_screen_title)
    val btcBillPaysTitle = stringResource(R.string.btc_bill_pays_screen_title)
    val months = remember(profile, transactionsInput, billPaysInput, budgetMonth) {
        transactionsInput.budgetMonthsFor(profile, budgetMonth, billPaysInput)
    }
    val initialMonth = remember(state.selectedMonth, months, budgetMonth) {
        resolveBudgetMonth(state.selectedMonth, months, budgetMonth)
    }
    // Dashboard MTD follows the canonical seeded/current month. Budget owns a
    // separate live picker, matching iOS where BudgetView's month offset cannot
    // silently change DashboardView's current-month figures.
    val dashboardMonth = initialMonth
    // The Budget screen's month scope. Held here rather than in the ViewModel
    // because it is view state, and because every row of the list has to agree on
    // it — the KPI strip, the banners and the categories all read the same month.
    // Re-seeded when the profile changes or the state names a month, so a preview
    // or the design packet can render any month without driving a tap.
    var picked by rememberSaveable(state.activeProfile, state.selectedMonth) {
        mutableStateOf(initialMonth)
    }
    var budgetEditor by remember(state.activeProfile) { mutableStateOf<BudgetCategoryEditorSeed?>(null) }
    var budgetDrilldownMonth by rememberSaveable(state.activeProfile) { mutableStateOf<String?>(null) }
    var budgetDrilldownCategory by rememberSaveable(state.activeProfile) { mutableStateOf<String?>(null) }
    var showBtcBuyEditor by rememberSaveable { mutableStateOf(false) }
    var showBtcBillPayEditor by rememberSaveable { mutableStateOf(false) }
    var showBtcTransferEditor by rememberSaveable { mutableStateOf(false) }
    var btcBillPayPrefill by remember(state.activeProfile) { mutableStateOf<BillPayPrefill?>(null) }
    // A refresh can retire the picked month. Fall back rather than render a month
    // the ledger no longer contains.
    val budgetSelectedMonth = resolveBudgetMonth(picked, months, budgetMonth)
    val collections = remember(
        profile,
        transactionsInput,
        accountsInput,
        buysInput,
        billPaysInput,
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
            visibleTodos = todosInput.todosFor(profile),
        )
    }
    val activitySearch = if (destination == Destination.ACTIVITY) {
        rememberActivitySearchProjection(
            transactions = collections.visibleTransactions,
            profile = state.activeProfile,
        )
    } else {
        null
    }
    val dashboardIncomeEntries = remember(profile, dashboardMonth, incomeInput) {
        state.data.dashboardIncomeEntries(profile, dashboardMonth)
    }
    val dashboardProjection = remember(dashboardMonth, collections, dashboardIncomeEntries, incomeFiguresUnavailable) {
        val budgetTransactions = collections.budgetTransactions.inMonth(dashboardMonth ?: "")
        val activity = collections.visibleTransactions.inMonth(dashboardMonth ?: "").take(6)
        DashboardProjection(
            activity = activity,
            accounts = collections.netWorthAccounts,
            balance = collections.netWorthBalance,
            incomeEntries = dashboardIncomeEntries,
            spendCents = budgetTransactions.sumLongOrNull { it.spendAmount },
            incomeCents = state.data.dashboardIncomeCents(profile, dashboardMonth),
            openTodos = collections.visibleTodos.count { !it.done },
        )
    }
    val budgetSpend = remember(
        state.data.budget.value,
        budgetSelectedMonth,
        collections.budgetTransactions,
        billPaysInput,
        profile,
    ) {
        state.data.budget.value?.let { budget ->
            val scoped =
                if (budgetSelectedMonth == null || budgetSelectedMonth == budget.month) {
                    budget
                } else {
                    budget.copy(month = budgetSelectedMonth)
                }
            deriveBudgetSpend(
                scoped,
                collections.budgetTransactions,
                budgetBillPays,
            )
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
            transferAccounts = collections.visibleAccounts,
            buys = collections.visibleBuys,
            billPays = collections.visibleBillPays,
            balance = collections.netWorthBalance,
            totalSats = collections.netWorthBalance?.totalSats ?: 0L,
            selfCustodySats = collections.netWorthBalance?.selfCustodySats ?: 0L,
        )
    }

    if (addingTransaction) {
        AddTransactionSheet(
            state = state,
            onDismiss = { addingTransaction = false },
            allowIncomeBitcoinBuy = destination == Destination.BUDGET,
            onOpenIncomeBitcoinBuy = { income ->
                addingTransaction = false
                incomeBitcoinBuySeed = income
            },
            onStartRiverBillPay = { prefill ->
                addingTransaction = false
                btcBillPayPrefill = prefill
                showBtcBillPayEditor = true
                onStartRiverBillPay(prefill)
            },
        )
    }
    incomeBitcoinBuySeed?.let { income ->
        BtcBuyFromIncomeEntrySheet(
            viewer = state.activeProfile,
            income = income,
            onDismiss = { incomeBitcoinBuySeed = null },
            onWriteSucceeded = onWriteSucceeded,
        )
    }

    // Today is the one destination that edits rows rather than listing them, so it
    // owns its own scaffold, snackbar and scrolling list, and renders instead of the
    // shared ledger column rather than inside it. It reaches the write transport
    // itself; nothing about writing passes through this shell.
    if (destination == Destination.TODAY) {
        key(state.activeProfile) {
            TodoScreen(
                state = state,
                onWriteSucceeded = onWriteSucceeded,
                modifier = modifier,
            )
        }
        return
    }

    Column(modifier.fillMaxWidth()) {
        ScreenActionBar(
            destination = destination,
            displayUnit = displayUnit,
            onDisplayUnitChange = onDisplayUnitChange,
            onAddTransaction = { addingTransaction = true },
        )
        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(ledgerTokens.density.screenGutter),
        ) {
            vaultContent {
            item {
                ScreenHeader(destination, state, budgetSelectedMonth)
            }
            when (destination) {
                Destination.DASHBOARD -> dashboard(state, dashboardProjection, displayUnit)
                Destination.ACTIVITY -> {
                    activity(state, checkNotNull(activitySearch), displayUnit) {
                        selectedTransactionKey = it.selectionKey
                    }
                }
                Destination.BUDGET -> {
                    val drilldownScope =
                        budgetDrilldownMonth?.let { selectedMonth ->
                            budgetDrilldownCategory?.let { category ->
                                BudgetCategoryDrilldownScope(selectedMonth, category)
                            }
                        }
                    if (drilldownScope == null) {
                        budget(
                            state,
                            months,
                            budgetSpend,
                            onSelectMonth = { picked = it },
                            onEditCategory = { budgetEditor = it },
                            onOpenCategory = { scope ->
                                budgetDrilldownMonth = scope.month
                                budgetDrilldownCategory = scope.category
                            },
                        )
                    } else {
                        budgetCategoryDrilldown(
                            state = state,
                            scope = drilldownScope,
                            transactions =
                                transactionsInput.budgetCategoryTransactionsFor(
                                    viewer = state.activeProfile,
                                    month = drilldownScope.month,
                                    category = drilldownScope.category,
                                ),
                            billPays =
                                billPaysInput.budgetCategoryBillPaysFor(
                                    viewer = state.activeProfile,
                                    month = drilldownScope.month,
                                    category = drilldownScope.category,
                                ),
                            onBack = {
                                budgetDrilldownMonth = null
                                budgetDrilldownCategory = null
                            },
                            onSelectTransaction = { selectedTransactionKey = it.selectionKey },
                        )
                    }
                }
                Destination.BITCOIN ->
                    bitcoin(
                        state,
                        bitcoinProjection,
                        displayUnit,
                        onAddBuy = { showBtcBuyEditor = true },
                        onAddBillPay = {
                            btcBillPayPrefill = null
                            showBtcBillPayEditor = true
                        },
                        onAddTransfer = { showBtcTransferEditor = true },
                    )
                Destination.BTC_BUYS -> btcBuysScreen(state, displayUnit, btcBuysTitle)
                Destination.BTC_BILL_PAYS -> btcBillPaysScreen(
                    state,
                    displayUnit,
                    btcBillPaysTitle,
                    onAddBillPay = {
                        btcBillPayPrefill = null
                        showBtcBillPayEditor = true
                    },
                )
                Destination.NET_WORTH -> netWorth(state, displayUnit)
                Destination.RETIREMENT -> retirement(state, displayUnit)
                Destination.EXPORT -> item { ExportScreen(state) }
                // Rendered above, outside the shared ledger column.
                Destination.TODAY -> Unit
                Destination.TASKS -> item {
                    // ScreenHost is the privacy boundary: a destination never
                    // receives rows its active profile cannot see. The refresh
                    // callback travels with the rows via taskListsContent's
                    // default, so filtering and refreshing cannot diverge.
                    taskListsContent(state, collections.visibleTodos)
                }
                Destination.FAMILY -> family(state)
                Destination.SETTINGS -> settings(
                    state,
                    remoteReadReady,
                    onRemoteRowsConnected,
                    ledgerSettings,
                    onLedgerSettingsChange,
                )
            }
            }
        }
    }
    budgetEditor?.let { seed ->
        BudgetCategoryEditorSheet(
            seed = seed,
            onDismiss = { budgetEditor = null },
            onWriteSucceeded = onWriteSucceeded,
        )
    }
    if (showBtcBuyEditor) {
        BtcBuyEntrySheet(
            owner = state.activeProfile,
            onDismiss = { showBtcBuyEditor = false },
            onWriteSucceeded = onWriteSucceeded,
        )
    }
    if (showBtcBillPayEditor) {
        BtcBillPayEntrySheet(
            owner = state.activeProfile,
            budgetCategories = state.data.budget.value?.categories?.map { it.name }.orEmpty(),
            prefill = btcBillPayPrefill,
            onDismiss = {
                showBtcBillPayEditor = false
                btcBillPayPrefill = null
            },
            onWriteSucceeded = onWriteSucceeded,
        )
    }
    if (showBtcTransferEditor) {
        BtcTransferEntrySheet(
            viewer = state.activeProfile,
            accounts = bitcoinProjection.transferAccounts,
            onDismiss = { showBtcTransferEditor = false },
            onWriteSucceeded = onWriteSucceeded,
        )
    }

    val selectedTransaction =
        collections.visibleTransactions.firstOrNull {
            it.selectionKey == selectedTransactionKey
        }
    if (selectedTransaction != null && transactionActions != null) {
        TransactionDetailScreen(
            transaction = selectedTransaction,
            actions = transactionActions,
            onClose = { selectedTransactionKey = null },
            onChanged = onWriteSucceeded,
        )
    }
}

/**
 * The action row under the top bar: unit chips and the one primary action,
 * once per screen. Screens with neither draw nothing here, so the first data
 * is never more than the title and one subtitle line away.
 */
@Composable
private fun ScreenActionBar(
    destination: Destination,
    displayUnit: DisplayUnit,
    onDisplayUnitChange: (DisplayUnit) -> Unit,
    onAddTransaction: () -> Unit,
) {
    val tokens = LocalLedgerTheme.current
    val canAdd = destination in ADD_TRANSACTION_DESTINATIONS
    val showsUnit = destination.supportsFinancialDisplayUnit
    if (!canAdd && !showsUnit) return
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .background(tokens.colors.panel)
                .padding(horizontal = tokens.density.screenGutter, vertical = VaultSpace.sm),
            horizontalArrangement = Arrangement.spacedBy(tokens.density.actionGap, Alignment.End),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (showsUnit) {
                BitcoinUnitToggle(
                    selected = displayUnit,
                    onSelect = onDisplayUnitChange,
                    modifier = Modifier.weight(1f, fill = false).widthIn(max = 200.dp),
                )
            }
            if (canAdd) {
                VaultButton(label = stringResource(R.string.add_transaction_action), onClick = onAddTransaction)
            }
        }
        HorizontalHairline()
    }
}

private val ADD_TRANSACTION_DESTINATIONS = setOf(
    Destination.DASHBOARD,
    Destination.ACTIVITY,
    Destination.BUDGET,
)

/** Two lines: the screen title and one tracked subtitle. Nothing else sits above the first data. */
@Composable
private fun ScreenHeader(
    destination: Destination,
    state: VaultUiState,
    budgetMonth: String?,
) {
    val tokens = LocalLedgerTheme.current
    val subtitle = when (destination) {
        Destination.DASHBOARD ->
            if (state.activeProfile.isAdult) "Household command center"
            else "${state.activeProfile.displayName}'s money"
        Destination.ACTIVITY -> "Transactions visible to this profile"
        // The month in scope, not the budget file's month: the two differ while an
        // earlier month is picked, and the header must not contradict the picker.
        // A profile with no budget file still says so; Maddox has none.
        Destination.BUDGET -> state.data.budget.value?.let { monthLabel(budgetMonth ?: it.month) } ?: "No budget"
        Destination.BITCOIN -> "Stack and custody"
        Destination.BTC_BUYS -> "Purchases visible to this profile"
        Destination.BTC_BILL_PAYS -> "Bitcoin spent on bills visible to this profile"
        Destination.NET_WORTH -> "Household for adults; self only for children"
        Destination.RETIREMENT -> "Retirement accounts and long-range scenario"
        Destination.EXPORT -> "Owner-filtered files shared outside the app"
        Destination.TODAY -> "Due today or overdue"
        Destination.TASKS -> "Projects, areas and smart lists"
        Destination.FAMILY -> "Who can see what"
        Destination.SETTINGS -> "Runtime and boundaries"
    }
    Column(verticalArrangement = Arrangement.spacedBy(VaultSpace.xs)) {
        Text(destination.label, style = tokens.type.screenTitle, color = tokens.colors.foreground)
        Text(
            subtitle.uppercase(),
            style = tokens.type.screenSubtitle,
            color = tokens.colors.foregroundSecondary,
            maxLines = 1,
        )
    }
}

internal val Destination.supportsFinancialDisplayUnit: Boolean
    get() =
        this in setOf(
            Destination.DASHBOARD,
            Destination.ACTIVITY,
            Destination.BITCOIN,
            Destination.BTC_BUYS,
            Destination.BTC_BILL_PAYS,
            Destination.NET_WORTH,
            Destination.RETIREMENT,
        )

@Composable
internal fun BitcoinUnitToggle(
    selected: DisplayUnit,
    onSelect: (DisplayUnit) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .horizontalScroll(rememberScrollState())
            .selectableGroup()
            .testTag(BITCOIN_UNIT_TOGGLE_TEST_TAG),
        horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DisplayUnit.entries.forEach { unit ->
            SelectionChip(
                label = unit.label,
                semanticLabel = "${unit.label} display unit",
                actionLabel = "Show amounts in ${unit.label}",
                selected = unit == selected,
                compact = true,
                onSelect = { onSelect(unit) },
            )
        }
    }
}

@Composable
internal fun BitcoinConversionNotice(state: VaultUiState) {
    val quote = state.operationalBitcoinQuote()
    if (quote != null) {
        StatusBanner(
            text = if (quote.status == MarketQuoteStatus.STALE) "BTC conversion · stale quote" else "BTC conversion",
            detail = "Uses ${quote.quoteHint(state.now)}.",
            tone = if (quote.status == MarketQuoteStatus.STALE) {
                LocalLedgerTheme.current.colors.loss
            } else {
                LocalLedgerTheme.current.colors.foregroundSecondary
            },
        )
    } else {
        StatusBanner(
            text = "BTC conversion unavailable",
            detail = "No usable operational BTC market quote is available. Recorded buys are execution metadata only.",
            tone = LocalLedgerTheme.current.colors.loss,
        )
    }
}

internal fun VaultUiState.bitcoinConversionProvenance(): String =
    operationalBitcoinQuote()?.let { quote -> "BTC conversion: ${quote.quoteHint(now)}" }
        ?: "BTC conversion unavailable"

// ── Dashboard ───────────────────────────────────────────────────────────────

private fun VaultLazyListScope.dashboard(
    state: VaultUiState,
    projection: DashboardProjection,
    displayUnit: DisplayUnit,
) {
    val incomeUnavailable = projection.incomeCents == null
    val balanceUnavailable = projection.balance == null
    val quote = state.operationalBitcoinQuote()
    val convertsUsd = displayUnit != DisplayUnit.USD &&
        (
            (!state.data.transactions.requiredProjectionUnavailable &&
                (projection.spendCents != null || projection.activity.isNotEmpty())) ||
                !incomeUnavailable
        )

    if (convertsUsd) item { BitcoinConversionNotice(state) }

    item {
        KpiStrip(
            listOf(
                Kpi(
                    "Spend",
                    figure(state.data.transactions.requiredProjectionUnavailable || projection.spendCents == null) {
                        formatFinancialAmount(
                            FinancialAmount(usdCents = requireNotNull(projection.spendCents)),
                            displayUnit,
                            quote,
                        )
                    },
                    tone = LocalLedgerTheme.current.colors.loss,
                ),
                Kpi(
                    "Income",
                    figure(incomeUnavailable) {
                        formatFinancialAmount(
                            FinancialAmount(usdCents = requireNotNull(projection.incomeCents)),
                            displayUnit,
                            quote,
                        )
                    },
                    tone = LocalLedgerTheme.current.colors.gain,
                ),
                Kpi(
                    "Stack",
                    figure(balanceUnavailable) {
                        state.formatBalance(requireNotNull(projection.balance), displayUnit)
                    },
                    hint = figure(balanceUnavailable) {
                        balanceSnapshotBasis(requireNotNull(projection.balance))
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
            rowContent = { TransactionRow(it, displayUnit, quote) },
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
                figure = formatFinancialAmount(
                    FinancialAmount(usdCents = entry.amountCents),
                    displayUnit,
                    quote,
                ),
                figureColor = LocalLedgerTheme.current.colors.gain,
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
        quote = quote,
    )
    item { DashboardAwards(state, projection) }
}

internal data class DashboardAward(val label: String, val earned: Boolean, val detail: String)

internal fun dashboardAwards(
    state: VaultUiState,
    projection: DashboardProjection,
): List<DashboardAward> {
    val balance = projection.balance.takeIf {
        state.data.btcBalance.status == Freshness.LIVE ||
            state.data.btcBalance.status == Freshness.STALE
    }
    val custodyRate = balance?.let {
        Money.basisPoints(it.selfCustodySats, it.totalSats)
    } ?: 0
    val tasksTrusted = state.data.todos.status == Freshness.LIVE ||
        state.data.todos.status == Freshness.STALE ||
        state.data.todos.status == Freshness.EMPTY
    val budget = state.data.budget.value.takeIf {
        state.data.budget.status == Freshness.LIVE ||
            state.data.budget.status == Freshness.STALE
    }
    return listOf(
        DashboardAward("Keys in hand", balance != null && custodyRate >= 5_000, "At least half the stack is self-custodied"),
        DashboardAward("Ledger closer", tasksTrusted && projection.openTodos == 0, "No open tasks in this profile"),
        DashboardAward(
            "Within plan",
            budget != null && budget.remainingCents?.let { it >= 0L } == true,
            "Current budget document has room remaining",
        ),
    )
}

@Composable
private fun DashboardAwards(state: VaultUiState, projection: DashboardProjection) {
    val awards = dashboardAwards(state, projection)
    Panel("Awards", "${awards.count(DashboardAward::earned)} of ${awards.size} earned") {
        Column {
            awards.forEachIndexed { index, award ->
                if (index > 0) HorizontalHairline()
                LedgerRow(
                    primary = award.label,
                    secondary = award.detail,
                    figure = if (award.earned) "earned" else "locked",
                    figureColor = if (award.earned) {
                        LocalLedgerTheme.current.colors.gain
                    } else {
                        LocalLedgerTheme.current.colors.foregroundTertiary
                    },
                )
            }
        }
    }
}

// ── Activity ────────────────────────────────────────────────────────────────

private fun VaultLazyListScope.activity(
    state: VaultUiState,
    search: ActivitySearchProjection,
    displayUnit: DisplayUnit,
    onSelectTransaction: (Transaction) -> Unit,
) {
    val quote = state.operationalBitcoinQuote()
    item { StaleNotice(state.data.transactions.status) }
    if (state.data.transactions.suppressFigures) {
        item { Panel { StateBlock(state.data.transactions.status) } }
        return
    }
    if (search.totalCount == 0) {
        item { Panel { StateBlock(Freshness.EMPTY) } }
        return
    }
    item { ActivitySearchControls(search) }
    val transactions = search.transactions
    if (transactions == null) {
        item {
            Panel {
                Text(
                    "Filtering cached records...",
                    modifier = Modifier.padding(vertical = VaultSpace.md),
                    color = LocalLedgerTheme.current.colors.foregroundSecondary,
                )
            }
        }
        return
    }
    if (transactions.isEmpty()) {
        item {
            Panel {
                Column(Modifier.padding(vertical = VaultSpace.md)) {
                    Text("No matching records", color = LocalLedgerTheme.current.colors.foreground)
                    Text(
                        "Try another search or filter.",
                        style = MaterialTheme.typography.bodySmall,
                        color = LocalLedgerTheme.current.colors.foregroundSecondary,
                    )
                }
            }
        }
        return
    }
    keyedPanel(
        sectionKey = "activity-transactions",
        title = if (transactions.size == search.totalCount) {
            "${transactions.size} records"
        } else {
            "${transactions.size} of ${search.totalCount} records"
        },
        source = if (displayUnit == DisplayUnit.USD) {
            state.data.transactions.source
        } else {
            "${state.data.transactions.source} · ${state.bitcoinConversionProvenance()}"
        },
        rows = transactions,
        rowKey = Transaction::selectionKey,
        rowContent = {
            Box(
                Modifier
                    .fillMaxWidth()
                    .clickable { onSelectTransaction(it) },
            ) {
                TransactionRow(it, displayUnit, quote)
            }
        },
    )
}

private val Transaction.selectionKey: String
    get() = "${owner.key}\u0000$id"

@Composable
private fun TransactionRow(
    transaction: Transaction,
    displayUnit: DisplayUnit,
    quote: MarketQuote?,
    secondary: String = "${transaction.date} · ${transaction.category}",
) {
    val isSpend = transaction.isSpend
    val isCreditOrWrongSign = transaction.hasOppositeSpendSign
    LedgerRow(
        primary = transaction.merchant,
        secondary = secondary,
        figure = formatTransactionAmount(transaction, displayUnit, quote),
        figureColor = if (isSpend && !isCreditOrWrongSign) {
            LocalLedgerTheme.current.colors.loss
        } else {
            LocalLedgerTheme.current.colors.gain
        },
    )
}

internal fun formatTransactionAmount(
    transaction: Transaction,
    displayUnit: DisplayUnit,
    quote: MarketQuote?,
): String {
    val displaySpend = transaction.displaySpendAmount
    val cents = when {
        !transaction.isSpend -> transaction.incomeAmount
        transaction.hasOppositeSpendSign -> displaySpend
        else -> displaySpend.negateOrNull() ?: return Money.PRICE_UNAVAILABLE
    }
    return formatFinancialAmount(FinancialAmount(usdCents = cents), displayUnit, quote)
}

// ── Budget ──────────────────────────────────────────────────────────────────

private fun VaultLazyListScope.budget(
    state: VaultUiState,
    months: List<String>,
    spend: BudgetSpend?,
    onSelectMonth: (String) -> Unit,
    onEditCategory: (BudgetCategoryEditorSeed) -> Unit,
    onOpenCategory: (BudgetCategoryDrilldownScope) -> Unit,
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
    val actualsUnavailable = state.data.budgetActualsUnavailable
    val actualsStatus = state.data.budgetActualsStatus

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
                    tone = if (derived.remainingCents < 0L) {
                        LocalLedgerTheme.current.colors.loss
                    } else {
                        LocalLedgerTheme.current.colors.gain
                    },
                ),
                Kpi(
                    "Over budget",
                    figure(actualsUnavailable) { derived.overBudgetCount.toString() },
                    hint = if (derived.overBudgetCount == 1) "1 category" else "${derived.overBudgetCount} categories",
                    tone = if (derived.overBudgetCount > 0) LocalLedgerTheme.current.colors.loss else null,
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
                tone = LocalLedgerTheme.current.colors.loss,
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
            EditableBudgetCategoryRow(
                category = category,
                canEdit =
                    derived.month == budget.month &&
                        slice.status == Freshness.LIVE,
                transactionsContentDescription =
                    stringResource(
                        R.string.budget_category_transactions_accessibility,
                        category.name,
                        derived.month,
                    ),
                onOpenTransactions = {
                    onOpenCategory(
                        BudgetCategoryDrilldownScope(
                            month = derived.month,
                            category = category.name,
                        ),
                    )
                },
                onEdit = {
                    onEditCategory(
                        BudgetCategoryEditorSeed(
                            viewer = state.activeProfile,
                            displayedMonth = derived.month,
                            budgetDocumentMonth = budget.month,
                            category = category,
                            budget = budget,
                            sourceFile = budgetCategoryDeleteSourceFile(state.activeProfile),
                        ),
                    )
                },
            )
        }
    }
}

private fun VaultLazyListScope.budgetCategoryDrilldown(
    state: VaultUiState,
    scope: BudgetCategoryDrilldownScope,
    transactions: List<Transaction>,
    billPays: List<BtcBillPay>,
    onBack: () -> Unit,
    onSelectTransaction: (Transaction) -> Unit,
) {
    item {
        TextButton(onClick = onBack) {
            Text(stringResource(R.string.budget_category_transactions_back))
        }
    }
    item { StaleNotice(state.data.transactions.status) }
    item { StaleNotice(state.data.btcBillPays.status) }

    if (state.data.budgetActualsUnavailable) {
        item {
            Panel(
                title = stringResource(R.string.budget_category_transactions_title, scope.category),
                source = "${state.data.budgetActualsStatus} · ${scope.month}",
            ) {
                StateBlock(state.data.budgetActualsStatus)
            }
        }
        return
    }

    if (transactions.isEmpty() && billPays.isEmpty()) {
        item {
            Panel(
                title = stringResource(R.string.budget_category_transactions_title, scope.category),
                source = "${state.data.transactions.source} · ${scope.month}",
            ) {
                Column(Modifier.padding(vertical = VaultSpace.md)) {
                    Text(
                        stringResource(R.string.budget_category_transactions_empty),
                        color = LocalLedgerTheme.current.colors.foreground,
                    )
                    Text(
                        stringResource(R.string.budget_category_transactions_empty_detail),
                        style = MaterialTheme.typography.bodySmall,
                        color = LocalLedgerTheme.current.colors.foregroundSecondary,
                    )
                }
            }
        }
        return
    }

    if (transactions.isNotEmpty()) {
        keyedPanel(
            sectionKey = "budget-category-transactions",
            title =
                "${scope.category} · ${transactions.size} " +
                    if (transactions.size == 1) "transaction" else "transactions",
            source = "${state.data.transactions.source} · ${scope.month}",
            rows = transactions,
            rowKey = Transaction::selectionKey,
            rowContent = { transaction ->
                val accessibilityLabel =
                    stringResource(
                        R.string.budget_transaction_edit_accessibility,
                        transaction.merchant,
                        transaction.date,
                        transaction.owner.displayName,
                    )
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clickable(
                            onClickLabel = accessibilityLabel,
                            role = Role.Button,
                            onClick = { onSelectTransaction(transaction) },
                        )
                        .semantics(mergeDescendants = true) {
                            contentDescription = accessibilityLabel
                        },
                ) {
                    TransactionRow(
                        transaction = transaction,
                        displayUnit = DisplayUnit.USD,
                        quote = null,
                        secondary = "${transaction.date} · ${transaction.owner.displayName}",
                    )
                }
            },
        )
    }

    if (billPays.isNotEmpty()) {
        keyedPanel(
            sectionKey = "budget-category-bill-pays",
            title =
                "${scope.category} · ${billPays.size} " +
                    if (billPays.size == 1) "bill pay" else "bill pays",
            source = "${state.data.btcBillPays.source} · ${scope.month}",
            rows = billPays,
            rowKey = BtcBillPay::id,
        ) { payment ->
            LedgerRow(
                primary = payment.merchant,
                secondary = "${payment.date} · ${payment.owner.displayName}",
                figure = formatBtcBillPayAmount(payment, DisplayUnit.USD),
                figureColor = LocalLedgerTheme.current.colors.loss,
                badge = payment.platform,
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
            color = LocalLedgerTheme.current.colors.foregroundTertiary,
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
internal fun MonthChip(month: String, selected: Boolean, onSelect: () -> Unit) {
    val label = monthLabel(month)
    SelectionChip(
        label = label,
        semanticLabel = "$label budget month",
        actionLabel = "Show budget month $label",
        selected = selected,
        onSelect = onSelect,
    )
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
    onAddBuy: () -> Unit,
    onAddBillPay: () -> Unit,
    onAddTransfer: () -> Unit,
) {
    val slice = state.data.btcBalance
    val unavailable = projection.balance == null
    val observation = state.bitcoinQuoteObservation()
    val quote = state.operationalBitcoinQuote()

    item { BitcoinPriceHero(observation, state.now) }

    if (displayUnit == DisplayUnit.USD && !unavailable) {
        item { BitcoinConversionNotice(state) }
    }

    item {
        KpiStrip(
            listOf(
                Kpi(
                    "Total stack",
                    figure(unavailable) {
                        state.formatBalance(requireNotNull(projection.balance), displayUnit)
                    },
                    provenance = canonicalBitcoinProvenance(
                        projection.balance?.fiatValuation != null,
                        displayUnit,
                        quote,
                    ),
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
        quote = quote,
    )
    if (state.data.btcBuys.status == Freshness.LIVE) {
        item { BtcBuyEntryAction(onAddBuy) }
    }
    if (canAddBtcBillPay(state.data.btcBillPays.status, state.activeProfile)) {
        item { BtcBillPayEntryAction(onAddBillPay) }
    }
    val transferAccounts = projection.transferAccounts.filter {
        it.owner == state.activeProfile.ledgerOwner
    }
    if (
        state.activeProfile.isAdult &&
        state.data.btcAccounts.status == Freshness.LIVE &&
        transferAccounts.size >= 2
    ) {
        item { BtcTransferEntryAction(onAddTransfer) }
    }
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
                secondary = "${buy.date} · ${Money.formatUsd(buy.priceUsdCents)}/BTC",
                figure = formatBtcBuyAmount(buy, displayUnit),
                figureColor = LocalLedgerTheme.current.colors.foreground,
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
                figure = formatBtcBillPayAmount(payment, displayUnit),
                figureColor = LocalLedgerTheme.current.colors.loss,
                badge = payment.platform,
            )
        }
    }
}

@Composable
internal fun BitcoinPriceHero(quote: MarketQuote?, nowMillis: Long? = null) {
    val tokens = LocalLedgerTheme.current
    val effects = LocalLedgerEffects.current
    val formatted = formatOperationalBitcoinPrice(quote)
    val decimalStart = formatted.lastIndexOf('.').takeIf { it > 0 }
    Panel {
        Column(Modifier.padding(tokens.density.cardPadding)) {
            Text(
                "BTC REFERENCE PRICE",
                style = tokens.type.kpiLabel,
                color = tokens.colors.foregroundTertiary,
            )
            if (decimalStart == null) {
                Text(formatted, style = tokens.type.priceHero, color = tokens.colors.foregroundTertiary)
            } else {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(
                        formatted.substring(0, decimalStart),
                        style = tokens.type.priceHero.withLedgerPhosphorGlow(effects.showPhosphorGlow),
                        color = tokens.colors.bitcoin,
                    )
                    Text(
                        formatted.substring(decimalStart),
                        style = tokens.type.priceHeroDecimals.withLedgerPhosphorGlow(effects.showPhosphorGlow),
                        color = tokens.colors.priceDecimals,
                    )
                }
            }
            Text(
                operationalBitcoinPriceBasis(quote, nowMillis).uppercase(),
                style = tokens.type.rowMeta,
                color = tokens.colors.foregroundTertiary,
            )
        }
    }
}

// ── Net Worth ───────────────────────────────────────────────────────────────

private fun VaultLazyListScope.netWorth(
    state: VaultUiState,
    displayUnit: DisplayUnit,
) {
    financeNetWorthSummary(state, displayUnit)
    netWorthRetirementAccounts(state, displayUnit)
    item { NetWorthProjectionPanel(state, displayUnit) }
}

private fun VaultLazyListScope.accountList(
    sectionKey: String,
    title: String,
    source: String?,
    accounts: List<BtcAccount>,
    status: Freshness,
    displayUnit: DisplayUnit,
    quote: MarketQuote?,
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
            primary = account.displayLabel(),
            secondary = buildString {
                append(account.owner.displayName)
                if (
                    canonicalBitcoinProvenance(
                        account.fiatValuation != null,
                        displayUnit,
                        quote,
                    ) == Provenance.ESTIMATED
                ) {
                    append(" · Estimated")
                }
            },
            figure = formatCanonicalAccount(account, displayUnit, quote),
            figureColor = LocalLedgerTheme.current.colors.foreground,
            badge = account.custody.label,
            badgeAccented = account.custody.key == "self_custody",
        )
    }
}

private fun VaultUiState.formatBitcoin(sats: Long, unit: DisplayUnit): String =
    formatFinancialAmount(
        FinancialAmount(sats = sats),
        unit,
        operationalBitcoinQuote(),
    )

private fun VaultUiState.formatBalance(balance: BtcBalance, unit: DisplayUnit): String =
    formatCanonicalBalance(balance, unit, operationalBitcoinQuote())

internal fun formatCanonicalBalance(
    balance: BtcBalance,
    unit: DisplayUnit,
    quote: MarketQuote? = null,
): String =
    formatFinancialAmount(
        FinancialAmount(
            usdCents = balance.fiatValuation?.cents,
            sats = balance.totalSats,
        ),
        unit,
        // Embedded canonical fiat wins inside formatFinancialAmount. Only a
        // separately supplied operational quote may fill a missing USD side.
        quote = quote,
    )

internal fun formatCanonicalAccount(
    account: BtcAccount,
    unit: DisplayUnit,
    quote: MarketQuote? = null,
): String =
    formatFinancialAmount(
        FinancialAmount(
            usdCents = account.fiatValuation?.cents,
            sats = account.sats,
        ),
        unit,
        quote = quote,
    )

private fun canonicalBitcoinProvenance(
    hasEmbeddedFiat: Boolean,
    unit: DisplayUnit,
    quote: MarketQuote?,
): Provenance =
    if (unit == DisplayUnit.USD && !hasEmbeddedFiat && quote != null) {
        Provenance.ESTIMATED
    } else {
        Provenance.ACTUAL
    }

internal fun formatOperationalBitcoinPrice(quote: MarketQuote?): String =
    quote?.priceCents?.let(Money::formatUsd) ?: Money.PRICE_UNAVAILABLE

internal fun operationalBitcoinPriceBasis(quote: MarketQuote?, nowMillis: Long? = null): String {
    quote ?: return "No operational quote"
    if (nowMillis != null) return quote.quoteHint(nowMillis)
    return buildString {
        append(quote.source)
        if (quote.status == MarketQuoteStatus.STALE) append(" · stale")
        append(" · ${quote.fetchedAt}")
    }
}

internal fun balanceSnapshotBasis(balance: BtcBalance): String = "Balance snapshot · ${balance.asOf}"

// Today lives in TodoScreen.kt: it edits rows, so it owns its own scaffold.

// ── Family ──────────────────────────────────────────────────────────────────

internal data class FamilyScopeSummary(
    val finance: String,
    val tasks: String,
    val netWorth: String,
)

internal fun familyScopeSummary(profile: FamilyMember): FamilyScopeSummary =
    if (profile.isAdult) {
        FamilyScopeSummary(
            finance = "Adult household + child oversight",
            tasks = "${profile.displayName} only",
            netWorth = "Adult household only",
        )
    } else {
        FamilyScopeSummary(
            finance = "${profile.displayName} only",
            tasks = "${profile.displayName} only",
            netWorth = "${profile.displayName} only",
        )
    }

private fun VaultLazyListScope.family(state: VaultUiState) {
    val scope = familyScopeSummary(state.activeProfile)
    item {
        Panel("Active profile scope", state.activeProfile.displayName) {
            Column {
                LedgerRow(
                    "Finance visibility",
                    figure = scope.finance,
                    figureColor = LocalLedgerTheme.current.colors.foregroundSecondary,
                )
                HorizontalHairline()
                LedgerRow(
                    "Private tasks",
                    figure = scope.tasks,
                    figureColor = LocalLedgerTheme.current.colors.foregroundSecondary,
                )
                HorizontalHairline()
                LedgerRow(
                    "Net worth total",
                    figure = scope.netWorth,
                    figureColor = LocalLedgerTheme.current.colors.foregroundSecondary,
                )
            }
        }
    }
    item {
        StatusBanner(
            "Victor and Rachel are one household",
            "They see identical finance data. Mason and Maddox are isolated and see only their own records.",
            tone = LocalLedgerTheme.current.colors.foregroundSecondary,
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
                        figureColor = LocalLedgerTheme.current.colors.foregroundSecondary,
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
                        figureColor = LocalLedgerTheme.current.colors.foregroundSecondary,
                    )
                }
            }
        }
    }
}

// ── Settings ────────────────────────────────────────────────────────────────

private fun VaultLazyListScope.settings(
    state: VaultUiState,
    remoteReadReady: Boolean,
    onRemoteRowsConnected: () -> Unit,
    ledgerSettings: LedgerUiSettings,
    onLedgerSettingsChange: (LedgerUiSettings) -> Unit,
) {
    item {
        if (remoteReadReady) {
            StatusBanner(
                "Convex row reads are enabled",
                "Every query is authenticated. Writes require the separate sync credential below.",
                tone = LocalLedgerTheme.current.colors.gain,
            )
        } else {
            StatusBanner(
                stringResource(R.string.convex_rows_inactive_title),
                stringResource(R.string.convex_rows_inactive_detail),
                tone = LocalLedgerTheme.current.colors.loss,
            )
        }
    }
    item { LedgerAppearanceSettings(ledgerSettings, onLedgerSettingsChange) }
    state.remoteConfigurationError?.let { detail ->
        item {
            StatusBanner(
                "Could not enable Convex row reads",
                detail,
                tone = LocalLedgerTheme.current.colors.loss,
            )
        }
    }
    item {
        BudgetNotificationSettings(state)
    }
    item {
        Panel(stringResource(R.string.read_bootstrap_title)) {
            ReadBootstrapConfiguration(
                remoteReadReady = remoteReadReady,
                onConnected = { onRemoteRowsConnected() },
                modifier = Modifier.padding(vertical = VaultSpace.md),
                allowReset = true,
            )
        }
    }
    item { SyncTokenConfiguration() }
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
                        figureColor = LocalLedgerTheme.current.colors.foregroundSecondary,
                    )
                }
            }
        }
    }
    item { Spacer(Modifier.height(VaultSpace.lg)) }
}

@Composable
internal fun SyncTokenConfiguration() {
    // Deliberately not saveable: the plaintext token must not enter saved
    // instance state. Submission immediately hands it to encrypted storage.
    var token by remember { mutableStateOf("") }
    val context = LocalContext.current
    val application = context.applicationContext as? VaultApplication
    var hasStoredToken by remember(application) {
        mutableStateOf(application?.hasConvexWriteCredential() == true)
    }
    var saveFailure by remember { mutableStateOf<String?>(null) }
    var removalFailure by remember { mutableStateOf<String?>(null) }

    Panel(stringResource(R.string.write_credential_title)) {
        Column(
            Modifier.padding(vertical = VaultSpace.md),
            verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
        ) {
            Text(
                text = stringResource(R.string.write_credential_source),
                color = LocalLedgerTheme.current.colors.foregroundSecondary,
                style = MaterialTheme.typography.labelSmall,
            )
            Text(
                text =
                    stringResource(
                        if (hasStoredToken) {
                            R.string.write_credential_configured
                        } else {
                            R.string.write_credential_unconfigured
                        },
                    ),
                color = LocalLedgerTheme.current.colors.foregroundSecondary,
                style = MaterialTheme.typography.bodySmall,
            )
            LedgerTextField(
                value = token,
                onValueChange = {
                    token = it
                    saveFailure = null
                },
                label = stringResource(R.string.write_credential_label),
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
            )
            VaultButton(
                label = stringResource(R.string.write_credential_save),
                enabled = token.isNotBlank() && application != null,
                onClick = {
                    val app = checkNotNull(application)
                    app
                        .saveConvexWriteCredential(token)
                        .onSuccess {
                            token = ""
                            hasStoredToken = app.hasConvexWriteCredential()
                            saveFailure = null
                            removalFailure = null
                        }.onFailure {
                            saveFailure = credentialSaveFailureMessage(it).resolve(context)
                        }
                },
            )
            if (hasStoredToken && application != null) {
                androidx.compose.material3.OutlinedButton(
                    onClick = {
                        application
                            .removeConvexWriteCredential()
                            .onSuccess {
                                token = ""
                                hasStoredToken = application.hasConvexWriteCredential()
                                saveFailure = null
                                removalFailure = null
                            }.onFailure {
                                removalFailure = credentialRemovalFailureMessage(it).resolve(context)
                            }
                    },
                    border =
                        androidx.compose.foundation.BorderStroke(
                            width = 1.dp,
                            color = LocalLedgerTheme.current.colors.line,
                        ),
                    colors =
                        androidx.compose.material3.ButtonDefaults.outlinedButtonColors(
                            contentColor = LocalLedgerTheme.current.colors.foreground,
                        ),
                ) {
                    Text(stringResource(R.string.write_credential_remove))
                }
            }
            saveFailure?.let {
                Text(
                    text = it,
                    color = LocalLedgerTheme.current.colors.loss,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            removalFailure?.let {
                Text(
                    text = it,
                    color = LocalLedgerTheme.current.colors.loss,
                    style = MaterialTheme.typography.bodySmall,
                )
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
        tone = LocalLedgerTheme.current.colors.loss,
    )
}
