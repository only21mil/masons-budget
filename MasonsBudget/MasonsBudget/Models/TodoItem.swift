// The Vogel Vault — Todo item model
// Mirrors todo data synced from Convex.

import Foundation
import SwiftData

@Model
final class TodoItem {
    @Attribute(.unique) var id: String
    var title: String
    var project: String?
    var area: String?
    var dueDate: Date?
    var priority: Int
    var isFlagged: Bool
    var isDone: Bool
    var owner: String
    var createdBy: String
    var createdAt: Date?
    var updatedAt: Date
    var completedAt: Date?
    var sourceFile: String?
    /// Exact row revision returned by Convex. Device update, delete, and restore
    /// requests must echo this value without deriving it from `updatedAt`.
    var updatedAtMs: Double?
    /// False only for a fresh local create that has not reached Convex. Once a
    /// create is accepted, a missing revision blocks further writes until a row
    /// refresh supplies the authoritative server revision.
    var hasServerAuthority: Bool = true

    init(
        id: String,
        title: String,
        project: String? = nil,
        area: String? = nil,
        dueDate: Date? = nil,
        priority: Int = 0,
        isFlagged: Bool = false,
        isDone: Bool = false,
        owner: FamilyMember = .victor,
        createdBy: String = "mc2",
        createdAt: Date? = nil,
        updatedAt: Date = .now,
        completedAt: Date? = nil,
        sourceFile: String? = "todos.json",
        updatedAtMs: Double? = nil,
        hasServerAuthority: Bool? = nil,
    ) {
        self.id = id
        self.title = title
        self.project = project
        self.area = area
        self.dueDate = dueDate
        self.priority = priority
        self.isFlagged = isFlagged
        self.isDone = isDone
        self.owner = owner.rawValue
        self.createdBy = createdBy
        self.createdAt = createdAt ?? (createdBy == "app" ? updatedAt : nil)
        self.updatedAt = updatedAt
        self.completedAt = completedAt
        self.sourceFile = sourceFile
        self.updatedAtMs = updatedAtMs
        self.hasServerAuthority = hasServerAuthority ?? (createdBy != "app")
    }

    var ownerMember: FamilyMember {
        get { FamilyMember(rawValue: owner) ?? .victor }
        set { owner = newValue.rawValue }
    }
}
