import Foundation
import os
import Security

struct MissionControlMobileCredentials: Equatable {
    let deviceID: String
    let deviceToken: String

    init(deviceID: String, deviceToken: String) {
        self.deviceID = deviceID.trimmingCharacters(in: .whitespacesAndNewlines)
        self.deviceToken = deviceToken.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var isValid: Bool {
        !deviceID.isEmpty && !deviceToken.isEmpty
    }
}

enum MissionControlServerConfig {
    static let serverURLKey = "mc2_server_url"
    static let mobileDeviceIDKey = "mc2_mobile_device_id"
    static let defaultBaseURLString = "https://sats21m.com"

    static var baseURL: URL {
        if let saved = UserDefaults.standard.string(forKey: serverURLKey),
           let url = URL(string: saved) {
            return url
        }
        return URL(string: defaultBaseURLString)!
    }

    static var mobileDeviceID: String {
        UserDefaults.standard.string(forKey: mobileDeviceIDKey) ?? ""
    }

    static var mobileDeviceToken: String {
        MissionControlMobileTokenStore.read() ?? ""
    }

    static var mobileCredentials: MissionControlMobileCredentials? {
        let credentials = MissionControlMobileCredentials(
            deviceID: mobileDeviceID,
            deviceToken: mobileDeviceToken
        )
        return credentials.isValid ? credentials : nil
    }

    static func save(baseURLString: String, deviceID: String, deviceToken: String) {
        let trimmedURL = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(
            trimmedURL.isEmpty ? defaultBaseURLString : trimmedURL,
            forKey: serverURLKey
        )
        UserDefaults.standard.set(
            deviceID.trimmingCharacters(in: .whitespacesAndNewlines),
            forKey: mobileDeviceIDKey
        )
        MissionControlMobileTokenStore.save(deviceToken)
    }

    static func clearMobileCredentials() {
        UserDefaults.standard.removeObject(forKey: mobileDeviceIDKey)
        MissionControlMobileTokenStore.delete()
    }

    static func makeTodoCompleteRequest(
        todoID: String,
        title: String,
        credentials: MissionControlMobileCredentials,
        baseURL: URL = Self.baseURL
    ) throws -> URLRequest {
        guard credentials.isValid else {
            throw AppWriteSyncService.SyncError.missingMobileCredentials
        }
        guard let url = URL(string: "/api/mobile/todos/complete", relativeTo: baseURL) else {
            throw AppWriteSyncService.SyncError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(credentials.deviceID, forHTTPHeaderField: "x-mobile-device-id")
        request.setValue(credentials.deviceToken, forHTTPHeaderField: "x-mobile-device-token")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "id": todoID,
            "title": title,
        ])
        return request
    }
}

private enum MissionControlMobileTokenStore {
    private static let service = "com.sats21m.masonsbudget.mc2-mobile"
    private static let account = "device-token"

    static func read() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            delete()
            return
        }

        let data = Data(trimmed.utf8)
        let status = SecItemUpdate(baseQuery() as CFDictionary, [
            kSecValueData as String: data,
        ] as CFDictionary)

        if status == errSecSuccess { return }

        var query = baseQuery()
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    static func delete() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

enum AppWriteSyncService {
    private static let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "AppWriteSync")
    private static let maxRetries = 2
    private static let retryDelay: UInt64 = 2_000_000_000

    private static func makeClient() -> ConvexClient {
        ConvexClient(deploymentURL: ConvexConfig.deploymentURL)
    }

    static func pushTransaction(_ transaction: Transaction, owner: FamilyMember) {
        guard ConvexConfig.isConfigured else { return }
        guard ConvexConfig.nativeWritesEnabled else {
            log.debug("Skipped native Convex transaction write; native writes are disabled")
            return
        }

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
        guard ConvexConfig.nativeWritesEnabled else {
            log.debug("Skipped native Convex transaction delete; native writes are disabled")
            return
        }

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
        guard ConvexConfig.nativeWritesEnabled else {
            if todo.isDone {
                completeTodoViaMissionControl(todo)
            } else {
                log.debug("Skipped native Convex todo write; native writes are disabled")
            }
            return
        }

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
        guard ConvexConfig.nativeWritesEnabled else {
            log.debug("Skipped native Convex todo delete; native writes are disabled")
            return
        }

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
        guard ConvexConfig.nativeWritesEnabled else {
            log.debug("Skipped native Convex budget write; native writes are disabled")
            return
        }

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

    private static func completeTodoViaMissionControl(_ todo: TodoItem) {
        guard let credentials = MissionControlServerConfig.mobileCredentials else {
            log.error("Skipped MC2 todo completion; missing paired mobile credentials")
            return
        }

        Task {
            await withRetry(label: "complete todo via MC2 \(todo.id)") {
                let request = try MissionControlServerConfig.makeTodoCompleteRequest(
                    todoID: todo.id,
                    title: todo.title,
                    credentials: credentials
                )

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw SyncError.unexpectedPayload
                }
                guard (200..<300).contains(http.statusCode) else {
                    let message = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
                    throw SyncError.serverRejected(status: http.statusCode, message: message)
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
        case invalidURL
        case missingMobileCredentials
        case unexpectedPayload
        case serverRejected(status: Int, message: String)
    }
}
