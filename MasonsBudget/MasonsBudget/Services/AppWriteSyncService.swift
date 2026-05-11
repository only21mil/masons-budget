import Foundation
import os

enum AppWriteSyncService {
    private static let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "AppWriteSync")
    private static let maxRetries = 2
    private static let retryDelay: UInt64 = 2_000_000_000

    private static func makeClient() -> ConvexClient {
        ConvexClient(deploymentURL: ConvexConfig.deploymentURL)
    }

    static func pushTransaction(_ transaction: Transaction, owner: FamilyMember) {
        guard ConvexConfig.isConfigured else { return }

        let fileName = owner.mc2TransactionsFileName
        let payload = MC2Transaction(appTransaction: transaction)

        Task {
            let client = makeClient()
            await withRetry(label: "push tx \(payload.id)") {
                _ = try await client.appendTransaction(payload, to: fileName)
            }
        }
    }

    static func deleteTransaction(_ transaction: Transaction, owner: FamilyMember) {
        guard ConvexConfig.isConfigured else { return }

        let fileName = owner.mc2TransactionsFileName
        let id = transaction.id

        Task {
            let client = makeClient()
            await withRetry(label: "delete tx \(id)") {
                let raw = try await client.fetchFileValue(fileName)
                guard var rows = raw as? [[String: Any]] else {
                    throw SyncError.unexpectedPayload
                }
                rows.removeAll { ($0["id"] as? String) == id }
                _ = try await client.syncFile(name: fileName, data: rows)
            }
        }
    }

    static func pushTodo(_ todo: TodoItem) {
        guard ConvexConfig.isConfigured else { return }

        let payload = MC2TodoItem(appTodo: todo)

        Task {
            let client = makeClient()
            await withRetry(label: "push todo \(payload.id)") {
                _ = try await client.upsertTodo(payload)
            }
        }
    }

    static func deleteTodo(_ todo: TodoItem) {
        guard ConvexConfig.isConfigured else { return }

        let todoId = todo.id

        Task {
            let client = makeClient()
            await withRetry(label: "delete todo \(todoId)") {
                _ = try await client.removeTodo(id: todoId)
            }
        }
    }

    static func pushBudgetCategoryUpdate(_ category: BudgetCategory) {
        guard ConvexConfig.isConfigured else { return }

        let name = category.name
        let budget = category.monthlyBudget

        Task {
            let client = makeClient()
            await withRetry(label: "update category \(name)") {
                let raw = try await client.fetchFileValue("budget")
                guard var budgetData = raw as? [String: Any],
                      var cats = budgetData["categories"] as? [[String: Any]] else {
                    throw SyncError.unexpectedPayload
                }
                if let idx = cats.firstIndex(where: { ($0["name"] as? String) == name }) {
                    cats[idx]["budget"] = NSDecimalNumber(decimal: budget).doubleValue
                    budgetData["categories"] = cats
                    _ = try await client.syncFile(name: "budget", data: budgetData)
                }
            }
        }
    }

    private static func withRetry(label: String, operation: @escaping () async throws -> Void) async {
        for attempt in 0...maxRetries {
            do {
                try await operation()
                return
            } catch {
                if attempt < maxRetries {
                    log.warning("Retry \(attempt + 1)/\(maxRetries) for \(label, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    try? await Task.sleep(nanoseconds: retryDelay)
                } else {
                    log.error("Failed \(label, privacy: .public) after \(maxRetries) retries: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    }

    enum SyncError: Error {
        case unexpectedPayload
    }
}
