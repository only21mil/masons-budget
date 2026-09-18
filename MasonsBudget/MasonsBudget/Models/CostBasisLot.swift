import Foundation
import SwiftData

@Model
final class CostBasisLot {
    @Attribute(.unique) var lotId: String
    var date: String
    var sats: Int64
    var basisUsd: Decimal
    var label: String
    var owner: String

    init(
        lotId: String,
        date: String,
        sats: Int64,
        basisUsd: Decimal,
        label: String = "",
        owner: FamilyMember = .victor,
    ) {
        self.lotId = lotId
        self.date = date
        self.sats = sats
        self.basisUsd = basisUsd
        self.label = label
        self.owner = owner.rawValue
    }

    var btcAmount: Decimal {
        Decimal(sats) / 100_000_000
    }

    func currentValue(btcPrice: Decimal) -> Decimal {
        btcAmount * btcPrice
    }

    func unrealizedGain(btcPrice: Decimal) -> Decimal {
        currentValue(btcPrice: btcPrice) - basisUsd
    }

    func unrealizedGainPct(btcPrice: Decimal) -> Decimal {
        guard basisUsd > 0 else { return 0 }
        return (unrealizedGain(btcPrice: btcPrice) / basisUsd) * 100
    }

    var ownerMember: FamilyMember {
        get { FamilyMember(rawValue: owner) ?? .victor }
        set { owner = newValue.rawValue }
    }
}
