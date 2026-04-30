// Mason's Budget App — Family profile model
// Per-user profile linking iCloud identity to a FamilyMember.
// Controls who can view/edit other members' data.

import Foundation
import SwiftData

@Model
final class FamilyProfile {
    /// Unique key — stores FamilyMember.rawValue as a String
    /// (SwiftData unique constraints require primitive types).
    @Attribute(.unique) var memberKey: String
    var displayName: String
    var iCloudUserHash: String?
    var canViewOthers: Bool
    var canEditOthers: Bool
    var lastSyncedAt: Date?

    /// Computed accessor for the typed enum.
    var member: FamilyMember {
        get { FamilyMember(rawValue: memberKey) ?? .victor }
        set { memberKey = newValue.rawValue }
    }

    init(
        member: FamilyMember,
        displayName: String,
        iCloudUserHash: String? = nil,
        canViewOthers: Bool = false,
        canEditOthers: Bool = false,
        lastSyncedAt: Date? = nil
    ) {
        self.memberKey = member.rawValue
        self.displayName = displayName
        self.iCloudUserHash = iCloudUserHash
        self.canViewOthers = canViewOthers
        self.canEditOthers = canEditOthers
        self.lastSyncedAt = lastSyncedAt
    }
}
