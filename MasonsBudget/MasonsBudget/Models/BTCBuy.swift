// Mason's Budget App — BTC buy record
// Mirrors Bitcoin-buy rows and their surviving legacy blob shape.
// ID format: "b-{source}-{date}" e.g. "b-strike-2026-04-01".
// BTC is Decimal, sats is Int64. Always derive one from the other.

import Foundation
import SwiftData

@Model
final class BTCBuy {
    @Attribute(.unique) var id: String
    var date: Date
    var source: String
    var amountBTC: Decimal
    var amountSats: Int64
    var priceUSD: Decimal
    var usd: Decimal
    /// Optional manual River fee in exact USD cents. Legacy rows omit it.
    var feeUsdCents: Int64?
    var note: String?
    var status: String
    var costBasisStatus: String
    var loggedBy: String?
    var archimedesRequestId: String?
    var owner: String?
    /// Exact server revision for optimistic edits. Nil is create-only legacy state.
    var updatedAtMs: Double?

    init(
        id: String,
        date: Date,
        source: String,
        amountBTC: Decimal,
        amountSats: Int64,
        priceUSD: Decimal,
        usd: Decimal,
        feeUsdCents: Int64? = nil,
        note: String? = nil,
        status: String = "complete",
        costBasisStatus: String = "complete",
        loggedBy: String? = nil,
        archimedesRequestId: String? = nil,
        owner: FamilyMember? = nil,
        updatedAtMs: Double? = nil,
    ) {
        self.id = id
        self.date = date
        self.source = source
        self.amountBTC = amountBTC
        self.amountSats = amountSats
        self.priceUSD = priceUSD
        self.usd = usd
        self.feeUsdCents = feeUsdCents
        self.note = note
        self.status = status
        self.costBasisStatus = costBasisStatus
        self.loggedBy = loggedBy
        self.archimedesRequestId = archimedesRequestId
        self.owner = owner?.rawValue
        self.updatedAtMs = updatedAtMs
    }

    var ownerMember: FamilyMember? {
        get { owner.flatMap(FamilyMember.init(rawValue:)) }
        set { owner = newValue?.rawValue }
    }

    /// Missing legacy fees become zero only at the domain boundary.
    var effectiveFeeUsdCents: Int64 {
        feeUsdCents ?? 0
    }
}
