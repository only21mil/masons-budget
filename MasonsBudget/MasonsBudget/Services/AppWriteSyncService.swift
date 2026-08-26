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
    typealias TodoWrite = @MainActor @Sendable (
        LegacyTodoDTO,
        FamilyMember,
        TodoDeviceWriteOperation,
        Double?
    ) async throws -> Void
    typealias TodoRevisionRead = @MainActor @Sendable (
        String,
        FamilyMember
    ) async throws -> Double

    /// Process-local ownership for an optimistic create attempt or retained
    /// retry. A row sync may reconcile this ID from the server, but must not reap
    /// a server-absent row while its exact payload can still be retried.
    private static var liveOptimisticTransactionIDs: Set<String> = []

    static func hasLiveOptimisticTransaction(_ id: String) -> Bool {
        liveOptimisticTransactionIDs.contains(id)
    }

    static func abandonOptimisticTransaction(_ id: String) {
        liveOptimisticTransactionIDs.remove(id)
    }

    private static let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "AppWriteSync")
    private static let maxRetries = 2
    private static let retryDelay: UInt64 = 2_000_000_000

    private static func makeClient() -> ConvexClient {
        ConvexClient(deploymentURL: ConvexConfig.deploymentURL)
    }

    static func pushTransaction(
        _ transaction: Transaction,
        owner: FamilyMember,
        tracksOptimisticCreate: Bool = false,
        onOperationStart: (@MainActor @Sendable (UUID) -> Void)? = nil,
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
            tracksOptimisticCreate: tracksOptimisticCreate,
            onOperationStart: onOperationStart,
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
        tracksOptimisticCreate: Bool = false,
        onOperationStart: (@MainActor @Sendable (UUID) -> Void)? = nil,
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
            onOperationStart?(operationID)
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
        // Only AddTransactionView explicitly opts into the durable create
        // marker. CSV, voice, detail edits and generated paycheck rows already
        // carry different lifecycle/provenance and must never be inferred into it.
        let deliverResult: @MainActor @Sendable (ConvexWriteResult) -> Void = { result in
            if tracksOptimisticCreate, result.isRetryable {
                // This marker is persisted with the optimistic row. If the
                // in-memory Retry action is dismissed or lost on app exit, a
                // later complete row sync can remove the server-absent row
                // instead of leaving a permanent local-only transaction.
                transaction.sourceFile = Transaction.pendingRowWriteSource
            } else if tracksOptimisticCreate {
                liveOptimisticTransactionIDs.remove(transaction.id)
                if result.isOk { transaction.sourceFile = fileName }
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
            onOperationStart: { operationID in
                if tracksOptimisticCreate {
                    liveOptimisticTransactionIDs.insert(transaction.id)
                }
                onOperationStart?(operationID)
            },
            onAttemptStart: {
                if tracksOptimisticCreate { transaction.sourceFile = nil }
            },
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
        onOperationStart: (@MainActor @Sendable (UUID) -> Void)? = nil,
        onAttemptStart: (@MainActor @Sendable () -> Void)? = nil,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
        onAcceptedRevision: (@MainActor @Sendable (Double) -> Void)? = nil,
    ) {
        let label = "Save transaction"
        onAttemptStart?()
        let operationID = reportSyncStart(label, statusStore: statusStore)
        onOperationStart?(operationID)
        if let blocked = preflight() {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                pushTransactionPayload(
                    payload, owner: owner, to: fileName,
                    statusStore: statusStore,
                    automaticRetries: automaticRetries,
                    retryDelayNanoseconds: retryDelayNanoseconds,
                    preflight: preflight,
                    write: write,
                    onOperationStart: onOperationStart,
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
                    onOperationStart: onOperationStart,
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
        onOperationStart: (@MainActor @Sendable (UUID) -> Void)? = nil,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let canonicalOwner = owner.ledgerOwner
        let fileName = canonicalOwner.btcBuysDataFileName
        let label = "Save BTC buy"
        let payload: LegacyBTCBuyDTO
        do {
            payload = try LegacyBTCBuyDTO(appBuy: buy, owner: canonicalOwner)
        } catch {
            let operationID = reportSyncStart(label)
            onOperationStart?(operationID)
            reportSyncResult(
                label: label,
                operationID: operationID,
                result: ConvexWriteResult.classify(error),
                retry: nil,
                onResult: onResult,
            )
            return
        }
        pushBTCBuyPayload(
            payload,
            owner: canonicalOwner,
            to: fileName,
            onOperationStart: onOperationStart,
            onAcceptedRevision: { buy.updatedAtMs = $0 },
            onResult: onResult,
        )
    }

    private static func pushBTCBuyPayload(
        _ payload: LegacyBTCBuyDTO,
        owner: FamilyMember,
        to fileName: String,
        onOperationStart: (@MainActor @Sendable (UUID) -> Void)? = nil,
        onAcceptedRevision: (@MainActor @Sendable (Double) -> Void)? = nil,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let label = "Save BTC buy"
        let operationID = reportSyncStart(label)
        onOperationStart?(operationID)
        if let blocked = writeBlocker(requiresSyncToken: true) {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                pushBTCBuyPayload(
                    payload,
                    owner: owner,
                    to: fileName,
                    onOperationStart: onOperationStart,
                    onAcceptedRevision: onAcceptedRevision,
                    onResult: onResult,
                )
            }, onResult: onResult)
            return
        }

        Task {
            let client = makeClient()
            let revision = AcceptedRevisionBox()
            let result = await withRetry(label: "push btc buy \(payload.id)") {
                revision.value = try await client.upsertBTCBuyRow(
                    payload,
                    owner: owner,
                    sourceFile: fileName,
                )
            }
            if case .ok = result, let accepted = revision.value {
                onAcceptedRevision?(accepted)
            }
            reportSyncResult(label: label, operationID: operationID, result: result, retry: {
                pushBTCBuyPayload(
                    payload,
                    owner: owner,
                    to: fileName,
                    onOperationStart: onOperationStart,
                    onAcceptedRevision: onAcceptedRevision,
                    onResult: onResult,
                )
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
        pushTodo(todo, label: "Save todo", onResult: onResult)
    }

    static func setTodoCompletion(
        _ todo: TodoItem,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        todo.completedAt = todo.isDone ? todo.updatedAt : nil
        pushTodo(todo, label: "Update todo completion", onResult: onResult)
    }

    private static func pushTodo(
        _ todo: TodoItem,
        label: String,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)?,
    ) {
        pushTodo(
            todo,
            label: label,
            statusStore: nil,
            automaticRetries: maxRetries,
            retryDelayNanoseconds: retryDelay,
            preflight: { writeBlocker(requiresSyncToken: false) },
            write: { payload, activeProfile, operation, baseUpdatedAtMs in
                let client = AppWritebackClient()
                let synced = try await client.upsertTodo(
                    payload,
                    activeProfile: activeProfile,
                    operation: operation,
                    baseUpdatedAtMs: baseUpdatedAtMs,
                )
                guard synced else { throw AppWriteSyncError.unexpectedPayload }
            },
            readRevision: { id, activeProfile in
                try await AppWritebackClient().todoRevision(
                    id: id,
                    activeProfile: activeProfile,
                )
            },
            onResult: onResult,
        )
    }

    /// Injection seam for the accepted-revision regression. Production uses
    /// this path with the paired-device writer and authenticated row reader.
    static func pushTodo(
        _ todo: TodoItem,
        label: String = "Save todo",
        statusStore: SyncStatusStore?,
        automaticRetries: Int,
        retryDelayNanoseconds: UInt64,
        preflight: @escaping @MainActor @Sendable () -> ConvexWriteResult?,
        write: @escaping TodoWrite,
        readRevision: @escaping TodoRevisionRead,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let payload = LegacyTodoDTO(appTodo: todo)
        let isFreshAppCreate = todo.createdBy == "app" &&
            !todo.hasServerAuthority && todo.updatedAtMs == nil
        let operation: TodoDeviceWriteOperation = isFreshAppCreate ? .create : .update
        let baseUpdatedAtMs = todo.updatedAtMs
        // The user's optimistic content is not authoritative until the write is
        // accepted and its canonical row revision has been read back.
        todo.hasServerAuthority = false
        pushTodoPayload(
            payload,
            operation: operation,
            baseUpdatedAtMs: baseUpdatedAtMs,
            activeProfile: AppWritebackConfig.activeProfile,
            label: label,
            statusStore: statusStore,
            automaticRetries: automaticRetries,
            retryDelayNanoseconds: retryDelayNanoseconds,
            preflight: preflight,
            write: write,
            readRevision: readRevision,
            onAcceptedRevision: { revision in
                todo.updatedAtMs = revision
                todo.hasServerAuthority = true
            },
            onResult: onResult,
        )
    }

    private static func pushTodoPayload(
        _ payload: LegacyTodoDTO,
        operation: TodoDeviceWriteOperation,
        baseUpdatedAtMs: Double?,
        activeProfile: FamilyMember,
        label: String = "Save todo",
        statusStore: SyncStatusStore?,
        automaticRetries: Int,
        retryDelayNanoseconds: UInt64,
        preflight: @escaping @MainActor @Sendable () -> ConvexWriteResult?,
        write: @escaping TodoWrite,
        readRevision: @escaping TodoRevisionRead,
        writeAlreadyAccepted: Bool = false,
        onAcceptedRevision: (@MainActor @Sendable (Double) -> Void)? = nil,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let operationID = reportSyncStart(label, statusStore: statusStore)
        if !writeAlreadyAccepted, let blocked = preflight() {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                pushTodoPayload(
                    payload,
                    operation: operation,
                    baseUpdatedAtMs: baseUpdatedAtMs,
                    activeProfile: activeProfile,
                    label: label,
                    statusStore: statusStore,
                    automaticRetries: automaticRetries,
                    retryDelayNanoseconds: retryDelayNanoseconds,
                    preflight: preflight,
                    write: write,
                    readRevision: readRevision,
                    onAcceptedRevision: onAcceptedRevision,
                    onResult: onResult,
                )
            }, onResult: onResult, statusStore: statusStore)
            return
        }

        Task {
            var accepted = writeAlreadyAccepted
            var result = ConvexWriteResult.ok
            if !accepted {
                result = await withRetry(
                    label: "push todo via paired device \(payload.id)",
                    maxRetryCount: automaticRetries,
                    retryDelayNanoseconds: retryDelayNanoseconds,
                ) {
                    try await write(payload, activeProfile, operation, baseUpdatedAtMs)
                }
                accepted = result.isOk
            }
            let revision = AcceptedRevisionBox()
            if accepted {
                result = await withRetry(
                    label: "refresh accepted todo revision \(payload.id)",
                    maxRetryCount: automaticRetries,
                    retryDelayNanoseconds: retryDelayNanoseconds,
                ) {
                    let acceptedRevision = try await readRevision(payload.id, activeProfile)
                    guard AppWritebackClient.isValidTaskRevision(acceptedRevision) else {
                        throw AppWriteSyncError.unexpectedPayload
                    }
                    revision.value = acceptedRevision
                }
                if result.isOk, let acceptedRevision = revision.value {
                    onAcceptedRevision?(acceptedRevision)
                } else if !result.isOk {
                    // The mutation is already committed. Keep the local row
                    // explicitly non-authoritative and retry only this readback;
                    // a terminal-looking read failure must never roll the
                    // accepted mutation back or resubmit its create/update.
                    result = .failed(.transport)
                }
            }
            reportSyncResult(label: label, operationID: operationID, result: result, retry: {
                pushTodoPayload(
                    payload,
                    operation: operation,
                    baseUpdatedAtMs: baseUpdatedAtMs,
                    activeProfile: activeProfile,
                    label: label,
                    statusStore: statusStore,
                    automaticRetries: automaticRetries,
                    retryDelayNanoseconds: retryDelayNanoseconds,
                    preflight: preflight,
                    write: write,
                    readRevision: readRevision,
                    writeAlreadyAccepted: accepted,
                    onAcceptedRevision: onAcceptedRevision,
                    onResult: onResult,
                )
            }, onResult: onResult, statusStore: statusStore)
        }
    }

    static func deleteTodo(
        _ todo: TodoItem,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        deleteTodo(
            id: todo.id,
            owner: todo.ownerMember,
            baseUpdatedAtMs: todo.updatedAtMs,
            onResult: onResult,
        )
    }

    static func deleteTodo(
        id todoId: String,
        owner: FamilyMember? = nil,
        baseUpdatedAtMs: Double? = nil,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let label = "Delete todo"
        let activeProfile = AppWritebackConfig.activeProfile
        let operationID = reportSyncStart(label)
        if let blocked = writeBlocker(requiresSyncToken: false) {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                deleteTodo(
                    id: todoId,
                    owner: owner,
                    baseUpdatedAtMs: baseUpdatedAtMs,
                    onResult: onResult,
                )
            }, onResult: onResult)
            return
        }

        Task {
            let result: ConvexWriteResult
            if baseUpdatedAtMs == nil {
                result = .failed(.revisionRequired)
            } else if let owner {
                let client = AppWritebackClient()
                result = await withRetry(label: "delete todo via paired device \(todoId)") {
                    _ = try await client.removeTodo(
                        id: todoId,
                        activeProfile: activeProfile,
                        owner: owner,
                        baseUpdatedAtMs: baseUpdatedAtMs,
                    )
                }
            } else {
                result = .failed(.ownerMismatch(field: "todo"))
            }
            reportSyncResult(label: label, operationID: operationID, result: result, retry: {
                deleteTodo(
                    id: todoId,
                    owner: owner,
                    baseUpdatedAtMs: baseUpdatedAtMs,
                    onResult: onResult,
                )
            }, onResult: onResult)
        }
    }

    static func restoreTodo(
        id todoId: String,
        owner: FamilyMember?,
        baseUpdatedAtMs: Double?,
        onAcceptedRevision: (@MainActor @Sendable (Double) -> Void)? = nil,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let label = "Restore todo"
        let activeProfile = AppWritebackConfig.activeProfile
        let operationID = reportSyncStart(label)
        if let blocked = writeBlocker(requiresSyncToken: false) {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                restoreTodo(
                    id: todoId,
                    owner: owner,
                    baseUpdatedAtMs: baseUpdatedAtMs,
                    onAcceptedRevision: onAcceptedRevision,
                    onResult: onResult,
                )
            }, onResult: onResult)
            return
        }

        Task {
            let result: ConvexWriteResult
            let revision = AcceptedRevisionBox()
            if baseUpdatedAtMs == nil {
                result = .failed(.revisionRequired)
            } else if let owner {
                let client = AppWritebackClient()
                result = await withRetry(label: "restore todo via paired device \(todoId)") {
                    revision.value = try await client.restoreTodo(
                        id: todoId,
                        activeProfile: activeProfile,
                        owner: owner,
                        baseUpdatedAtMs: baseUpdatedAtMs,
                    )
                }
            } else {
                result = .failed(.ownerMismatch(field: "todo"))
            }
            if case .ok = result, let revision = revision.value {
                onAcceptedRevision?(revision)
            }
            reportSyncResult(label: label, operationID: operationID, result: result, retry: {
                restoreTodo(
                    id: todoId,
                    owner: owner,
                    baseUpdatedAtMs: baseUpdatedAtMs,
                    onAcceptedRevision: onAcceptedRevision,
                    onResult: onResult,
                )
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

    /// Contract-only support for current-month deletion. No visual delete control
    /// is added here; callers must first build a validated deletion intent.
    static func deleteBudgetCategory(
        _ intent: BudgetCategoryDeletionIntent,
        onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)? = nil,
    ) {
        let label = "Delete budget category"
        let operationID = reportSyncStart(label)
        if let blocked = writeBlocker(requiresSyncToken: false) {
            reportSyncResult(label: label, operationID: operationID, result: blocked, retry: {
                deleteBudgetCategory(intent, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let client = AppWritebackClient()
            let result = await withRetry(label: "delete category \(intent.categoryName)") {
                _ = try await client.deleteBudgetCategory(intent)
            }
            reportSyncResult(label: label, operationID: operationID, result: result, retry: {
                deleteBudgetCategory(intent, onResult: onResult)
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
