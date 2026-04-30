import SwiftUI
import SwiftData
import Charts

struct MonthlyTrendChart: View {
    @Query private var snapshots: [MonthlyBudgetSnapshot]

    private var trendData: [(String, Decimal, Decimal, Decimal)] {
        snapshots
            .sorted { $0.monthKey < $1.monthKey }
            .map { snapshot in
                (String(snapshot.monthKey.prefix(3)), snapshot.monthlyGross, 0, snapshot.monthlyGross)
            }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Monthly Trends", icon: "chart.xyaxis.line")

            if trendData.isEmpty {
                HStack(spacing: 12) {
                    Image(systemName: "chart.line.downtrend.xyaxis")
                        .font(.title3)
                        .foregroundStyle(AppTheme.tertiaryText)
                    Text("Monthly trends will appear after syncing budget history from MC2.")
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                }
            } else {
                Chart {
                    ForEach(trendData, id: \.0) { item in
                        LineMark(
                            x: .value("Month", item.0),
                            y: .value("Income", item.1)
                        )
                        .foregroundStyle(AppTheme.accentColor)
                        .symbol(Circle().strokeBorder(lineWidth: 2))
                    }
                    ForEach(trendData, id: \.0) { item in
                        AreaMark(
                            x: .value("Month", item.0),
                            y: .value("Income", item.1)
                        )
                        .foregroundStyle(
                            LinearGradient(
                                colors: [AppTheme.accentColor.opacity(0.3), AppTheme.accentColor.opacity(0.02)],
                                startPoint: .top, endPoint: .bottom
                            )
                        )
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisValueLabel {
                            if let v = value.as(Decimal.self) {
                                Text(formatCurrency(v))
                                    .font(.system(size: 10))
                                    .foregroundStyle(AppTheme.tertiaryText)
                            }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks { _ in
                        AxisValueLabel()
                            .font(.system(size: 10))
                            .foregroundStyle(AppTheme.tertiaryText)
                    }
                }
                .frame(height: 180)
            }
        }
        .glassCard()
    }
}
