// The Vogel Vault — Legacy family profile model
// Retained in the SwiftData schema so existing installs can migrate safely.

import Foundation
import SwiftData

@Model
final class FamilyProfile {
    @Attribute(.unique) var memberKey: String
    var displayName: String
    var iCloudUserHash: String?
    var canViewOthers: Bool
    var canEditOthers: Bool
    var lastSyncedAt: Date?

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
