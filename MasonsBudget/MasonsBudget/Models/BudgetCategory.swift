// Mason's Budget App — Budget category model
// Mirrors MC2 budget.json category entries (Bills & Utilities, Dining, etc.).

import Foundation
import SwiftData

@Model
final class BudgetCategory {
    @Attribute(.unique) var name: String
    var icon: String
    var monthlyBudget: Decimal
    var sortOrder: Int
    var isIncome: Bool

    init(
        name: String,
        icon: String,
        monthlyBudget: Decimal,
        sortOrder: Int = 0,
        isIncome: Bool = false
    ) {
        self.name = name
        self.icon = icon
        self.monthlyBudget = monthlyBudget
        self.sortOrder = sortOrder
        self.isIncome = isIncome
    }
}
