// Mason's Budget App — SwiftData models (DRAFT — STALE)
//
// Lane D 2026-09-07: retained as historical sketch only. Not compiled into any
// client target. Production SwiftData / app models live under MasonsBudget/.
//
// Schema mirrors ~/Workspace MC2/mission-control/*.json so the iOS app and
// MC2 read/write the same data. See PLAN.md for context.
//
// Layered model:
//   - Local SwiftData store on the device for fast reads + offline writes.
//   - iCloud Drive sync layer hydrates SwiftData from MC2 JSON files at app open
//     and on file-change events, and writes append-only event files back.
//
// Conventions:
//   - Money is `Decimal` (never Double — financial precision).
//   - Bitcoin is `Decimal` for BTC and `Int64` for sats. Always derive one from the other.
//   - All entities have a stable string `id` matching MC2's id format where present
//     (e.g., "b-strike-2026-04-01" for BTC buys, "t005" or "mortgage-2026-03-01" for transactions).
//   - Timestamps in UTC; render in user's local zone.

import Foundation
import SwiftData

// MARK: - Spending

@Model
final class Transaction {
    @Attribute(.unique) var id: String
    var date: Date
    var merchant: String
    var amount: Decimal
    var category: String
    var card: String?
    var note: String?
    var createdBy: String
    var createdAt: Date
    var sourceFile: String?

    init(
        id: String,
        date: Date,
        merchant: String,
        amount: Decimal,
        category: String,
        card: String? = nil,
        note: String? = nil,
        createdBy: String,
        createdAt: Date = .now,
        sourceFile: String? = nil
    ) {
        self.id = id
        self.date = date
        self.merchant = merchant
        self.amount = amount
        self.category = category
        self.card = card
        self.note = note
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.sourceFile = sourceFile
    }
}

@Model
final class Category {
    @Attribute(.unique) var name: String
    var icon: String
    var monthlyBudget: Decimal
    var sortOrder: Int
    var isIncome: Bool

    init(name: String, icon: String, monthlyBudget: Decimal, sortOrder: Int = 0, isIncome: Bool = false) {
        self.name = name
        self.icon = icon
        self.monthlyBudget = monthlyBudget
        self.sortOrder = sortOrder
        self.isIncome = isIncome
    }
}

@Model
final class MonthlyBudgetSnapshot {
    @Attribute(.unique) var monthKey: String
    var avenBalance: Decimal
    var coinbaseOneBalance: Decimal
    var weeklyGross: Decimal
    var weeklyStrike: Decimal
    var weeklyRiver: Decimal
    var monthlyGross: Decimal
    var payFrequency: String
    var strategyNote: String?
    var lastUpdated: Date

    init(
        monthKey: String,
        avenBalance: Decimal = 0,
        coinbaseOneBalance: Decimal = 0,
        weeklyGross: Decimal = 0,
        weeklyStrike: Decimal = 0,
        weeklyRiver: Decimal = 0,
        monthlyGross: Decimal = 0,
        payFrequency: String = "weekly",
        strategyNote: String? = nil,
        lastUpdated: Date = .now
    ) {
        self.monthKey = monthKey
        self.avenBalance = avenBalance
        self.coinbaseOneBalance = coinbaseOneBalance
        self.weeklyGross = weeklyGross
        self.weeklyStrike = weeklyStrike
        self.weeklyRiver = weeklyRiver
        self.monthlyGross = monthlyGross
        self.payFrequency = payFrequency
        self.strategyNote = strategyNote
        self.lastUpdated = lastUpdated
    }
}

// MARK: - Bitcoin

@Model
final class BTCAccount {
    @Attribute(.unique) var key: String
    var label: String
    var custody: BTCCustody
    var btc: Decimal
    var fiat: Decimal
    var owner: FamilyMember
    var lastUpdated: Date

    init(key: String, label: String, custody: BTCCustody, btc: Decimal, fiat: Decimal = 0, owner: FamilyMember, lastUpdated: Date = .now) {
        self.key = key
        self.label = label
        self.custody = custody
        self.btc = btc
        self.fiat = fiat
        self.owner = owner
        self.lastUpdated = lastUpdated
    }
}

enum BTCCustody: String, Codable {
    case exchange
    case selfCustody = "self_custody"
}

