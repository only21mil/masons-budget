import Charts
import SwiftData
import SwiftUI

struct HomeDashboardView: View {
    @Environment(\.theme) private var theme
    @Environment(CanonicalFinancialSourceStore.self) private var financials
    @AppStorage("selected_family_member") private var memberRaw = FamilyMember.victor.rawValue
    @AppStorage("display_unit") private var unitRaw = DisplayUnit.btc.rawValue
    @AppStorage(MarketQuoteService.cacheKey) private var quoteCache = Data()
    @AppStorage(ConvexSyncService.lastSyncKey) private var lastSync = 0.0
    @AppStorage(ConvexSyncService.versionsMemberKey) private var syncedMember = ""
    @Query private var holdings: [HoldingAccount]
    @Query(sort: \NetWorthSnapshot.date) private var snapshots: [NetWorthSnapshot]
    @Query(sort: \Transaction.date, order: .reverse) private var transactions: [Transaction]
    @Query(sort: \TodoItem.priority, order: .reverse) private var todos: [TodoItem]
    @Query private var categories: [BudgetCategory]
    @State private var addingTask = false

    private var member: FamilyMember { FamilyMember(rawValue: memberRaw) ?? .victor }
    private var unit: DisplayUnit { DisplayUnit(rawValue: unitRaw) ?? .btc }
    private var unitBinding: Binding<DisplayUnit> {
        Binding(get: { unit }, set: { unitRaw = $0.rawValue })
    }
    private var balance: CanonicalBTCBalance? {
        guard let balance = financials.btcBalance.value, member.sharesNetWorth(with: balance.owner) else { return nil }
        return balance
    }
    private var visibleTransactions: [Transaction] {
        transactions.filter { member.canSee(dataOwnedBy: $0.ownerMember) }
    }
    private var todayTasks: [TodoItem] {
        todos.filter {
            member.canAccessTodo(ownedBy: $0.ownerMember) && !$0.isDone &&
                SmartListFilter.today.matches($0, now: Date(), calendar: .current)
        }
    }
    private var retirementUSD: Decimal {
        holdings.filter { member.sharesNetWorth(with: $0.ownerMember) }
            .reduce(Decimal(0)) { $0 + $1.liveValue(vooPrice: StockPriceService.vooPrice, ibitPrice: StockPriceService.ibitPrice) }
    }
    private var netWorthUSD: Decimal? {
        guard let balance, let price = BTCPriceService.storedPrice, hasLoaded("finances") else { return nil }
        return Decimal(balance.totalSats) / 100_000_000 * price + retirementUSD
    }
    private var history: [NetWorthHistoryPoint] {
        guard let total = netWorthUSD else { return [] }
        return NetWorthHistory.recentMonths(
            snapshots: snapshots.filter { member.sharesNetWorth(with: $0.ownerMember) }.map {
                NetWorthHistoryPoint(date: $0.date, total: $0.totalValue, btc: $0.btcValue, holdings: $0.holdingsValue)
            },
            current: NetWorthHistoryPoint(date: Date(), total: total, btc: total - retirementUSD, holdings: retirementUSD)
        )
    }
    private var transactionSource: String { member.hasDedicatedChildFinanceFiles ? "mason-transactions" : "transactions" }
    private var budgetSource: String { member.hasDedicatedChildFinanceFiles ? "mason-budget" : "budget" }

