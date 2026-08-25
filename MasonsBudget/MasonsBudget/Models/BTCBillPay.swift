// Mason's Budget App — BTC bill pay record
// Mirrors Bitcoin bill-pay rows and their surviving legacy blob shape.
// Bills paid in BTC via Strike (mortgage, credit cards, insurance, etc.).

import Foundation
import SwiftData

enum BTCBillPayBudgetEffect: String, Codable, Equatable, Sendable {
    case budgetCategory = "budget_category"
    case creditCardPayment = "credit_card_payment"

    static let creditCardPaymentCategory = "Credit Card Payment"
}

enum BTCBillPayContractError: LocalizedError, Equatable {
    case invalidBudgetEffect(String)
    case inconsistentCreditCardPaymentCategory(String)

    var errorDescription: String? {
        switch self {
        case let .invalidBudgetEffect(value):
            "Unknown Bitcoin bill-pay budget effect '\(value)'."
        case let .inconsistentCreditCardPaymentCategory(category):
            "A credit-card-payment bill pay must use category '\(BTCBillPayBudgetEffect.creditCardPaymentCategory)', not '\(category)'."
        }
    }
}

@Model
final class BTCBillPay {
    @Attribute(.unique) var id: String
    var date: Date
    var merchant: String
    var category: String
    var amountUSD: Decimal
    var btcSpent: Decimal
    var btcPrice: Decimal
    var feeUSD: Decimal?
    /// Nil marks a pre-amendment row, which defaults to credit-card-payment treatment.
    var budgetEffect: String?
    var platform: String
    var note: String?
    var reference: String?
    var owner: String = FamilyMember.victor.rawValue
    var updatedAtMs: Double?

    init(
        id: String,
        date: Date,
        merchant: String,
        category: String,
        amountUSD: Decimal,
        btcSpent: Decimal,
        btcPrice: Decimal,
        feeUSD: Decimal? = nil,
        budgetEffect: BTCBillPayBudgetEffect? = nil,
        platform: String = "Strike",
        note: String? = nil,
        reference: String? = nil,
        owner: FamilyMember = .victor,
        updatedAtMs: Double? = nil,
    ) {
        self.id = id
        self.date = date
        self.merchant = merchant
        self.category = category
        self.amountUSD = amountUSD
        self.btcSpent = btcSpent
        self.btcPrice = btcPrice
        self.feeUSD = feeUSD
        self.budgetEffect = budgetEffect?.rawValue
        self.platform = platform
        self.note = note
        self.reference = reference
        self.owner = owner.rawValue
        self.updatedAtMs = updatedAtMs
    }

    var ownerMember: FamilyMember {
        get { FamilyMember(rawValue: owner) ?? .victor }
        set { owner = newValue.rawValue }
    }

    /// Missing legacy fees become zero only at the domain boundary.
    var effectiveFeeUSD: Decimal {
        feeUSD ?? 0
    }

    func validatedBudgetEffect() throws -> BTCBillPayBudgetEffect {
        let effect: BTCBillPayBudgetEffect
        if let budgetEffect {
            guard let decoded = BTCBillPayBudgetEffect(rawValue: budgetEffect) else {
                throw BTCBillPayContractError.invalidBudgetEffect(budgetEffect)
            }
            effect = decoded
        } else {
            effect = .creditCardPayment
        }

        if effect == .creditCardPayment,
           category != BTCBillPayBudgetEffect.creditCardPaymentCategory
        {
            // Pre-amendment rows did not carry the effect and may have arbitrary
            // legacy categories. Only an explicit contradictory wire value fails.
            if budgetEffect != nil {
                throw BTCBillPayContractError.inconsistentCreditCardPaymentCategory(category)
            }
        }
        return effect
    }
}
