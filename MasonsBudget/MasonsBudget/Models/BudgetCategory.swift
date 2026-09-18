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

    /// Household budget scope excludes child totals; invalid profiles match nothing.
    static func predicate(for member: FamilyMember?) -> Predicate<BudgetCategory> {
        let owner = member?.rawValue ?? "__invalid_owner__"
        let includesHousehold = member?.isAdult == true
        let victor = FamilyMember.victor.rawValue
        let rachel = FamilyMember.rachel.rawValue
        return #Predicate { category in
            category.owner == owner || (includesHousehold && (category.owner == victor || category.owner == rachel))
        }
    }

    var displayName: String {
        LedgerMapper.wireBudgetCategoryName(from: name, owner: ownerMember)
    }

    func matches(_ transaction: Transaction) -> Bool {
        ownerMember.sharesNetWorth(with: transaction.ownerMember) &&
            LedgerMapper.wireBudgetCategoryName(from: transaction.category, owner: transaction.ownerMember) == displayName
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
