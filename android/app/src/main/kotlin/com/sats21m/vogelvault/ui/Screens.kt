package com.sats21m.vogelvault.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
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
import com.sats21m.vogelvault.data.DeviceCapability
import com.sats21m.vogelvault.data.DeviceCapabilities
import com.sats21m.vogelvault.data.BitcoinDeleteKind
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.BillPayBudgetEffect
import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.BtcTransfer
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
import com.sats21m.vogelvault.ui.theme.LedgerTreatment
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.LocalLedgerEffects
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.rememberPhosphorPulseBlur
import com.sats21m.vogelvault.ui.theme.rememberSettledCents
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
    today: java.time.LocalDate,
): Long? {
    val rows = dashboardIncomeEntries(viewer, month).filter { it.date <= today.toString() }
    return if (incomeFiguresUnavailable || month == null) null else rows.sumLongOrNull { it.amountCents }
}

internal fun ReadModel.yearToDateIncomeCents(
    viewer: FamilyMember,
    month: String,
    today: java.time.LocalDate,
): Long? =
    if (incomeFiguresUnavailable) null else income.value.netWorthScopeFor(viewer)
        .filter { it.month.take(4) == month.take(4) && it.month <= month && it.date <= today.toString() }
        .sumLongOrNull { it.amountCents }

internal fun ReadModel.netWorthBalanceForDisplay(): BtcBalance? =
    btcBalance.value?.takeUnless { netWorthFiguresUnavailable }

