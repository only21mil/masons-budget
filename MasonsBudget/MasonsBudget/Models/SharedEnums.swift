// The Vogel Vault — Shared enums
// Used across multiple SwiftData models.

import Foundation

/// Family members with access to the app.
enum FamilyMember: String, Codable, CaseIterable, Identifiable, Sendable {
    case victor
    case rachel
    case mason
    case maddox

    var id: String {
        rawValue
    }

    var displayName: String {
        rawValue.capitalized
    }

    var icon: String {
        switch self {
        case .victor: "person.fill"
        case .rachel: "person.fill"
        case .mason: "person.fill"
        case .maddox: "figure.child"
        }
    }

    /// Whether this profile shows full budget/spending views (adults)
    /// or a simplified Bitcoin-focused experience (kids).
    var showsFullBudget: Bool {
        switch self {
        case .victor, .rachel: true
        case .mason, .maddox: false
        }
    }

    var profileDescription: String {
        switch self {
        case .victor: "Full budget, spending & Bitcoin"
        case .rachel: "Full budget, spending & Bitcoin"
        case .mason: "Bitcoin stack & spending"
        case .maddox: "Bitcoin stack & allowance"
        }
    }

    var isAdult: Bool {
        switch self {
        case .victor, .rachel: true
        case .mason, .maddox: false
        }
    }

    /// Canonical owner for financial ledger records.
    ///
    /// Victor and Rachel are one household. Rachel remains the actor/viewer,
    /// while durable adult financial rows are Victor-owned.
    var ledgerOwner: FamilyMember {
        isAdult ? .victor : self
    }

    var allowedSwitchTargets: [FamilyMember] {
        if isAdult { return FamilyMember.allCases }
        return [self]
    }

    var requiresAuthToSwitch: Bool {
        true
    }

    var transactionsDataFileName: String {
        switch self {
        case .victor, .rachel:
            "transactions"
        case .mason:
            "mason-transactions"
        case .maddox:
            "maddox-transactions"
        }
    }

    var btcBuysDataFileName: String {
        switch self {
        case .mason:
            "mason-bitcoin-buys"
        case .victor, .rachel, .maddox:
            "bitcoin-buys"
        }
    }

    var hasDedicatedChildFinanceFiles: Bool {
        switch self {
        case .mason:
            true
        case .victor, .rachel, .maddox:
            false
        }
    }

    /// Adults can see the household and kids. Kids see only their own data.
    func canSee(dataOwnedBy owner: FamilyMember) -> Bool {
        if self == owner { return true }
        if isAdult { return true }
        return false
    }

    /// Todos are profile-private even when financial records are household-visible.
    /// A list or access check must never aggregate another adult's todos.
    func canAccessTodo(ownedBy owner: FamilyMember) -> Bool {
        self == owner
    }

    /// Net-worth totals are household-scoped for adults, but must not roll child stacks into adult totals.
    func sharesNetWorth(with owner: FamilyMember) -> Bool {
        if self == owner { return true }
        return isAdult && owner.isAdult
    }

    /// Money-out-today spending scope, shared with the server rule: adults
    /// aggregate the household, kids count only their own rows.
    func isSpendingScope(of owner: FamilyMember) -> Bool {
        isAdult ? owner.isAdult : owner == self
    }
}

/// Bitcoin custody classification.
enum BTCCustody: String, Codable, Sendable {
    case exchange
    case selfCustody = "self_custody"
}

/// Sync event operation type.
enum SyncOperation: String, Codable {
    case create, update, delete
}

extension Decimal {
    /// Convert to Int64 without trapping on overflow (clamps to Int64 range).
    /// Use instead of `Int64(truncating: self as NSNumber)` for any user/CSV/voice-supplied amount.
    var clampedInt64: Int64 {
        let handler = NSDecimalNumberHandler(
            roundingMode: .plain,
            scale: 0,
            raiseOnExactness: false,
            raiseOnOverflow: false,
            raiseOnUnderflow: false,
            raiseOnDivideByZero: false,
        )
        return NSDecimalNumber(decimal: self).rounding(accordingToBehavior: handler).int64Value
    }
}

enum ExactMoneyError: LocalizedError, Equatable {
    case fractionalCent(field: String)
    case negative(field: String)
    case overflow(field: String)

    var errorDescription: String? {
        switch self {
        case let .fractionalCent(field):
            "\(field) is not an exact USD-cent amount."
        case let .negative(field):
            "\(field) must not be negative."
        case let .overflow(field):
            "\(field) does not fit exact Int64 USD cents."
        }
    }
}

