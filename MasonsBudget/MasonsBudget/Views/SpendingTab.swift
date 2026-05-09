import SwiftUI
import SwiftData

struct SpendingTab: View {
    private let title: String
    @Query private var transactions: [Transaction]
    @Query private var categories: [BudgetCategory]
    @Query private var snapshots: [MonthlyBudgetSnapshot]
    @Query(sort: \BTCBillPay.date, order: .reverse) private var btcBillPays: [BTCBillPay]
    @Environment(\.modelContext) private var modelContext
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @AppStorage(BTCPriceService.priceKey) private var liveBTCPriceUSD: Double = 0
    @AppStorage("btc_display_unit") private var btcDisplayUnitRaw: String = BitcoinDisplayUnit.btc.rawValue
    @State private var monthOffset: Int = 0
    @State private var transactionToDelete: Transaction?
    @State private var transactionToEdit: Transaction?
    private let syncClient = ConvexClient(deploymentURL: ConvexConfig.deploymentURL)

    init(title: String = "Budget") {
        self.title = title
    }

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var liveBTCPrice: Decimal? {
        liveBTCPriceUSD > 0 ? Decimal(liveBTCPriceUSD) : nil
    }

    private var myTransactions: [Transaction] {
        transactions.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var budgetCategories: [BudgetCategory] {
        currentMember.showsFullBudget ? categories : []
    }

    private var budgetSnapshots: [MonthlyBudgetSnapshot] {
        currentMember.showsFullBudget ? snapshots : []
    }

    private var selectedMonth: Date {
        if let month = selectedHistoryMonth {
            return month
        }
        return Calendar.current.date(byAdding: .month, value: monthOffset, to: Date()) ?? Date()
    }

    private var monthLabel: String {
        let fmt = DateFormatter()
        fmt.dateFormat = "MMMM yyyy"
        return fmt.string(from: selectedMonth)
    }

    private var isCurrentMonth: Bool { monthOffset == 0 }

    private var selectedMonthTransactions: [Transaction] {
        let cal = Calendar.current
        return myTransactions.filter {
            cal.isDate($0.date, equalTo: selectedMonth, toGranularity: .month)
        }
    }

    private var sortedTransactions: [Transaction] {
        selectedMonthTransactions.sorted(by: { $0.date > $1.date })
    }

    private var totalSpent: Decimal {
        selectedMonthTransactions.reduce(Decimal(0)) { $0 + $1.amount }
    }

    private var totalBudgeted: Decimal {
        budgetCategories.reduce(Decimal(0)) { $0 + $1.monthlyBudget }
    }

    private var groupedByCategory: [(String, Decimal, Decimal, String)] {
        let categoryBudget = Dictionary(uniqueKeysWithValues: budgetCategories.map { ($0.name, $0.monthlyBudget) })
        let categoryIcons = Dictionary(uniqueKeysWithValues: budgetCategories.map { ($0.name, $0.icon) })
        var spentByCategory: [String: Decimal] = [:]
        for tx in selectedMonthTransactions {
            spentByCategory[tx.category, default: 0] += tx.amount
        }
        return categoryBudget.map { name, budget in
            (name, budget, spentByCategory[name] ?? 0, categoryIcons[name] ?? "?")
        }.sorted(by: { $0.2 > $1.2 })
    }

    private var selectedMonthBillPays: [BTCBillPay] {
        let cal = Calendar.current
        return btcBillPays.filter { pay in
            currentMember.canSee(dataOwnedBy: pay.ownerMember) &&
                cal.isDate(pay.date, equalTo: selectedMonth, toGranularity: .month)
        }
        .sorted { $0.date > $1.date }
    }

    private var historyMonths: [Date] {
        let calendar = Calendar.current
        let starts = Set(myTransactions.map { calendar.startOfMonth(for: $0.date) })
        let snapshotStarts = budgetSnapshots.compactMap { parseMonthYear($0.monthKey) }.map { calendar.startOfMonth(for: $0) }
        let all = Array(starts.union(snapshotStarts)).sorted()
        if all.isEmpty {
            return (0..<12).compactMap {
                calendar.date(byAdding: .month, value: -11 + $0, to: calendar.startOfMonth(for: Date()))
            }
        }
        return Array(all.suffix(12))
    }

    private var selectedHistoryMonth: Date? {
        let index = historyMonths.count - 1 + monthOffset
        guard historyMonths.indices.contains(index) else { return nil }
        return historyMonths[index]
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppTheme.cardSpacing) {
                    monthStrip
                    monthNavigator
                    spendingHero

                    if !groupedByCategory.isEmpty {
                        SectionHeader(title: "By Category", icon: "chart.bar.fill")
                        ForEach(groupedByCategory, id: \.0) { catName, budget, spent, icon in
                            NavigationLink {
                                CategoryDetailView(
                                    categoryName: catName,
                                    categoryIcon: icon,
                                    budget: budget,
                                    spent: spent,
                                    transactions: selectedMonthTransactions.filter { $0.category == catName }
                                )
                            } label: {
                                CategoryRow(name: catName, icon: icon, spent: spent, budget: budget)
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    if !selectedMonthBillPays.isEmpty {
                        bitcoinBillPaySection
                    }

                    SpendingDonutChart(selectedMonth: selectedMonth)
                    MonthlyTrendChart()

                    if !sortedTransactions.isEmpty {
                        SectionHeader(title: "Recent Transactions", icon: "list.bullet.rectangle")
                        ForEach(sortedTransactions.prefix(20), id: \.id) { tx in
                            Button {
                                transactionToEdit = tx
                            } label: {
                                TransactionRow(
                                    merchant: tx.merchant,
                                    amount: tx.amount,
                                    category: tx.category,
                                    date: tx.date,
                                    card: tx.card
                                )
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button {
                                    transactionToEdit = tx
                                } label: {
                                    Label("Edit", systemImage: "pencil")
                                }
                                Button(role: .destructive) {
                                    transactionToDelete = tx
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle(title)
            #if os(iOS)
            .toolbarColorScheme(.dark, for: .navigationBar)
            #endif
            .sheet(isPresented: Binding(
                get: { transactionToEdit != nil },
                set: { if !$0 { transactionToEdit = nil } }
            )) {
                if let tx = transactionToEdit {
                    EditTransactionView(transaction: tx) { savedTransaction in
                        saveAndSync(savedTransaction)
                        transactionToEdit = nil
                    }
                }
            }
            .alert("Delete Transaction?", isPresented: Binding(
                get: { transactionToDelete != nil },
                set: { if !$0 { transactionToDelete = nil } }
            )) {
                Button("Cancel", role: .cancel) { transactionToDelete = nil }
                Button("Delete", role: .destructive) {
                    if let tx = transactionToDelete {
                        modelContext.delete(tx)
                        try? modelContext.save()
                    }
                    transactionToDelete = nil
                }
            } message: {
                if let tx = transactionToDelete {
                    Text("Delete \(tx.merchant) — \(formatCurrency(tx.amount))?")
                }
            }
        }
    }

    private var bitcoinBillPaySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Bitcoin Bill Pay", icon: "bitcoinsign.circle.fill")
            ForEach(selectedMonthBillPays.prefix(6), id: \.id) { pay in
                HStack(spacing: 12) {
                    Image(systemName: "bolt.circle.fill")
                        .foregroundStyle(AppTheme.accentColor)
                        .font(.title3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(pay.merchant)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppTheme.primaryText)
                        Text("\(pay.platform) · \(pay.date.formatted(date: .abbreviated, time: .omitted))")
                            .font(.caption2)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(formatCurrency(pay.amountUSD))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppTheme.primaryText)
                        BitcoinAmountView(
                            btc: pay.btcSpent,
                            unit: BitcoinDisplayUnit(rawValue: btcDisplayUnitRaw) ?? .btc,
                            liveBTCPrice: liveBTCPrice,
                            font: .caption2,
                            color: AppTheme.secondaryText
                        )
                    }
                }
                .glassCard()
            }
        }
    }

    private var spendingHero: some View {
        let pct = totalBudgeted > 0 ? Double(truncating: (totalSpent / totalBudgeted) as NSNumber) : 0
        return HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("MONTHLY SPENDING")
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
                    .tracking(0.5)
                Text(formatCurrency(totalSpent))
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .foregroundStyle(AppTheme.primaryText)
                Text("of \(formatCurrency(totalBudgeted)) budgeted")
                    .font(.caption2)
                    .foregroundStyle(AppTheme.tertiaryText)
            }
            Spacer()
            if totalBudgeted > 0 {
                ZStack {
                    Circle()
                        .stroke(AppTheme.background, lineWidth: 6)
                    Circle()
                        .trim(from: 0, to: min(pct, 1.0))
                        .stroke(
                            pct > 1.0 ? AppTheme.negative : AppTheme.accentColor,
                            style: StrokeStyle(lineWidth: 6, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))
                    VStack(spacing: 0) {
                        Text("\(Int(pct * 100))%")
                            .font(.system(size: 14, weight: .bold, design: .rounded))
                            .foregroundStyle(AppTheme.primaryText)
                        Text("used")
                            .font(.system(size: 8))
                            .foregroundStyle(AppTheme.tertiaryText)
                    }
                }
                .frame(width: 56, height: 56)
            }
        }
        .glassCard(highlight: true)
    }

    private func saveAndSync(_ transaction: Transaction) {
        do {
            try modelContext.save()
            pushTransaction(transaction)
        } catch {
            assertionFailure("Failed to save edited transaction: \(error)")
        }
    }

    private func pushTransaction(_ transaction: Transaction) {
        let fileName = transaction.ownerMember.mc2TransactionsFileName
        let dto = MC2Transaction(appTransaction: transaction)
        Task {
            do {
                try await syncClient.appendTransaction(dto, to: fileName)
            } catch {
                assertionFailure("Failed to sync edited transaction: \(error)")
            }
        }
    }

    private var monthNavigator: some View {
        HStack {
            Button { monthOffset -= 1 } label: {
                Image(systemName: "chevron.left")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AppTheme.accentColor)
                    .frame(width: 36, height: 36)
            }
            Spacer()
            Text(monthLabel)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppTheme.primaryText)
            Spacer()
            Button {
                if !isCurrentMonth { monthOffset += 1 }
            } label: {
                Image(systemName: "chevron.right")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(isCurrentMonth ? AppTheme.tertiaryText : AppTheme.accentColor)
                    .frame(width: 36, height: 36)
            }
            .disabled(isCurrentMonth)
        }
        .padding(.horizontal, 4)
    }

    private var monthStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(historyMonths.enumerated()), id: \.offset) { index, month in
                    let offset = index - (historyMonths.count - 1)
                    let selected = Calendar.current.isDate(month, equalTo: selectedMonth, toGranularity: .month)
                    Button {
                        monthOffset = offset
                    } label: {
                        monthChip(month: month, selected: selected)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func monthChip(month: Date, selected: Bool) -> some View {
        let spending = spending(for: month)
        let income = income(for: month)
        let saved = income - spending
        let rate = income > 0 ? Double(truncating: (saved / income) as NSNumber) : 0

        return VStack(alignment: .leading, spacing: 4) {
            Text(month.formatted(.dateTime.month(.abbreviated).year(.twoDigits)))
                .font(.system(size: 10, weight: .bold))
                .textCase(.uppercase)
            Text(formatCurrency(spending))
                .font(AppTheme.monoCaption.weight(.bold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(income > 0 ? "\(Int(rate * 100))% saved" : "No income")
                .font(.system(size: 10, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .foregroundStyle(selected ? Color.white : AppTheme.primaryText)
        .frame(width: 82, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(selected ? AppTheme.accentColor : AppTheme.cardBackground, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(selected ? AppTheme.accentColor : AppTheme.cardBorder, lineWidth: 1)
        )
    }

    private func spending(for month: Date) -> Decimal {
        let cal = Calendar.current
        return myTransactions
            .filter {
                cal.isDate($0.date, equalTo: month, toGranularity: .month) &&
                !$0.category.localizedCaseInsensitiveContains("income")
            }
            .reduce(Decimal(0)) { $0 + $1.amount }
    }

    private func income(for month: Date) -> Decimal {
        if let snapshot = budgetSnapshots.first(where: { snapshot in
            guard let snapshotMonth = parseMonthYear(snapshot.monthKey) else { return false }
            return Calendar.current.isDate(snapshotMonth, equalTo: month, toGranularity: .month)
        }) {
            return snapshot.mtdIncome > 0 ? snapshot.mtdIncome : snapshot.monthlyGross
        }
        return myTransactions
            .filter {
                Calendar.current.isDate($0.date, equalTo: month, toGranularity: .month) &&
                $0.category.localizedCaseInsensitiveContains("income")
            }
            .reduce(Decimal(0)) { $0 + $1.amount }
    }

    private func parseMonthYear(_ raw: String) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "MMMM yyyy"
        return formatter.date(from: raw)
    }

}

private extension Calendar {
    func startOfMonth(for date: Date) -> Date {
        let components = dateComponents([.year, .month], from: date)
        return self.date(from: components) ?? startOfDay(for: date)
    }
}

#Preview {
    SpendingTab()
}
