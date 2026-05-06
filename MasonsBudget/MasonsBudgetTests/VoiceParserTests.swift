// Mason's Budget App — VoiceParser tests (SAT-308)

import XCTest
import Foundation

final class VoiceParserTests: XCTestCase {

    // Pin "today" so weekday math is deterministic. 2026-04-30 is a Thursday.
    private let today: Date = {
        var c = DateComponents()
        c.year = 2026; c.month = 4; c.day = 30
        c.timeZone = TimeZone(identifier: "America/New_York")
        return Calendar(identifier: .gregorian).date(from: c)!
    }()

    private let parser = VoiceParser()

    // MARK: - Amount

    func testAmount_DollarSign() {
        XCTAssertEqual(parser.parse("$45 at Costco", today: today).amount, 45)
        XCTAssertEqual(parser.parse("spent $12.50 on lunch", today: today).amount, Decimal(string: "12.50"))
        XCTAssertEqual(parser.parse("paid $1,234.56", today: today).amount, Decimal(string: "1234.56"))
    }

    func testAmount_DollarsKeyword() {
        XCTAssertEqual(parser.parse("45 dollars at Kroger", today: today).amount, 45)
        XCTAssertEqual(parser.parse("12.30 dollars", today: today).amount, Decimal(string: "12.30"))
        XCTAssertEqual(parser.parse("5 bucks", today: today).amount, 5)
    }

    func testAmount_Verb() {
        XCTAssertEqual(parser.parse("spent 45 at Kroger", today: today).amount, 45)
        XCTAssertEqual(parser.parse("paid about 100 at Costco", today: today).amount, 100)
    }

    func testAmount_WordNumbers() {
        XCTAssertEqual(parser.parse("five dollars at Starbucks", today: today).amount, 5)
        XCTAssertEqual(parser.parse("forty five dollars at Kroger", today: today).amount, 45)
        XCTAssertEqual(parser.parse("two hundred dollars", today: today).amount, 200)
        XCTAssertEqual(parser.parse("one thousand dollars", today: today).amount, 1000)
    }

    func testAmount_Missing() {
        let r = parser.parse("at Costco yesterday", today: today)
        XCTAssertNil(r.amount)
        XCTAssertEqual(r.confidence.amount, 0)
    }

    func testAmount_ConfidenceHighForDollarSign() {
        let r = parser.parse("$45", today: today)
        XCTAssertGreaterThanOrEqual(r.confidence.amount, 0.9)
    }

    // MARK: - Merchant

    func testMerchant_AtPreposition() {
        XCTAssertEqual(parser.parse("$45 at Costco", today: today).merchant, "Costco")
        XCTAssertEqual(parser.parse("12 at Trader Joe's", today: today).merchant, "Trader Joe's")
    }

    func testMerchant_FromPreposition() {
        XCTAssertEqual(parser.parse("$30 from Amazon", today: today).merchant, "Amazon")
    }

    func testMerchant_ForServiceSubscription() {
        XCTAssertEqual(parser.parse("I spent $9.99 for an Apple iCloud subscription", today: today).merchant, "Apple iCloud")
        XCTAssertEqual(parser.parse("paid 9.99 for Apple iCloud subscription", today: today).merchant, "Apple iCloud")
    }

    func testMerchant_TrimsTrailingFollowOn() {
        // "Costco For" should drop the "For"
        XCTAssertEqual(parser.parse("$45 at Costco For", today: today).merchant, "Costco")
        XCTAssertEqual(parser.parse("$45 at Costco Yesterday", today: today).merchant, "Costco")
    }

    func testMerchant_Missing() {
        let r = parser.parse("spent 5 dollars yesterday", today: today)
        XCTAssertNil(r.merchant)
    }

    // MARK: - Category

    func testCategory_FromMerchant() {
        XCTAssertEqual(parser.parse("$45 at Costco", today: today).category, "Groceries")
        XCTAssertEqual(parser.parse("$12 at Chick-fil-A", today: today).category, "Dining & Drinks")
        XCTAssertEqual(parser.parse("$60 at Shell", today: today).category, "Auto & Transport")
        XCTAssertEqual(parser.parse("$35 at Target", today: today).category, "Shopping")
        XCTAssertEqual(parser.parse("$20 at Netflix", today: today).category, "Bills & Utilities")
    }

    func testCategory_KeywordFallback_WhenNoMerchantMatch() {
        // No known merchant; keyword "groceries" should resolve.
        let r = parser.parse("$45 for groceries", today: today)
        XCTAssertEqual(r.category, "Groceries")
    }

    func testCategory_ServiceSubscription() {
        XCTAssertEqual(parser.parse("I spent $9.99 for an Apple iCloud subscription", today: today).category, "Bills & Utilities")
        XCTAssertEqual(parser.parse("paid 9.99 for Apple iCloud subscription", today: today).category, "Bills & Utilities")
    }

