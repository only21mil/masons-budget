// Mason's Budget App — BTC account model
// Mirrors MC2 btc-balance-snapshot.json account entries.
// Each account: Strike, River, CashApp, Coldcard, Zeus, etc.

import Foundation
import SwiftData

@Model
final class BTCAccount {
    @Attribute(.unique) var key: String
    var label: String
    var custody: BTCCustody
    var btc: Decimal
    var fiat: Decimal
    var owner: String
    var lastUpdated: Date

    func usdValue(liveBTCPrice: Decimal? = BTCPriceService.storedPrice) -> Decimal {
        if let liveBTCPrice, liveBTCPrice > 0 {
            return btc * liveBTCPrice
        }
        return fiat > 0 ? fiat : btc * AppTheme.fallbackBTCPrice
    }

    init(
        key: String,
        label: String,
        custody: BTCCustody,
        btc: Decimal,
        fiat: Decimal = 0,
        owner: FamilyMember,
        lastUpdated: Date = .now
    ) {
        self.key = key
        self.label = label
        self.custody = custody
        self.btc = btc
        self.fiat = fiat
        self.owner = owner.rawValue
        self.lastUpdated = lastUpdated
    }

    var ownerMember: FamilyMember {
        get { FamilyMember(rawValue: owner) ?? .victor }
        set { owner = newValue.rawValue }
    }
}
