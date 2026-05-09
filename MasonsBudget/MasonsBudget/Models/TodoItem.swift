// The Vogel Vault — Todo item model
// Mirrors MC2 todos data synced through Convex.

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
    var updatedAt: Date
    var sourceFile: String?

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
        updatedAt: Date = .now,
        sourceFile: String? = "todos.json"
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
        self.updatedAt = updatedAt
        self.sourceFile = sourceFile
    }

    var ownerMember: FamilyMember {
        get { FamilyMember(rawValue: owner) ?? .victor }
        set { owner = newValue.rawValue }
    }
}
