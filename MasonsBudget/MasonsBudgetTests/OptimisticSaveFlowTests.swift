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
            card: "zeus_on_chain",
            owner: .victor,
            createdBy: "app",
        )
    }

    private func rowCount(in context: ModelContext) throws -> Int {
        try context.fetch(FetchDescriptor<Transaction>()).count
    }

    func testTerminalRejectedSaveRollsBackSoRetryWithSameStableIDCannotCollide() throws {
        let context = try makeContext()
        let createIDs = AddTransactionCreateIDStore()
        let stableID = createIDs.transactionID

        // Two terminal rejections, exactly as a user correcting and re-saving:
        // same session, same stable ID, fresh model each tap.
        for result in [ConvexWriteResult.failed(.serverRejected), .unauthorized] {
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
                "A terminal rejection must roll the optimistic row back so a corrected save starts clean.",
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

    func testSaveFlowRefusesASecondInsertWhileTheStableIDIsWriteOwned() throws {
        let context = try makeContext()
        let feedback = WriteFeedbackStore()
        feedback.begin()
        var remoteWriteStarted = false

        let started = OptimisticSaveFlow.run(
            models: [makeTransaction(id: "write-owned")],
            operation: "Transaction",
            in: context,
            feedback: feedback,
            push: { _ in remoteWriteStarted = true },
            afterResult: { _ in },
        )

        XCTAssertFalse(started)
        XCTAssertFalse(remoteWriteStarted)
        XCTAssertEqual(try rowCount(in: context), 0)
    }

    func testRetryableFailureKeepsRowAndAppWriteRetryInstallsRevision() async throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: Transaction.self, configurations: configuration)
        let context = ModelContext(container)
        let transaction = makeTransaction(id: "retained-retry")
        let feedback = WriteFeedbackStore()
        let statusStore = SyncStatusStore()
        let harness = TransactionRetryHarness()

        let started = OptimisticSaveFlow.run(
            models: [transaction],
            operation: "Transaction",
            in: context,
            feedback: feedback,
            push: { completion in
                AppWriteSyncService.pushTransaction(
                    transaction,
                    owner: .victor,
                    statusStore: statusStore,
                    automaticRetries: 0,
                    retryDelayNanoseconds: 0,
                    preflight: { nil },
                    write: { _, _, _ in try await harness.write() },
                    tracksOptimisticCreate: true,
                    onResult: completion,
                )
            },
            afterResult: { harness.results.append($0) },
        )

        XCTAssertTrue(started)
        await waitForResults(1, in: harness)
        XCTAssertEqual(harness.results, [.failed(.transport)])
        XCTAssertEqual(try rowCount(in: context), 1)
        XCTAssertNil(transaction.updatedAtMs)
        XCTAssertEqual(transaction.sourceFile, Transaction.pendingRowWriteSource)
        let freshContext = ModelContext(container)
        let persisted = try XCTUnwrap(
            freshContext.fetch(FetchDescriptor<Transaction>()).first(where: {
                $0.id == transaction.id
            }),
        )
        XCTAssertEqual(
            persisted.sourceFile,
            Transaction.pendingRowWriteSource,
            "The retry marker must survive a fresh ModelContext, not merely the writing context.",
        )
        XCTAssertTrue(statusStore.canRetry)
        XCTAssertFalse(feedback.isSaving)
        XCTAssertTrue(feedback.isRetryPending)

        let liveSync = ConvexSyncService(context: context)
        try liveSync.replaceTransactions(
            ownedBy: [.victor],
            with: [],
            rowAuthoritative: true,
        )
        try context.save()
        XCTAssertEqual(
            try rowCount(in: context),
            1,
            "An authoritative snapshot must not reap a row while its retry payload is live.",
        )

        statusStore.retry()
        await waitForResults(2, in: harness)
        XCTAssertEqual(harness.results, [.failed(.transport), .ok])
        XCTAssertEqual(harness.attempts, 2)
        XCTAssertEqual(try rowCount(in: context), 1)
        XCTAssertEqual(transaction.updatedAtMs, 42)
        XCTAssertEqual(transaction.sourceFile, FamilyMember.victor.transactionsDataFileName)
        let acceptedContext = ModelContext(container)
        let accepted = try XCTUnwrap(
            acceptedContext.fetch(FetchDescriptor<Transaction>()).first(where: {
                $0.id == transaction.id
            }),
        )
        XCTAssertEqual(accepted.updatedAtMs, 42)
        XCTAssertEqual(accepted.sourceFile, FamilyMember.victor.transactionsDataFileName)
        XCTAssertFalse(statusStore.canRetry)
        XCTAssertFalse(feedback.isSaving)
        XCTAssertFalse(feedback.isRetryPending)
    }

    func testAuthoritativeRevisionMakesAStaleTerminalCreateResultAccepted() {
        XCTAssertEqual(
            OptimisticSaveFlow.resolveCreateResult(
                .failed(.serverRejected),
                acceptedRevision: 42,
            ),
            .ok,
        )
        XCTAssertEqual(
            OptimisticSaveFlow.resolveCreateResult(
                .failed(.serverRejected),
                acceptedRevision: nil,
            ),
            .failed(.serverRejected),
        )
    }

    func testGenericTransactionWriterPreservesNonCreateSourceProvenance() async throws {
        let transaction = makeTransaction(id: "csv-provenance")
        transaction.createdBy = "csv_import"
        transaction.sourceFile = "csv-import-strike-2026-08-03"
        let harness = TransactionRetryHarness()

        AppWriteSyncService.pushTransaction(
            transaction,
            owner: .victor,
            statusStore: SyncStatusStore(),
            automaticRetries: 0,
            retryDelayNanoseconds: 0,
            preflight: { nil },
            write: { _, _, _ in try await harness.write() },
        )

        for _ in 0 ..< 100 where harness.attempts < 1 {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(harness.attempts, 1)
        XCTAssertEqual(transaction.sourceFile, "csv-import-strike-2026-08-03")
    }

    private func waitForResults(_ count: Int, in harness: TransactionRetryHarness) async {
        for _ in 0 ..< 100 {
            if harness.results.count >= count { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for \(count) AppWriteSyncService results")
    }
}

@MainActor
private final class TransactionRetryHarness {
    var attempts = 0
    var results: [ConvexWriteResult] = []

    func write() async throws -> Double? {
        attempts += 1
        if attempts == 1 { throw URLError(.timedOut) }
        return 42
    }
}
