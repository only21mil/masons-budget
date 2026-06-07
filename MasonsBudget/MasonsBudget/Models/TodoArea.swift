import Foundation
import SwiftData

@Model
final class TodoArea {
    @Attribute(.unique) var areaId: String
    var name: String
    var icon: String
    var owner: String

    init(
        areaId: String = UUID().uuidString,
        name: String,
        icon: String = "vault",
        owner: FamilyMember = .victor,
    ) {
        self.areaId = areaId
        self.name = name
        self.icon = icon
        self.owner = owner.rawValue
    }

    var ownerMember: FamilyMember {
        get { FamilyMember(rawValue: owner) ?? .victor }
        set { owner = newValue.rawValue }
    }
}
