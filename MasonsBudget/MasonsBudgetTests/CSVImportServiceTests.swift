import Foundation
import XCTest

final class CSVImportServiceTests: XCTestCase {
    func testImportedBitcoinRowKeepsFiatAndSatsSeparate() throws {
        let csv = """
        date,amount,memo
        2026-05-01,0.01,Strike DCA
        """.data(using: .utf8)!

        let service = CSVImportService(importBTCPrice: 90000)
        let imported = try service.parseCSV(data: csv, source: .custom)
        let transactions = service.toTransactions(imported, owner: .victor, sourceTag: "test.csv")

        XCTAssertEqual(imported.count, 1)
        XCTAssertEqual(imported[0].sats, 1_000_000)
        XCTAssertEqual(imported[0].amountUsd, 900)

        XCTAssertEqual(transactions.count, 1)
        XCTAssertEqual(transactions[0].amount, 900)
        XCTAssertEqual(transactions[0].amountSats, 1_000_000)
        XCTAssertEqual(transactions[0].satsValue(btcPrice: 90000), 1_000_000)
    }

    func testDuplicateDetectionComparesExplicitSats() throws {
        let csv = """
        date,amount,memo
        2026-05-01,0.01,Strike DCA
        """.data(using: .utf8)!

        let service = CSVImportService()
        let imported = try service.parseCSV(data: csv, source: .custom)
        let existing = Transaction(
            id: "existing",
            date: imported[0].date,
            merchant: "Strike DCA",
            amount: 900,
            category: "Bitcoin",
            amountSats: 1_000_000,
            createdBy: "test",
        )

        XCTAssertTrue(service.filterDuplicates(imported, existing: [existing]).isEmpty)
    }
}