enum ExactMoney {
    /// Converts Decimal dollars to exact Int64 cents without passing through Double.
    static func cents(from dollars: Decimal, field: String) throws -> Int64 {
        var scaled = dollars * 100
        var integral = Decimal()
        NSDecimalRound(&integral, &scaled, 0, .plain)
        guard scaled == integral else {
            throw ExactMoneyError.fractionalCent(field: field)
        }

        let number = NSDecimalNumber(decimal: integral)
        guard number != NSDecimalNumber.notANumber,
              number.compare(NSDecimalNumber(string: String(Int64.min))) != .orderedAscending,
              number.compare(NSDecimalNumber(string: String(Int64.max))) != .orderedDescending
        else {
            throw ExactMoneyError.overflow(field: field)
        }
        return number.int64Value
    }

    /// Missing manual fees are zero. Present fees must be exact, non-negative cents.
    static func manualFeeCents(from dollars: Decimal?, field: String) throws -> Int64 {
        let exactCents = try cents(from: dollars ?? 0, field: field)
        guard exactCents >= 0 else {
            throw ExactMoneyError.negative(field: field)
        }
        return exactCents
    }

    /// Converts optional exact cents back to dollars while preserving absence.
    static func optionalDollars(from cents: Int64?, field: String) throws -> Decimal? {
        guard let cents else { return nil }
        guard cents >= 0 else {
            throw ExactMoneyError.negative(field: field)
        }
        return decimalMinorUnits(cents, scale: 2)
    }
}

enum MoneyOutTodayError: LocalizedError, Equatable {
    case invalidDay(String)
    case overflow

    var errorDescription: String? {
        switch self {
        case let .invalidDay(day):
            "Money Out Today requires an ISO yyyy-MM-dd day, not '\(day)'."
        case .overflow:
            "Money Out Today does not fit exact Int64 USD cents."
        }
    }
}

struct MoneyOutTodayTransaction: Equatable, Sendable {
    let owner: FamilyMember
    let day: String
    let amountCents: Int64
    let category: String

    init(owner: FamilyMember, day: String, amountCents: Int64, category: String) throws {
        guard Phase1DateContract.isValidDay(day) else {
            throw MoneyOutTodayError.invalidDay(day)
        }
        self.owner = owner
        self.day = day
        self.amountCents = amountCents
        self.category = category
    }
}

struct MoneyOutTodayBillPay: Equatable, Sendable {
    let owner: FamilyMember
    let day: String
    let principalUsdCents: Int64
    let feeUsdCents: Int64
    let budgetEffect: BTCBillPayBudgetEffect

    init(
        owner: FamilyMember,
        day: String,
        principalUsdCents: Int64,
        feeUsdCents: Int64? = nil,
        budgetEffect: BTCBillPayBudgetEffect,
    ) throws {
        guard Phase1DateContract.isValidDay(day) else {
            throw MoneyOutTodayError.invalidDay(day)
        }
        let normalizedFee = feeUsdCents ?? 0
        guard normalizedFee >= 0 else {
            throw ExactMoneyError.negative(field: "moneyOutToday.billPay.feeUsdCents")
        }
        guard principalUsdCents >= 0 else {
            throw ExactMoneyError.negative(field: "moneyOutToday.billPay.principalUsdCents")
        }
        self.owner = owner
        self.day = day
        self.principalUsdCents = principalUsdCents
        self.feeUsdCents = normalizedFee
        self.budgetEffect = budgetEffect
    }
}

enum MoneyOutTodayContract {
    /// Derives, but never persists, the exact signed USD-cent total for one injected day.
    /// Bitcoin buys are deliberately not an input and therefore cannot enter the total.
    static func deriveCents(
        viewer: FamilyMember,
        day: String,
        transactions: [MoneyOutTodayTransaction],
        billPays: [MoneyOutTodayBillPay],
    ) throws -> Int64 {
        guard Phase1DateContract.isValidDay(day) else {
            throw MoneyOutTodayError.invalidDay(day)
        }

        var total: Int64 = 0

        for transaction in transactions where viewer.isSpendingScope(of: transaction.owner) && transaction.day == day {
            guard transaction.category.caseInsensitiveCompare("Income") != .orderedSame,
                  transaction.category.caseInsensitiveCompare(BTCBillPayBudgetEffect.creditCardPaymentCategory) != .orderedSame
            else { continue }
            total = try adding(transaction.amountCents, to: total)
        }

        for billPay in billPays where viewer.isSpendingScope(of: billPay.owner) && billPay.day == day {
            guard billPay.budgetEffect != .creditCardPayment else { continue }
            let contribution = try adding(billPay.feeUsdCents, to: billPay.principalUsdCents)
            total = try adding(contribution, to: total)
        }

        return total
    }