    /// The source version proves a successful load, including a genuinely empty ledger.
    private func hasLoaded(_ source: String) -> Bool {
        _ = lastSync
        guard syncedMember == member.rawValue else { return false }
        return UserDefaults.standard.dictionary(forKey: ConvexSyncService.dataVersionsKey)?[source] != nil
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { _ in
            ScrollView {
                VStack(spacing: AppLayout.cardSpacing) {
                    ScreenHeader(title: "Home", eyebrow: member.displayName)
                    hero
                    custody
                    spentToday
                    todayPreview
                    recentActivity
                    budgetPreview
                }
                .padding(.bottom, AppLayout.cardSpacing)
            }
            .background(theme.bg)
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Net worth").ledgerType(.sectionLabel)
                Spacer(minLength: 8)
                UnitToggleView(unit: unitBinding, size: .sm)
            }
            NavigationLink {
                LedgerDrilldown(title: "Net Worth") { NetWorthView() }
            } label: {
                VStack(alignment: .leading, spacing: 10) {
                    if let total = netWorthUSD, let price = BTCPriceService.storedPrice {
                        AmountView(sats: total / price * 100_000_000, unit: unit, role: .heroNumeral, btcPrice: price)
                            .lineLimit(1).minimumScaleFactor(0.7)
                        if history.count > 1 {
                            Chart(history, id: \.date) { point in
                                LineMark(x: .value("Date", point.date), y: .value("USD", NSDecimalNumber(decimal: point.total).doubleValue))
                                    .foregroundStyle(theme.accent)
                            }
                            .chartXAxis(.hidden).chartYAxis(.hidden).frame(height: 64)
                            Text("Recorded USD history · \(NetWorthHistory.spanLabel(history))").ledgerType(.rowMeta)
                        }
                    } else {
                        Text("Net worth unavailable").ledgerType(.kpiValue)
                        Text("Refresh balances and prices to calculate your total.").ledgerType(.rowMeta)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            if let quote = MarketQuoteService.quote(.btc) {
                Text("BTC · \(quote.source) · \(quote.effectiveStatus().rawValue)").ledgerType(.rowMeta)
            }
            Text("Retirement includes recorded values when a market quote is unavailable.")
                .ledgerType(.rowMeta).foregroundStyle(theme.textMuted)
            HStack(spacing: 16) {
                link("Price") { BitcoinPriceView() }
                link("Retirement") { RetirementView() }
            }
        }
        .foregroundStyle(theme.text)
        .glassCard(padding: 16, radius: 4)
        .padding(.horizontal, AppLayout.sectionPadding)
    }

    private var custody: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let balance {
                ForEach([BTCCustody.selfCustody, .exchange], id: \.self) { custody in
                    let accounts = balance.accounts.filter { $0.custody == custody }
                    if !accounts.isEmpty {
                        NavigationLink {
                            LedgerDrilldown(title: custody == .selfCustody ? "Self-custody" : "Exchange accounts") {
                                BTCAccountDetailView(title: custody == .selfCustody ? "Self-custody" : "Exchange accounts", custody: custody)
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(custody == .selfCustody ? "Self-custody" : "Exchange accounts").ledgerType(.sectionLabel)
                                Text(accounts.map(\.label).joined(separator: " · ")).ledgerType(.rowMeta)
                                let sats = accounts.reduce(Decimal(0)) { $0 + Decimal($1.sats) }
                                if unit != .usd || BTCPriceService.storedPrice != nil {
                                    AmountView(sats: sats, unit: unit, role: .kpiValue, btcPrice: BTCPriceService.storedPrice ?? 0)
                                } else { Text("USD value unavailable").ledgerType(.rowMeta) }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassCard(padding: 16, radius: 4)
                        }.buttonStyle(.plain)
                    }
                }
            } else { Text("Bitcoin balances unavailable").ledgerType(.rowMeta) }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 16) { bitcoinLinks }
                VStack(alignment: .leading, spacing: 4) { bitcoinLinks }
            }
        }
        .foregroundStyle(theme.text)
        .padding(.horizontal, AppLayout.sectionPadding)
    }
    @ViewBuilder private var bitcoinLinks: some View {
        link("Accounts") { BitcoinOverviewView() }
        link("Buys") { BTCBuysView() }
        link("Bill Pay") { BTCBillPayView() }
    }

    private var spentToday: some View {
        NavigationLink {
            LedgerDrilldown(title: "Activity") { ActivityView(todayOnly: true) }
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                Text("Spent today").ledgerType(.sectionLabel)
                if hasLoaded(transactionSource) {
                    let total = HomeDashboardData.spentToday(transactions, viewer: member, now: Date())
                    Text(AppFormatter.formatCurrency(total)).ledgerType(.kpiValue)
                } else { Text("Unavailable").ledgerType(.rowPrimary) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard(padding: 16, radius: 4)
        }
        .buttonStyle(.plain).foregroundStyle(theme.text)
        .padding(.horizontal, AppLayout.sectionPadding)
    }

    private var todayPreview: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Today · \(todayTasks.count)").ledgerType(.sectionLabel)
                Spacer()
                link("See all") { TaskSmartListView(filter: .today) }
            }
            ForEach(Array(todayTasks.prefix(4))) { TaskRowView(todo: $0) }
            if todayTasks.isEmpty { Text("No tasks due today").ledgerType(.rowMeta) }
            InlineAddTaskBar(defaultDueDate: Date(), isExpanded: $addingTask)
        }
        .foregroundStyle(theme.text)
        .glassCard(padding: 16, radius: 4)
        .padding(.horizontal, AppLayout.sectionPadding)
    }

    private struct RecentEntry: Identifiable {
        let id: String
        let date: Date
        let transaction: Transaction?
        let income: ConvexIncomeRow?
    }
    private var recentEntries: [RecentEntry] {
        var entries = visibleTransactions.map { RecentEntry(id: "tx:" + $0.id, date: $0.date, transaction: $0, income: nil) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        entries += (financials.income.value?.rows ?? []).filter { member.canSee(dataOwnedBy: $0.owner) }.compactMap {
            guard let date = formatter.date(from: String($0.date.prefix(10))) else { return nil }
            return RecentEntry(id: "income:" + $0.incomeId, date: date, transaction: nil, income: $0)
        }
        return Array(entries.sorted { $0.date > $1.date }.prefix(4))
    }
    private var recentActivity: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Recent activity").ledgerType(.sectionLabel)
                Spacer()
                link("See all") { ActivityView() }
            }
            ForEach(recentEntries) { entry in
                if let tx = entry.transaction {
                    NavigationLink {
                        LedgerDrilldown(title: "Transaction") { TransactionDetailView(transaction: tx) }
                    } label: { recentRow(tx.merchant, date: entry.date, amount: tx.displayAmount) }
                    .buttonStyle(.plain)
                } else if let income = entry.income {
                    NavigationLink {
                        IncomeActivityDetail(row: income)
                    } label: { recentRow(income.source, date: entry.date, amount: Decimal(income.amountCents) / 100) }
                    .buttonStyle(.plain)
                }
            }
            if recentEntries.isEmpty {
                Text(hasLoaded(transactionSource) ? "No recent activity" : "Activity unavailable").ledgerType(.rowMeta)
            }
            if financials.income.value == nil { Text("Income unavailable").ledgerType(.rowMeta) }
        }
        .foregroundStyle(theme.text).glassCard(padding: 16, radius: 4)
        .padding(.horizontal, AppLayout.sectionPadding)
    }
    private func recentRow(_ title: String, date: Date, amount: Decimal) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).ledgerType(.rowPrimary)
            Text(date, format: .dateTime.month().day()).ledgerType(.rowMeta)
            Text(AppFormatter.formatCurrency(amount)).ledgerType(.rowFigure)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var budgetPreview: some View {
        VStack(alignment: .leading, spacing: 12) {
            link(Date().formatted(.dateTime.month(.wide).year()) + " budget") { BudgetView() }
            let scoped = categories.filter { member.sharesNetWorth(with: $0.ownerMember) && !$0.isIncome }
            let planned = scoped.reduce(Decimal(0)) { $0 + $1.monthlyBudget }
            if hasLoaded(budgetSource), hasLoaded(transactionSource), planned > 0 {
                let spent = transactions.filter {
                    member.sharesNetWorth(with: $0.ownerMember) && Calendar.current.isDate($0.date, equalTo: Date(), toGranularity: .month)
                }.reduce(Decimal(0)) { $0 + $1.spendAmount }
                Text("\(AppFormatter.formatCurrency(spent)) of \(AppFormatter.formatCurrency(planned)) planned").ledgerType(.rowFigure)
                LedgerProgressBar(fraction: NSDecimalNumber(decimal: spent / planned).doubleValue, fill: theme.accent, track: theme.border)
            } else {
                Text("No budget plan available").ledgerType(.rowMeta)
                BudgetPlanCarryAction(viewer: member, selectedMonth: Date()) { _ in }
            }
        }
        .foregroundStyle(theme.text).glassCard(padding: 16, radius: 4)
        .padding(.horizontal, AppLayout.sectionPadding)
    }
    private func link(_ title: String, @ViewBuilder destination: @escaping () -> some View) -> some View {
        NavigationLink { LedgerDrilldown(title: title, content: destination) } label: {
            Text(title).ledgerType(.button).frame(minHeight: 44)
        }.foregroundStyle(theme.accent)
    }
}

struct IncomeActivityDetail: View {
    let row: ConvexIncomeRow
    var body: some View {
        Form {
            LabeledContent("Source", value: row.source)
            LabeledContent("Date", value: row.date)
            LabeledContent("Amount", value: AppFormatter.formatCurrency(Decimal(row.amountCents) / 100))
            if let note = row.note { LabeledContent("Note", value: note) }
        }
        .navigationTitle("Income")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        #endif
    }
}

enum HomeDashboardData {
    static func spentToday(_ transactions: [Transaction], viewer: FamilyMember, now: Date, calendar: Calendar = .current) -> Decimal {
        transactions.filter { viewer.canSee(dataOwnedBy: $0.ownerMember) && calendar.isDate($0.date, inSameDayAs: now) }
            .reduce(Decimal(0)) { $0 + $1.spendAmount }
    }
}
