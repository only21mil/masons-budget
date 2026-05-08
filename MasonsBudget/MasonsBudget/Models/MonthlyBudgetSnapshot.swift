// Mason's Budget App — Monthly budget snapshot
// Mirrors MC2 budget.json top-level fields (balances, income, strategy).
// One snapshot per month, keyed by "April 2026" etc.

import Foundation
import SwiftData

@Model
final class MonthlyBudgetSnapshot {
    @Attribute(.unique) var monthKey: String
    var coinbaseOneBalance: Decimal
    var weeklyGross: Decimal
    var weeklyStrike: Decimal
    var weeklyRiver: Decimal
    var monthlyGross: Decimal
    var mtdIncome: Decimal = 0
    var ytdIncome: Decimal = 0
    var payFrequency: String
    var strategyNote: String?
    var lastUpdated: Date

    init(
        monthKey: String,
        coinbaseOneBalance: Decimal = 0,
        weeklyGross: Decimal = 0,
        weeklyStrike: Decimal = 0,
        weeklyRiver: Decimal = 0,
        monthlyGross: Decimal = 0,
        mtdIncome: Decimal = 0,
        ytdIncome: Decimal = 0,
        payFrequency: String = "weekly",
        strategyNote: String? = nil,
        lastUpdated: Date = .now
    ) {
        self.monthKey = monthKey
        self.coinbaseOneBalance = coinbaseOneBalance
        self.weeklyGross = weeklyGross
        self.weeklyStrike = weeklyStrike
        self.weeklyRiver = weeklyRiver
        self.monthlyGross = monthlyGross
        self.mtdIncome = mtdIncome
        self.ytdIncome = ytdIncome
        self.payFrequency = payFrequency
        self.strategyNote = strategyNote
        self.lastUpdated = lastUpdated
    }
}