    private static func adding(_ value: Int64, to total: Int64) throws -> Int64 {
        let (sum, overflow) = total.addingReportingOverflow(value)
        guard !overflow else { throw MoneyOutTodayError.overflow }
        return sum
    }

}

enum BudgetCategoryDeletionEligibilityError: LocalizedError, Equatable {
    case invalidCurrentMonth(String)
    case invalidBudgetMonth(String)
    case unsupportedChildBudget(FamilyMember)
    case monthMismatch(currentMonth: String, budgetMonth: String)
    case ownerMismatch(expected: FamilyMember, actual: FamilyMember)
    case sourceMismatch(expected: String, actual: String)
    case missingCategory(String)
    case nonCanonicalCategory(expected: String, actual: String)
    case foldedCategoryCollision(String)
    case missingRevision
    case invalidRevision(Int64)
    case invalidRevisionNumber(Double)
    case revisionMismatch(expected: Int64, actual: Int64)

    var errorDescription: String? {
        switch self {
        case let .invalidCurrentMonth(month):
            "Current month must be ISO yyyy-MM, not '\(month)'."
        case let .invalidBudgetMonth(month):
            "Budget month must be ISO yyyy-MM, not '\(month)'."
        case let .unsupportedChildBudget(member):
            "Category deletion is unsupported for child budget '\(member.rawValue)'."
        case let .monthMismatch(currentMonth, budgetMonth):
            "Budget month '\(budgetMonth)' is not current month '\(currentMonth)'."
        case let .ownerMismatch(expected, actual):
            "Budget owner '\(actual.rawValue)' is not canonical owner '\(expected.rawValue)'."
        case let .sourceMismatch(expected, actual):
            "Budget source '\(actual)' is not canonical source '\(expected)'."
        case let .missingCategory(name):
            "Budget category '\(name)' does not exist exactly."
        case let .nonCanonicalCategory(expected, actual):
            "Budget category '\(actual)' does not match canonical category '\(expected)'."
        case let .foldedCategoryCollision(name):
            "Budget category '\(name)' has more than one folded identity match."
        case .missingRevision:
            "Budget category deletion requires the current server revision."
        case let .invalidRevision(revision):
            "Budget revision '\(revision)' is invalid."
        case let .invalidRevisionNumber(revision):
            "Budget revision '\(revision)' is not an exact positive JSON integer."
        case let .revisionMismatch(expected, actual):
            "Budget revision '\(actual)' does not match current revision '\(expected)'."
        }
    }
}

struct BudgetCategoryDeletionIntent: Equatable, Sendable {
    static let canonicalSource = "budget"
    static let canonicalMasonSource = "mason-budget"
    static let maximumExactJSONRevision: Int64 = 9_007_199_254_740_991

    let month: String
    let owner: FamilyMember
    let source: String
    let categoryName: String
    let baseUpdatedAtMs: Int64

    private init(
        month: String,
        owner: FamilyMember,
        source: String,
        categoryName: String,
        baseUpdatedAtMs: Int64,
    ) {
        self.month = month
        self.owner = owner
        self.source = source
        self.categoryName = categoryName
        self.baseUpdatedAtMs = baseUpdatedAtMs
    }

