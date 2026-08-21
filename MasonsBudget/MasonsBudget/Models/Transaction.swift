// Mason's Budget App — Transaction model
// Mirrors the surviving legacy transactions blob and public Convex rows.
// Money is Decimal (never Double — financial precision).

import Foundation
import SwiftData

@Model
final class Transaction {
    /// Persistent marker for an optimistic row whose remote write failed with
    /// a retryable result. A complete authoritative row-API sync reconciles
    /// these rows against the server snapshot after an app restart or a
    /// dismissed in-memory retry.
    static let pendingRowWriteSource = "app-pending-row-write"

    @Attribute(.unique) var id: String
    var date: Date
    var merchant: String
    /// Fiat budget amount in USD. Keep this canonical for legacy blob compatibility.
    var amount: Decimal
    var category: String
    var amountSats: Int64?
    /// True only when the user typed the amount in BTC or sats. Optional so the
    /// store migrates lightly: an existing row has no answer, and `nil` must be
    /// read as "not explicitly Bitcoin" so a legacy or USD-derived row never
    /// claims exact sats it does not have.
    var enteredInBitcoin: Bool?
    var card: String?
    /// Bitcoin account this row posts to, when its payment source is
    /// Bitcoin-native. Sent alongside amountSats; the backend rejects a
    /// Bitcoin-native row without it. Nil on fiat/legacy/untagged rows.
    var bitcoinAccountKey: String?
    var note: String?
    var owner: String
    var createdBy: String
    var createdAt: Date
    var sourceFile: String?
    var updatedAtMs: Double?

    init(
        id: String,
        date: Date,
        merchant: String,
        amount: Decimal,
        category: String,
        amountSats: Int64? = nil,
        enteredInBitcoin: Bool? = nil,
        card: String? = nil,
        bitcoinAccountKey: String? = nil,
        note: String? = nil,
        owner: FamilyMember = .victor,
        createdBy: String,
        createdAt: Date = .now,
        sourceFile: String? = nil,
        updatedAtMs: Double? = nil,
    ) {
        self.id = id
        self.date = date
        self.merchant = merchant
        self.amount = amount
        self.category = category
        self.amountSats = amountSats
        self.enteredInBitcoin = enteredInBitcoin
        self.card = card
        self.bitcoinAccountKey = bitcoinAccountKey
        self.note = note
        self.owner = owner.rawValue
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.sourceFile = sourceFile
        self.updatedAtMs = updatedAtMs
    }

    var ownerMember: FamilyMember {
        get { FamilyMember(rawValue: owner) ?? .victor }
        set { owner = newValue.rawValue }
    }

    func satsValue(btcPrice: Decimal = BTCPriceService.fallbackPriceUSD) -> Decimal {
        if let amountSats {
            return Decimal(amountSats)
        }

        guard btcPrice > 0 else { return 0 }
        return (amount / btcPrice) * 100_000_000
    }

    var isIncome: Bool {
        category.caseInsensitiveCompare("Income") == .orderedSame
    }

    var isSpend: Bool {
        !isIncome && amount != 0
    }

    /// Signed budget contribution: spend is positive and credits reduce spend.
    var spendAmount: Decimal {
        guard isSpend else { return 0 }
        return amount
    }

    /// Stable magnitude for rendering legacy rows, regardless of stored sign.
    var displaySpendAmount: Decimal {
        isSpend ? abs(spendAmount) : 0
    }

    /// A credit/refund that reduces spend.
    var hasOppositeSpendSign: Bool {
        spendAmount < 0
    }

    var displayAmount: Decimal {
        if isIncome { return abs(amount) }
        return spendAmount < 0 ? displaySpendAmount : -displaySpendAmount
    }

    func displaySatsValue(btcPrice: Decimal = BTCPriceService.fallbackPriceUSD) -> Decimal {
        let sats = abs(satsValue(btcPrice: btcPrice))
        return isSpend && !hasOppositeSpendSign ? -sats : sats
    }

    func spendSatsValue(btcPrice: Decimal = BTCPriceService.fallbackPriceUSD) -> Decimal {
        guard isSpend else { return 0 }
        return satsValue(btcPrice: btcPrice)
    }
}
