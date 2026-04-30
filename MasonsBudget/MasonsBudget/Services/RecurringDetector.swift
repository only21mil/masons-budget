import Foundation

struct RecurringTransaction: Identifiable {
    let id = UUID()
    let merchant: String
    let category: String
    let averageAmount: Decimal
    let occurrences: Int
    let estimatedInterval: Int
    let lastDate: Date?
    let nextDate: Date?
    let confidence: Double
}

final class RecurringDetector {
    func detect(from transactions: [Transaction]) -> [RecurringTransaction] {
        var grouped: [String: [Transaction]] = [:]
        for tx in transactions {
            let key = "\(tx.merchant.lowercased())-\(tx.category)"
            grouped[key, default: []].append(tx)
        }

        var results: [RecurringTransaction] = []
        for (_, group) in grouped where group.count >= 2 {
            guard let first = group.first else { continue }

            let totalAmount = group.reduce(Decimal(0)) { $0 + $1.amount }
            let avgAmount = totalAmount / Decimal(group.count)

            let amountVariance = group.map {
                abs(Double(truncating: (($0.amount - avgAmount) / max(avgAmount, 1)) as NSNumber))
            }.reduce(0, +) / Double(group.count)

            let sorted = group.sorted(by: { $0.date < $1.date })
            var intervals: [Int] = []
            for i in 1..<sorted.count {
                let days = Calendar.current.dateComponents([.day], from: sorted[i-1].date, to: sorted[i].date).day ?? 0
                intervals.append(max(days, 1))
            }
            let avgInterval = intervals.isEmpty ? 30 : Int(Double(intervals.reduce(0, +)) / Double(intervals.count) + 0.5)

            let intervalVariance = intervals.isEmpty ? 0.0 : Double(intervals.map { abs($0 - avgInterval) }.reduce(0, +)) / Double(intervals.count)

            let confidence = max(0, min(1, 1.0 - (amountVariance + intervalVariance / Double(max(avgInterval, 7)))))

            guard confidence > 0.4 else { continue }

            let lastDate = sorted.last?.date
            var nextDate: Date?
            if let last = lastDate, avgInterval > 0 {
                nextDate = Calendar.current.date(byAdding: .day, value: avgInterval, to: last)
            }

            results.append(RecurringTransaction(
                merchant: first.merchant,
                category: first.category,
                averageAmount: avgAmount,
                occurrences: group.count,
                estimatedInterval: avgInterval,
                lastDate: lastDate,
                nextDate: nextDate,
                confidence: confidence
            ))
        }

        return results.sorted(by: { $0.confidence > $1.confidence })
    }
}
