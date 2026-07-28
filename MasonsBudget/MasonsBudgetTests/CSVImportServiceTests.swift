import Foundation
import XCTest

final class CSVImportServiceTests: XCTestCase {
    func testPositivePurchaseIsNotPreviewedAsIncome() throws {
        let csv = """
        date,amount,type,memo
        2026-05-01,1000,purchase,Costco groceries
        """.data(using: .utf8)!

        let imported = try CSVImportService(importBTCPrice: 90000).parseCSV(
            data: csv,
            source: .custom,
        )

        XCTAssertEqual(imported.count, 1)
        XCTAssertEqual(imported[0].category, "Groceries")
        XCTAssertEqual(imported[0].kind, .purchase)
        XCTAssertFalse(imported[0].isIncome)
        XCTAssertFalse(imported[0].isRefund)
        XCTAssertEqual(imported[0].sats, 1000)
        XCTAssertEqual(imported[0].previewSign, "−")
    }

    func testGenuineNegativeRefundRemainsAndIsPreviewedAsRefund() throws {
        let csv = """
        date,amount,type,memo
        2026-05-02,-500,refund,Costco return
        """.data(using: .utf8)!

        let service = CSVImportService(importBTCPrice: 90000)
        let imported = try service.parseCSV(data: csv, source: .custom)
        let transactions = service.toTransactions(imported, owner: .victor, sourceTag: "refund.csv")

        XCTAssertEqual(imported.count, 1)
        XCTAssertEqual(imported[0].category, "Groceries")
        XCTAssertEqual(imported[0].kind, .refund)
        XCTAssertFalse(imported[0].isIncome)
        XCTAssertTrue(imported[0].isRefund)
        XCTAssertEqual(imported[0].sats, -500)
        XCTAssertEqual(imported[0].previewSign, "+")
        XCTAssertEqual(transactions[0].amountSats, -500)
        XCTAssertLessThan(transactions[0].amount, 0)
    }

    func testOldConventionNegativePurchaseIsCanonicalizedPositiveWhenLabeled() throws {
        let csv = """
        date,amount,type,memo
        2026-05-03,-750,purchase,Target
        """.data(using: .utf8)!

        let imported = try CSVImportService().parseCSV(data: csv, source: .custom)

        XCTAssertEqual(imported.count, 1)
        XCTAssertEqual(imported[0].kind, .purchase)
        XCTAssertEqual(imported[0].sats, 750)
        XCTAssertFalse(imported[0].isIncome)
        XCTAssertFalse(imported[0].isRefund)
    }

    func testUnlabeledNegativeNonIncomeAmountIsRejectedAsAmbiguous() throws {
        let csv = """
        date,amount,memo
        2026-05-04,-750,Target
        """.data(using: .utf8)!

        XCTAssertThrowsError(try CSVImportService().parseCSV(data: csv, source: .custom)) { error in
            guard let importError = error as? CSVImportError else {
                return XCTFail("Expected CSVImportError, got \(error)")
            }
            guard case let .ambiguousNegativeAmount(row) = importError else {
                return XCTFail("Expected ambiguousNegativeAmount, got \(importError)")
            }
            XCTAssertEqual(row, 2)
        }
    }

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
