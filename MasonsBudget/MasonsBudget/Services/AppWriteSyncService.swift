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
        let payload: MC2Transaction
        do {
            payload = try MC2Transaction(appTransaction: transaction, owner: owner)
        } catch {
            log.error("\(error.localizedDescription, privacy: .public)")
            reportSyncStart(label)
            reportSyncResult(label: label, success: false, retry: nil, onResult: onResult)
            return
        }

        let fileName = owner.mc2TransactionsFileName
        pushTransactionPayload(payload, to: fileName, onResult: onResult)
    }

    private static func pushTransactionPayload(
        _ payload: MC2Transaction,
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
                _ = try await client.appendTransaction(payload, to: fileName)
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
        let fileName = owner.mc2TransactionsFileName
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
                let raw = try await client.fetchFileValue(fileName)
                guard var rows = raw as? [[String: Any]] else {
                    throw SyncError.unexpectedPayload
                }
                rows.removeAll { ($0["id"] as? String) == id }
                _ = try await client.syncFile(name: fileName, data: rows)
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
        let fileName = owner.mc2BTCBuysFileName
        let payload = MC2BTCBuy(appBuy: buy)
        pushBTCBuyPayload(payload, to: fileName, onResult: onResult)
    }

    private static func pushBTCBuyPayload(
        _ payload: MC2BTCBuy,
        to fileName: String,
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
    ) {
        let label = "Save BTC buy"
        reportSyncStart(label)
        guard ConvexConfig.isConfigured else {
            reportSyncResult(label: label, success: false, retry: {
                pushBTCBuyPayload(payload, to: fileName, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let client = makeClient()
            let ok = await withRetry(label: "push btc buy \(payload.id)") {
                let raw = try await client.fetchFileValue(fileName)
                guard var rows = raw as? [[String: Any]] else {
                    throw SyncError.unexpectedPayload
                }
                rows.removeAll { ($0["id"] as? String) == payload.id }
                try rows.append(payload.convexJSONObject())
                _ = try await client.syncFile(name: fileName, data: rows)
            }
            reportSyncResult(label: label, success: ok, retry: {
                pushBTCBuyPayload(payload, to: fileName, onResult: onResult)
            }, onResult: onResult)
        }
    }

    /// Pushes a todo for ANY owner (multi-profile). The optional `onResult` is invoked on the
    /// main actor with the final success/failure so callers can surface sync state (see SAT-1342)
    /// instead of treating every write as a phantom success.
    static func pushTodo(_ todo: TodoItem, onResult: (@MainActor @Sendable (Bool) -> Void)? = nil) {
        let payload = MC2TodoItem(appTodo: todo)
        pushTodoPayload(payload, onResult: onResult)
    }

    static func setTodoCompletion(_ todo: TodoItem, onResult: (@MainActor @Sendable (Bool) -> Void)? = nil) {
        let payload = MC2TodoItem(appTodo: todo)
        setTodoCompletionPayload(payload, isDone: todo.isDone, onResult: onResult)
    }

    private static func pushTodoPayload(
        _ payload: MC2TodoItem,
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
                    _ = try await client.upsertTodo(payload)
                }
            } else {
                let client = MC2MobileWritebackClient()
                ok = await withRetry(label: "push todo via MC2 \(payload.id)") {
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
        _ payload: MC2TodoItem,
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
            let client = MC2MobileWritebackClient()
            let ok = await withRetry(label: "set todo completion via MC2 \(payload.id)") {
                let synced = try await client.setTodoDone(id: payload.id, title: payload.effectiveTitle, isDone: isDone)
                guard synced else { throw SyncError.unexpectedPayload }
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
                    _ = try await client.removeTodo(id: todoId)
                }
            } else {
                let client = MC2MobileWritebackClient()
                ok = await withRetry(label: "delete todo via MC2 \(todoId)") {
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
        let budget = category.monthlyBudget
        pushBudgetCategoryUpdate(name: name, budget: budget, onResult: onResult)
    }

    private static func pushBudgetCategoryUpdate(
        name: String,
        budget: Decimal,
        onResult: (@MainActor @Sendable (Bool) -> Void)? = nil,
    ) {
        let label = "Save budget"
        reportSyncStart(label)
        guard ConvexConfig.isConfigured else {
            reportSyncResult(label: label, success: false, retry: {
                pushBudgetCategoryUpdate(name: name, budget: budget, onResult: onResult)
            }, onResult: onResult)
            return
        }

        Task {
            let client = makeClient()
            let ok = await withRetry(label: "update category \(name)") {
                let raw = try await client.fetchFileValue("budget")
                guard var budgetData = raw as? [String: Any],
                      var cats = budgetData["categories"] as? [[String: Any]]
                else {
                    throw SyncError.unexpectedPayload
                }
                if let idx = cats.firstIndex(where: { ($0["name"] as? String) == name }) {
                    cats[idx]["budget"] = NSDecimalNumber(decimal: budget).doubleValue
                    budgetData["categories"] = cats
                    _ = try await client.syncFile(name: "budget", data: budgetData)
                }
            }
            reportSyncResult(label: label, success: ok, retry: {
                pushBudgetCategoryUpdate(name: name, budget: budget, onResult: onResult)
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
