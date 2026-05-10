import XCTest
import Foundation

final class RecurringDetectorTests: XCTestCase {

    private func makeTransaction(
        id: String,
        merchant: String,
        category: String,
        amount: Decimal,
        date: Date,
        amountSats: Int64? = nil
    ) -> Transaction {
        Transaction(
            id: id,
            date: date,
            merchant: merchant,
            amount: amount,
            category: category,
            amountSats: amountSats,
            createdBy: "test",
            createdAt: date
        )
    }

    private func ymd(_ s: String) -> Date {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.date(from: s)!
    }

    func testDetectsWeeklyRecurring() {
        let txs = [
            makeTransaction(id: "1", merchant: "Kroger", category: "Groceries", amount: 76, date: ymd("2026-04-01")),
            makeTransaction(id: "2", merchant: "Kroger", category: "Groceries", amount: 82, date: ymd("2026-04-08")),
            makeTransaction(id: "3", merchant: "Kroger", category: "Groceries", amount: 79, date: ymd("2026-04-15")),
            makeTransaction(id: "4", merchant: "Kroger", category: "Groceries", amount: 75, date: ymd("2026-04-22")),
        ]
        let results = RecurringDetector().detect(from: txs)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].merchant, "Kroger")
        XCTAssertEqual(results[0].occurrences, 4)
        XCTAssertGreaterThan(results[0].confidence, 0.7)
    }

    func testSkipsSingleTransaction() {
        let txs = [
            makeTransaction(id: "1", merchant: "Costco", category: "Groceries", amount: 200, date: ymd("2026-04-15")),
        ]
        let results = RecurringDetector().detect(from: txs)
        XCTAssertTrue(results.isEmpty)
    }

    func testGroupsByMerchantAndCategory() {
        let txs = [
            makeTransaction(id: "1", merchant: "Amazon", category: "Shopping", amount: 30, date: ymd("2026-04-01")),
            makeTransaction(id: "2", merchant: "Amazon", category: "Bills & Utilities", amount: 15, date: ymd("2026-04-01")),
            makeTransaction(id: "3", merchant: "Amazon", category: "Shopping", amount: 35, date: ymd("2026-04-15")),
        ]
        let results = RecurringDetector().detect(from: txs)
        let shopping = results.filter { $0.category == "Shopping" }
        XCTAssertEqual(shopping.count, 1)
        XCTAssertEqual(shopping[0].occurrences, 2)
    }

    func testFiltersLowConfidence() {
        let txs = [
            makeTransaction(id: "1", merchant: "X", category: "Other", amount: 5, date: ymd("2026-01-15")),
            makeTransaction(id: "2", merchant: "X", category: "Other", amount: 5000, date: ymd("2026-04-30")),
        ]
        let results = RecurringDetector().detect(from: txs)
        XCTAssertTrue(results.isEmpty)
    }

    func testCalculatesNextDate() {
        let txs = [
            makeTransaction(id: "1", merchant: "Netflix", category: "Bills & Utilities", amount: 20, date: ymd("2026-03-01")),
            makeTransaction(id: "2", merchant: "Netflix", category: "Bills & Utilities", amount: 20, date: ymd("2026-04-01")),
        ]
        let results = RecurringDetector().detect(from: txs)
        XCTAssertEqual(results.count, 1)
        XCTAssertNotNil(results[0].nextDate)
    }

    func testSatsDeflationUsesExplicitSatsNotFiatAmount() {
        let txs = [
            makeTransaction(id: "1", merchant: "Rent", category: "Housing", amount: 1_500, date: ymd("2025-03-01"), amountSats: 600_000),
            makeTransaction(id: "2", merchant: "Rent", category: "Housing", amount: 1_500, date: ymd("2025-04-01"), amountSats: 600_000),
            makeTransaction(id: "3", merchant: "Rent", category: "Housing", amount: 1_500, date: ymd("2026-03-01"), amountSats: 400_000),
            makeTransaction(id: "4", merchant: "Rent", category: "Housing", amount: 1_500, date: ymd("2026-04-01"), amountSats: 400_000),
        ]

        let results = RecurringDetector().detect(from: txs, referenceDate: ymd("2026-05-09"))

        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].satsLastYear, 1_200_000)
        let diff = abs((results[0].yoyChangePct ?? 0) - Decimal(-33.3333))
        XCTAssertLessThan(diff, Decimal(0.001))
    }
}
