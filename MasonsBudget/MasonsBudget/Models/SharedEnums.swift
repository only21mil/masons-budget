// The Vogel Vault — Shared enums
// Used across multiple SwiftData models.

import Foundation

/// Family members with access to the app.
enum FamilyMember: String, Codable, CaseIterable, Identifiable {
    case victor
    case rachel
    case mason
    case maddox

    var id: String {
        rawValue
    }

    var displayName: String {
        rawValue.capitalized
    }

    var icon: String {
        switch self {
        case .victor: "person.fill"
        case .rachel: "person.fill"
        case .mason: "person.fill"
        case .maddox: "figure.child"
        }
    }

    /// Whether this profile shows full budget/spending views (adults)
    /// or a simplified Bitcoin-focused experience (kids).
    var showsFullBudget: Bool {
        switch self {
        case .victor, .rachel: true
        case .mason, .maddox: false
        }
    }

    var profileDescription: String {
        switch self {
        case .victor: "Full budget, spending & Bitcoin"
        case .rachel: "Full budget, spending & Bitcoin"
        case .mason: "Bitcoin stack & spending"
        case .maddox: "Bitcoin stack & allowance"
        }
    }

    var isAdult: Bool {
        switch self {
        case .victor, .rachel: true
        case .mason, .maddox: false
        }
    }

    var allowedSwitchTargets: [FamilyMember] {
        if isAdult { return FamilyMember.allCases }
        return FamilyMember.allCases.filter { $0.isAdult || $0 == self }
    }

    var requiresAuthToSwitch: Bool {
        true
    }

    var mc2TransactionsFileName: String {
        switch self {
        case .victor, .rachel:
            "transactions"
        case .mason:
            "mason-transactions"
        case .maddox:
            "maddox-transactions"
        }
    }

    var mc2BTCBuysFileName: String {
        switch self {
        case .mason:
            "mason-bitcoin-buys"
        case .victor, .rachel, .maddox:
            "bitcoin-buys"
        }
    }

    var hasDedicatedMC2ChildFinanceFiles: Bool {
        switch self {
        case .mason:
            true
        case .victor, .rachel, .maddox:
            false
        }
    }

    /// Adults can see the household and kids. Kids see only their own data.
    func canSee(dataOwnedBy owner: FamilyMember) -> Bool {
        if self == owner { return true }
        if isAdult { return true }
        return false
    }

    /// Net-worth totals are household-scoped for adults, but must not roll child stacks into adult totals.
    func sharesNetWorth(with owner: FamilyMember) -> Bool {
        if self == owner { return true }
        return isAdult && owner.isAdult
    }
}

/// Bitcoin custody classification.
enum BTCCustody: String, Codable {
    case exchange
    case selfCustody = "self_custody"
}

/// Sync event operation type.
enum SyncOperation: String, Codable {
    case create, update, delete
}

extension Decimal {
    /// Convert to Int64 without trapping on overflow (clamps to Int64 range).
    /// Use instead of `Int64(truncating: self as NSNumber)` for any user/CSV/voice-supplied amount.
    var clampedInt64: Int64 {
        let handler = NSDecimalNumberHandler(
            roundingMode: .plain,
            scale: 0,
            raiseOnExactness: false,
            raiseOnOverflow: false,
            raiseOnUnderflow: false,
            raiseOnDivideByZero: false,
        )
        return NSDecimalNumber(decimal: self).rounding(accordingToBehavior: handler).int64Value
    }
}
