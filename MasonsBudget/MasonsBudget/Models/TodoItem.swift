import Foundation
import SwiftData

@Model
final class TodoItem {
    @Attribute(.unique) var id: String
    var text: String
    var project: String
    var when: String
    var isDone: Bool
    var isFlagged: Bool
    var sortOrder: Int
    var createdAt: Date

    init(
        id: String = UUID().uuidString,
        text: String,
        project: String = "Inbox",
        when: String = "Today",
        isDone: Bool = false,
        isFlagged: Bool = false,
        sortOrder: Int = 0,
        createdAt: Date = .now
    ) {
        self.id = id
        self.text = text
        self.project = project
        self.when = when
        self.isDone = isDone
        self.isFlagged = isFlagged
        self.sortOrder = sortOrder
        self.createdAt = createdAt
    }
}
