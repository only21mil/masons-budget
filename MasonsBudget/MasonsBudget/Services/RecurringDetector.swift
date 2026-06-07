import Foundation

struct RecurringTransaction: Identifiable {
    let id = UUID()
    let merchant: String
    let category: String
    let averageAmount: Decimal
    let averageSats: Decimal
    let occurrences: Int
    let estimatedInterval: Int
    let lastDate: Date?
    let nextDate: Date?
    let confidence: Double
    let satsLastYear: Decimal?
    let yoyChangePct: Decimal?
}

final class RecurringDetector {
    func detect(from transactions: [Transaction], referenceDate: Date = Date()) -> [RecurringTransaction] {
        let cal = Calendar.current
        let now = referenceDate
        let oneYearAgo = cal.date(byAdding: .year, value: -1, to: now) ?? now
        let twoYearsAgo = cal.date(byAdding: .year, value: -2, to: now) ?? now

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
            let totalSats = group.reduce(Decimal(0)) { $0 + $1.satsValue() }
            let avgSats = totalSats / Decimal(group.count)

            let amountDenominator = max(abs(avgAmount), 1)
            let amountVariance = group.map {
                abs(Double(truncating: (($0.amount - avgAmount) / amountDenominator) as NSNumber))
            }.reduce(0, +) / Double(group.count)

            let sorted = group.sorted(by: { $0.date < $1.date })
            var intervals: [Int] = []
            for i in 1 ..< sorted.count {
                let days = cal.dateComponents([.day], from: sorted[i - 1].date, to: sorted[i].date).day ?? 0
                intervals.append(max(days, 1))
            }
            let medianInterval = Self.medianInterval(in: intervals)
            let cadenceIntervals = intervals.filter { $0 <= max(medianInterval * 2, 45) }
            let intervalsForCadence = cadenceIntervals.isEmpty ? intervals : cadenceIntervals
            let avgInterval = intervalsForCadence.isEmpty ? 30 : Int(Double(intervalsForCadence.reduce(0, +)) / Double(intervalsForCadence.count) + 0.5)

            let intervalVariance = intervalsForCadence.isEmpty ? 0.0 : Double(intervalsForCadence.map { abs($0 - avgInterval) }.reduce(0, +)) / Double(intervalsForCadence.count)

            let confidence = max(0, min(1, 1.0 - (amountVariance + intervalVariance / Double(max(avgInterval, 7)))))

            guard confidence > 0.4 else { continue }

            let lastDate = sorted.last?.date
            var nextDate: Date?
            if let last = lastDate, avgInterval > 0 {
                nextDate = cal.date(byAdding: .day, value: avgInterval, to: last)
            }

            let thisYearTxs = group.filter { $0.date >= oneYearAgo }
            let lastYearTxs = group.filter { $0.date >= twoYearsAgo && $0.date < oneYearAgo }

            var satsLastYear: Decimal?
            var yoyChangePct: Decimal?

            if !lastYearTxs.isEmpty {
                let lastYearTotal = lastYearTxs.reduce(Decimal(0)) { $0 + $1.satsValue() }
                satsLastYear = lastYearTotal

                if !thisYearTxs.isEmpty {
                    let thisYearTotal = thisYearTxs.reduce(Decimal(0)) { $0 + $1.satsValue() }
                    if lastYearTotal != 0 {
                        yoyChangePct = ((thisYearTotal - lastYearTotal) / abs(lastYearTotal)) * 100
                    }
                }
            }

            results.append(RecurringTransaction(
                merchant: first.merchant,
                category: first.category,
                averageAmount: avgAmount,
                averageSats: avgSats,
                occurrences: group.count,
                estimatedInterval: avgInterval,
                lastDate: lastDate,
                nextDate: nextDate,
                confidence: confidence,
                satsLastYear: satsLastYear,
                yoyChangePct: yoyChangePct,
            ))
        }

        return results.sorted(by: { $0.confidence > $1.confidence })
    }

    private static func medianInterval(in intervals: [Int]) -> Int {
        guard !intervals.isEmpty else { return 30 }
        let sorted = intervals.sorted()
        return sorted[sorted.count / 2]
    }
}