    static func make(
        viewer: FamilyMember,
        currentMonth: String,
        budgetMonth: String,
        budgetOwner: FamilyMember,
        budgetSource: String,
        existingCategoryNames: [String],
        categoryName: String,
        budgetUpdatedAtMs: Int64,
        baseUpdatedAtMs: Int64,
    ) throws -> BudgetCategoryDeletionIntent {
        guard Phase1DateContract.isValidMonth(currentMonth) else {
            throw BudgetCategoryDeletionEligibilityError.invalidCurrentMonth(currentMonth)
        }
        guard Phase1DateContract.isValidMonth(budgetMonth) else {
            throw BudgetCategoryDeletionEligibilityError.invalidBudgetMonth(budgetMonth)
        }
        guard let expectedSource = canonicalSource(for: viewer) else {
            throw BudgetCategoryDeletionEligibilityError.unsupportedChildBudget(viewer)
        }
        guard currentMonth == budgetMonth else {
            throw BudgetCategoryDeletionEligibilityError.monthMismatch(
                currentMonth: currentMonth,
                budgetMonth: budgetMonth,
            )
        }

        let expectedOwner = viewer.ledgerOwner
        guard budgetOwner == expectedOwner else {
            throw BudgetCategoryDeletionEligibilityError.ownerMismatch(
                expected: expectedOwner,
                actual: budgetOwner,
            )
        }
        guard budgetSource == expectedSource else {
            throw BudgetCategoryDeletionEligibilityError.sourceMismatch(
                expected: expectedSource,
                actual: budgetSource,
            )
        }
        let trimmedCategoryName = categoryName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedCategoryName.isEmpty else {
            throw BudgetCategoryDeletionEligibilityError.missingCategory(categoryName)
        }
        guard trimmedCategoryName == categoryName else {
            throw BudgetCategoryDeletionEligibilityError.nonCanonicalCategory(
                expected: trimmedCategoryName,
                actual: categoryName,
            )
        }
        let targetFold = foldedCategoryName(trimmedCategoryName)
        let foldedMatches = existingCategoryNames.filter {
            foldedCategoryName($0) == targetFold
        }
        guard !foldedMatches.isEmpty else {
            throw BudgetCategoryDeletionEligibilityError.missingCategory(categoryName)
        }
        guard foldedMatches.count == 1 else {
            throw BudgetCategoryDeletionEligibilityError.foldedCategoryCollision(categoryName)
        }
        guard budgetUpdatedAtMs > 0,
              budgetUpdatedAtMs <= maximumExactJSONRevision
        else {
            throw BudgetCategoryDeletionEligibilityError.invalidRevision(budgetUpdatedAtMs)
        }
        guard baseUpdatedAtMs > 0,
              baseUpdatedAtMs <= maximumExactJSONRevision
        else {
            throw BudgetCategoryDeletionEligibilityError.invalidRevision(baseUpdatedAtMs)
        }
        guard baseUpdatedAtMs == budgetUpdatedAtMs else {
            throw BudgetCategoryDeletionEligibilityError.revisionMismatch(
                expected: budgetUpdatedAtMs,
                actual: baseUpdatedAtMs,
            )
        }

        return BudgetCategoryDeletionIntent(
            month: budgetMonth,
            owner: budgetOwner,
            source: budgetSource,
            categoryName: foldedMatches[0],
            baseUpdatedAtMs: baseUpdatedAtMs,
        )
    }

    private static func foldedCategoryName(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(with: Locale(identifier: "en_US_POSIX"))
    }

    static func canonicalSource(for viewer: FamilyMember) -> String? {
        switch viewer {
        case .victor, .rachel:
            canonicalSource
        case .mason:
            canonicalMasonSource
        case .maddox:
            nil
        }
    }
}

// MARK: - Budget plan carry-forward (shared/domain/src/budgetPlanCarry.ts)

/// Why the copy-forward action is not offered. Raw values are the shared
/// contract's rejection reasons, pinned by budget-plan-carry-cases.json.
enum BudgetPlanCarryRejection: String, Equatable, Sendable {
    case invalidCurrentMonth = "invalid-current-month"
    case invalidSelectedMonth = "invalid-selected-month"
    case unsupportedProfile = "unsupported-profile"
    case ownerMismatch = "owner-mismatch"
    case invalidPlanMonth = "invalid-plan-month"
    case planIsCurrent = "plan-is-current"
    case invalidRevision = "invalid-revision"
    case revisionMismatch = "revision-mismatch"
}

/// What the device sends to `tables:copyBudgetPlanForwardFromDevice`. The
/// server repeats every check before it advances the plan's month in place.
struct BudgetPlanCarryIntent: Equatable, Sendable {
    let owner: FamilyMember
    let sourceFile: String
    let fromMonth: String
    let toMonth: String
    let baseUpdatedAtMs: Int64
}

enum BudgetPlanCarryEligibility: Equatable, Sendable {
    case eligible(BudgetPlanCarryIntent)
    case ineligible(BudgetPlanCarryRejection)

    var intent: BudgetPlanCarryIntent? {
        if case let .eligible(intent) = self {
            return intent
        }
        return nil
    }

    var rejection: BudgetPlanCarryRejection? {
        if case let .ineligible(reason) = self {
            return reason
        }
        return nil
    }
}

/// Decides, on the device, whether the Budget screen offers "Copy <month>
/// plan to <next month>". The plan moves exactly one month per copy, so a
/// plan two months stale is copied in two visible steps.
enum BudgetPlanCarry {
    static let mutationPath = "tables:copyBudgetPlanForwardFromDevice"
    static let maximumExactJSONRevision: Int64 = 9_007_199_254_740_991

