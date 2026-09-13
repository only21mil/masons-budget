import Foundation

struct NetWorthHistoryPoint {
    let date: Date
    let total: Decimal
    let btc: Decimal
    let holdings: Decimal
}

enum NetWorthHistory {
    /// Keep only observed months. The current valuation replaces this month's capture.
    static func recentMonths(
        snapshots: [NetWorthHistoryPoint], current: NetWorthHistoryPoint,
        calendar: Calendar = .current,
    ) -> [NetWorthHistoryPoint] {
        guard let month = calendar.dateInterval(of: .month, for: current.date)?.start,
              let start = calendar.date(byAdding: .month, value: -11, to: month)
        else { return [current] }
        var months: [Date: NetWorthHistoryPoint] = [:]
        for point in snapshots.sorted(by: { $0.date < $1.date }) where point.date >= start && point.date <= current.date {
            guard let key = calendar.dateInterval(of: .month, for: point.date)?.start else { continue }
            months[key] = point
        }
        months[month] = current
        return months.values.sorted { $0.date < $1.date }
    }

    static func change(_ points: [NetWorthHistoryPoint]) -> Decimal? {
        guard points.count >= 2, let first = points.first, let last = points.last else { return nil }
        return last.total - first.total
    }

    static func spanLabel(_ points: [NetWorthHistoryPoint]) -> String {
        guard points.count >= 2, let first = points.first, let last = points.last else { return "Current value" }
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, yyyy"
        return "\(formatter.string(from: first.date)) to \(formatter.string(from: last.date))"
    }
}

/// Income assumptions are valid only for the shared adult household.
enum RetirementProjectionInputs {
    static func income(
        viewer: FamilyMember, summary: CanonicalIncomeSummary?, month: String,
        matchingSnapshotIncome: Decimal?,
    ) -> Decimal? {
        guard viewer.isAdult, let summary,
              summary.rows.allSatisfy({ viewer.sharesNetWorth(with: $0.owner) })
        else { return nil }
        let fallback = matchingSnapshotIncome.flatMap { $0 >= 0 ? $0 : nil }
        return summary.amount(forMonth: month, emptyLedgerFallback: fallback)
    }
}
