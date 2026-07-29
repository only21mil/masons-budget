import Foundation
import os

enum AppWriteSyncService {
    private static let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "AppWriteSync")
    private static let maxRetries = 2
    private static let retryDelay: UInt64 = 2_000_000_000

    private static func makeClient() -> ConvexClient {
        ConvexClient(deploymentURL: ConvexConfig.deploymentURL)
    }

    static func pushTransaction(
        _ transaction: Transaction,
        owner: FamilyMember,
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
    ) {
        let label = "Save transaction"
        let payload: LegacyTransactionDTO
        do {
            payload = try LegacyTransactionDTO(appTransaction: transaction, owner: owner)
        } catch {
            log.error("\(error.localizedDescription, privacy: .public)")
            reportSyncStart(label)
            reportSyncResult(label: label, success: false, retry: nil, onResult: onResult)
            return
        }

        let fileName = owner.transactionsDataFileName
        pushTransactionPayload(payload, to: fileName, onResult: onResult)
    }

    private static func pushTransactionPayload(
        _ payload: LegacyTransactionDTO,
        to fileName: String,
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
    ) {
        let label = "Save transaction"
        reportSyncStart(label)
        guard ConvexConfig.isConfigured else {
            reportSyncResult(label: label, success: false, retry: {
                pushTransactionPayload(payload, to: fileName, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let client = makeClient()
            let ok = await withRetry(label: "push tx \(payload.id)") {
                try await client.upsertTransactionRow(payload, sourceFile: fileName)
            }
            reportSyncResult(label: label, success: ok, retry: {
                pushTransactionPayload(payload, to: fileName, onResult: onResult)
            }, onResult: onResult)
        }
    }

    static func deleteTransaction(
        _ transaction: Transaction,
        owner: FamilyMember,
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
    ) {
        let fileName = owner.transactionsDataFileName
        let id = transaction.id
        deleteTransaction(id: id, from: fileName, onResult: onResult)
    }

    private static func deleteTransaction(
        id: String,
        from fileName: String,
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
    ) {
        let label = "Delete transaction"
        reportSyncStart(label)
        guard ConvexConfig.isConfigured else {
            reportSyncResult(label: label, success: false, retry: {
                deleteTransaction(id: id, from: fileName, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let client = makeClient()
            let ok = await withRetry(label: "delete tx \(id)") {
                try await client.deleteTransactionRow(id: id, sourceFile: fileName)
            }
            reportSyncResult(label: label, success: ok, retry: {
                deleteTransaction(id: id, from: fileName, onResult: onResult)
            }, onResult: onResult)
        }
    }

    static func pushBTCBuy(
        _ buy: BTCBuy,
        owner: FamilyMember,
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
    ) {
        let fileName = owner.btcBuysDataFileName
        let payload = LegacyBTCBuyDTO(appBuy: buy)
        pushBTCBuyPayload(payload, owner: owner, to: fileName, onResult: onResult)
    }

    private static func pushBTCBuyPayload(
        _ payload: LegacyBTCBuyDTO,
        owner: FamilyMember,
        to fileName: String,
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
    ) {
        let label = "Save BTC buy"
        reportSyncStart(label)
        guard ConvexConfig.isConfigured else {
            reportSyncResult(label: label, success: false, retry: {
                pushBTCBuyPayload(payload, owner: owner, to: fileName, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let client = makeClient()
            let ok = await withRetry(label: "push btc buy \(payload.id)") {
                try await client.upsertBTCBuyRow(
                    payload,
                    owner: owner,
                    sourceFile: fileName,
                )
            }
            reportSyncResult(label: label, success: ok, retry: {
                pushBTCBuyPayload(payload, owner: owner, to: fileName, onResult: onResult)
            }, onResult: onResult)
        }
    }

    /// Pushes a todo for ANY owner (multi-profile). The optional `onResult` is invoked on the
    /// main actor with the final success/failure so callers can surface sync state (see SAT-1342)
    /// instead of treating every write as a phantom success.
    static func pushTodo(_ todo: TodoItem, onResult: (@MainActor @Sendable (Bool) -> Void)? = nil) {
        let payload = LegacyTodoDTO(appTodo: todo)
        pushTodoPayload(payload, onResult: onResult)
    }

    static func setTodoCompletion(_ todo: TodoItem, onResult: (@MainActor @Sendable (Bool) -> Void)? = nil) {
        let payload = LegacyTodoDTO(appTodo: todo)
        setTodoCompletionPayload(payload, isDone: todo.isDone, onResult: onResult)
    }

    private static func pushTodoPayload(
        _ payload: LegacyTodoDTO,
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
    ) {
        let label = "Save todo"
        reportSyncStart(label)
        guard ConvexConfig.isConfigured else {
            reportSyncResult(label: label, success: false, retry: {
                pushTodoPayload(payload, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let ok: Bool
            if !ConvexConfig.syncToken.isEmpty {
                let client = makeClient()
                ok = await withRetry(label: "push todo \(payload.id)") {
                    try await client.upsertTodoRow(payload)
                }
            } else {
                // Genuine row-API gap: paired-device credentials are accepted
                // only by the legacy mobile todo mutations. Row mutations
                // currently require the runtime-injected shared sync token.
                let client = AppWritebackClient()
                ok = await withRetry(label: "push todo via paired writeback \(payload.id)") {
                    let synced = try await client.upsertTodo(payload)
                    guard synced else { throw SyncError.unexpectedPayload }
                }
            }
            reportSyncResult(label: label, success: ok, retry: {
                pushTodoPayload(payload, onResult: onResult)
            }, onResult: onResult)
        }
    }

    private static func setTodoCompletionPayload(
        _ payload: LegacyTodoDTO,
        isDone: Bool,
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
    ) {
        let label = "Update todo completion"
        reportSyncStart(label)
        guard ConvexConfig.isConfigured else {
            reportSyncResult(label: label, success: false, retry: {
                setTodoCompletionPayload(payload, isDone: isDone, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let ok: Bool
            if !ConvexConfig.syncToken.isEmpty {
                let client = makeClient()
                ok = await withRetry(label: "set todo completion \(payload.id)") {
                    try await client.upsertTodoRow(payload)
                }
            } else {
                // See pushTodoPayload: no paired-device row mutation exists.
                let client = AppWritebackClient()
                ok = await withRetry(label: "set todo completion via paired writeback \(payload.id)") {
                    let synced = try await client.setTodoDone(id: payload.id, title: payload.effectiveTitle, isDone: isDone)
                    guard synced else { throw SyncError.unexpectedPayload }
                }
            }
            reportSyncResult(label: label, success: ok, retry: {
                setTodoCompletionPayload(payload, isDone: isDone, onResult: onResult)
            }, onResult: onResult)
        }
    }

    static func deleteTodo(_ todo: TodoItem, onResult: (@MainActor @Sendable (Bool) -> Void)? = nil) {
        let todoId = todo.id
        deleteTodo(id: todoId, onResult: onResult)
    }

    static func deleteTodo(
        id todoId: String,
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
    ) {
        let label = "Delete todo"
        reportSyncStart(label)
        guard ConvexConfig.isConfigured else {
            reportSyncResult(label: label, success: false, retry: {
                deleteTodo(id: todoId, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let ok: Bool
            if !ConvexConfig.syncToken.isEmpty {
                let client = makeClient()
                ok = await withRetry(label: "delete todo \(todoId)") {
                    try await client.deleteTodoRow(id: todoId)
                }
            } else {
                // See pushTodoPayload: no paired-device row mutation exists.
                let client = AppWritebackClient()
                ok = await withRetry(label: "delete todo via paired writeback \(todoId)") {
                    let synced = try await client.removeTodo(id: todoId)
                    guard synced else { throw SyncError.unexpectedPayload }
                }
            }
            reportSyncResult(label: label, success: ok, retry: {
                deleteTodo(id: todoId, onResult: onResult)
            }, onResult: onResult)
        }
    }

    static func pushBudgetCategoryUpdate(
        _ category: BudgetCategory,
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
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
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
    ) {
        let label = "Save budget"
        reportSyncStart(label)
        guard ConvexConfig.isConfigured else {
            reportSyncResult(label: label, success: false, retry: {
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
            let ok = await withRetry(label: "update category \(name)") {
                try await client.upsertBudgetCategoryRow(
                    name: name,
                    icon: icon,
                    budget: budget,
                    viewer: viewer,
                )
            }
            reportSyncResult(label: label, success: ok, retry: {
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

    private static func reportSyncResult(
        label: String,
        success: Bool,
        retry: (@MainActor @Sendable () -> Void)?,
        onResult: (@MainActor @Sendable (Bool) -> Void)?,
    ) {
        Task { @MainActor in
            SyncStatusStore.shared.complete(label, success: success, retry: retry)
            onResult?(success)
        }
    }

    private static func reportSyncStart(_ label: String) {
        Task { @MainActor in
            SyncStatusStore.shared.begin(label)
        }
    }

    /// Returns true on success, false after exhausting retries. Marked discardable so the
    /// existing transaction/budget callers that don't yet consume the result still compile.
    @discardableResult
    private static func withRetry(label: String, operation: @escaping () async throws -> Void) async -> Bool {
        for attempt in 0 ... maxRetries {
            do {
                try await operation()
                return true
            } catch {
                if attempt < maxRetries {
                    log.warning("Retry \(attempt + 1)/\(maxRetries) for \(label, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    try? await Task.sleep(nanoseconds: retryDelay)
                } else {
                    log.error("Failed \(label, privacy: .public) after \(maxRetries) retries: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
        return false
    }

    enum SyncError: Error {
        case unexpectedPayload
    }
}