    private static let monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ]

    /// The row API retains legacy English month labels. Normalize at the read
    /// boundary; eligibility itself still accepts only canonical month keys.
    static func canonicalStoredMonth(_ stored: String) -> String? {
        if monthIndex(stored) != nil {
            return stored
        }
        let parts = stored.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 2,
              let index = monthNames.firstIndex(of: String(parts[0]))
        else { return nil }
        let month = index + 1
        let key = "\(parts[1])-\(month < 10 ? "0" : "")\(month)"
        return monthIndex(key) == nil ? nil : key
    }

    static func monthLabel(_ key: String) -> String {
        guard let index = monthIndex(key) else { return key }
        return "\(monthNames[index % 12]) \(key.prefix(4))"
    }

    /// `2026-12` becomes `2027-01`. Nil for anything that is not yyyy-MM.
    static func nextBudgetMonth(_ month: String) -> String? {
        guard let index = monthIndex(month) else { return nil }
        let next = index + 1
        let year = next / 12
        let monthOfYear = next % 12 + 1
        let paddedYear = String(repeating: "0", count: max(0, 4 - String(year).count)) + String(year)
        let paddedMonth = monthOfYear < 10 ? "0\(monthOfYear)" : "\(monthOfYear)"
        return "\(paddedYear)-\(paddedMonth)"
    }

    /// Months since year zero, or nil for a non-canonical key.
    static func monthIndex(_ month: String) -> Int? {
        guard Phase1DateContract.isValidMonth(month),
              let year = Int(month.prefix(4)),
              let monthOfYear = Int(month.suffix(2))
        else { return nil }
        return year * 12 + (monthOfYear - 1)
    }

    static func canonicalIdentity(for activeProfile: FamilyMember) -> (owner: FamilyMember, sourceFile: String)? {
        if activeProfile.isAdult {
            return (.victor, BudgetCategoryDeletionIntent.canonicalSource)
        }
        if activeProfile == .mason {
            return (.mason, BudgetCategoryDeletionIntent.canonicalMasonSource)
        }
        return nil
    }

    static func isExactRevision(_ value: Double) -> Bool {
        value.isFinite &&
            value > 0 &&
            value <= Double(maximumExactJSONRevision) &&
            value.rounded(.towardZero) == value
    }

    /// Performs no mutation. Order of checks matches the shared contract.
    static func eligibility(
        activeProfile: FamilyMember,
        currentMonth: String,
        selectedMonth: String?,
        budgetOwner: FamilyMember,
        budgetMonth: String,
        budgetUpdatedAtMs: Double?,
        baseUpdatedAtMs: Double,
    ) -> BudgetPlanCarryEligibility {
        guard let currentIndex = monthIndex(currentMonth) else {
            return .ineligible(.invalidCurrentMonth)
        }
        var viewedIndex = currentIndex
        if let selectedMonth {
            guard let selectedIndex = monthIndex(selectedMonth) else {
                return .ineligible(.invalidSelectedMonth)
            }
            viewedIndex = max(viewedIndex, selectedIndex)
        }
        guard let identity = canonicalIdentity(for: activeProfile) else {
            return .ineligible(.unsupportedProfile)
        }
        guard budgetOwner.ledgerOwner == identity.owner else {
            return .ineligible(.ownerMismatch)
        }
        guard let planIndex = monthIndex(budgetMonth),
              let toMonth = nextBudgetMonth(budgetMonth)
        else {
            return .ineligible(.invalidPlanMonth)
        }
        guard viewedIndex > planIndex else {
            return .ineligible(.planIsCurrent)
        }
        guard isExactRevision(baseUpdatedAtMs),
              let exactRevision = Int64(exactly: baseUpdatedAtMs)
        else {
            return .ineligible(.invalidRevision)
        }
        guard baseUpdatedAtMs == budgetUpdatedAtMs else {
            return .ineligible(.revisionMismatch)
        }
        return .eligible(BudgetPlanCarryIntent(
            owner: identity.owner,
            sourceFile: identity.sourceFile,
            fromMonth: budgetMonth,
            toMonth: toMonth,
            baseUpdatedAtMs: exactRevision,
        ))
    }
}

private enum Phase1DateContract {
    static func isValidDay(_ value: String) -> Bool {
        guard value.count == 10,
              value[value.index(value.startIndex, offsetBy: 4)] == "-",
              value[value.index(value.startIndex, offsetBy: 7)] == "-"
        else { return false }

        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        guard let date = formatter.date(from: value) else { return false }
        return formatter.string(from: date) == value
    }

    static func isValidMonth(_ value: String) -> Bool {
        guard value.count == 7,
              value[value.index(value.startIndex, offsetBy: 4)] == "-",
              value.prefix(4).allSatisfy(\.isNumber),
              value.suffix(2).allSatisfy(\.isNumber),
              let year = Int(value.prefix(4)),
              let month = Int(value.suffix(2))
        else { return false }
        return year > 0 && (1 ... 12).contains(month)
    }
}
