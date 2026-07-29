// Mason's Budget App — Budget category model
// Mirrors budget category rows and their surviving legacy blob shape.

import Foundation
import SwiftData

@Model
final class BudgetCategory {
    @Attribute(.unique) var name: String
    var icon: String
    var monthlyBudget: Decimal
    var sortOrder: Int
    var isIncome: Bool
    var owner: String = "victor"

    static let displayPriority: [String: Int] = [
        "Bills & Utilities": 0,
        "Groceries": 1,
        "Dining & Drinks": 98,
        "Auto & Transport": 99,
    ]

    var displayRank: Int {
        Self.displayPriority[name] ?? 50
    }

    var ownerMember: FamilyMember {
        FamilyMember(rawValue: owner) ?? .victor
    }

    init(
        name: String,
        icon: String,
        monthlyBudget: Decimal,
        sortOrder: Int = 0,
        isIncome: Bool = false,
        owner: FamilyMember = .victor,
    ) {
        self.name = name
        self.icon = icon
        self.monthlyBudget = monthlyBudget
        self.sortOrder = sortOrder
        self.isIncome = isIncome
        self.owner = owner.rawValue
    }
}
