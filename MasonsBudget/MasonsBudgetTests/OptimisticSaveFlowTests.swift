import SwiftData
import XCTest

/// Drives the SAME OptimisticSaveFlow.run the add-entry views call — not a
/// standalone component — so a regression in the real save/retry lifecycle
/// fails here. This is the end-to-end gap the revision-2 review found: the ID
/// store rotated correctly while the production path still inserted a fresh
/// local row per attempt and collided on retry.
@MainActor
final class OptimisticSaveFlowTests: XCTestCase {
    private func makeContext() throws -> ModelContext {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: Transaction.self, configurations: configuration)
        return ModelContext(container)
    }

    private func makeTransaction(id: String) -> Transaction {
        Transaction(
            id: id,
            date: Date(timeIntervalSince1970: 1_785_600_000),
            merchant: "Retry Market",
            amount: Decimal(string: "12.34")!,
            category: "Other",
            amountSats: nil,
            enteredInBitcoin: nil,
            card: "on-chain",
            owner: .victor,
            createdBy: "app",
        )
    }

    private func rowCount(in context: ModelContext) throws -> Int {
        try context.fetch(FetchDescriptor<Transaction>()).count
    }

    func testRejectedSaveRollsBackSoRetryWithSameStableIDCannotCollide() throws {
        let context = try makeContext()
        let createIDs = AddTransactionCreateIDStore()
        let stableID = createIDs.transactionID

        // Two consecutive failed attempts, exactly as a user retrying after
        // rejections: same session, same stable ID, fresh model each tap.
        for result in [ConvexWriteResult.failed(.transport), .unauthorized] {
            var delivered: ConvexWriteResult?
            OptimisticSaveFlow.run(
                models: [makeTransaction(id: stableID)],
                operation: "Transaction",
                in: context,
                feedback: WriteFeedbackStore(),
                push: { completion in completion(result) },
                afterResult: { received in
                    delivered = received
                    _ = createIDs.recordServerResult(received, for: .transaction)
                },
            )
            XCTAssertEqual(delivered, result)
            XCTAssertEqual(
                try rowCount(in: context),
                0,
                "A non-accepted result must roll the optimistic row back so the retry starts clean.",
            )
            XCTAssertEqual(
                createIDs.transactionID,
                stableID,
                "The create ID must survive a failed attempt for the retry.",
            )
        }

        // Third attempt succeeds: exactly one row, and the session rotates.
        OptimisticSaveFlow.run(
            models: [makeTransaction(id: stableID)],
            operation: "Transaction",
            in: context,
            feedback: WriteFeedbackStore(),
            push: { completion in completion(.ok) },
            afterResult: { received in
                _ = createIDs.recordServerResult(received, for: .transaction)
            },
        )
        XCTAssertEqual(try rowCount(in: context), 1)
        XCTAssertEqual(
            try context.fetch(FetchDescriptor<Transaction>()).first?.id,
            stableID,
            "The accepted row carries the session's stable ID the server deduped on.",
        )
        XCTAssertNotEqual(
            createIDs.transactionID,
            stableID,
            "Acceptance rotates the session to a fresh create ID.",
        )
    }

    func testAcceptedSaveKeepsTheRowAndDeliversTheResult() throws {
        let context = try makeContext()
        var delivered: ConvexWriteResult?

        let started = OptimisticSaveFlow.run(
            models: [makeTransaction(id: "flow-accept")],
            operation: "Transaction",
            in: context,
            feedback: WriteFeedbackStore(),
            push: { completion in completion(.ok) },
            afterResult: { delivered = $0 },
        )

        XCTAssertTrue(started)
        XCTAssertEqual(delivered, .ok)
        XCTAssertEqual(try rowCount(in: context), 1)
    }
}
