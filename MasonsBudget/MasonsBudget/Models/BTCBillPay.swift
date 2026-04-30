// Mason's Budget App — BTC bill pay record
// Mirrors MC2 bitcoin-bill-pays.json entries.
// Bills paid in BTC via Strike (mortgage, credit cards, insurance, etc.).

import Foundation
import SwiftData

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
