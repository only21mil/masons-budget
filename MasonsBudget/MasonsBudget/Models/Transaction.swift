// Mason's Budget App — Transaction model
// Mirrors MC2 transactions.json entries.
// Money is Decimal (never Double — financial precision).

import Foundation
import SwiftData

@Model
final class Transaction {
    @Attribute(.unique) var id: String
    var date: Date
    var merchant: String
    /// Fiat budget amount in USD. Keep this canonical for MC2 transactions.json compatibility.
    var amount: Decimal
    var category: String
    var amountSats: Int64?
    var card: String?
    var note: String?
    var owner: String
    var createdBy: String
    var createdAt: Date
    var sourceFile: String?

    init(
        id: String,
        date: Date,
        merchant: String,
        amount: Decimal,
        category: String,
        amountSats: Int64? = nil,
        card: String? = nil,
        note: String? = nil,
        owner: FamilyMember = .victor,
        createdBy: String,
        createdAt: Date = .now,
        sourceFile: String? = nil,
    ) {
        self.id = id
        self.date = date
        self.merchant = merchant
        self.amount = amount
        self.category = category
        self.amountSats = amountSats
        self.card = card
        self.note = note
        self.owner = owner.rawValue
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.sourceFile = sourceFile
    }

    var ownerMember: FamilyMember {
        get { FamilyMember(rawValue: owner) ?? .victor }
        set { owner = newValue.rawValue }
    }

    func satsValue(btcPrice: Decimal = AppTheme.fallbackBTCPrice) -> Decimal {
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

    var spendAmount: Decimal {
        isSpend ? abs(amount) : 0
    }

    var displayAmount: Decimal {
        isSpend ? -abs(amount) : abs(amount)
    }

    func displaySatsValue(btcPrice: Decimal = AppTheme.fallbackBTCPrice) -> Decimal {
        let sats = abs(satsValue(btcPrice: btcPrice))
        return isSpend ? -sats : sats
    }

    func spendSatsValue(btcPrice: Decimal = AppTheme.fallbackBTCPrice) -> Decimal {
        isSpend ? abs(satsValue(btcPrice: btcPrice)) : 0
    }
}
