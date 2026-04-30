import SwiftUI
import SwiftData
import Charts

struct SpendingDonutChart: View {
    @Query private var transactions: [Transaction]
    @Query private var categories: [BudgetCategory]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var currentMonthTransactions: [Transaction] {
        let cal = Calendar.current
        let now = Date()
        return transactions.filter {
            $0.owner == currentMember && cal.isDate($0.date, equalTo: now, toGranularity: .month)
        }
    }

    private var totalSpent: Decimal {
        currentMonthTransactions.reduce(Decimal(0)) { $0 + $1.amount }
    }

    private var categoryBreakdown: [(String, Decimal, String)] {
        let iconMap = Dictionary(uniqueKeysWithValues: categories.map { ($0.name, $0.icon) })
        var spentByCategory: [String: Decimal] = [:]
        for tx in currentMonthTransactions {
            spentByCategory[tx.category, default: 0] += tx.amount
        }
        return spentByCategory.map { name, spent in
            (name, spent, iconMap[name] ?? "")
        }.sorted { $0.1 > $1.1 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Spending Breakdown", icon: "chart.pie.fill")

            if categoryBreakdown.isEmpty {
                emptyState
            } else {
                ZStack {
                    Chart(categoryBreakdown, id: \.0) { item in
                        SectorMark(
                            angle: .value("Spent", item.1),
                            innerRadius: .ratio(0.55),
                            angularInset: 1.5
                        )
                        .foregroundStyle(chartColor(for: item.0))
                    }
                    .frame(height: 200)

                    VStack(spacing: 2) {
                        Text(formatCurrency(totalSpent))
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(AppTheme.primaryText)
                        Text("this month")
                            .font(.system(size: 10))
                            .foregroundStyle(AppTheme.tertiaryText)
                    }
                }

                VStack(spacing: 8) {
                    ForEach(categoryBreakdown.prefix(8), id: \.0) { name, spent, icon in
                        HStack(spacing: 8) {
                            Circle()
                                .fill(chartColor(for: name))
                                .frame(width: 10, height: 10)
                            if !icon.isEmpty {
                                Text(icon)
                                    .font(.caption)
                            }
                            Text(name)
                                .font(.caption)
                                .foregroundStyle(AppTheme.secondaryText)
                                .lineLimit(1)
                            Spacer()
                            Text(formatCurrency(spent))
                                .font(.caption.weight(.medium))
                                .foregroundStyle(AppTheme.primaryText)
                            Text(pctString(spent))
                                .font(.caption2)
                                .foregroundStyle(AppTheme.tertiaryText)
                                .frame(width: 36, alignment: .trailing)
                        }
                    }
                }
            }
        }
        .glassCard()
    }

    private var emptyState: some View {
        HStack(spacing: 12) {
            Image(systemName: "chart.pie")
                .font(.title3)
                .foregroundStyle(AppTheme.tertiaryText)
            Text("Add transactions to see spending breakdown.")
                .font(.caption)
                .foregroundStyle(AppTheme.secondaryText)
        }
    }

    private func pctString(_ value: Decimal) -> String {
        guard totalSpent > 0 else { return "0%" }
        let pct = Double(truncating: (value / totalSpent * 100) as NSNumber)
        return String(format: "%.0f%%", pct)
    }

    private func chartColor(for category: String) -> Color {
        let colors: [Color] = [
            AppTheme.accentColor, AppTheme.secondaryAccent, AppTheme.warning,
            AppTheme.positive, Color(hex: 0x8B5CF6), Color(hex: 0xEC4899),
            Color(hex: 0x06B6D4), Color(hex: 0xF97316),
        ]
        let index = categoryBreakdown.firstIndex(where: { $0.0 == category }) ?? 0
        return colors[index % colors.count]
    }
}