    func testCategory_CommonMicrophoneCuesUseCanonicalCategories() {
        XCTAssertEqual(parser.parse("log 18 dollars at Starbucks for coffee", today: today).category, "Dining & Drinks")
        XCTAssertEqual(parser.parse("spent 42 dollars at Shell gas station", today: today).category, "Auto & Transport")
        XCTAssertEqual(parser.parse("paid 120 dollars at CVS pharmacy", today: today).category, "Medical")
        XCTAssertEqual(parser.parse("spent 64 dollars at Chewy for dog food", today: today).category, "Pets")
        XCTAssertEqual(parser.parse("paid 80 dollars under health and wellness", today: today).category, "Health & Wellness")
    }

    func testCategory_ExplicitAliasWins() {
        XCTAssertEqual(parser.parse("spent 22 dollars at Unknown category bills", today: today).category, "Bills & Utilities")
        XCTAssertEqual(parser.parse("spent 30 dollars at Food Truck under dining", today: today).category, "Dining & Drinks")
    }

    func testCategory_LunchKeyword() {
        let r = parser.parse("spent 12 on lunch yesterday", today: today)
        XCTAssertEqual(r.category, "Dining & Drinks")
    }

    func testCategory_PaycheckIncome() {
        let r = parser.parse("paycheck 1500", today: today)
        XCTAssertEqual(r.category, "Income")
    }

    func testCategory_NilWhenUnknown() {
        let r = parser.parse("$5 at SomethingObscure", today: today)
        XCTAssertNil(r.category)
    }

    // MARK: - Date

    func testDate_Today() {
        let r = parser.parse("$5 at Costco today", today: today)
        let cal = Calendar(identifier: .gregorian)
        XCTAssertEqual(cal.startOfDay(for: r.date ?? .distantPast), cal.startOfDay(for: today))
    }

    func testDate_Yesterday() {
        let r = parser.parse("$5 at Costco yesterday", today: today)
        let cal = Calendar(identifier: .gregorian)
        let expected = cal.date(byAdding: .day, value: -1, to: cal.startOfDay(for: today))!
        XCTAssertEqual(cal.startOfDay(for: r.date ?? .distantPast), expected)
    }

    func testDate_DayBeforeYesterday() {
        let r = parser.parse("$5 at Costco the day before yesterday", today: today)
        let cal = Calendar(identifier: .gregorian)
        let expected = cal.date(byAdding: .day, value: -2, to: cal.startOfDay(for: today))!
        XCTAssertEqual(cal.startOfDay(for: r.date ?? .distantPast), expected)
    }

    func testDate_LastWeekday() {
        // 2026-04-30 is a Thursday. "last Friday" = 2026-04-24.
        let r = parser.parse("$5 at Costco last Friday", today: today)
        let cal = Calendar(identifier: .gregorian)
        let comps = cal.dateComponents([.year, .month, .day], from: r.date ?? .distantPast)
        XCTAssertEqual(comps.year, 2026)
        XCTAssertEqual(comps.month, 4)
        XCTAssertEqual(comps.day, 24)
    }

    func testDate_BareWeekday_PrefersPast() {
        // Bare "Tuesday" on a Thursday → previous Tuesday (2026-04-28).
        let r = parser.parse("$5 at Costco on Tuesday", today: today)
        let cal = Calendar(identifier: .gregorian)
        let comps = cal.dateComponents([.year, .month, .day], from: r.date ?? .distantPast)
        XCTAssertEqual(comps.year, 2026)
        XCTAssertEqual(comps.month, 4)
        XCTAssertEqual(comps.day, 28)
    }

    func testDate_ISOFormat() {
        let r = parser.parse("$5 at Costco 2026-04-15", today: today)
        let cal = Calendar(identifier: .gregorian)
        let comps = cal.dateComponents([.year, .month, .day], from: r.date ?? .distantPast)
        XCTAssertEqual(comps.year, 2026)
        XCTAssertEqual(comps.month, 4)
        XCTAssertEqual(comps.day, 15)
    }

    func testDate_SlashFormat() {
        let r = parser.parse("$5 at Costco 4/15", today: today)
        let cal = Calendar(identifier: .gregorian)
        let comps = cal.dateComponents([.year, .month, .day], from: r.date ?? .distantPast)
        XCTAssertEqual(comps.year, 2026)
        XCTAssertEqual(comps.month, 4)
        XCTAssertEqual(comps.day, 15)
    }

    func testDate_MonthName() {
        let r = parser.parse("$5 at Costco April 15", today: today)
        let cal = Calendar(identifier: .gregorian)
        let comps = cal.dateComponents([.year, .month, .day], from: r.date ?? .distantPast)
        XCTAssertEqual(comps.year, 2026)
        XCTAssertEqual(comps.month, 4)
        XCTAssertEqual(comps.day, 15)
    }

    func testDate_MonthNameRollsToPriorYear() {
        // "December 1" on April 30 → assume previous December (2025).
        let r = parser.parse("$5 at Costco December 1", today: today)
        let cal = Calendar(identifier: .gregorian)
        let comps = cal.dateComponents([.year, .month, .day], from: r.date ?? .distantPast)
        XCTAssertEqual(comps.year, 2025)
        XCTAssertEqual(comps.month, 12)
    }

