import SwiftUI
import SwiftData

struct SpendingTab: View {
    @Query private var transactions: [Transaction]
    @Query private var categories: [BudgetCategory]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @State private var monthOffset: Int = 0
    @State private var recurringItems: [RecurringTransaction] = []

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var myTransactions: [Transaction] {
        transactions.filter { $0.owner == currentMember }
    }

    private var selectedMonth: Date {
        Calendar.current.date(byAdding: .month, value: monthOffset, to: Date()) ?? Date()
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
        categories.reduce(Decimal(0)) { $0 + $1.monthlyBudget }
    }

    private var groupedByCategory: [(String, Decimal, Decimal, String)] {
        let categoryBudget = Dictionary(uniqueKeysWithValues: categories.map { ($0.name, $0.monthlyBudget) })
        let categoryIcons = Dictionary(uniqueKeysWithValues: categories.map { ($0.name, $0.icon) })
        var spentByCategory: [String: Decimal] = [:]
        for tx in selectedMonthTransactions {
            spentByCategory[tx.category, default: 0] += tx.amount
        }
        return categoryBudget.map { name, budget in
            (name, budget, spentByCategory[name] ?? 0, categoryIcons[name] ?? "?")
        }.sorted(by: { $0.2 > $1.2 })
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppTheme.cardSpacing) {
                    monthNavigator
                    spendingHero

                    if !groupedByCategory.isEmpty {
                        SectionHeader(title: "By Category", icon: "chart.bar.fill")
                        ForEach(groupedByCategory, id: \.0) { catName, budget, spent, icon in
                            CategoryRow(name: catName, icon: icon, spent: spent, budget: budget)
                        }
                    }

                    SpendingDonutChart()
                    MonthlyTrendChart()

                    if !recurringItems.isEmpty {
                        SectionHeader(title: "Recurring", icon: "arrow.triangle.2.circlepath")
                        ForEach(recurringItems.prefix(6)) { item in
                            recurringRow(item)
                        }
                    }

                    if !sortedTransactions.isEmpty {
                        SectionHeader(title: "Recent Transactions", icon: "list.bullet.rectangle")
                        ForEach(sortedTransactions.prefix(20), id: \.id) { tx in
                            TransactionRow(
                                merchant: tx.merchant,
                                amount: tx.amount,
                                category: tx.category,
                                date: tx.date,
                                card: tx.card
                            )
                        }
                    }
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle("Spending")
            .toolbarColorScheme(.dark, for: .navigationBar)
            .task {
                recurringItems = RecurringDetector().detect(from: myTransactions)
            }
        }
    }

    private func recurringRow(_ item: RecurringTransaction) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.merchant)
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.primaryText)
                HStack(spacing: 4) {
                    Text(item.category)
                        .font(.caption2)
                    Text("·")
                    Text("~\(item.estimatedInterval)d")
                        .font(.caption2)
                    Text("·")
                    Text("\(item.occurrences)×")
                        .font(.caption2)
                }
                .foregroundStyle(AppTheme.tertiaryText)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(formatCurrency(item.averageAmount))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppTheme.primaryText)
                if let next = item.nextDate {
                    Text("Next: \(next.formatted(date: .abbreviated, time: .omitted))")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.secondaryText)
                }
            }
        }
        .glassCard()
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

}

#Preview {
    SpendingTab()
}
