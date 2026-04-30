import SwiftUI
import SwiftData

struct SpendingTab: View {
    @Query private var transactions: [Transaction]
    @Query private var categories: [BudgetCategory]
    @State private var monthOffset: Int = 0

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
        return transactions.filter {
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
                            categoryRow(name: catName, icon: icon, spent: spent, budget: budget)
                        }
                    }

                    if !sortedTransactions.isEmpty {
                        SectionHeader(title: "Recent Transactions", icon: "list.bullet.rectangle")
                        ForEach(sortedTransactions.prefix(20), id: \.id) { tx in
                            transactionRow(tx)
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

    private func categoryRow(name: String, icon: String, spent: Decimal, budget: Decimal) -> some View {
        let pct = budget > 0 ? spent / budget : 0
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(icon) \(name)")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppTheme.primaryText)
                Spacer()
                Text("\(formatCurrency(spent)) / \(formatCurrency(budget))")
                    .font(.caption)
                    .foregroundStyle(pct > 1.0 ? AppTheme.negative : AppTheme.secondaryText)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(AppTheme.background)
                        .frame(height: 7)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(
                            pct > 1.0
                            ? LinearGradient(colors: [AppTheme.negative, AppTheme.negative.opacity(0.6)], startPoint: .leading, endPoint: .trailing)
                            : LinearGradient(colors: [AppTheme.accentColor, AppTheme.accentColor.opacity(0.5)], startPoint: .leading, endPoint: .trailing)
                        )
                        .frame(width: max(0, min(geo.size.width, CGFloat(truncating: pct as NSNumber) * geo.size.width)), height: 7)
                }
            }
            .frame(height: 7)
        }
        .glassCard()
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

    private func transactionRow(_ tx: Transaction) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(tx.merchant)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppTheme.primaryText)
                Text(tx.date.formatted(date: .abbreviated, time: .omitted))
                    .font(.caption2)
                    .foregroundStyle(AppTheme.tertiaryText)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(formatCurrency(tx.amount))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.negative)
                Text(tx.category)
                    .font(.caption2)
                    .foregroundStyle(AppTheme.secondaryText)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(AppTheme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.white.opacity(0.04), lineWidth: 1)
        )
    }
}

#Preview {
    SpendingTab()
}
