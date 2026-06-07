import Foundation
import SwiftData
import SwiftUI

@Model
final class TodoProject {
    @Attribute(.unique) var projectId: String
    var name: String
    var icon: String
    var color: String
    var owner: String
    var createdAt: Date

    init(
        projectId: String = UUID().uuidString,
        name: String,
        icon: String = "box",
        color: String = "#F7931A",
        owner: FamilyMember = .victor,
        createdAt: Date = .now,
    ) {
        self.projectId = projectId
        self.name = name
        self.icon = icon
        self.color = color
        self.owner = owner.rawValue
        self.createdAt = createdAt
    }

    var ownerMember: FamilyMember {
        get { FamilyMember(rawValue: owner) ?? .victor }
        set { owner = newValue.rawValue }
    }

    var accentColor: Color {
        Color(hex: UInt(color.dropFirst(), radix: 16) ?? 0xF7931A)
    }
}
