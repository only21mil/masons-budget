// The Vogel Vault — Shared enums
// Used across multiple SwiftData models.

import Foundation

/// Family members with access to the app.
enum FamilyMember: String, Codable, CaseIterable, Identifiable {
    case victor
    case rachel
    case mason
    case maddox

    var id: String { rawValue }

    var displayName: String {
        rawValue.capitalized
    }

    var icon: String {
        switch self {
        case .victor: "person.fill"
        case .rachel: "person.fill"
        case .mason:  "figure.child"
        case .maddox: "figure.child"
        }
    }

    var accentColorName: String {
        switch self {
        case .victor: "AccentColor"
        case .rachel: "AccentColor"
        case .mason:  "AccentColor"
        case .maddox: "AccentColor"
        }
    }

    /// Whether this profile shows full budget/spending views (adults)
    /// or a simplified Bitcoin-focused experience (kids).
    var showsFullBudget: Bool {
        switch self {
        case .victor, .rachel: true
        case .mason, .maddox:  false
        }
    }

    var profileDescription: String {
        switch self {
        case .victor: "Full budget, spending & Bitcoin"
        case .rachel: "Full budget, spending & Bitcoin"
        case .mason:  "Bitcoin stack & allowance"
        case .maddox: "Bitcoin stack & allowance"
        }
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