internal fun ReadModel.billPaysAvailableTo(viewer: FamilyMember): Boolean =
    !billPayLedgerUnavailable && btcBillPays.value.visibleTo(viewer).isNotEmpty()

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun ScreenHost(
    destination: Destination,
    state: VaultUiState,
    onNavigate: (Destination) -> Unit = {},
    onBack: (() -> Unit)? = null,
    primaryReset: String = "",
    quickAddRequested: Boolean = false,
    onQuickAddConsumed: () -> Unit = {},
    onEnableRemoteRows: (String) -> Unit = {},
    onRemoteRowsConnected: () -> Unit = {},
    onWriteSucceeded: () -> Unit = {},
    onStartRiverBillPay: (BillPayPrefill) -> Unit = {},
    displayUnit: DisplayUnit = DisplayUnit.BTC,
    onDisplayUnitChange: (DisplayUnit) -> Unit = {},
    initialBitcoinSegment: BitcoinSegment = BitcoinSegment.OVERVIEW,
    ledgerSettings: LedgerUiSettings = LedgerUiSettings(),
    onLedgerSettingsChange: (LedgerUiSettings) -> Unit = {},
    modifier: Modifier = Modifier,
    profileSwitcher: @Composable () -> Unit = {},
    taskListsContent: @Composable (VaultUiState, List<TodoItem>) -> Unit = { taskState, todos ->
        TaskListsScreen(
            state = taskState,
            todos = todos,
            onWriteSucceeded = onWriteSucceeded,
            adaptive = true,
        )
    },
) {
    val ledgerTokens = LocalLedgerTheme.current
    var addingTransaction by rememberSaveable { mutableStateOf(false) }
    var addingIncome by rememberSaveable { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(quickAddRequested) {
        if (quickAddRequested) {
            addingIncome = false
            addingTransaction = true
            onQuickAddConsumed()
        }
    }
    var incomeBitcoinBuySeed by remember(state.activeProfile) { mutableStateOf<IncomeEntry?>(null) }
    var selectedTransactionKey by rememberSaveable(state.activeProfile, primaryReset) {
        mutableStateOf<String?>(null)
    }
    // The write surface owns its own client, per the house write pattern: nothing
    // threads suspend write callbacks through MainActivity -> VaultApp -> ScreenHost.
    val vaultApplication = LocalContext.current.applicationContext as? VaultApplication
    val remoteReadReady by
        vaultApplication?.effectiveReadReady?.collectAsStateWithLifecycle()
            ?: remember { mutableStateOf(false) }
    val capabilities = vaultApplication?.deviceCapabilities ?: DeviceCapabilities()
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
    val months = remember(profile, transactionsInput, billPaysInput, incomeInput, budgetMonth) {
        (transactionsInput.budgetMonthsFor(profile, budgetMonth, billPaysInput) +
            incomeInput.netWorthScopeFor(profile).map { it.month }).distinct().sortedDescending()
    }
    val initialMonth = remember(state.selectedMonth, months, budgetMonth) {
        resolveBudgetMonth(state.selectedMonth, months, budgetMonth)
    }
    // Dashboard follows the device calendar independently of the Budget picker.
    val dashboardMonth = calendarMonth(state.now)
    // The Budget screen's month scope. Held here rather than in the ViewModel
    // because it is view state, and because every row of the list has to agree on
    // it — the KPI strip, the banners and the categories all read the same month.
    // Re-seeded when the profile changes or the state names a month, so a preview
    // or the design packet can render any month without driving a tap.
    var picked by rememberSaveable(state.activeProfile, state.selectedMonth) {
        mutableStateOf(initialMonth)
    }
    var budgetEditor by remember(state.activeProfile) { mutableStateOf<BudgetCategoryEditorSeed?>(null) }
    var budgetDrilldownMonth by rememberSaveable(state.activeProfile, primaryReset) { mutableStateOf<String?>(null) }
    var budgetDrilldownCategory by rememberSaveable(state.activeProfile, primaryReset) { mutableStateOf<String?>(null) }
    BackHandler(destination == Destination.BUDGET && budgetDrilldownCategory != null) {
        budgetDrilldownMonth = null
        budgetDrilldownCategory = null
    }
    var showBitcoinAdd by rememberSaveable { mutableStateOf(false) }
    var showBtcBuyEditor by rememberSaveable { mutableStateOf(false) }
    var showBtcBillPayEditor by rememberSaveable { mutableStateOf(false) }
    var showBtcTransferEditor by rememberSaveable { mutableStateOf(false) }
    var showBtcAccountEditor by rememberSaveable { mutableStateOf(false) }
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
    val activitySearch = rememberActivitySearchProjection(
            transactions = collections.visibleTransactions,
            profile = state.activeProfile,
            incomeEntries = incomeInput.visibleTo(profile),
        )
    val dashboardIncomeEntries = remember(profile, dashboardMonth, incomeInput) {
        state.data.dashboardIncomeEntries(profile, dashboardMonth)
    }
    val dashboardProjection = remember(state.now, dashboardMonth, collections, dashboardIncomeEntries, incomeFiguresUnavailable) {
        val budgetTransactions = collections.budgetTransactions.inMonth(dashboardMonth ?: "")
        val activity = collections.visibleTransactions.inMonth(dashboardMonth ?: "").take(6)
        DashboardProjection(
            activity = activity,
            accounts = collections.netWorthAccounts,
            balance = collections.netWorthBalance,
            incomeEntries = dashboardIncomeEntries,
            spendCents = budgetTransactions.sumLongOrNull { it.spendAmount },
            incomeCents = state.data.dashboardIncomeCents(profile, dashboardMonth, calendarDate(state.now)),
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
    // A missing/loading snapshot cannot prove removal. Keep the stable category
    // selection until an available plan actually drops that category.
    androidx.compose.runtime.LaunchedEffect(state.data.budget, budgetDrilldownCategory) {
        val slice = state.data.budget
        val category = budgetDrilldownCategory
        if (category != null && slice.status == Freshness.LIVE &&
            slice.value?.categories?.none { it.name == category } == true) {
            budgetDrilldownMonth = null
            budgetDrilldownCategory = null
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

    if (showBtcAccountEditor) {
        BtcAccountEntrySheet(state.activeProfile, state.data.btcBalance, state.data.btcBalanceReadOwner, { showBtcAccountEditor = false }, onWriteSucceeded)
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
    if (showBtcBuyEditor) {
        BtcBuyEntrySheet(
            owner = state.activeProfile,
            quoteCents = state.liveBitcoinQuote()?.priceCents ?: 0L,
            onDismiss = { showBtcBuyEditor = false },
            onWriteSucceeded = onWriteSucceeded,
        )
    }
    if (addingTransaction) {
        key(state.activeProfile) {
            AddTransactionSheet(
                state = state,
                onDismiss = { addingTransaction = false },
                onOpenBitcoinBuy = { addingTransaction = false; showBtcBuyEditor = true },
                initialType = if (addingIncome) AddTransactionType.INCOME else AddTransactionType.SPEND,
                allowIncomeBitcoinBuy = destination == Destination.BUDGET && capabilities.allows(profile, DeviceCapability.BITCOIN),
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
    }
    incomeBitcoinBuySeed?.let { income ->
        BtcBuyFromIncomeEntrySheet(
            viewer = state.activeProfile,
            quoteCents = state.liveBitcoinQuote()?.priceCents ?: 0L,
            income = income,
            onDismiss = { incomeBitcoinBuySeed = null },
            onWriteSucceeded = onWriteSucceeded,
        )
    }

    if (showBitcoinAdd) {
        androidx.compose.material3.ModalBottomSheet(onDismissRequest = { showBitcoinAdd = false }) {
            LedgerMenuItem("Buy BTC", enabled = state.data.btcBuys.status == Freshness.LIVE,
                onClick = { showBitcoinAdd = false; showBtcBuyEditor = true })
            LedgerMenuItem("Bill Pay", enabled = !state.data.billPayLedgerUnavailable && canAddBtcBillPay(state.data.btcBillPays.status, profile),
                onClick = { showBitcoinAdd = false; btcBillPayPrefill = null; showBtcBillPayEditor = true })
            LedgerMenuItem("Transfer", enabled = state.data.btcAccounts.status == Freshness.LIVE && bitcoinProjection.transferAccounts.count { it.owner == profile.ledgerOwner } >= 2,
                onClick = { showBitcoinAdd = false; showBtcTransferEditor = true })
        }
    }

    // Every route retains its own offset for Back. A deliberate tab selection
    // creates a fresh state only for its destination.
    val listStates = Destination.entries.associateWith { route ->
        key(route) {
            val reset = primaryReset.takeIf { it.substringBefore(":") == route.name }
            rememberSaveable(state.activeProfile, reset, saver = androidx.compose.foundation.lazy.LazyListState.Saver) {
                androidx.compose.foundation.lazy.LazyListState()
            }
        }
    }
    val listState = listStates.getValue(destination)
    var bitcoinSegmentName by rememberSaveable(state.activeProfile, destination) {
        mutableStateOf(
            if (destination == Destination.BITCOIN) initialBitcoinSegment.name else BitcoinSegment.OVERVIEW.name,
        )
    }
    val bitcoinSegment = BitcoinSegment.entries.firstOrNull { it.name == bitcoinSegmentName }
        ?: BitcoinSegment.OVERVIEW

    if (destination == Destination.TASKS) {
        Column(modifier.fillMaxSize()) {
            onBack?.let { back -> TextButton(onClick = back) { Text("Back") } }
            Box(Modifier.weight(1f).fillMaxWidth()) { taskListsContent(state, collections.visibleTodos) }
        }
        return
    }

    val panePlan = LocalLedgerPanePlan.current
    val drilldownScope = budgetDrilldownMonth?.let { month ->
        budgetDrilldownCategory?.let { BudgetCategoryDrilldownScope(month, it) }
    }
    val selectedTransaction = collections.visibleTransactions.firstOrNull { it.selectionKey == selectedTransactionKey }
    val hasDetail = selectedTransaction != null || (destination == Destination.BUDGET && drilldownScope != null)
    BackHandler(selectedTransaction != null) { selectedTransactionKey = null }
    val detailContent: @Composable () -> Unit = {
        if (selectedTransaction != null) {
            key(selectedTransaction.selectionKey) {
                TransactionDetailScreen(
                    transaction = selectedTransaction,
                    viewer = state.activeProfile,
                    actions = transactionActions,
                    onClose = { selectedTransactionKey = null },
                    onChanged = onWriteSucceeded,
                    embedded = true,
                )
            }
        } else if (destination == Destination.BUDGET && drilldownScope != null) {
            LazyColumn(contentPadding = androidx.compose.foundation.layout.PaddingValues(ledgerTokens.density.screenGutter)) {
                vaultContent {
                    // Editing lives on the drilldown. Only the current budget
                    // document month is writable, and only from a live read.
                    val editorSeed = state.data.budget.value?.let { budget ->
                        budgetSpend
                            ?.takeIf {
                                drilldownScope.month == budget.month &&
                                    state.data.budget.status == Freshness.LIVE
                            }
                            ?.categories
                            ?.firstOrNull { it.name == drilldownScope.category }
                            ?.let { category ->
                                BudgetCategoryEditorSeed(
                                    viewer = state.activeProfile,
                                    displayedMonth = drilldownScope.month,
                                    budgetDocumentMonth = budget.month,
                                    category = category,
                                    budget = budget,
                                    sourceFile = budgetCategoryDeleteSourceFile(state.activeProfile),
                                )
                            }
                    }
                    budgetCategoryDrilldown(
                        state = state,
                        scope = drilldownScope,
                        onEdit = editorSeed?.let { seed -> { budgetEditor = seed } },
                        editUnavailableReason = capabilities.unavailableReason(profile, DeviceCapability.BUDGET),
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
        } else LedgerDetailPrompt(destination)
    }
    LedgerPanes(
        plan = panePlan,
        showCompactDetail = hasDetail,
        modifier = modifier.fillMaxSize(),
        detail = detailContent,
        list = {
            Column(Modifier.fillMaxSize()) {
                onBack?.let { back -> TextButton(onClick = back) { Text("Back") } }
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(ledgerTokens.density.screenGutter),
                ) {
                    vaultContent {
                    item {
                        ScreenHeader(destination, state, budgetSelectedMonth, bitcoinSegment)
                    }
                    when (destination) {
                        Destination.HOME -> dashboard(state, dashboardProjection, displayUnit, { target ->
                            if (target == Destination.BUDGET) {
                                picked = dashboardMonth
                                budgetDrilldownMonth = null
                                budgetDrilldownCategory = null
                            }
                            onNavigate(target)
                        }) { selectedTransactionKey = it.selectionKey }
                        Destination.ACTIVITY -> {
                            activity(state, checkNotNull(activitySearch), displayUnit, selectedTransactionKey) {
                                selectedTransactionKey = it.selectionKey
                            }
                        }
                        Destination.BUDGET -> {
                                budget(
                                    state,
                                    months,
                                    budgetSpend,
                                    selectedMonth = budgetSelectedMonth,
                                    selectedCategory = drilldownScope,
                                    onSelectMonth = { picked = it },
                                    onAddIncome = { addingIncome = true; addingTransaction = true },
                                    onOpenCategory = { scope ->
                                        selectedTransactionKey = null
                                        budgetDrilldownMonth = scope.month
                                        budgetDrilldownCategory = scope.category
                                    },
                                    onPlanCopied = { month ->
                                        picked = month
                                        onWriteSucceeded()
                                    },
                                )

                        }
                        Destination.BITCOIN -> {
                            item {
                                BitcoinSegmentSelector(
                                    selected = bitcoinSegment,
                                    onSelect = { bitcoinSegmentName = it.name },
                                )
                            }
                            when (bitcoinSegment) {
                                BitcoinSegment.OVERVIEW ->
                                    bitcoin(
                                        state,
                                        bitcoinProjection,
                                        displayUnit,
                                        onAdd = { showBitcoinAdd = true },
                                        onNavigate = onNavigate,
                                        capabilities = capabilities,
                                        onAddAccount = { showBtcAccountEditor = true },
                                        onWriteSucceeded = onWriteSucceeded,
                                    )
                                BitcoinSegment.NET_WORTH -> netWorth(state, displayUnit)
                                BitcoinSegment.RETIREMENT -> retirement(state, displayUnit)
                            }
                        }
                        Destination.BTC_BUYS -> btcBuysScreen(state, displayUnit, btcBuysTitle, onWriteSucceeded = onWriteSucceeded)
                        Destination.BTC_BILL_PAYS -> btcBillPaysScreen(
                            state,
                            displayUnit,
                            btcBillPaysTitle,
                            onWriteSucceeded = onWriteSucceeded,
                            onAddBillPay = {
                                btcBillPayPrefill = null
                                showBtcBillPayEditor = true
                            },
                        )
                        Destination.EXPORT -> item { ExportScreen(state) }
                        Destination.TASKS -> item {
                            // ScreenHost is the privacy boundary: a destination never
                            // receives rows its active profile cannot see. The refresh
                            // callback travels with the rows via taskListsContent's
                            // default, so filtering and refreshing cannot diverge.
                            taskListsContent(state, collections.visibleTodos)
                        }
                        Destination.FAMILY -> family(state, profileSwitcher)
                        Destination.SETTINGS -> settings(
                            state,
                            remoteReadReady,
                            onRemoteRowsConnected,
                            onEnableRemoteRows,
                            ledgerSettings,
                            onLedgerSettingsChange,
                            displayUnit,
                            onDisplayUnitChange,
                        )
                    }
                    }
                }
            }
        },
    )
    budgetEditor?.let { seed ->
        BudgetCategoryEditorSheet(
            seed = seed,
            onDismiss = { budgetEditor = null },
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


}

/** Two lines: the screen title and one tracked subtitle. Nothing else sits above the first data. */
@Composable
private fun ScreenHeader(
    destination: Destination,
    state: VaultUiState,
    budgetMonth: String?,
    bitcoinSegment: BitcoinSegment = BitcoinSegment.OVERVIEW,
) {
    val tokens = LocalLedgerTheme.current
    val subtitle = when (destination) {
        Destination.HOME ->
            "${monthLabel(calendarMonth(state.now))} · " +
                if (state.activeProfile.isAdult) "Household" else state.activeProfile.displayName
        Destination.ACTIVITY -> "Transactions visible to this profile"
        // The month in scope, not the budget file's month: the two differ while an
        // earlier month is picked, and the header must not contradict the picker.
        // A profile with no budget file still says so; Maddox has none.
        Destination.BUDGET -> state.data.budget.value?.let { monthLabel(budgetMonth ?: it.month) } ?: "No budget"
        Destination.BITCOIN -> when (bitcoinSegment) {
            BitcoinSegment.OVERVIEW -> "Stack and custody"
            BitcoinSegment.NET_WORTH -> "Household for adults; self only for children"
            BitcoinSegment.RETIREMENT -> "Retirement accounts and long-range scenario"
        }
        Destination.BTC_BUYS -> "Purchases visible to this profile"
        Destination.BTC_BILL_PAYS -> "Bitcoin spent on bills visible to this profile"
        Destination.EXPORT -> "Share files for this profile"
        Destination.TASKS -> "Due today, projects, and smart lists"
        Destination.FAMILY -> "Who can see what"
        Destination.SETTINGS -> "Appearance and connection"
    }
    Column(verticalArrangement = Arrangement.spacedBy(VaultSpace.xs)) {
        Text(destination.label, style = tokens.type.screenTitle, color = tokens.colors.foreground)
        Text(
            subtitle,
            style = tokens.type.screenSubtitle,
            color = tokens.colors.foregroundSecondary,
            maxLines = 1,
        )
    }
}

internal val Destination.supportsFinancialDisplayUnit: Boolean
    get() =
        this in setOf(
            Destination.HOME,
            Destination.ACTIVITY,
            Destination.BITCOIN,
            Destination.BTC_BUYS,
            Destination.BTC_BILL_PAYS,
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
    com.sats21m.vogelvault.ui.components.FreshnessTag(
        status = if (quote == null) Freshness.ERROR else if (quote.status == MarketQuoteStatus.STALE) Freshness.STALE else Freshness.LIVE,
        updatedAt = quote?.fetchedAt?.let { java.time.Instant.parse(it).toEpochMilli() },
        now = state.now,
        provenance = state.bitcoinConversionProvenance(),
    )
}

internal fun VaultUiState.bitcoinConversionProvenance(): String =
    operationalBitcoinQuote()?.let { quote -> "BTC conversion: ${quote.quoteHint(now)}" }
        ?: "BTC conversion unavailable"

// ── Dashboard ───────────────────────────────────────────────────────────────

private fun VaultLazyListScope.dashboard(
    state: VaultUiState,
    projection: DashboardProjection,
    displayUnit: DisplayUnit,
    onNavigate: (Destination) -> Unit,
    onSelectTransaction: (Transaction) -> Unit,
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
    item {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = { onNavigate(Destination.BUDGET) }) { Text("Budget") }
            TextButton(onClick = { onNavigate(Destination.TASKS) }) { Text("Tasks") }
        }
        TextButton(onClick = { onNavigate(Destination.ACTIVITY) }) { Text("Recent activity · See all") }
    }
    item { StaleNotice(state.data.transactions.status, state.data.transactions.updatedAt, state.now) }
    if (state.data.transactions.suppressFigures) {
        item {
            Panel("Recent activity", state.data.transactions.source) {
                StateBlock(state.data.transactions.status, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() })
            }
        }
    } else if (projection.activity.isEmpty()) {
        item {
            Panel("Recent activity", state.data.transactions.source) {
                StateBlock(Freshness.EMPTY, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() })
            }
        }
    } else {
        keyedPanel(
            sectionKey = "dashboard-activity",
            title = "Recent activity",
            source = state.data.transactions.source,
            rows = projection.activity,
            rowKey = Transaction::id,
            revealKey = state.data.transactions.updatedAt,
            onHeaderClick = { onNavigate(Destination.ACTIVITY) },
            rowContent = { transaction ->
                Box(Modifier.clickable(role = Role.Button) { onSelectTransaction(transaction) }) { TransactionRow(transaction, displayUnit, quote) }
            },
        )
    }
    if (incomeUnavailable) {
        item {
            Panel("Income", state.data.income.source) {
                StateBlock(state.data.income.status, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() })
            }
        }
    } else {
        keyedPanel(
            sectionKey = "dashboard-income",
            title = "Income",
            source = state.data.income.source,
            rows = projection.incomeEntries.take(6),
            rowKey = { "${it.owner.key}:${it.id}" },
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
    selectedTransactionKey: String?,
    onSelectTransaction: (Transaction) -> Unit,
) {
    val quote = state.operationalBitcoinQuote()
    item { ActivitySearchControls(search) }
    if (search.filter == ActivityTransactionFilter.INCOME) {
        incomeRows(state, search.incomeEntries, "activity-income", onClearFilters = {
            search.onQueryChange("")
            search.onFilterChange(ActivityTransactionFilter.ALL)
        })
        return
    }
    item { StaleNotice(state.data.transactions.status, state.data.transactions.updatedAt, state.now) }
    if (state.data.transactions.suppressFigures) {
        item { Panel { StateBlock(state.data.transactions.status, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() }) } }
        return
    }
    if (search.totalCount == 0) {
        item { Panel { StateBlock(Freshness.EMPTY, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() }) } }
        return
    }
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
                StateBlock(Freshness.EMPTY, title = "No matching records", detail = "Try another search or filter.", action = {
                    TextButton(onClick = {
                        search.onQueryChange("")
                        search.onFilterChange(ActivityTransactionFilter.ALL)
                    }) { Text("Clear filters") }
                })
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
        revealKey = state.data.transactions.updatedAt,
        rowContent = {
            val selected = it.selectionKey == selectedTransactionKey
            val colors = LocalLedgerTheme.current.colors
            Box(
                Modifier
                    .fillMaxWidth()
                    .selectable(selected = selected, onClick = { onSelectTransaction(it) })
                    .drawBehind {
                        if (selected) {
                            drawRect(colors.bitcoinSoft)
                            drawRect(colors.bitcoin, Offset.Zero, Size(2.dp.toPx(), size.height))
                        }
                    }
                    .padding(start = VaultSpace.sm),
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

internal fun calendarDate(now: Long, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): java.time.LocalDate =
    java.time.Instant.ofEpochMilli(now).atZone(zone).toLocalDate()

internal fun calendarMonth(now: Long, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String =
    calendarDate(now, zone).toString().take(7)

private fun VaultLazyListScope.incomeSection(state: VaultUiState, month: String, onAddIncome: () -> Unit) {
    val rows = state.data.dashboardIncomeEntries(state.activeProfile, month)
    item {
        Panel("Income · ${monthLabel(month)}") {
            val app = LocalContext.current.applicationContext as? VaultApplication
            val allowed = app?.deviceCapabilities?.allows(state.activeProfile, DeviceCapability.TRANSACTIONS) == true
            VaultButton(label = "+ Income", onClick = onAddIncome, enabled = allowed)
            KpiStrip(listOf(
                Kpi("Month to date", figure(state.data.incomeFiguresUnavailable) {
                    state.data.dashboardIncomeCents(state.activeProfile, month, calendarDate(state.now))?.let(Money::formatUsd) ?: "Unavailable"
                }),
                Kpi("Year to date", figure(state.data.incomeFiguresUnavailable) {
                    state.data.yearToDateIncomeCents(state.activeProfile, month, calendarDate(state.now))?.let(Money::formatUsd) ?: "Unavailable"
                }),
            ))
        }
    }
    incomeRows(state, rows, "budget-income")
}

private fun VaultLazyListScope.incomeRows(
    state: VaultUiState,
    rows: List<IncomeEntry>,
    sectionKey: String,
    onClearFilters: (() -> Unit)? = null,
) {
    if (state.data.incomeFiguresUnavailable || rows.isEmpty()) {
        item {
            Panel("Income") {
                if (!state.data.incomeFiguresUnavailable && onClearFilters != null) {
                    StateBlock(
                        Freshness.EMPTY,
                        title = "No matching records",
                        detail = "Try another search or filter.",
                        action = { TextButton(onClick = onClearFilters) { Text("Clear filters") } },
                    )
                } else {
                    StateBlock(
                        if (state.data.incomeFiguresUnavailable) state.data.income.status else Freshness.EMPTY,
                        action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() },
                    )
                }
            }
        }
        return
    }
    keyedPanel(
        sectionKey = sectionKey,
        title = "Income",
        source = state.data.income.source,
        rows = rows.sortedByDescending { it.date },
        rowKey = { "${it.owner.key}:${it.id}" },
        revealKey = state.data.income.updatedAt,
    ) { entry ->
        LedgerRow(primary = entry.sourceName, secondary = entry.date,
            figure = Money.formatUsd(entry.amountCents), figureColor = LocalLedgerTheme.current.colors.gain)
    }
}

// ── Budget ──────────────────────────────────────────────────────────────────

private fun VaultLazyListScope.budget(
    state: VaultUiState,
    months: List<String>,
    spend: BudgetSpend?,
    selectedMonth: String?,
    selectedCategory: BudgetCategoryDrilldownScope?,
    onSelectMonth: (String) -> Unit,
    onAddIncome: () -> Unit,
    onOpenCategory: (BudgetCategoryDrilldownScope) -> Unit,
    /** The month the plan now names, after Convex accepted the copy. */
    onPlanCopied: (String) -> Unit = {},
) {
    val incomeMonth = selectedMonth ?: calendarMonth(state.now)
    if (months.size > 1 && (!state.data.incomeFiguresUnavailable || !state.data.budgetActualsUnavailable)) {
        item { MonthPicker(months, incomeMonth, onSelectMonth) }
    }
    incomeSection(state, incomeMonth, onAddIncome)
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
        val readable = slice.status == Freshness.LIVE || slice.status == Freshness.DEMO || slice.status == Freshness.EMPTY
        item {
            Panel {
                StateBlock(
                    if (readable) Freshness.EMPTY else slice.status,
                    title = if (readable) "No budget for this profile" else null,
                    detail = if (readable && state.activeProfile == FamilyMember.MADDOX) {
                        "Victor or Rachel can create Maddox's budget."
                    } else if (slice.status == Freshness.DEMO) {
                        "This demo profile has no sample budget."
                    } else if (readable) {
                        "Victor or Rachel can create a budget for this profile."
                    } else null, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() })
            }
        }
        return
    }

    val derived = spend ?: return
    val plannedUnavailable = slice.requiredProjectionUnavailable
    val actualsUnavailable = state.data.budgetActualsUnavailable
    val actualsStatus = state.data.budgetActualsStatus

    // A new month with no plan yet is the first thing to fix, so the offer sits
    // above the figures. Only a live read carries the revision the copy fences on;
    // the contract withholds the action otherwise.
    if (slice.status == Freshness.LIVE) {
        item {
            val app = LocalContext.current.applicationContext as? VaultApplication
            val reason = (app?.deviceCapabilities ?: DeviceCapabilities())
                .unavailableReason(state.activeProfile, DeviceCapability.BUDGET)
            BudgetPlanCarryAction(
                activeProfile = state.activeProfile,
                unavailableReason = reason,
                budget = budget,
                selectedMonth = derived.month,
                onCopied = onPlanCopied,
            )
        }
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
    item { StaleNotice(slice.status, slice.updatedAt, state.now) }
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
                StateBlock(actualsStatus, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() })
            }
        }
    } else {
        keyedPanel(
            sectionKey = "budget-categories",
            title = "Categories",
            source = "${slice.source} · ${derived.month} transactions",
            rows = derived.categories,
            rowKey = { it.name },
            revealKey = state.data.transactions.updatedAt,
        ) { category ->
            EditableBudgetCategoryRow(
                category = category,
                selected = selectedCategory == BudgetCategoryDrilldownScope(derived.month, category.name),
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
    /** Null when this month or read is not writable; the button is then absent, not disabled. */
    onEdit: (() -> Unit)? = null,
    editUnavailableReason: String? = null,
) {
    item {
        if (onEdit != null && editUnavailableReason != null) Text(editUnavailableReason, style = MaterialTheme.typography.bodySmall)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) {
                Text(stringResource(R.string.budget_category_transactions_back))
            }
            Spacer(Modifier.weight(1f))
            if (onEdit != null) {
                VaultButton(
                    label = stringResource(R.string.budget_category_edit_action),
                    onClick = onEdit,
                    enabled = editUnavailableReason == null,
                    secondary = true,
                )
            }
        }
    }
    item { StaleNotice(state.data.transactions.status, state.data.transactions.updatedAt, state.now) }
    item { StaleNotice(state.data.btcBillPays.status, state.data.btcBillPays.updatedAt, state.now) }

    if (state.data.budgetActualsUnavailable) {
        item {
            Panel(
                title = stringResource(R.string.budget_category_transactions_title, scope.category),
                source = "${state.data.budgetActualsStatus} · ${scope.month}",
            ) {
                StateBlock(state.data.budgetActualsStatus, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() })
            }
        }
        return
    }

    val category = state.data.budget.value?.let { budget ->
        deriveBudgetSpend(budget.copy(month = scope.month), transactions, billPays)
            ?.categories?.firstOrNull { it.name == scope.category }
    }
    if (category != null) {
        item {
            KpiStrip(listOf(
                Kpi("Remaining", Money.formatUsd(category.remainingCents),
                    hint = "OF ${Money.formatUsd(category.budgetCents)} planned"),
                Kpi("Spent", Money.formatUsd(category.spentCents)),
            ))
        }
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
    onAdd: () -> Unit,
    onNavigate: (Destination) -> Unit,
    capabilities: DeviceCapabilities,
    onAddAccount: () -> Unit,
    onWriteSucceeded: () -> Unit,
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
    item { StaleNotice(slice.status, slice.updatedAt, state.now) }
    val canWriteBitcoin = capabilities.allows(state.activeProfile, DeviceCapability.BITCOIN)
    item {
        val reason = capabilities.unavailableReason(state.activeProfile, DeviceCapability.BITCOIN)
        if (state.activeProfile.isAdult) {
            TextButton(onClick = onAddAccount, enabled = reason == null) { Text("Add account") }
            if (reason != null) Text(reason, style = MaterialTheme.typography.bodySmall)
        }
    }
    accountList(
        sectionKey = "bitcoin-accounts",
        title = "Accounts in net worth",
        source = slice.source,
        accounts = projection.accounts,
        status = slice.status,
        displayUnit = displayUnit,
        quote = quote,
    )
    item {
        if (state.activeProfile.isAdult) VaultButton("+ Add", onClick = onAdd, enabled = canWriteBitcoin)
        TextButton(onClick = { onNavigate(Destination.BTC_BUYS) }) { Text("Buys · See all") }
        TextButton(onClick = { onNavigate(Destination.BTC_BILL_PAYS) }) { Text("Bill Pays · See all") }
    }
    if (state.data.btcBuys.suppressFigures) {
        item {
            Panel("Recent buys", state.data.btcBuys.source) {
                StateBlock(state.data.btcBuys.status, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() })
            }
        }
    } else if (projection.buys.isEmpty()) {
        item {
            Panel("Recent buys", state.data.btcBuys.source) {
                StateBlock(Freshness.EMPTY, action = {
                    if (state.activeProfile.isAdult) {
                        TextButton(onClick = onAdd, enabled = canWriteBitcoin) { Text("Add") }
                        capabilities.unavailableReason(state.activeProfile, DeviceCapability.BITCOIN)?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                })
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
            if (state.data.btcBuys.status == Freshness.LIVE) BitcoinDeleteAction(
                state.activeProfile, BitcoinDeleteKind.BUY, buy.id, buy.owner, buy.updatedAtMs, onWriteSucceeded)
        }
    }
    if (!state.data.billPaysAvailableTo(state.activeProfile)) {
        item {
            Panel("Bitcoin bill pays", state.data.btcBillPays.source) {
                StateBlock(state.data.btcBillPays.status, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() })
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
            if (state.data.btcBillPays.status == Freshness.LIVE) BitcoinDeleteAction(
                state.activeProfile, BitcoinDeleteKind.BILL_PAY, payment.id, payment.owner, payment.updatedAtMs, onWriteSucceeded)
        }
    }
    val transfers = state.data.btcTransfers
    val visibleTransfers = transfers.value.visibleTo(state.activeProfile)
    if (transfers.suppressFigures || visibleTransfers.isEmpty()) {
        item { Panel("Transfers", transfers.source) {
            StateBlock(if (transfers.suppressFigures) transfers.status else Freshness.EMPTY, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() })
        } }
    } else {
        keyedPanel(sectionKey = "bitcoin-transfers", title = "Transfers", source = transfers.source,
            rows = visibleTransfers, rowKey = { "${it.owner.key}:${it.id}" }, revealKey = transfers.updatedAt) { transfer ->
            val accounts = state.data.btcAccounts.value.visibleTo(state.activeProfile)
            fun accountLabel(key: String) = accounts.firstOrNull { it.owner == transfer.owner && it.key == key }?.label ?: key
            LedgerRow(primary = "${accountLabel(transfer.fromAccountKey)} → ${accountLabel(transfer.toAccountKey)}",
                secondary = "${transfer.date} · Fee ${Money.formatSats(transfer.feeSats)}",
                figure = state.formatBitcoin(transfer.sats, displayUnit))
            if (transfers.status == Freshness.LIVE) BitcoinDeleteAction(state.activeProfile,
                BitcoinDeleteKind.TRANSFER, transfer.id, transfer.owner, transfer.updatedAtMs, onWriteSucceeded)
        }
    }

}

@Composable
internal fun BitcoinPriceHero(quote: MarketQuote?, nowMillis: Long? = null) {
    val tokens = LocalLedgerTheme.current
    val effects = LocalLedgerEffects.current
    // The figure settles from the last reading instead of jumping; the glow
    // takes one breath per new price and otherwise rests at the resting blur.
    val settledCents = rememberSettledCents(quote?.priceCents)
    val formatted = settledCents?.let(Money::formatUsd) ?: Money.PRICE_UNAVAILABLE
    val glowBlur = rememberPhosphorPulseBlur(
        trigger = quote?.priceCents,
        enabled = effects.showPhosphorGlow && tokens.treatment == LedgerTreatment.TERMINAL_DARK,
    )
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
                        style = tokens.type.priceHero.withLedgerPhosphorGlow(effects.showPhosphorGlow, glowBlur),
                        color = tokens.colors.bitcoin,
                    )
                    Text(
                        formatted.substring(decimalStart),
                        style = tokens.type.priceHeroDecimals.withLedgerPhosphorGlow(effects.showPhosphorGlow, glowBlur),
                        color = tokens.colors.priceDecimals,
                    )
                }
            }
            Text(
                operationalBitcoinPriceBasis(quote, nowMillis),
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
                StateBlock(status, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() })
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
                    detail = "This profile has no Bitcoin accounts counting toward its net worth.", action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() })
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
        append("Market quote")
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

private fun VaultLazyListScope.family(
    state: VaultUiState,
    profileSwitcher: @Composable () -> Unit,
) {
    item {
        Panel("Switch profile") { profileSwitcher() }
    }
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
}

// ── Settings ────────────────────────────────────────────────────────────────

private fun VaultLazyListScope.settings(
    state: VaultUiState,
    remoteReadReady: Boolean,
    onRemoteRowsConnected: () -> Unit,
    onEnableRemoteRows: (String) -> Unit,
    ledgerSettings: LedgerUiSettings,
    onLedgerSettingsChange: (LedgerUiSettings) -> Unit,
    displayUnit: DisplayUnit,
    onDisplayUnitChange: (DisplayUnit) -> Unit,
) {
    item { Panel("Display unit") { BitcoinUnitToggle(displayUnit, onDisplayUnitChange) } }
    item { LedgerAppearanceSettings(ledgerSettings, onLedgerSettingsChange) }
    item { BudgetNotificationSettings(state) }
    item { com.sats21m.vogelvault.ui.components.SectionLabel("Diagnostics") }
    item {
        Panel("Services") {
            Text("Household sync: Convex")
            state.marketQuotes?.quotes?.map { it.source }?.distinct()?.forEach { Text("Market data: $it") }
        }
    }
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
        Panel(stringResource(R.string.read_bootstrap_title)) {
            ReadBootstrapConfiguration(
                remoteReadReady = remoteReadReady,
                onConnected = { onRemoteRowsConnected() },
                modifier = Modifier.padding(vertical = VaultSpace.md),
                allowReset = state.activeProfile.isAdult,
                profile = state.activeProfile,
                onSaveReadToken = onEnableRemoteRows,
            )
        }
    }
    item { SyncTokenConfiguration() }
    item {
        Panel("Slices") {
            Column {
                listOf(
                    "Transactions" to state.data.transactions.status,
                    "Budget" to state.data.budget.status,
                    "Bitcoin accounts" to state.data.btcAccounts.status,
                    "Bitcoin buys" to state.data.btcBuys.status,
                    "Tasks" to state.data.todos.status,
                    "Income" to state.data.income.status,
                    "Bitcoin balance" to state.data.btcBalance.status,
                    "Bitcoin bill pays" to state.data.btcBillPays.status,
                    "Bitcoin transfers" to state.data.btcTransfers.status,
                    "Finances" to state.financeStatus,
                    "Market prices" to state.marketQuoteStatus,
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
private fun StaleNotice(status: Freshness, updatedAt: Long?, now: Long) {
    if (status != Freshness.STALE) return
    com.sats21m.vogelvault.ui.components.FreshnessTag(status, updatedAt, now, "Saved figures")
}
