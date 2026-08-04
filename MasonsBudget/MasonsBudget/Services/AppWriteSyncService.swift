import Foundation
import os

enum AppWriteSyncError: Error {
    case unexpectedPayload
}

/// Carries the revision out of the escaping retry closure without mutating a
/// captured `var` from concurrently-executing code.
private final class AcceptedRevisionBox: @unchecked Sendable {
    var value: Double?
}

@MainActor
enum AppWriteSyncService {
    typealias TransactionRowWrite = @MainActor @Sendable (
        LegacyTransactionDTO,
        FamilyMember,
        String
    ) async throws -> Double?

    private static let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "AppWriteSync")
    private static let maxRetries = 2
    private static let retryDelay: UInt64 = 2_000_000_000

    private static func makeClient() -> ConvexClient {
        ConvexClient(deploymentURL: ConvexConfig.deploymentURL)
    }

    static func pushTransaction(
        _ transaction: Transaction,
        owner: FamilyMember,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        pushTransaction(
            transaction,
            owner: owner,
            statusStore: nil,
            automaticRetries: maxRetries,
            retryDelayNanoseconds: retryDelay,
            preflight: { writeBlocker(requiresSyncToken: true) },
            write: { payload, canonicalOwner, fileName in
                let client = makeClient()
                return try await client.upsertTransactionRow(
                    payload,
                    owner: canonicalOwner,
                    sourceFile: fileName,
                )
            },
            onResult: onResult,
        )
    }

    /// Injection seam used by the transaction retry regression. Production
    /// calls this same path with the real preflight and row writer above.
    static func pushTransaction(
        _ transaction: Transaction,
        owner: FamilyMember,
        statusStore: SyncStatusStore?,
        automaticRetries: Int,
        retryDelayNanoseconds: UInt64,
        preflight: @escaping @MainActor @Sendable () -> ConvexWriteResult?,
        write: @escaping TransactionRowWrite,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let canonicalOwner = owner.ledgerOwner
        let label = "Save transaction"
        let payload: LegacyTransactionDTO
        do {
            payload = try LegacyTransactionDTO(appTransaction: transaction, owner: canonicalOwner)
        } catch {
            log.error("Refused transaction payload: \(ConvexWriteResult.classify(error).diagnosticCode, privacy: .public)")
            let operationID = reportSyncStart(label, statusStore: statusStore)
            reportSyncResult(
                label: label,
                operationID: operationID,
                result: ConvexWriteResult.classify(error),
                retry: nil,
                onResult: onResult,
                statusStore: statusStore,
            )
            return
        }

        let fileName = canonicalOwner.transactionsDataFileName
        let deliverResult: @MainActor @Sendable (ConvexWriteResult) -> Void = { result in
            if result.isRetryable {
                // This marker is persisted with the optimistic row. If the
                // in-memory Retry action is dismissed or lost on app exit, a
                // later complete row sync can remove the server-absent row
                // instead of leaving a permanent local-only transaction.
                transaction.sourceFile = Transaction.pendingRowWriteSource
            } else if result.isOk {
                transaction.sourceFile = fileName
            }
            onResult?(result)
        }
        pushTransactionPayload(
            payload,
            owner: canonicalOwner,
            to: fileName,
            statusStore: statusStore,
            automaticRetries: automaticRetries,
            retryDelayNanoseconds: retryDelayNanoseconds,
            preflight: preflight,
            write: write,
            onAttemptStart: { transaction.sourceFile = nil },
            onResult: deliverResult,
            // The server fences the next edit and delete on the revision it just
            // accepted. Install it now or an immediate add -> edit is rejected
            // until some later sync happens to refresh the row.
            onAcceptedRevision: { accepted in transaction.updatedAtMs = accepted },
        )
    }

    private static func pushTransactionPayload(
        _ payload: LegacyTransactionDTO,
        owner: FamilyMember,
        to fileName: String,
        statusStore: SyncStatusStore?,
        automaticRetries: Int,
        retryDelayNanoseconds: UInt64,
        preflight: @escaping @MainActor @Sendable () -> ConvexWriteResult?,
        write: @escaping TransactionRowWrite,
        onAttemptStart: (@MainActor @Sendable () -> Void)? = nil,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
        onAcceptedRevision: (@MainActor @Sendable (Double) -> Void)? = nil,
    ) {
        let label = "Save transaction"
        onAttemptStart?()
        let operationID = reportSyncStart(label, statusStore: statusStore)
        if let blocked = preflight() {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                pushTransactionPayload(
                    payload, owner: owner, to: fileName,
                    statusStore: statusStore,
                    automaticRetries: automaticRetries,
                    retryDelayNanoseconds: retryDelayNanoseconds,
                    preflight: preflight,
                    write: write,
                    onAttemptStart: onAttemptStart,
                    onResult: onResult, onAcceptedRevision: onAcceptedRevision,
                )
            }, onResult: onResult, statusStore: statusStore)
            return
        }

        Task {
            let revision = AcceptedRevisionBox()
            let result = await withRetry(
                label: "push tx \(payload.id)",
                maxRetryCount: automaticRetries,
                retryDelayNanoseconds: retryDelayNanoseconds,
            ) {
                revision.value = try await write(payload, owner, fileName)
            }
            if case .ok = result, let accepted = revision.value {
                onAcceptedRevision?(accepted)
            }
            reportSyncResult(label: label, operationID: operationID, result: result, retry: {
                pushTransactionPayload(
                    payload, owner: owner, to: fileName,
                    statusStore: statusStore,
                    automaticRetries: automaticRetries,
                    retryDelayNanoseconds: retryDelayNanoseconds,
                    preflight: preflight,
                    write: write,
                    onAttemptStart: onAttemptStart,
                    onResult: onResult, onAcceptedRevision: onAcceptedRevision,
                )
            }, onResult: onResult, statusStore: statusStore)
        }
    }

    static func deleteTransaction(
        _ transaction: Transaction,
        owner: FamilyMember,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        deleteTransaction(
            id: transaction.id,
            owner: owner,
            baseUpdatedAtMs: transaction.updatedAtMs,
            onResult: onResult
        )
    }

    static func deleteTransaction(
        id: String,
        owner: FamilyMember,
        baseUpdatedAtMs: Double? = nil,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let canonicalOwner = owner.ledgerOwner
        let fileName = canonicalOwner.transactionsDataFileName
        deleteTransaction(
            id: id,
            owner: canonicalOwner,
            from: fileName,
            baseUpdatedAtMs: baseUpdatedAtMs,
            onResult: onResult
        )
    }

    private static func deleteTransaction(
        id: String,
        owner: FamilyMember,
        from fileName: String,
        baseUpdatedAtMs: Double?,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let label = "Delete transaction"
        let operationID = reportSyncStart(label)
        if let blocked = writeBlocker(requiresSyncToken: true) {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                deleteTransaction(
                    id: id,
                    owner: owner,
                    from: fileName,
                    baseUpdatedAtMs: baseUpdatedAtMs,
                    onResult: onResult
                )
            }, onResult: onResult)
            return
        }

        Task {
            let client = makeClient()
            let result = await withRetry(label: "delete tx \(id)") {
                try await client.deleteTransactionRow(
                    id: id,
                    owner: owner,
                    sourceFile: fileName,
                    baseUpdatedAtMs: baseUpdatedAtMs
                )
            }
            reportSyncResult(label: label, operationID: operationID, result: result, retry: {
                deleteTransaction(
                    id: id,
                    owner: owner,
                    from: fileName,
                    baseUpdatedAtMs: baseUpdatedAtMs,
                    onResult: onResult
                )
            }, onResult: onResult)
        }
    }

    static func pushBTCBuy(
        _ buy: BTCBuy,
        owner: FamilyMember,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let canonicalOwner = owner.ledgerOwner
        let fileName = canonicalOwner.btcBuysDataFileName
        let payload = LegacyBTCBuyDTO(appBuy: buy, owner: canonicalOwner)
        pushBTCBuyPayload(payload, owner: canonicalOwner, to: fileName, onResult: onResult)
    }

    private static func pushBTCBuyPayload(
        _ payload: LegacyBTCBuyDTO,
        owner: FamilyMember,
        to fileName: String,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let label = "Save BTC buy"
        let operationID = reportSyncStart(label)
        if let blocked = writeBlocker(requiresSyncToken: true) {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                pushBTCBuyPayload(payload, owner: owner, to: fileName, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let client = makeClient()
            let result = await withRetry(label: "push btc buy \(payload.id)") {
                try await client.upsertBTCBuyRow(
                    payload,
                    owner: owner,
                    sourceFile: fileName,
                )
            }
            reportSyncResult(label: label, operationID: operationID, result: result, retry: {
                pushBTCBuyPayload(payload, owner: owner, to: fileName, onResult: onResult)
            }, onResult: onResult)
        }
    }

    /// Pushes a todo for ANY owner (multi-profile). The optional `onResult` is invoked on the
    /// main actor with the final `ConvexWriteResult` so callers can surface the CAUSE of a
    /// rejection (see SAT-1342) instead of treating every write as a phantom success.
    static func pushTodo(
        _ todo: TodoItem,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let payload = LegacyTodoDTO(appTodo: todo)
        pushTodoPayload(payload, onResult: onResult)
    }

    static func setTodoCompletion(
        _ todo: TodoItem,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let payload = LegacyTodoDTO(appTodo: todo)
        setTodoCompletionPayload(payload, isDone: todo.isDone, onResult: onResult)
    }

    private static func pushTodoPayload(
        _ payload: LegacyTodoDTO,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let label = "Save todo"
        let operationID = reportSyncStart(label)
        if let blocked = writeBlocker(requiresSyncToken: false) {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                pushTodoPayload(payload, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let result: ConvexWriteResult
            if ConvexConfig.hasSyncToken {
                let client = makeClient()
                result = await withRetry(label: "push todo \(payload.id)") {
                    try await client.upsertTodoRow(payload)
                }
            } else {
                // Genuine row-API gap: paired-device credentials are accepted
                // only by the legacy mobile todo mutations. Row mutations
                // currently require the runtime-injected shared sync token.
                //
                // This reroute used to hide the case where NEITHER path had a
                // usable credential. `AppWritebackError.notConfigured` and an
                // unclaimable pairing now classify as `.unauthorized`.
                let client = AppWritebackClient()
                result = await withRetry(label: "push todo via paired writeback \(payload.id)") {
                    let synced = try await client.upsertTodo(payload)
                    guard synced else { throw AppWriteSyncError.unexpectedPayload }
                }
            }
            reportSyncResult(label: label, operationID: operationID, result: result, retry: {
                pushTodoPayload(payload, onResult: onResult)
            }, onResult: onResult)
        }
    }

    private static func setTodoCompletionPayload(
        _ payload: LegacyTodoDTO,
        isDone: Bool,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let label = "Update todo completion"
        let operationID = reportSyncStart(label)
        if let blocked = writeBlocker(requiresSyncToken: false) {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                setTodoCompletionPayload(payload, isDone: isDone, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let result: ConvexWriteResult
            if ConvexConfig.hasSyncToken {
                let client = makeClient()
                result = await withRetry(label: "set todo completion \(payload.id)") {
                    try await client.upsertTodoRow(payload)
                }
            } else {
                // See pushTodoPayload: no paired-device row mutation exists.
                let client = AppWritebackClient()
                result = await withRetry(label: "set todo completion via paired writeback \(payload.id)") {
                    let synced = try await client.setTodoDone(id: payload.id, title: payload.effectiveTitle, isDone: isDone)
                    guard synced else { throw AppWriteSyncError.unexpectedPayload }
                }
            }
            reportSyncResult(label: label, operationID: operationID, result: result, retry: {
                setTodoCompletionPayload(payload, isDone: isDone, onResult: onResult)
            }, onResult: onResult)
        }
    }

    static func deleteTodo(
        _ todo: TodoItem,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let todoId = todo.id
        deleteTodo(id: todoId, onResult: onResult)
    }

    static func deleteTodo(
        id todoId: String,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let label = "Delete todo"
        let operationID = reportSyncStart(label)
        if let blocked = writeBlocker(requiresSyncToken: false) {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                deleteTodo(id: todoId, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let result: ConvexWriteResult
            if ConvexConfig.hasSyncToken {
                let client = makeClient()
                result = await withRetry(label: "delete todo \(todoId)") {
                    try await client.deleteTodoRow(id: todoId)
                }
            } else {
                // See pushTodoPayload: no paired-device row mutation exists.
                let client = AppWritebackClient()
                result = await withRetry(label: "delete todo via paired writeback \(todoId)") {
                    let synced = try await client.removeTodo(id: todoId)
                    guard synced else { throw AppWriteSyncError.unexpectedPayload }
                }
            }
            reportSyncResult(label: label, operationID: operationID, result: result, retry: {
                deleteTodo(id: todoId, onResult: onResult)
            }, onResult: onResult)
        }
    }

    static func pushBudgetCategoryUpdate(
        _ category: BudgetCategory,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let name = category.name
        let icon = category.icon
        let budget = category.monthlyBudget
        let viewer = category.ownerMember
        pushBudgetCategoryUpdate(
            name: name,
            icon: icon,
            budget: budget,
            viewer: viewer,
            onResult: onResult,
        )
    }

    private static func pushBudgetCategoryUpdate(
        name: String,
        icon: String,
        budget: Decimal,
        viewer: FamilyMember,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let label = "Save budget"
        let operationID = reportSyncStart(label)
        if let blocked = writeBlocker(requiresSyncToken: true) {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                pushBudgetCategoryUpdate(
                    name: name,
                    icon: icon,
                    budget: budget,
                    viewer: viewer,
                    onResult: onResult,
                )
            }, onResult: onResult)
            return
        }

        Task {
            let client = makeClient()
            let result = await withRetry(label: "update category \(name)") {
                try await client.upsertBudgetCategoryRow(
                    name: name,
                    icon: icon,
                    budget: budget,
                    viewer: viewer,
                )
            }
            reportSyncResult(label: label, operationID: operationID, result: result, retry: {
                pushBudgetCategoryUpdate(
                    name: name,
                    icon: icon,
                    budget: budget,
                    viewer: viewer,
                    onResult: onResult,
                )
            }, onResult: onResult)
        }
    }

    /// The states that refuse a write before any network I/O, or `nil` to proceed.
    ///
    /// `requiresSyncToken` is true for the row mutation API, which has no
    /// paired-device fallback. Refusing there with `.unauthorized` matches
    /// Android's `ConvexMutationClient`, which checks its token before building a
    /// request instead of discovering the rejection three retries later.
    static func writeBlocker(requiresSyncToken: Bool) -> ConvexWriteResult? {
        if !ConvexConfig.writesEnabled { return .disabled }
        if !ConvexConfig.isConfigured { return .notConfigured }
        if requiresSyncToken, !ConvexConfig.hasSyncToken { return .unauthorized }
        return nil
    }

    static func reportSyncResult(
        label: String,
        operationID: UUID,
        result: ConvexWriteResult,
        retry: (@MainActor @Sendable () -> Void)?,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)?,
        statusStore: SyncStatusStore? = nil,
    ) {
        let statusStore = statusStore ?? .shared
        // A Retry button that cannot change the outcome is worse than none: it
        // tells the user the save might still land.
        let retryAction = result.isRetryable ? retry : nil
        statusStore.complete(
            label,
            id: operationID,
            result: result,
            retry: retryAction,
        )
        onResult?(result)
    }

    @discardableResult
    static func reportSyncStart(
        _ label: String,
        statusStore: SyncStatusStore? = nil,
    ) -> UUID {
        let statusStore = statusStore ?? .shared
        let id = UUID()
        statusStore.begin(label, id: id)
        return id
    }

    /// Returns `.ok` on success, otherwise the classified cause of the last attempt.
    ///
    /// Non-retryable causes (a rejected credential, an unwritable amount, a profile
    /// mismatch) return immediately instead of burning `maxRetries` attempts at
    /// `retryDelay` each to reach the same answer.
    ///
    /// Marked discardable so callers that don't yet consume the result still compile.
    @discardableResult
    static func withRetry(
        label: String,
        maxRetryCount: Int = maxRetries,
        retryDelayNanoseconds: UInt64 = retryDelay,
        operation: @escaping () async throws -> Void,
    ) async -> ConvexWriteResult {
        let retryCount = max(0, maxRetryCount)
        var lastResult = ConvexWriteResult.failed(.transport)
        for attempt in 0 ... retryCount {
            do {
                try Task.checkCancellation()
                try await operation()
                return .ok
            } catch is CancellationError {
                log.info("Cancelled \(label, privacy: .public)")
                return .failed(.cancelled)
            } catch {
                lastResult = ConvexWriteResult.classify(error)
                guard lastResult.isRetryable else {
                    log.error("Refused \(label, privacy: .public): \(lastResult.diagnosticCode, privacy: .public)")
                    return lastResult
                }
                if attempt < retryCount {
                    log.warning("Retry \(attempt + 1)/\(retryCount) for \(label, privacy: .public): \(lastResult.diagnosticCode, privacy: .public)")
                    do {
                        try await Task.sleep(nanoseconds: retryDelayNanoseconds)
                    } catch is CancellationError {
                        log.info("Cancelled \(label, privacy: .public) during retry delay")
                        return .failed(.cancelled)
                    } catch {
                        return ConvexWriteResult.classify(error)
                    }
                } else {
                    log.error("Failed \(label, privacy: .public) after \(retryCount) retries: \(lastResult.diagnosticCode, privacy: .public)")
                }
            }
        }
        return lastResult
    }
}
