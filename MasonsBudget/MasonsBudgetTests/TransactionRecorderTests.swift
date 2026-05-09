import XCTest
import SwiftData
import Foundation

@MainActor
final class TransactionRecorderTests: XCTestCase {
    private var container: ModelContainer!
    private var context: ModelContext!

    override func setUp() async throws {
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        container = try ModelContainer(
            for: Transaction.self, BudgetCategory.self, MonthlyBudgetSnapshot.self,
            BTCAccount.self, BTCBuy.self, BTCBillPay.self, HoldingAccount.self,
            Holding.self, HoldingLot.self, SyncEvent.self, FamilyProfile.self,
            NetWorthSnapshot.self,
            configurations: config
        )
        context = container.mainContext
    }

    override func tearDown() async throws {
        UserDefaults.standard.removeObject(forKey: "selected_family_member")
        container = nil
        context = nil
    }

    func testRecordWritesTransactionToModelContext() throws {
        let recorder = TransactionRecorder(modelContext: context, convex: ConvexClient(deploymentURL: URL(string: "https://example.invalid")!))
        let tx = try recorder.record(
            amount: 12.34,
            merchant: "Costco",
            category: "Groceries",
            card: "SoFi Card",
            note: nil,
            owner: .victor,
            source: .siri
        )

        XCTAssertEqual(tx.merchant, "Costco")
        XCTAssertEqual(tx.amount, 12.34)
        XCTAssertEqual(tx.category, "Groceries")
        XCTAssertEqual(tx.card, "SoFi Card")
        XCTAssertEqual(tx.ownerMember, .victor)
        XCTAssertEqual(tx.createdBy, "siri")
        XCTAssertTrue(tx.id.hasPrefix("siri-"))

        let stored = try context.fetch(FetchDescriptor<Transaction>())
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored.first?.id, tx.id)
    }

    func testRecordMasonTransactionUsesMasonOwnership() throws {
        let recorder = TransactionRecorder(modelContext: context, convex: ConvexClient(deploymentURL: URL(string: "https://example.invalid")!))
        let tx = try recorder.record(
            amount: 5,
            merchant: "Allowance",
            category: "Allowance",
            owner: .mason,
            source: .siri
        )

        XCTAssertEqual(tx.ownerMember, .mason)
    }

    func testActiveProfileThrowsWhenUserDefaultsMissing() {
        UserDefaults.standard.removeObject(forKey: "selected_family_member")
        XCTAssertThrowsError(try TransactionRecorder.activeProfile()) { error in
            XCTAssertEqual((error as? TransactionRecorder.RecorderError), .noActiveProfile)
        }
    }

    func testActiveProfileResolvesFromUserDefaults() throws {
        UserDefaults.standard.set("rachel", forKey: "selected_family_member")
        XCTAssertEqual(try TransactionRecorder.activeProfile(), .rachel)
    }
}

extension TransactionRecorder.RecorderError: Equatable {
    static func == (lhs: TransactionRecorder.RecorderError, rhs: TransactionRecorder.RecorderError) -> Bool {
        switch (lhs, rhs) {
        case (.noActiveProfile, .noActiveProfile): return true
        }
    }
}