enum FamilyMember: String, Codable, CaseIterable {
    case victor
    case rachel
    case mason
    case maddox
}

@Model
final class BTCBuy {
    @Attribute(.unique) var id: String
    var date: Date
    var source: String
    var amountBTC: Decimal
    var amountSats: Int64
    var priceUSD: Decimal
    var usd: Decimal
    var note: String?
    var status: String
    var costBasisStatus: String
    var loggedBy: String?
    var archimedesRequestId: String?

    init(
        id: String,
        date: Date,
        source: String,
        amountBTC: Decimal,
        amountSats: Int64,
        priceUSD: Decimal,
        usd: Decimal,
        note: String? = nil,
        status: String = "complete",
        costBasisStatus: String = "complete",
        loggedBy: String? = nil,
        archimedesRequestId: String? = nil
    ) {
        self.id = id
        self.date = date
        self.source = source
        self.amountBTC = amountBTC
        self.amountSats = amountSats
        self.priceUSD = priceUSD
        self.usd = usd
        self.note = note
        self.status = status
        self.costBasisStatus = costBasisStatus
        self.loggedBy = loggedBy
        self.archimedesRequestId = archimedesRequestId
    }
}

@Model
final class BTCBillPay {
    @Attribute(.unique) var id: String
    var date: Date
    var merchant: String
    var category: String
    var amountUSD: Decimal
    var btcSpent: Decimal
    var btcPrice: Decimal
    var feeUSD: Decimal?
    var platform: String
    var note: String?
    var reference: String?

    init(
        id: String,
        date: Date,
        merchant: String,
        category: String,
        amountUSD: Decimal,
        btcSpent: Decimal,
        btcPrice: Decimal,
        feeUSD: Decimal? = nil,
        platform: String = "Strike",
        note: String? = nil,
        reference: String? = nil
    ) {
        self.id = id
        self.date = date
        self.merchant = merchant
        self.category = category
        self.amountUSD = amountUSD
        self.btcSpent = btcSpent
        self.btcPrice = btcPrice
        self.feeUSD = feeUSD
        self.platform = platform
        self.note = note
        self.reference = reference
    }
}

// MARK: - Retirement / Brokerage

@Model
final class HoldingAccount {
    @Attribute(.unique) var name: String
    var provider: String
    var owner: FamilyMember
    var totalValue: Decimal
    var weeklyContribution: Decimal
    var lastUpdated: Date

    @Relationship(deleteRule: .cascade) var holdings: [Holding] = []

    init(name: String, provider: String, owner: FamilyMember, totalValue: Decimal, weeklyContribution: Decimal = 0, lastUpdated: Date = .now) {
        self.name = name
        self.provider = provider
        self.owner = owner
        self.totalValue = totalValue
        self.weeklyContribution = weeklyContribution
        self.lastUpdated = lastUpdated
    }
}

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

// MARK: - Sync metadata

@Model
final class SyncEvent {
    @Attribute(.unique) var id: String
    var timestamp: Date
    var entity: String
    var operation: SyncOperation
    var entityId: String
    var deviceId: String
    var userId: String
    var checksum: String?

    init(
        id: String,
        timestamp: Date = .now,
        entity: String,
        operation: SyncOperation,
        entityId: String,
        deviceId: String,
        userId: String,
        checksum: String? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.entity = entity
        self.operation = operation
        self.entityId = entityId
        self.deviceId = deviceId
        self.userId = userId
        self.checksum = checksum
    }
}

enum SyncOperation: String, Codable {
    case create, update, delete
}

@Model
final class FamilyProfile {
    @Attribute(.unique) var member: FamilyMember
    var displayName: String
    var iCloudUserHash: String?
    var canViewOthers: Bool
    var canEditOthers: Bool
    var lastSyncedAt: Date?

    init(member: FamilyMember, displayName: String, iCloudUserHash: String? = nil, canViewOthers: Bool = false, canEditOthers: Bool = false, lastSyncedAt: Date? = nil) {
        self.member = member
        self.displayName = displayName
        self.iCloudUserHash = iCloudUserHash
        self.canViewOthers = canViewOthers
        self.canEditOthers = canEditOthers
        self.lastSyncedAt = lastSyncedAt
    }
}
