import Foundation
@testable import VogelVaultCore
import XCTest

final class VoiceParserCoreTests: XCTestCase {
    private let today: Date = {
        var components = DateComponents()
        components.year = 2026
        components.month = 4
        components.day = 30
        components.timeZone = TimeZone(identifier: "America/New_York")
        return Calendar(identifier: .gregorian).date(from: components)!
    }()

    func testParsesAmountMerchantCategoryAndCard() {
        let result = VoiceParser().parse("$45 at Costco on Strike", today: today)

        XCTAssertEqual(result.amount, 45)
        XCTAssertEqual(result.merchant, "Costco")
        XCTAssertEqual(result.category, "Groceries")
        XCTAssertEqual(result.card, "Strike")
        XCTAssertTrue(result.hasMinimumFields)
    }

    func testDateParsingPrefersPastWeekday() {
        let result = VoiceParser().parse("$5 at Costco on Tuesday", today: today)
        let components = Calendar(identifier: .gregorian).dateComponents(
            [.year, .month, .day],
            from: result.date ?? .distantPast
        )

        XCTAssertEqual(components.year, 2026)
        XCTAssertEqual(components.month, 4)
        XCTAssertEqual(components.day, 28)
    }

    func testFallbackRunsForLowConfidence() async {
        let fallback = RecordingFallback()
        let parser = VoiceParser(llmFallback: fallback, confidenceThreshold: 0.95)

        let result = await parser.parseWithFallback("pay something maybe", today: today)

        XCTAssertTrue(fallback.wasCalled)
        XCTAssertEqual(result.merchant, "Fallback")
    }
}

private final class RecordingFallback: VoiceParserLLMFallback, @unchecked Sendable {
    private(set) var wasCalled = false

    func refine(transcript: String, partial: ParsedTransaction) async -> ParsedTransaction {
        wasCalled = true
        var refined = partial
        refined.amount = refined.amount ?? 1
        refined.merchant = "Fallback"
        return refined
    }
}
