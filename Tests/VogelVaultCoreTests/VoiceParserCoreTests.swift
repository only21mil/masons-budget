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
}
