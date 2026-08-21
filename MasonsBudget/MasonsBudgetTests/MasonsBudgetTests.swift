// Mason's Budget App — Unit Tests

import SwiftData
import SwiftUI
import XCTest

final class MasonsBudgetTests: XCTestCase {
    // MARK: - Theme & UI

    func testAppThemeColorsExist() {
        XCTAssertEqual(ColorTokens.dark.accent, Color(hex: 0xF7931A))
        XCTAssertEqual(ColorTokens.dark.bg, Color(hex: 0x050505))
        XCTAssertEqual(ColorTokens.dark.surface, Color(hex: 0x15120E))
        XCTAssertEqual(ColorTokens.dark.text, Color(hex: 0xF5F2EA))

        XCTAssertEqual(ColorTokens.light.accent, Color(hex: 0xF7931A))
        XCTAssertEqual(ColorTokens.light.bg, Color(hex: 0xFAF8F4))
        XCTAssertEqual(ColorTokens.light.surface, .white)
        XCTAssertEqual(ColorTokens.light.text, Color(hex: 0x15110A))
    }

    func testAppTabCases() {
        let tabs = AppTab.allCases
        XCTAssertEqual(tabs, [.home, .budget, .tasks, .vault, .more])
        for tab in tabs {
            XCTAssertFalse(tab.label.isEmpty, "\(tab) should have a label")
            XCTAssertFalse(tab.icon.isEmpty, "\(tab) should have an icon")
        }

        XCTAssertTrue(MacNav.moneyItems.contains(.activity))
        XCTAssertTrue(MacNav.moneyItems.contains(.netWorth))
        XCTAssertTrue(MacNav.taskItems.contains(.projects))
        XCTAssertEqual(MacNav.toolItems, [.syncSetup, .export])
        XCTAssertEqual(MacNav.syncSetup.label, "Sync Setup")
        XCTAssertFalse(MacNav.syncSetup.icon.isEmpty)
    }

    func testColorHexInit() {
        let btcOrange = Color(hex: 0xF7931A)
        XCTAssertEqual(
            btcOrange,
            Color(
                red: 247.0 / 255.0,
                green: 147.0 / 255.0,
                blue: 26.0 / 255.0,
            ),
        )
    }

    // MARK: - Enums

    func testFamilyMemberCases() {
        let members = FamilyMember.allCases
        XCTAssertEqual(members.count, 4)
        XCTAssertEqual(FamilyMember.victor.displayName, "Victor")
        XCTAssertEqual(FamilyMember.mason.displayName, "Mason")
    }

    func testFamilyMemberVisibilityRules() {
        XCTAssertTrue(FamilyMember.victor.isAdult)
        XCTAssertTrue(FamilyMember.rachel.isAdult)
        XCTAssertFalse(FamilyMember.mason.isAdult)
        XCTAssertFalse(FamilyMember.maddox.isAdult)

        XCTAssertTrue(FamilyMember.victor.canSee(dataOwnedBy: .mason))
        XCTAssertTrue(FamilyMember.rachel.canSee(dataOwnedBy: .victor))
        XCTAssertFalse(FamilyMember.mason.canSee(dataOwnedBy: .victor))
        XCTAssertEqual(FamilyMember.mason.allowedSwitchTargets, [.mason])
    }

    func testBTCCustodyRawValues() {
        XCTAssertEqual(BTCCustody.exchange.rawValue, "exchange")
        XCTAssertEqual(BTCCustody.selfCustody.rawValue, "self_custody")
    }

    func testSyncOperationCases() {
        XCTAssertEqual(SyncOperation.create.rawValue, "create")
        XCTAssertEqual(SyncOperation.update.rawValue, "update")
        XCTAssertEqual(SyncOperation.delete.rawValue, "delete")
    }

    func testTransactionSourceCatalogIncludesRequestedCards() {
        let spendSources = TransactionSourceCatalog.wires(for: .spend)
        XCTAssertTrue(spendSources.contains("aven"))
        XCTAssertTrue(spendSources.contains("coinbase_card"))
    }

    func testTransactionSourceCatalogFiltersByActivity() {
        let billPaySources = TransactionSourceCatalog.wires(for: .btcBillPay)
        XCTAssertEqual(billPaySources, ["river_bitcoin_bill_pay"])

        let incomeSources = TransactionSourceCatalog.wires(for: .income)
        XCTAssertEqual(incomeSources, ["river", "zeus_lightning", "zeus_on_chain", "strike"])

        XCTAssertFalse(billPaySources.contains("sofi_card"))
    }

    // MARK: - Model init (verify defaults)

    func testTransactionInit() {
        let tx = Transaction(
            id: "t-test-001",
            date: .now,
            merchant: "Costco",
            amount: 45.99,
            category: "Groceries",
            createdBy: "mason",
        )
        XCTAssertEqual(tx.id, "t-test-001")
        XCTAssertEqual(tx.merchant, "Costco")
        XCTAssertEqual(tx.amount, 45.99)
        XCTAssertNil(tx.amountSats)
        XCTAssertNil(tx.card)
        XCTAssertNil(tx.note)
    }

