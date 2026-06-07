import Foundation
import SwiftData

@Model
final class NetWorthSnapshot {
    var date: Date
    var totalValue: Decimal
    var btcValue: Decimal
    var holdingsValue: Decimal
    var owner: String

    init(
        date: Date = .now,
        totalValue: Decimal,
        btcValue: Decimal,
        holdingsValue: Decimal,
        owner: FamilyMember = .victor,
    ) {
        self.date = date
        self.totalValue = totalValue
        self.btcValue = btcValue
        self.holdingsValue = holdingsValue
        self.owner = owner.rawValue
    }

    var ownerMember: FamilyMember {
        get { FamilyMember(rawValue: owner) ?? .victor }
        set { owner = newValue.rawValue }
    }
}
