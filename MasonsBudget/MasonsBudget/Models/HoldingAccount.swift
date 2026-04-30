// Mason's Budget App — Retirement / brokerage models
// Mirrors MC2 finances.json structure.
// HoldingAccount → Holding → HoldingLot (cascading relationships).

import Foundation
import SwiftData

// MARK: - Account (e.g., "401k", "WAP")

@Model
final class HoldingAccount {
    @Attribute(.unique) var name: String
    var provider: String
    var owner: FamilyMember
    var totalValue: Decimal
    var weeklyContribution: Decimal
    var lastUpdated: Date

    @Relationship(deleteRule: .cascade) var holdings: [Holding] = []

    init(
        name: String,
        provider: String,
        owner: FamilyMember,
        totalValue: Decimal,
        weeklyContribution: Decimal = 0,
        lastUpdated: Date = .now
    ) {
        self.name = name
        self.provider = provider
        self.owner = owner
        self.totalValue = totalValue
        self.weeklyContribution = weeklyContribution
        self.lastUpdated = lastUpdated
    }
}

// MARK: - Individual holding (e.g., "VOO", "QQQ")

@Model
final class Holding {
    var name: String
    var category: String
    var ticker: String?
    var value: Decimal
    var costBasis: Decimal
    var gainPct: Decimal
    var shares: Decimal
    var avgCost: Decimal
    var currentPricePerShare: Decimal
    var isProxy: Bool
    var proxyNote: String?
    var account: HoldingAccount?

    @Relationship(deleteRule: .cascade) var lots: [HoldingLot] = []

    init(
        name: String,
        category: String,
        ticker: String? = nil,
        value: Decimal,
        costBasis: Decimal,
        gainPct: Decimal,
        shares: Decimal,
        avgCost: Decimal,
        currentPricePerShare: Decimal,
        isProxy: Bool = false,
        proxyNote: String? = nil
    ) {
        self.name = name
        self.category = category
        self.ticker = ticker
        self.value = value
        self.costBasis = costBasis
        self.gainPct = gainPct
        self.shares = shares
        self.avgCost = avgCost
        self.currentPricePerShare = currentPricePerShare
        self.isProxy = isProxy
        self.proxyNote = proxyNote
    }
}

// MARK: - Individual contribution lot (cost basis tracking)

@Model
final class HoldingLot {
    var date: Date
    var type: String
    var pricePerShare: Decimal
    var shares: Decimal
    var amountInvested: Decimal
    var note: String?
    var holding: Holding?

    init(
        date: Date,
        type: String,
        pricePerShare: Decimal,
        shares: Decimal,
        amountInvested: Decimal,
        note: String? = nil
    ) {
        self.date = date
        self.type = type
        self.pricePerShare = pricePerShare
        self.shares = shares
        self.amountInvested = amountInvested
        self.note = note
    }
}
