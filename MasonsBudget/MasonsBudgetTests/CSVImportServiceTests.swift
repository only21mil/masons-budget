import Foundation
import XCTest

final class CSVImportServiceTests: XCTestCase {
    func testPositivePurchaseIsNotClassifiedAsIncome() throws {
        let csv = """
        date,amount,memo
        2026-05-01,500,Costco
        """.data(using: .utf8)!

        let imported = try CSVImportService().parseCSV(data: csv, source: .custom)

        XCTAssertEqual(imported.count, 1)
        XCTAssertEqual(imported[0].sats, 500)
        XCTAssertEqual(imported[0].category, "Groceries")
        XCTAssertFalse(imported[0].isIncome)
    }

    func testNegativeRefundKeepsItsSignAndIsNotClassifiedAsIncome() throws {
        let csv = """
        date,amount,memo
        2026-05-01,-500,Costco refund
        """.data(using: .utf8)!

        let service = CSVImportService(importBTCPrice: 100_000)
        let imported = try service.parseCSV(data: csv, source: .custom)
        let transactions = service.toTransactions(imported, owner: .victor, sourceTag: "test.csv")

        XCTAssertEqual(imported.count, 1)
        XCTAssertEqual(imported[0].sats, -500)
        XCTAssertEqual(imported[0].category, "Groceries")
        XCTAssertFalse(imported[0].isIncome)

        XCTAssertEqual(transactions.count, 1)
        XCTAssertEqual(transactions[0].amount, -0.5)
        XCTAssertEqual(transactions[0].amountSats, -500)
        XCTAssertTrue(transactions[0].hasOppositeSpendSign)
        XCTAssertFalse(transactions[0].isIncome)
    }

    func testImportedBitcoinRowKeepsFiatAndSatsSeparate() throws {
        let csv = """
        date,btc,memo
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
        XCTAssertEqual(transactions[0].enteredInBitcoin, true)
        XCTAssertEqual(transactions[0].satsValue(btcPrice: 90000), 1_000_000)
    }

    func testImportedSatIncomeCarriesBitcoinOriginMarker() throws {
        let csv = """
        date,sats,memo
        2026-05-01,1000000,Payroll income
        """.data(using: .utf8)!

        let service = CSVImportService(importBTCPrice: 90_000)
        let imported = try service.parseCSV(data: csv, source: .custom)
        let transactions = service.toTransactions(imported, owner: .victor, sourceTag: "income.csv")

        XCTAssertEqual(transactions.count, 1)
        XCTAssertEqual(transactions[0].category, "Income")
        XCTAssertEqual(transactions[0].amountSats, 1_000_000)
        XCTAssertEqual(transactions[0].enteredInBitcoin, true)
    }

    func testImportedUSDIncomeOmitsBitcoinOriginMarker() throws {
        let csv = """
        date,amount_usd,memo
        2026-05-01,900,Payroll income
        """.data(using: .utf8)!

        let service = CSVImportService(importBTCPrice: 90_000)
        let imported = try service.parseCSV(data: csv, source: .custom)
        let transactions = service.toTransactions(imported, owner: .victor, sourceTag: "income.csv")

        XCTAssertEqual(transactions.count, 1)
        XCTAssertEqual(transactions[0].category, "Income")
        XCTAssertEqual(transactions[0].enteredInBitcoin, false)
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
