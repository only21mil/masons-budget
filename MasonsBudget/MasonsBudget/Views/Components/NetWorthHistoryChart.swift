import SwiftUI
import SwiftData
import Charts

struct NetWorthHistoryChart: View {
    @Query(sort: \NetWorthSnapshot.date, order: .forward) private var snapshots: [NetWorthSnapshot]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @State private var range: RangePicker.Range = .threeMonths

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var filteredSnapshots: [NetWorthSnapshot] {
        let mine = snapshots.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
        let cutoff = cutoffDate(for: range)
        return mine.filter { $0.date >= cutoff }
    }

    private var latestValue: Decimal {
        filteredSnapshots.last?.totalValue ?? 0
    }

    private var changeFromFirst: Decimal {
        guard let first = filteredSnapshots.first,
              let last = filteredSnapshots.last,
              first.totalValue > 0 else { return 0 }
        return last.totalValue - first.totalValue
    }

    private var changePct: Double {
        guard let first = filteredSnapshots.first,
              first.totalValue > 0,
              let last = filteredSnapshots.last else { return 0 }
        return Double(truncating: ((last.totalValue - first.totalValue) / first.totalValue * 100) as NSNumber)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Net Worth History", icon: "chart.line.uptrend.xyaxis")

            if filteredSnapshots.count < 2 {
                emptyState
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(formatCurrency(latestValue))
                            .font(.title2.weight(.bold))
                            .foregroundStyle(AppTheme.primaryText)
                        Spacer()
                        HStack(spacing: 4) {
                            Image(systemName: changeFromFirst >= 0 ? "arrow.up.right" : "arrow.down.right")
                                .font(.caption2.weight(.bold))
                            Text(String(format: "%+.1f%%", changePct))
                                .font(.caption.weight(.semibold).monospacedDigit())
                        }
                        .foregroundStyle(changeFromFirst >= 0 ? AppTheme.positive : AppTheme.negative)
                    }

                    Chart(filteredSnapshots, id: \.date) { snapshot in
                        AreaMark(
                            x: .value("Date", snapshot.date),
                            y: .value("Value", snapshot.totalValue)
                        )
                        .foregroundStyle(
                            LinearGradient(
                                colors: [AppTheme.accentColor.opacity(0.3), AppTheme.accentColor.opacity(0.0)],
                                startPoint: .top, endPoint: .bottom
                            )
                        )
                        .interpolationMethod(.catmullRom)

                        LineMark(
                            x: .value("Date", snapshot.date),
                            y: .value("Value", snapshot.totalValue)
                        )
                        .foregroundStyle(AppTheme.accentColor)
                        .interpolationMethod(.catmullRom)
                    }
                    .chartYAxis {
                        AxisMarks(position: .leading) { value in
                            AxisValueLabel {
                                if let v = value.as(Decimal.self) {
                                    Text(formatCurrency(v))
                                        .font(.system(size: 9))
                                        .foregroundStyle(AppTheme.tertiaryText)
                                }
                            }
                        }
                    }
                    .chartXAxis {
                        AxisMarks { _ in
                            AxisValueLabel(format: .dateTime.month(.abbreviated))
                                .font(.system(size: 10))
                                .foregroundStyle(AppTheme.tertiaryText)
                        }
                    }
                    .frame(height: 160)

                    RangePicker(selected: $range)
                }
            }
        }
        .glassCard()
    }

    private var emptyState: some View {
        HStack(spacing: 12) {
            Image(systemName: "chart.line.uptrend.xyaxis")
                .font(.title3)
                .foregroundStyle(AppTheme.tertiaryText)
            Text("Net worth history will build up over time as MC2 syncs your data.")
                .font(.caption)
                .foregroundStyle(AppTheme.secondaryText)
        }
    }

    private func cutoffDate(for range: RangePicker.Range) -> Date {
        let cal = Calendar.current
        let now = Date()
        switch range {
        case .oneMonth: return cal.date(byAdding: .month, value: -1, to: now) ?? now
        case .threeMonths: return cal.date(byAdding: .month, value: -3, to: now) ?? now
        case .sixMonths: return cal.date(byAdding: .month, value: -6, to: now) ?? now
        case .oneYear: return cal.date(byAdding: .year, value: -1, to: now) ?? now
        case .all: return .distantPast
        }
    }
}
