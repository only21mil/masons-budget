import SwiftUI
import SwiftData

struct SpendingTab: View {
    @Query private var transactions: [Transaction]
    @Query private var categories: [BudgetCategory]
    @Environment(\.modelContext) private var modelContext
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @State private var monthOffset: Int = 0
    @State private var transactionToDelete: Transaction?
    @State private var transactionToEdit: Transaction?
    private let syncClient = ConvexClient(deploymentURL: ConvexConfig.deploymentURL)

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var myTransactions: [Transaction] {
        transactions.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var selectedMonth: Date {
        Calendar.current.date(byAdding: .month, value: monthOffset, to: Date()) ?? Date()
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
        categories.filter { !$0.isIncome }.reduce(Decimal(0)) { $0 + $1.monthlyBudget }
    }

    private var groupedByCategory: [(name: String, budget: Decimal, spent: Decimal, icon: String)] {
        let expenseCategories = categories.filter { !$0.isIncome }
        let categoryBudget = Dictionary(uniqueKeysWithValues: expenseCategories.map { ($0.name, $0.monthlyBudget) })
        let categoryIcons = Dictionary(uniqueKeysWithValues: expenseCategories.map { ($0.name, $0.icon) })
        var spentByCategory: [String: Decimal] = [:]
        for tx in selectedMonthTransactions {
            spentByCategory[tx.category, default: 0] += tx.amount
        }
        return categoryBudget.map { name, budget in
            (name: name, budget: budget, spent: spentByCategory[name] ?? 0, icon: categoryIcons[name] ?? "?")
        }.sorted(by: { $0.spent > $1.spent })
    }

    private var eyebrowText: String {
        let fmt = DateFormatter()
        fmt.dateFormat = "MMM yyyy"
        let label = fmt.string(from: selectedMonth)
        return isCurrentMonth ? "\(label) · MTD" : label
    }

    var body: some View {
        #if os(iOS)
        NavigationStack {
            spendingContent
                .toolbarColorScheme(.dark, for: .navigationBar)
        }
        #else
        spendingContent
        #endif
    }

    private var spendingContent: some View {
        ScrollView {
            VStack(spacing: AppTheme.cardSpacing) {
                screenHeader
                monthStrip
                spentLimitCard
                categorySection
                transactionSection
            }
            .padding(.horizontal, AppTheme.horizontalPadding)
            .padding(.top, 8)
            .padding(.bottom, 100)
        }
        .background(AppTheme.background)
        .navigationTitle("Budget")
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

    // MARK: - Screen Header

    private var screenHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(eyebrowText.uppercased())
                .font(AppTheme.eyebrowFont)
                .tracking(1)
                .foregroundStyle(AppTheme.accentColor)
            Text("Budget")
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(AppTheme.primaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    // MARK: - Month Strip

    private var monthStrip: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(-5...0, id: \.self) { offset in
                        monthPill(offset: offset)
                            .id(offset)
                    }
                }
                .padding(.horizontal, 4)
            }
            .onChange(of: monthOffset) { _, newValue in
                withAnimation { proxy.scrollTo(newValue) }
            }
        }
    }

    private func monthPill(offset: Int) -> some View {
        let date = Calendar.current.date(byAdding: .month, value: offset, to: Date()) ?? Date()
        let cal = Calendar.current
        let txs = myTransactions.filter { cal.isDate($0.date, equalTo: date, toGranularity: .month) }
        let spent = txs.reduce(Decimal(0)) { $0 + $1.amount }
        let isSelected = offset == monthOffset
        let fmt = DateFormatter()
        fmt.dateFormat = "MMM"
        let monthAbbr = fmt.string(from: date)
        let year = cal.component(.year, from: date)

        return Button { monthOffset = offset } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(monthAbbr) '\(String(year).suffix(2))\(offset == 0 ? " · now" : "")")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(0.5)
                    .textCase(.uppercase)
                    .opacity(isSelected ? 0.85 : 0.55)
                Text(formatCurrency(spent))
                    .font(.system(size: 14, weight: .bold, design: .monospaced))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .foregroundStyle(isSelected ? .white : AppTheme.primaryText)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(isSelected ? AppTheme.accentColor : AppTheme.cardBackground)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(isSelected ? AppTheme.accentColor : AppTheme.cardBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Spent / Limit Card

    private var spentLimitCard: some View {
        let pct = totalBudgeted > 0 ? Double(truncating: (totalSpent / totalBudgeted) as NSNumber) : 0
        let saved = totalBudgeted - totalSpent

        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Spent / Limit")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.secondaryText)
                Spacer()
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(formatCurrency(totalSpent))
                        .font(.system(size: 20, weight: .bold, design: .monospaced))
                        .foregroundStyle(AppTheme.primaryText)
                    Text("/ \(formatCurrency(totalBudgeted))")
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(AppTheme.tertiaryText)
                }
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(AppTheme.surface2)
                        .frame(height: 8)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(AppTheme.accentColor)
                        .frame(width: max(0, min(geo.size.width, CGFloat(pct) * geo.size.width)), height: 8)
                }
            }
            .frame(height: 8)

            HStack {
                Text("\(Int(pct * 100))% of budget spent")
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.secondaryText)
                Spacer()
                if saved >= 0 {
                    Text("\(formatCurrency(saved)) left")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.positive)
                } else {
                    Text("\(formatCurrency(-saved)) over")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.negative)
                }
            }
        }
        .glassCard()
    }

    // MARK: - Categories

    private var categorySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !groupedByCategory.isEmpty {
                Text("CATEGORIES")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(AppTheme.secondaryText)
                    .padding(.horizontal, 4)

                ForEach(groupedByCategory, id: \.name) { cat in
                    NavigationLink {
                        CategoryDetailView(
                            categoryName: cat.name,
                            categoryIcon: cat.icon,
                            budget: cat.budget,
                            spent: cat.spent,
                            transactions: selectedMonthTransactions.filter { $0.category == cat.name }
                        )
                    } label: {
                        budgetCategoryCard(name: cat.name, icon: cat.icon, spent: cat.spent, budget: cat.budget)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func budgetCategoryCard(name: String, icon: String, spent: Decimal, budget: Decimal) -> some View {
        let pct = budget > 0 ? Double(truncating: (spent / budget) as NSNumber) : 0
        let over = pct > 1.0
        let close = pct >= 0.85 && !over
        let statusColor = over ? AppTheme.negative : (close ? AppTheme.warning : AppTheme.positive)
        let statusBg = over ? AppTheme.negativeSoft : (close ? AppTheme.warningSoft : AppTheme.positiveSoft)
        let statusLabel = over ? "OVER" : (close ? "CLOSE" : "ON TRACK")
        let remainingPct = max(0, Int((1.0 - pct) * 100))

        return HStack(spacing: 12) {
            Text(icon)
                .font(.system(size: 18))
                .frame(width: 38, height: 38)
                .background(statusBg)
                .clipShape(RoundedRectangle(cornerRadius: 12))

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    HStack(spacing: 8) {
                        Text(name)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(AppTheme.primaryText)
                        Text(statusLabel)
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .tracking(0.5)
                            .foregroundStyle(statusColor)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(statusBg)
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                    Spacer()
                    Text(formatCurrency(spent))
                        .font(AppTheme.monoData)
                        .foregroundStyle(AppTheme.primaryText)
                }

                HStack(spacing: 10) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 3)
                                .fill(AppTheme.surface2)
                                .frame(height: 6)
                            RoundedRectangle(cornerRadius: 3)
                                .fill(statusColor)
                                .frame(width: max(0, min(geo.size.width, CGFloat(min(pct, 1.0)) * geo.size.width)), height: 6)
                        }
                    }
                    .frame(height: 6)

                    if over {
                        Text("+\(Int((pct - 1.0) * 100))% over")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundStyle(AppTheme.negative)
                            .frame(minWidth: 76, alignment: .trailing)
                    } else {
                        Text("\(remainingPct)% left")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundStyle(statusColor)
                            .frame(minWidth: 76, alignment: .trailing)
                    }
                }
            }
        }
        .glassCard()
    }

    // MARK: - Transactions

    private var transactionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !sortedTransactions.isEmpty {
                Text("TRANSACTIONS")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(AppTheme.secondaryText)
                    .padding(.horizontal, 4)

                VStack(spacing: 0) {
                    ForEach(Array(sortedTransactions.prefix(20).enumerated()), id: \.element.id) { index, tx in
                        Button {
                            transactionToEdit = tx
                        } label: {
                            HStack(spacing: 12) {
                                Text(String(tx.merchant.prefix(1)).uppercased())
                                    .font(.system(size: 13, weight: .bold, design: .monospaced))
                                    .foregroundStyle(AppTheme.accentColor)
                                    .frame(width: 34, height: 34)
                                    .background(AppTheme.accentSoft)
                                    .clipShape(RoundedRectangle(cornerRadius: 10))

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(tx.merchant)
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(AppTheme.primaryText)
                                        .lineLimit(1)
                                    HStack(spacing: 4) {
                                        Text(tx.category)
                                            .font(.system(size: 11))
                                            .foregroundStyle(AppTheme.tertiaryText)
                                        if let card = tx.card {
                                            Text(card)
                                                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                                                .foregroundStyle(AppTheme.accentColor)
                                                .padding(.horizontal, 5)
                                                .padding(.vertical, 1)
                                                .background(AppTheme.accentSoft)
                                                .clipShape(Capsule())
                                        }
                                    }
                                }

                                Spacer()

                                Text(formatCurrency(tx.amount))
                                    .font(AppTheme.monoData)
                                    .foregroundStyle(AppTheme.primaryText)
                            }
                            .padding(.vertical, 12)
                            .padding(.horizontal, 14)
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

                        if index < min(sortedTransactions.count, 20) - 1 {
                            Divider()
                                .background(AppTheme.cardBorder)
                                .padding(.leading, 60)
                        }
                    }
                }
                .background(AppTheme.cardBackground)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
                .overlay(
                    RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                        .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
                )
            }
        }
    }

    // MARK: - Sync

    private func saveAndSync(_ transaction: Transaction) {
        do {
            try modelContext.save()
            pushTransaction(transaction)
        } catch {
            assertionFailure("Failed to save edited transaction: \(error)")
        }
    }

    private func pushTransaction(_ transaction: Transaction) {
        let fileName = transaction.ownerMember == .mason ? "mason-transactions" : "transactions"
        let dto = MC2Transaction(appTransaction: transaction)
        Task {
            do {
                try await syncClient.appendTransaction(dto, to: fileName)
            } catch {
                assertionFailure("Failed to sync edited transaction: \(error)")
            }
        }
    }
}

#Preview {
    SpendingTab()
}
