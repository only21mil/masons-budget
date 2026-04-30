// Mason's Budget App — Shared enums
// Used across multiple SwiftData models.

import Foundation

/// Family members with access to the app.
enum FamilyMember: String, Codable, CaseIterable {
    case victor
    case rachel
    case mason
    case maddox

    var displayName: String {
        rawValue.capitalized
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
