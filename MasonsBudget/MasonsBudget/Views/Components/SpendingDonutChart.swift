import SwiftUI
import SwiftData
import Charts

struct SpendingDonutChart: View {
    let categoryBreakdown: [(String, Decimal, String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Spending Breakdown", icon: "chart.pie.fill")

            if categoryBreakdown.isEmpty {
                emptyState
            } else {
                Chart(categoryBreakdown, id: \.0) { item in
                    SectorMark(
                        angle: .value("Spent", item.1),
                        innerRadius: .ratio(0.5),
                        angularInset: 1.5
                    )
                    .foregroundStyle(chartColor(for: item.0))
                }
                .frame(height: 220)

                VStack(spacing: 8) {
                    ForEach(categoryBreakdown.prefix(6), id: \.0) { name, spent, _ in
                        HStack(spacing: 8) {
                            Circle()
                                .fill(chartColor(for: name))
                                .frame(width: 10, height: 10)
                            Text(name)
                                .font(.caption)
                                .foregroundStyle(AppTheme.secondaryText)
                                .lineLimit(1)
                            Spacer()
                            Text(formatCurrency(spent))
                                .font(.caption.weight(.medium))
                                .foregroundStyle(AppTheme.primaryText)
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