    func testDate_MissingDefaultsToToday() {
        let r = parser.parse("$5 at Costco", today: today)
        let cal = Calendar(identifier: .gregorian)
        XCTAssertEqual(cal.startOfDay(for: r.date ?? .distantPast), cal.startOfDay(for: today))
        // No phrase parsed → neutral confidence.
        XCTAssertEqual(r.confidence.date, 0.5, accuracy: 0.001)
    }

    // MARK: - Card

    func testCard_OnPreposition() {
        XCTAssertEqual(parser.parse("$45 at Costco on Strike", today: today).card, "Strike")
    }

    func testCard_WithMy() {
        XCTAssertEqual(parser.parse("$45 at Costco with my Strike", today: today).card, "Strike")
    }

    func testCard_AppleCardMultiword() {
        XCTAssertEqual(parser.parse("$45 at Costco with Apple Card", today: today).card, "Apple Card")
    }

    func testCard_Missing() {
        XCTAssertNil(parser.parse("$45 at Costco", today: today).card)
    }

    // MARK: - Note

    func testNote_ExplicitPrefix() {
        let r = parser.parse("$45 at Costco note: birthday cake", today: today)
        XCTAssertEqual(r.note, "birthday cake")
    }

    func testNote_Missing() {
        XCTAssertNil(parser.parse("$45 at Costco", today: today).note)
    }

    // MARK: - Confidence + hasMinimumFields

    func testHasMinimumFields() {
        let full = parser.parse("$45 at Costco", today: today)
        XCTAssertTrue(full.hasMinimumFields)

        let amountOnly = parser.parse("$45", today: today)
        XCTAssertFalse(amountOnly.hasMinimumFields)

        let merchantOnly = parser.parse("at Costco", today: today)
        XCTAssertFalse(merchantOnly.hasMinimumFields)
    }

    func testOverallConfidence_HighWhenAllFieldsPresent() {
        let r = parser.parse("$45 at Costco yesterday", today: today)
        XCTAssertGreaterThan(r.confidence.overall, 0.7)
    }

    func testOverallConfidence_LowWhenOnlyVerb() {
        let r = parser.parse("spent some money", today: today)
        XCTAssertLessThan(r.confidence.overall, 0.5)
    }

    // MARK: - Integration

    func testIntegration_RealisticTranscript() {
        let r = parser.parse("Spent $76.81 at Kroger yesterday with Strike", today: today)
        XCTAssertEqual(r.amount, Decimal(string: "76.81"))
        XCTAssertEqual(r.merchant, "Kroger")
        XCTAssertEqual(r.category, "Groceries")
        XCTAssertEqual(r.card, "Strike")
        let cal = Calendar(identifier: .gregorian)
        let expected = cal.date(byAdding: .day, value: -1, to: cal.startOfDay(for: today))!
        XCTAssertEqual(cal.startOfDay(for: r.date ?? .distantPast), expected)
        XCTAssertGreaterThan(r.confidence.overall, 0.8)
    }

    func testIntegration_MortgagePayment() {
        let r = parser.parse("Paid $3,613.79 to PennyMac on Strike note: monthly mortgage", today: today)
        XCTAssertEqual(r.amount, Decimal(string: "3613.79"))
        XCTAssertEqual(r.merchant, "PennyMac")
        XCTAssertEqual(r.category, "Bills & Utilities")
        XCTAssertEqual(r.card, "Strike")
        XCTAssertEqual(r.note, "monthly mortgage")
    }

    // MARK: - LLM fallback hook

    func testNoOpFallback_PassesThrough() async {
        let partial = ParsedTransaction(amount: 5, merchant: "X")
        let refined = await NoOpLLMFallback().refine(transcript: "irrelevant", partial: partial)
        XCTAssertEqual(refined, partial)
    }

    func testParseWithFallback_HighConfidenceSkipsFallback() async {
        let recorder = RecordingFallback()
        let p = VoiceParser(llmFallback: recorder, confidenceThreshold: 0.5)
        _ = await p.parseWithFallback("$45 at Costco yesterday", today: today)
        XCTAssertEqual(recorder.callCount, 0)
    }

    func testParseWithFallback_LowConfidenceTriggersFallback() async {
        let recorder = RecordingFallback()
        let p = VoiceParser(llmFallback: recorder, confidenceThreshold: 0.95)
        _ = await p.parseWithFallback("spent some money", today: today)
        XCTAssertEqual(recorder.callCount, 1)
    }
}

// Test double — counts how many times the fallback was invoked.
private final class RecordingFallback: VoiceParserLLMFallback, @unchecked Sendable {
    var callCount = 0
    func refine(transcript: String, partial: ParsedTransaction) async -> ParsedTransaction {
        callCount += 1
        return partial
    }
}