    func testTransactionKeepsFiatAmountSeparateFromSats() {
        let tx = Transaction(
            id: "t-sats-001",
            date: .now,
            merchant: "Strike DCA",
            amount: 90,
            category: "Bitcoin",
            amountSats: 125_000,
            createdBy: "test",
        )

        XCTAssertEqual(tx.amount, 90)
        XCTAssertEqual(tx.amountSats, 125_000)
        XCTAssertEqual(tx.satsValue(btcPrice: 90000), 125_000)
    }

    func testTransactionDerivesSatsFromFiatWhenExplicitSatsMissing() {
        let tx = Transaction(
            id: "t-usd-001",
            date: .now,
            merchant: "Coffee",
            amount: 90,
            category: "Dining",
            createdBy: "test",
        )

        XCTAssertNil(tx.amountSats)
        XCTAssertEqual(tx.satsValue(btcPrice: 90000), 100_000)
    }

    // MARK: - Search

    func testSearchMatcherFindsTransactionAcrossMerchantNoteAmountCategoryAndCard() {
        let tx = Transaction(
            id: "t-search-001",
            date: .now,
            merchant: "Café São Paulo",
            amount: -42.75,
            category: "Dining",
            amountSats: 45000,
            card: "zeus_lightning",
            note: "Family dinner",
            createdBy: "test",
        )

        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "cafe sao"))
        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "family"))
        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "42.75"))
        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "dining"))
        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "45000"))
        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "LIGHTNING"))
        XCTAssertFalse(SearchMatcher.matches(transaction: tx, query: "groceries"))
    }

    func testSearchMatcherFindsTodoAcrossTitleProjectAndArea() {
        let todo = TodoItem(
            id: "todo-search-001",
            title: "Call orthodontist",
            project: "Health Admin",
            area: "Family",
            owner: .rachel,
            createdBy: "mc2",
        )

        XCTAssertTrue(SearchMatcher.matches(todo: todo, query: "ORTHODONTIST"))
        XCTAssertTrue(SearchMatcher.matches(todo: todo, query: "health"))
        XCTAssertTrue(SearchMatcher.matches(todo: todo, query: "family"))
        XCTAssertFalse(SearchMatcher.matches(todo: todo, query: "mortgage"))
    }

    @MainActor
    func testSyncStatusStoreTracksFailureAndRetry() {
        let store = SyncStatusStore()
        var didRetry = false

        let id = store.begin("Save transaction")
        store.complete("Save transaction", id: id, result: .failed(.transport), retry: {
            didRetry = true
        })

        XCTAssertEqual(store.phase, .failed)
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertEqual(store.lastError, "Save transaction was not saved (the network request failed)")
        XCTAssertTrue(store.canRetry)

        store.retry()

        XCTAssertTrue(didRetry)
        XCTAssertEqual(store.phase, .idle)
        XCTAssertNil(store.lastError)
        XCTAssertNil(store.lastResult)
        XCTAssertFalse(store.canRetry)
    }

    @MainActor
    func testSyncStatusStoreClearsAfterFinalSuccess() {
        let store = SyncStatusStore()

        let todoID = store.begin("Save todo")
        let transactionID = store.begin("Save transaction")
        store.complete("Save todo", id: todoID, result: .ok)

        XCTAssertEqual(store.phase, .syncing)
        XCTAssertEqual(store.pendingCount, 1)

        store.complete("Save transaction", id: transactionID, result: .ok)

        XCTAssertEqual(store.phase, .idle)
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertNil(store.lastError)
        XCTAssertNil(store.lastResult)
    }

    @MainActor
    func testSyncStatusStorePreservesEarlierFailureWhenLaterWriteSucceedsLast() {
        let store = SyncStatusStore()

        let firstID = store.begin("CSV transaction A")
        let secondID = store.begin("CSV transaction B")
        store.complete("CSV transaction A", id: firstID, result: .failed(.transport))
        store.complete("CSV transaction B", id: secondID, result: .ok)

        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertEqual(store.phase, .failed)
        XCTAssertEqual(store.lastOperation, "CSV transaction A")
        XCTAssertEqual(store.lastResult, .failed(.transport))
        XCTAssertEqual(
            store.lastError,
            "CSV transaction A was not saved (the network request failed)",
        )
    }

    @MainActor
    func testSyncStatusStorePreservesFailureForConcurrentSameLabelOperations() {
        let store = SyncStatusStore()

        let firstID = store.begin("Save transaction")
        let secondID = store.begin("Save transaction")
        store.complete("Save transaction", id: firstID, result: .failed(.transport))
        store.complete("Save transaction", id: secondID, result: .unauthorized)

        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertEqual(store.phase, .failed)
        XCTAssertEqual(store.lastResult, .failed(.transport))
        XCTAssertEqual(store.retainedFailureCount, 2)

        store.dismissFailure()
        XCTAssertEqual(store.phase, .failed)
        XCTAssertEqual(store.lastResult, .unauthorized)
        XCTAssertEqual(store.retainedFailureCount, 1)

        store.dismissFailure()
        XCTAssertEqual(store.phase, .idle)
        XCTAssertEqual(store.retainedFailureCount, 0)
    }

    @MainActor
    func testSyncStatusStoreDismissesOnlyTheNamedRetryOperation() {
        let store = SyncStatusStore()
        var transactionRetryCount = 0
        var unrelatedRetryCount = 0
        let unrelatedID = store.begin("CSV import")
        let transactionID = store.begin("Save transaction")
        store.complete("CSV import", id: unrelatedID, result: .failed(.transport), retry: {
            unrelatedRetryCount += 1
        })
        store.complete("Save transaction", id: transactionID, result: .failed(.transport), retry: {
            transactionRetryCount += 1
        })

        store.dismissFailure(id: transactionID)
        XCTAssertEqual(store.retainedFailureCount, 1)
        XCTAssertEqual(store.lastOperation, "CSV import")
        store.retry()
        XCTAssertEqual(unrelatedRetryCount, 1)
        XCTAssertEqual(transactionRetryCount, 0)
    }

    @MainActor
    func testExplicitOperationIDBalancesImmediateFailureWithoutOrderingRace() {
        let store = SyncStatusStore()
        let id = AppWriteSyncService.reportSyncStart(
            "Save transaction",
            statusStore: store,
        )

        AppWriteSyncService.reportSyncResult(
            label: "Save transaction",
            operationID: id,
            result: .disabled,
            retry: nil,
            onResult: nil,
            statusStore: store,
        )

        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertEqual(store.phase, .failed)
        XCTAssertEqual(store.lastResult, .disabled)
    }

    @MainActor
    func testExplicitOperationIDBalancesImmediatePayloadFailure() {
        let store = SyncStatusStore()
        let id = AppWriteSyncService.reportSyncStart(
            "Save transaction",
            statusStore: store,
        )

        AppWriteSyncService.reportSyncResult(
            label: "Save transaction",
            operationID: id,
            result: .failed(.invalidAmount(field: "transaction.amount")),
            retry: nil,
            onResult: nil,
            statusStore: store,
        )

        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertEqual(store.retainedFailureCount, 1)
        XCTAssertEqual(
            store.lastError,
            "Save transaction was not saved (transaction.amount is not a writable amount)",
        )
    }

    @MainActor
    func testExplicitOperationIDBalancesMockAsyncCompletion() async {
        let store = SyncStatusStore()
        let id = AppWriteSyncService.reportSyncStart(
            "Save todo",
            statusStore: store,
        )

        await Task.yield()
        AppWriteSyncService.reportSyncResult(
            label: "Save todo",
            operationID: id,
            result: .ok,
            retry: nil,
            onResult: nil,
            statusStore: store,
        )

        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertEqual(store.phase, .idle)
    }

    @MainActor
    func testImmediateWriteBlockerCompletesBeforePushReturns() {
        let original = ConvexConfig.writesEnabled
        SyncStatusStore.shared.resetForTesting()
        defer {
            ConvexConfig.setWritesEnabled(original)
            SyncStatusStore.shared.resetForTesting()
        }
        ConvexConfig.setWritesEnabled(false)
        let recorder = WriteResultRecorder()
        let transaction = Transaction(
            id: "blocked-operation",
            date: .now,
            merchant: "Test",
            amount: 1,
            category: "Other",
            owner: .victor,
            createdBy: "app",
        )

        AppWriteSyncService.pushTransaction(transaction, owner: .victor) {
            recorder.result = $0
        }

        XCTAssertEqual(recorder.result, .disabled)
    }

    @MainActor
    func testImmediatePayloadFailureCompletesBeforePushReturns() {
        SyncStatusStore.shared.resetForTesting()
        defer { SyncStatusStore.shared.resetForTesting() }
        let recorder = WriteResultRecorder()
        let transaction = Transaction(
            id: "invalid-payload-operation",
            date: .now,
            merchant: "Test",
            amount: 1,
            category: "Other",
            owner: .mason,
            createdBy: "app",
        )

        AppWriteSyncService.pushTransaction(transaction, owner: .victor) {
            recorder.result = $0
        }

        XCTAssertEqual(
            recorder.result,
            .failed(.ownerMismatch(field: "transaction")),
        )
    }

    // MARK: - Write result causes (SAT-1342)
    //
    // The regression these guard: every write outcome was a Bool, so a missing
    // sync token, an unauthorized profile and a rejected amount produced the
    // same message. Each cause must stay distinguishable and distinctly worded.

    @MainActor
    func testEveryWriteCauseProducesADistinctMessage() {
        let results: [ConvexWriteResult] = [
            .disabled,
            .notConfigured,
            .unauthorized,
            .missing,
            .failed(.transport),
            .failed(.cancelled),
            .failed(.credentialStorage),
            .failed(.serverRejected),
            .failed(.rowAPIUnavailable),
            .failed(.malformedResponse),
            .failed(.payloadEncoding),
            .failed(.invalidAmount(field: "transaction.amount")),
            .failed(.ownerMismatch(field: "transaction")),
            .failed(.http(status: 500)),
        ]
        let messages = results.map { $0.userMessage(operation: "Save transaction") }

        XCTAssertFalse(messages.contains(where: { $0 == nil }))
        XCTAssertEqual(Set(messages.compactMap { $0 }).count, results.count)
        XCTAssertNil(ConvexWriteResult.ok.userMessage(operation: "Save transaction"))
    }

    @MainActor
    func testWriteCauseCopyMatchesAndroid() {
        XCTAssertEqual(
            ConvexWriteResult.unauthorized.userMessage(operation: "Transaction"),
            "The sync credential is missing or was rejected",
        )
        XCTAssertEqual(
            ConvexWriteResult.notConfigured.userMessage(operation: "Transaction"),
            "Transaction writing is not configured",
        )
        XCTAssertEqual(
            ConvexWriteResult.disabled.userMessage(operation: "Transaction"),
            "Transaction writing is disabled",
        )
        XCTAssertEqual(
            ConvexWriteResult.missing.userMessage(operation: "Transaction"),
            "Convex returned no write result",
        )
        XCTAssertEqual(
            ConvexWriteResult.failed(.serverRejected).userMessage(operation: "Transaction"),
            "Transaction was not saved (the server rejected the write)",
        )
        XCTAssertEqual(
            ConvexWriteResult.failed(.credentialStorage).userMessage(operation: "Pairing"),
            "Pairing was not saved (the device credential could not be stored securely)",
        )
    }

    func testClassifyMapsEveryConvexWriteErrorOntoItsCause() {
        XCTAssertEqual(ConvexWriteResult.classify(ConvexError.unauthorized(path: "tables:upsertTransaction")), .unauthorized)
        XCTAssertEqual(ConvexWriteResult.classify(ConvexError.rowAPIUnavailable(path: "tables:x")), .failed(.rowAPIUnavailable))
        XCTAssertEqual(ConvexWriteResult.classify(ConvexError.serverError(path: "tables:x")), .failed(.serverRejected))
        XCTAssertEqual(ConvexWriteResult.classify(ConvexError.noData("tables:x")), .missing)
        XCTAssertEqual(ConvexWriteResult.classify(ConvexError.httpError(500)), .failed(.http(status: 500)))
        XCTAssertEqual(ConvexWriteResult.classify(ConvexError.httpError(401)), .unauthorized)
        XCTAssertEqual(ConvexWriteResult.classify(ConvexError.notConfigured), .notConfigured)
        XCTAssertEqual(
            ConvexWriteResult.classify(ConvexRowMutationError.fractionalMinorUnit(field: "transaction.amount")),
            .failed(.invalidAmount(field: "transaction.amount")),
        )
        XCTAssertEqual(
            ConvexWriteResult.classify(ConvexRowMutationError.minorUnitOverflow(field: "btcBuy.usd")),
            .failed(.invalidAmount(field: "btcBuy.usd")),
        )
        XCTAssertEqual(
            ConvexWriteResult.classify(ConvexRowMutationError.ownerMismatch(field: "btcBuy", expected: .victor, actual: "mason")),
            .failed(.ownerMismatch(field: "btcBuy")),
        )
        XCTAssertEqual(
            ConvexWriteResult.classify(ConvexRowMutationError.unexpectedResponse(path: "tables:x")),
            .failed(.malformedResponse),
        )
        XCTAssertEqual(
            ConvexWriteResult.classify(TransactionWriteValidationError.ownerMismatch(transactionOwner: "mason", targetOwner: .victor)),
            .failed(.ownerMismatch(field: "transaction")),
        )
        XCTAssertEqual(
            ConvexWriteResult.classify(TransactionWriteValidationError.incomeMustBePositive(owner: .victor)),
            .failed(.invalidAmount(field: "transaction.amount")),
        )
        XCTAssertEqual(ConvexWriteResult.classify(AppWritebackError.notConfigured), .unauthorized)
        XCTAssertEqual(
            ConvexWriteResult.classify(AppWritebackError.credentialStorageFailed),
            .failed(.credentialStorage),
        )
        XCTAssertEqual(ConvexWriteResult.classify(URLError(.timedOut)), .failed(.transport))
        XCTAssertEqual(ConvexWriteResult.classify(CancellationError()), .failed(.cancelled))
    }

    func testNonRetryableCausesDoNotBurnRetries() {
        XCTAssertFalse(ConvexWriteResult.unauthorized.isRetryable)
        XCTAssertFalse(ConvexWriteResult.notConfigured.isRetryable)
        XCTAssertFalse(ConvexWriteResult.disabled.isRetryable)
        XCTAssertFalse(ConvexWriteResult.failed(.invalidAmount(field: "a")).isRetryable)
        XCTAssertFalse(ConvexWriteResult.failed(.ownerMismatch(field: "a")).isRetryable)
        XCTAssertFalse(ConvexWriteResult.failed(.payloadEncoding).isRetryable)
        XCTAssertFalse(ConvexWriteResult.failed(.credentialStorage).isRetryable)
        XCTAssertTrue(ConvexWriteResult.failed(.transport).isRetryable)
        XCTAssertFalse(ConvexWriteResult.failed(.cancelled).isRetryable)
        XCTAssertFalse(ConvexWriteResult.failed(.serverRejected).isRetryable)
        XCTAssertFalse(ConvexWriteResult.failed(.rowAPIUnavailable).isRetryable)
        XCTAssertFalse(ConvexWriteResult.failed(.malformedResponse).isRetryable)
        XCTAssertFalse(ConvexWriteResult.failed(.http(status: 400)).isRetryable)
        XCTAssertTrue(ConvexWriteResult.failed(.http(status: 429)).isRetryable)
        XCTAssertTrue(ConvexWriteResult.failed(.http(status: 503)).isRetryable)
    }

    @MainActor
    func testNoRetryOfferedForACauseRetryingCannotFix() {
        let store = SyncStatusStore()
        var didRetry = false

        let id = store.begin("Save transaction")
        store.complete("Save transaction", id: id, result: .unauthorized, retry: { didRetry = true })

        XCTAssertEqual(store.lastError, "The sync credential is missing or was rejected")
        XCTAssertFalse(store.canRetry)

        store.retry()
        XCTAssertFalse(didRetry)
    }

    @MainActor
    func testBatchTallyReportsPartialImportFailure() {
        let tally = WriteBatchTally()
        tally.start(expected: 3)
        tally.record(.ok)
        tally.record(.unauthorized)
        tally.record(.ok)

        XCTAssertTrue(tally.isFinished)
        XCTAssertEqual(tally.failed, 1)
        XCTAssertEqual(
            tally.summary(operation: "Transaction"),
            "1 of 3 did not sync — The sync credential is missing or was rejected",
        )
    }

    @MainActor
    func testBatchTallyIsSilentWhenEveryWriteLands() {
        let tally = WriteBatchTally()
        tally.start(expected: 2)
        tally.record(.ok)
        tally.record(.ok)

        XCTAssertTrue(tally.isFinished)
        XCTAssertNil(tally.summary(operation: "Transaction"))
    }

    @MainActor
    func testWriteFeedbackStoreHoldsTheSheetOpenOnRejection() {
        let store = WriteFeedbackStore()
        store.begin()
        XCTAssertTrue(store.isSaving)

        XCTAssertFalse(store.finish(.failed(.invalidAmount(field: "transaction.amount")), operation: "Transaction"))
        XCTAssertFalse(store.isSaving)
        XCTAssertEqual(store.message, "Transaction was not saved (transaction.amount is not a writable amount)")

        store.begin()
        XCTAssertTrue(store.finish(.ok, operation: "Transaction"))
        XCTAssertNil(store.message)
    }

    @MainActor
    func testWriteFeedbackRetryOwnershipSurvivesEditsUntilExplicitlyAbandoned() throws {
        let feedback = WriteFeedbackStore()
        let status = SyncStatusStore()
        var staleRetryCount = 0
        let operationID = UUID()
        status.begin("Save transaction", id: operationID)
        feedback.begin()
        feedback.bindRetryOperation(operationID)

        // The amount can be edited while the network write is still in flight.
        // That must not lose the exact retry entry before the result arrives.
        feedback.clear()
        XCTAssertTrue(feedback.isSaving)
        XCTAssertEqual(feedback.retryOperationID, operationID)
        status.complete("Save transaction", id: operationID, result: .failed(.transport), retry: {
            staleRetryCount += 1
        })
        XCTAssertFalse(feedback.finish(.failed(.transport), operation: "Transaction"))
        XCTAssertTrue(feedback.isRetryPending)
        XCTAssertEqual(feedback.retryOperationID, operationID)

        feedback.failRetryAbandonment(.persistence, operation: "Abandon transaction")
        XCTAssertTrue(feedback.isRetryPending)
        XCTAssertEqual(feedback.retryOperationID, operationID)
        XCTAssertEqual(feedback.lastLocalFailure, .persistence)

        status.dismissFailure(id: try XCTUnwrap(feedback.retryOperationID))
        feedback.abandonRetry()
        status.retry()
        XCTAssertEqual(staleRetryCount, 0)
        XCTAssertFalse(feedback.isRetryPending)
        XCTAssertNil(feedback.retryOperationID)
        XCTAssertNil(feedback.lastResult)
    }

    @MainActor
    func testLocalSaveFailureRollsBackAndNeverStartsRemoteWriteback() {
        let context = FailingLocalMutationContext()
        let statusStore = SyncStatusStore()
        var remoteWriteCount = 0
        var mutationValue = "changed"
        let unrelatedValue = "preserved"
        var surfacedFailure: LocalSaveFailure?

        let saved = LocalMutationSave.perform(
            operation: "Transaction",
            in: context,
            statusStore: statusStore,
            onFailure: { surfacedFailure = $0 },
            rollbackMutation: { mutationValue = "original" },
        ) {
            remoteWriteCount += 1
        }

        XCTAssertFalse(saved)
        XCTAssertEqual(context.saveAttempts, 1)
        XCTAssertEqual(mutationValue, "original")
        XCTAssertEqual(unrelatedValue, "preserved")
        XCTAssertEqual(remoteWriteCount, 0)
        XCTAssertEqual(surfacedFailure, .persistence)
        XCTAssertEqual(statusStore.phase, .failed)
        XCTAssertEqual(statusStore.lastLocalFailure, .persistence)
        XCTAssertNil(statusStore.lastResult)
        XCTAssertEqual(
            statusStore.lastError,
            "Transaction was not saved on this device (the local database rejected the change)",
        )

        let id = statusStore.begin("Save todo")
        statusStore.complete("Save todo", id: id, result: .ok)
        XCTAssertEqual(statusStore.phase, .failed)
        XCTAssertEqual(statusStore.lastLocalFailure, .persistence)
    }

    @MainActor
    func testFailedTodoDeleteRollbackReusesTrackedSwiftDataIdentity() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: TodoItem.self, configurations: configuration)
        let context = ModelContext(container)
        let todo = TodoItem(
            id: "rollback-identity",
            title: "Preserve this model",
            owner: .mason,
            createdBy: "app",
        )
        context.insert(todo)
        try context.save()
        let originalPersistentID = todo.persistentModelID

        let unrelated = TodoItem(
            id: "unrelated-pending-edit",
            title: "Original title",
            owner: .victor,
            createdBy: "app",
        )
        context.insert(unrelated)
        try context.save()
        unrelated.title = "Keep this pending edit"

        let rollback = TaskUndoStore.beginTrackedDelete(todo, in: context)
        TaskUndoStore.restoreFailedDelete(rollback)
        try context.save()

        let restored = try XCTUnwrap(
            context.fetch(FetchDescriptor<TodoItem>()).first(where: {
                $0.id == "rollback-identity"
            }),
        )
        XCTAssertTrue(restored === todo)
        XCTAssertEqual(restored.persistentModelID, originalPersistentID)
        XCTAssertEqual(unrelated.title, "Keep this pending edit")
    }

    @MainActor
    func testWriteKillSwitchRefusesBeforeAnyIO() {
        let original = ConvexConfig.writesEnabled
        defer { ConvexConfig.setWritesEnabled(original) }

        ConvexConfig.setWritesEnabled(false)
        XCTAssertEqual(AppWriteSyncService.writeBlocker(requiresSyncToken: true), .disabled)
        XCTAssertEqual(AppWriteSyncService.writeBlocker(requiresSyncToken: false), .disabled)

        ConvexConfig.setWritesEnabled(true)
        XCTAssertNotEqual(AppWriteSyncService.writeBlocker(requiresSyncToken: true), .disabled)
    }

    func testRowReadsDefaultOnWithExplicitKillSwitch() throws {
        let suiteName = "ConvexConfigTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertTrue(ConvexConfig.rowReadsEnabled(in: defaults))
        ConvexConfig.setRowReadsEnabled(false, in: defaults)
        XCTAssertFalse(ConvexConfig.rowReadsEnabled(in: defaults))
        ConvexConfig.setRowReadsEnabled(true, in: defaults)
        XCTAssertTrue(ConvexConfig.rowReadsEnabled(in: defaults))
    }

    @MainActor
    func testCancellationStopsRetryLoopImmediately() async {
        var attempts = 0

        let result = await AppWriteSyncService.withRetry(label: "cancelled mock") {
            attempts += 1
            throw CancellationError()
        }

        XCTAssertEqual(result, .failed(.cancelled))
        XCTAssertEqual(attempts, 1)
    }

    @MainActor
    func testCancellationDuringRetryDelayIsNotSwallowed() async {
        var attempts = 0
        let task = Task { @MainActor in
            await AppWriteSyncService.withRetry(label: "cancelled delay mock") {
                attempts += 1
                throw URLError(.timedOut)
            }
        }

        while attempts == 0 {
            await Task.yield()
        }
        task.cancel()

        let result = await task.value
        XCTAssertEqual(result, .failed(.cancelled))
        XCTAssertEqual(attempts, 1)
    }

    @MainActor
    func testRowWritesAreRefusedBeforeIOWithoutASyncToken() throws {
        // Android's ConvexMutationClient refuses on a missing token instead of
        // discovering the rejection after three retries; Apple now matches. The
        // unit-test bundle has no keychain access group, so hasSyncToken is false.
        let original = ConvexConfig.writesEnabled
        defer { ConvexConfig.setWritesEnabled(original) }
        ConvexConfig.setWritesEnabled(true)

        guard ConvexConfig.isConfigured, !ConvexConfig.hasSyncToken else {
            throw XCTSkip("Needs a configured deployment with no sync token")
        }
        XCTAssertEqual(AppWriteSyncService.writeBlocker(requiresSyncToken: true), .unauthorized)
        // The todo path keeps its paired-device fallback and is not refused here.
        XCTAssertNil(AppWriteSyncService.writeBlocker(requiresSyncToken: false))
    }

    func testBudgetCategoryInit() {
        let cat = BudgetCategory(
            name: "Groceries",
            icon: "cart.fill",
            monthlyBudget: 800,
        )
        XCTAssertEqual(cat.name, "Groceries")
        XCTAssertEqual(cat.sortOrder, 0)
        XCTAssertFalse(cat.isIncome)
    }

    func testTransactionsExportUsesWideRecordVisibility() {
        let adult = Transaction(
            id: "tx-export-adult",
            date: Date(),
            merchant: "Grocer",
            amount: -10,
            category: "Groceries",
            owner: .victor,
            createdBy: "victor",
        )
        let child = Transaction(
            id: "tx-export-child",
            date: Date(),
            merchant: "Game Store",
            amount: 10,
            category: "Gaming",
            owner: .mason,
            createdBy: "mason",
        )

        let adultExport = ExportView.transactionsVisible(to: .victor, in: [adult, child])
        let childExport = ExportView.transactionsVisible(to: .mason, in: [adult, child])

        XCTAssertEqual(adultExport.map(\.id), [adult.id, child.id])
        XCTAssertEqual(childExport.map(\.id), [child.id])
    }

    @MainActor
    func testTransactionDetailCategoryQueryUsesTransactionBudgetScope() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: BudgetCategory.self, configurations: configuration)
        let context = container.mainContext
        context.insert(BudgetCategory(name: "Adult", icon: "house", monthlyBudget: 100, owner: .victor))
        context.insert(BudgetCategory(name: "Spouse", icon: "house", monthlyBudget: 100, owner: .rachel))
        context.insert(BudgetCategory(name: "Child", icon: "gamecontroller", monthlyBudget: 100, owner: .mason))
        try context.save()

        let adultCategories = try context.fetch(FetchDescriptor(
            predicate: TransactionDetailView.categoryPredicate(for: .victor),
        ))
        let childCategories = try context.fetch(FetchDescriptor(
            predicate: TransactionDetailView.categoryPredicate(for: .mason),
        ))

        XCTAssertEqual(Set(adultCategories.map(\.ownerMember)), Set([.victor, .rachel]))
        XCTAssertEqual(childCategories.map(\.ownerMember), [.mason])
    }

    func testBTCAccountInit() throws {
        let acct = try BTCAccount(
            key: "strike-victor",
            label: "Strike",
            custody: .exchange,
            btc: XCTUnwrap(Decimal(string: "0.01001648")),
            owner: .victor,
        )
        XCTAssertEqual(acct.key, "strike-victor")
        XCTAssertEqual(acct.custody, .exchange)
        XCTAssertEqual(acct.fiat, 0)
    }

    func testBTCAccountUsesSyncedFiatValue() throws {
        UserDefaults.standard.removeObject(forKey: BTCPriceService.priceKey)
        let acct = try BTCAccount(
            key: "river-victor",
            label: "River",
            custody: .exchange,
            btc: XCTUnwrap(Decimal(string: "0.5")),
            fiat: 50000,
            owner: .victor,
        )

        XCTAssertEqual(acct.usdValue(), 50000)
    }

    func testBTCAccountUsesLivePriceOverSnapshotFiat() throws {
        let acct = try BTCAccount(
            key: "river-victor-live",
            label: "River",
            custody: .exchange,
            btc: XCTUnwrap(Decimal(string: "0.5")),
            fiat: 50000,
            owner: .victor,
        )

        XCTAssertEqual(acct.usdValue(liveBTCPrice: 100_000), 50000)
    }

    func testRachelTransactionPayloadUsesVictorLedgerOwner() throws {
        let transaction = Transaction(
            id: "adult-shared-ledger",
            date: .now,
            merchant: "Household",
            amount: 10,
            category: "Other",
            owner: .rachel,
            createdBy: "app",
        )

        let dto = try LegacyTransactionDTO(appTransaction: transaction, owner: .rachel)

        XCTAssertEqual(dto.owner, .victor)
    }

    func testBTCBuyInit() throws {
        let buy = try BTCBuy(
            id: "b-strike-2026-04-30",
            date: .now,
            source: "Strike",
            amountBTC: XCTUnwrap(Decimal(string: "0.00052")),
            amountSats: 52000,
            priceUSD: 95000,
            usd: 49.40,
        )
        XCTAssertEqual(buy.status, "complete")
        XCTAssertEqual(buy.costBasisStatus, "complete")
        XCTAssertNil(buy.archimedesRequestId)
    }

    func testBTCBuyPayloadPreservesDecimalAndOwnerShape() throws {
        let buy = try BTCBuy(
            id: "b-app-test",
            date: Date(timeIntervalSince1970: 1_777_000_000),
            source: "River",
            amountBTC: XCTUnwrap(Decimal(string: "0.00123456")),
            amountSats: 123_456,
            priceUSD: XCTUnwrap(Decimal(string: "100000")),
            usd: XCTUnwrap(Decimal(string: "123.456")),
            note: "Logged in app",
            loggedBy: "app",
            owner: .rachel,
        )

        let dto = LegacyBTCBuyDTO(appBuy: buy, owner: .rachel)
        let object = try dto.convexJSONObject()

        XCTAssertEqual(dto.amountBtc, Decimal(string: "0.00123456"))
        XCTAssertEqual(dto.amountSats, 123_456)
        XCTAssertEqual(dto.owner, FamilyMember.victor.rawValue)
        XCTAssertEqual(object["owner"] as? String, FamilyMember.victor.rawValue)
        XCTAssertEqual((object["amount_sats"] as? NSNumber)?.int64Value, 123_456)
    }

    func testBTCBuyFileRoutingUsesDedicatedMasonFileOnly() {
        XCTAssertEqual(FamilyMember.victor.btcBuysDataFileName, "bitcoin-buys")
        XCTAssertEqual(FamilyMember.rachel.btcBuysDataFileName, "bitcoin-buys")
        XCTAssertEqual(FamilyMember.mason.btcBuysDataFileName, "mason-bitcoin-buys")
        XCTAssertEqual(FamilyMember.maddox.btcBuysDataFileName, "bitcoin-buys")
    }

    func testBTCBillPayInit() throws {
        let pay = try BTCBillPay(
            id: "bp-mortgage-2026-04",
            date: .now,
            merchant: "Mortgage",
            category: "Housing",
            amountUSD: 2800,
            btcSpent: XCTUnwrap(Decimal(string: "0.029")),
            btcPrice: 96551,
        )
        XCTAssertEqual(pay.platform, "Strike")
        XCTAssertNil(pay.feeUSD)
        XCTAssertEqual(pay.ownerMember, .victor)
    }

    func testBTCBillPayHiddenFromKidProfiles() throws {
        let pay = try BTCBillPay(
            id: "bp-victor",
            date: .now,
            merchant: "PENNYMAC",
            category: "Mortgage",
            amountUSD: 3613.79,
            btcSpent: XCTUnwrap(Decimal(string: "0.054")),
            btcPrice: 66612.33,
        )
        XCTAssertTrue(FamilyMember.victor.canSee(dataOwnedBy: pay.ownerMember))
        XCTAssertTrue(FamilyMember.rachel.canSee(dataOwnedBy: pay.ownerMember))
        XCTAssertFalse(FamilyMember.mason.canSee(dataOwnedBy: pay.ownerMember))
    }

    func testTodoItemInit() {
        let todo = TodoItem(
            id: "vv-test-task",
            title: "Verify Convex todo sync",
            project: "Inbox",
            dueDate: Date(),
            isFlagged: true,
            owner: .victor,
            createdBy: "vogel-vault",
        )

        XCTAssertEqual(todo.id, "vv-test-task")
        XCTAssertEqual(todo.title, "Verify Convex todo sync")
        XCTAssertEqual(todo.project, "Inbox")
        XCTAssertTrue(todo.isFlagged)
        XCTAssertFalse(todo.isDone)
        XCTAssertEqual(todo.ownerMember, .victor)
    }

    func testTodoMapperSkipsNonFamilyAssignee() throws {
        let json = """
        [
          {
            "id": "sats-agent-task",
            "text": "Operational task that should stay out of Vogel Vault",
            "category": "sats",
            "assignee": "sats",
            "done": false
          },
          {
            "id": "family-task",
            "text": "Call Ann about hiring",
            "category": "work",
            "status": "pending"
          }
        ]
        """.data(using: .utf8)!
        let dtos = try JSONDecoder().decode([LegacyTodoDTO].self, from: json)
        let todos = LedgerMapper.mapTodos(dtos, viewer: .victor)

        XCTAssertEqual(todos.map(\.id), ["family-task"])
        XCTAssertEqual(todos.first?.ownerMember, .victor)
        XCTAssertEqual(todos.first?.project, "work")
    }

    func testTodoDecoderAcceptsNumericTimestamps() throws {
        let json = """
        [
          {
            "id": 1774806795347,
            "text": "Sync task with legacy numeric timestamps",
            "category": "family",
            "createdAt": 1774914863033,
            "updated_at": 1774914863034,
            "completedAt": 1774914863035
          }
        ]
        """.data(using: .utf8)!

        let dtos = try JSONDecoder().decode([LegacyTodoDTO].self, from: json)

        XCTAssertEqual(dtos.first?.id, "1774806795347")
        XCTAssertEqual(dtos.first?.createdAt, "1774914863033")
        XCTAssertEqual(dtos.first?.updatedAt, "1774914863034")
        XCTAssertEqual(dtos.first?.completedAt, "1774914863035")
    }

    func testTodoMapperKeepsRecognizedNonVictorOwnersAndDropsUnknownOwners() throws {
        let json = """
        [
          {
            "id": "rachel-task",
            "text": "Rachel task",
            "owner": "rachel"
          },
          {
            "id": "mason-task",
            "text": "Mason task",
            "owner": "mason"
          },
          {
            "id": "unknown-owner-task",
            "text": "Unknown owner task",
            "owner": "sats"
          }
        ]
        """.data(using: .utf8)!

        let dtos = try JSONDecoder().decode([LegacyTodoDTO].self, from: json)
        let todos = LedgerMapper.mapTodos(dtos, viewer: .victor)

        XCTAssertEqual(todos.map(\.id), ["rachel-task", "mason-task"])
        XCTAssertEqual(todos.map(\.ownerMember), [.rachel, .mason])
    }

    func testAppTodoPayloadPreservesTodoOwner() {
        let todo = TodoItem(
            id: "mason-app-task",
            title: "Mason app task",
            owner: .mason,
            createdBy: "app",
        )

        let dto = LegacyTodoDTO(appTodo: todo)

        XCTAssertEqual(dto.owner, FamilyMember.mason.rawValue)
    }

    func testHoldingAccountRelationship() {
        let acct = HoldingAccount(
            name: "401k",
            provider: "Fidelity",
            owner: .victor,
            totalValue: 773_307.46,
        )
        XCTAssertTrue(acct.holdings.isEmpty)
        XCTAssertEqual(acct.weeklyContribution, 0)
    }
}

@MainActor
private final class WriteResultRecorder {
    var result: ConvexWriteResult?
}

@MainActor
private final class FailingLocalMutationContext: LocalMutationContext {
    private(set) var saveAttempts = 0

    func save() throws {
        saveAttempts += 1
        throw TestLocalSaveError.rejected
    }
}

private enum TestLocalSaveError: Error {
    case rejected
}
