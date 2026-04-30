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
