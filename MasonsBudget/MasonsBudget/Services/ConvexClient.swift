// The Vogel Vault — Convex HTTP Client
// Communicates with the Convex backend to fetch and sync financial data.
// Replaces the local-file-based MC2 reader with a cloud-native approach.

import CryptoKit
import Foundation
import os
import Security

/// Configuration for the Convex deployment.
enum ConvexConfig {
    /// The Convex deployment URL. Updated after `npx convex deploy`.
    /// Store in UserDefaults so it can be changed without an app update.
    static var deploymentURL: URL {
        if let saved = UserDefaults.standard.string(forKey: "convex_deployment_url"),
           let url = URL(string: saved)
        {
            return url
        }
        return URL(string: "https://keen-elephant-452.convex.cloud")!
    }

    static func setDeploymentURL(_ urlString: String) {
        UserDefaults.standard.set(urlString, forKey: "convex_deployment_url")
    }

    /// Whether the Convex URL has been configured (not placeholder).
    static var isConfigured: Bool {
        let url = deploymentURL.absoluteString
        return !url.contains("placeholder")
    }

    /// Optional sync token for an authorized write path. NEVER hardcode a shared secret here
    /// (see AGENTS.md). Sourced from UserDefaults so it can be injected at runtime; empty by
    /// default so native writes stay fail-closed (the server rejects an empty/invalid token).
    static var syncToken: String {
        UserDefaults.standard.string(forKey: "convex_sync_token") ?? ""
    }
}

enum MC2MobileWritebackConfig {
    private static let baseURLKey = "mc2_mobile_base_url"
    private static let deviceIDKey = "mc2_mobile_device_id"
    private static let deviceTokenKey = "mc2_mobile_device_token"

    static var baseURL: URL? {
        guard let raw = UserDefaults.standard.string(forKey: baseURLKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty
        else { return nil }
        return URL(string: raw)
    }

    static var deviceID: String {
        UserDefaults.standard.string(forKey: deviceIDKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    static var deviceToken: String {
        if let token = MC2MobileDeviceTokenStore.read(), !token.isEmpty {
            return token
        }
        let legacyToken = UserDefaults.standard.string(forKey: deviceTokenKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !legacyToken.isEmpty {
            MC2MobileDeviceTokenStore.save(legacyToken)
            UserDefaults.standard.removeObject(forKey: deviceTokenKey)
        }
        return legacyToken
    }

    static var isConfigured: Bool {
        baseURL != nil && !deviceID.isEmpty && !deviceToken.isEmpty
    }

    static var bundledPairingURLs: [String] {
        if let encoded = Bundle.main.object(forInfoDictionaryKey: "MC2BundledPairingURLsB64") as? String,
           !encoded.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let data = Data(base64Encoded: encoded.trimmingCharacters(in: .whitespacesAndNewlines)),
           let urls = try? JSONDecoder().decode([String].self, from: data)
        {
            return urls.filter { URL(string: $0) != nil }
        }

        if let raw = Bundle.main.object(forInfoDictionaryKey: "MC2BundledPairingURLs") as? String {
            return raw
                .components(separatedBy: CharacterSet(charactersIn: "\n,"))
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty && URL(string: $0) != nil }
        }

        return []
    }

    static func save(baseURL: String, deviceID: String, deviceToken: String) {
        UserDefaults.standard.set(baseURL.trimmingCharacters(in: .whitespacesAndNewlines), forKey: baseURLKey)
        UserDefaults.standard.set(deviceID.trimmingCharacters(in: .whitespacesAndNewlines), forKey: deviceIDKey)
        MC2MobileDeviceTokenStore.save(deviceToken.trimmingCharacters(in: .whitespacesAndNewlines))
        UserDefaults.standard.removeObject(forKey: deviceTokenKey)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: baseURLKey)
        UserDefaults.standard.removeObject(forKey: deviceIDKey)
        UserDefaults.standard.removeObject(forKey: deviceTokenKey)
        MC2MobileDeviceTokenStore.clear()
    }
}

private enum MC2MobileDeviceTokenStore {
    private static let service = "com.sats21m.vogel-vault.mc2-mobile"
    private static let account = "device-token"

    static func read() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8)
        else { return nil }
        return token.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func save(_ token: String) {
        clear()
        guard let data = token.data(using: .utf8), !token.isEmpty else { return }
        var item = baseQuery
        item[kSecValueData as String] = data
        SecItemAdd(item as CFDictionary, nil)
    }

    static func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

enum MC2MobileWritebackError: LocalizedError {
    case notConfigured
    case invalidBaseURL
    case invalidPairingURL
    case httpError(Int)
    case serverError(String)
    case unexpectedResponse

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            "MC2 mobile writeback is not configured."
        case .invalidBaseURL:
            "MC2 mobile writeback URL is invalid."
        case .invalidPairingURL:
            "MC2 pairing URL is invalid or expired."
        case let .httpError(code):
            "MC2 mobile writeback returned HTTP \(code)."
        case let .serverError(message):
            message
        case .unexpectedResponse:
            "MC2 mobile writeback returned an unexpected response."
        }
    }
}

final class MC2MobileWritebackClient: Sendable {
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func claimPairing(pairingURL rawURL: String, deviceName: String) async throws {
        let trimmed = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme,
              let host = url.host,
              let pair = Self.pairFragment(from: url)
        else {
            throw MC2MobileWritebackError.invalidPairingURL
        }

        var baseComponents = URLComponents()
        baseComponents.scheme = scheme
        baseComponents.host = host
        baseComponents.port = url.port
        guard let baseURL = baseComponents.url else {
            throw MC2MobileWritebackError.invalidPairingURL
        }

        if Self.isConvexBaseURL(baseURL) {
            try await claimConvexPairing(baseURL: baseURL, pair: pair, deviceName: deviceName)
            return
        }

        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("mobile")
            .appendingPathComponent("pair")
            .appendingPathComponent("claim")
        guard endpoint.scheme == "https" || endpoint.host == "localhost" || endpoint.host == "127.0.0.1" else {
            throw MC2MobileWritebackError.invalidBaseURL
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "pairId": pair.pairID,
            "proofHash": pair.proofHash,
            "deviceName": deviceName,
        ])

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MC2MobileWritebackError.httpError(0)
        }
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        if http.statusCode != 200 {
            let message = object?["error"] as? String
            throw MC2MobileWritebackError.serverError(message ?? "MC2 pairing failed.")
        }
        guard let deviceID = object?["deviceId"] as? String,
              let deviceToken = object?["deviceToken"] as? String
        else {
            throw MC2MobileWritebackError.unexpectedResponse
        }

        MC2MobileWritebackConfig.save(
            baseURL: baseURL.absoluteString,
            deviceID: deviceID,
            deviceToken: deviceToken,
        )
    }

    func claimBundledPairing(deviceName: String) async throws {
        if MC2MobileWritebackConfig.isConfigured { return }

        let urls = MC2MobileWritebackConfig.bundledPairingURLs
        guard !urls.isEmpty else {
            throw MC2MobileWritebackError.serverError("This build does not include a mobile pairing slot.")
        }

        var lastError: Error?
        for url in urls {
            do {
                try await claimPairing(pairingURL: url, deviceName: deviceName)
                return
            } catch {
                lastError = error
            }
        }

        throw lastError ?? MC2MobileWritebackError.invalidPairingURL
    }

    @discardableResult
    func completeTodo(id: String, title: String) async throws -> Bool {
        try await setTodoDone(id: id, title: title, isDone: true)
    }

    @discardableResult
    func setTodoDone(id: String, title: String, isDone: Bool) async throws -> Bool {
        if !MC2MobileWritebackConfig.isConfigured {
            #if os(iOS)
                let deviceName = "Vogel Vault iOS"
            #else
                let deviceName = "Vogel Vault macOS"
            #endif
            try await claimBundledPairing(deviceName: deviceName)
        }

        guard let baseURL = MC2MobileWritebackConfig.baseURL,
              !MC2MobileWritebackConfig.deviceID.isEmpty,
              !MC2MobileWritebackConfig.deviceToken.isEmpty
        else { throw MC2MobileWritebackError.notConfigured }

        if Self.isConvexBaseURL(baseURL) {
            return try await setTodoDoneViaConvex(baseURL: baseURL, id: id, title: title, isDone: isDone)
        }

        guard isDone else {
            throw MC2MobileWritebackError.serverError("This mobile writeback endpoint cannot reopen todos.")
        }

        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("mobile")
            .appendingPathComponent("todos")
            .appendingPathComponent("complete")
        guard endpoint.scheme == "https" || endpoint.host == "localhost" || endpoint.host == "127.0.0.1" else {
            throw MC2MobileWritebackError.invalidBaseURL
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(MC2MobileWritebackConfig.deviceID, forHTTPHeaderField: "x-mobile-device-id")
        request.setValue(MC2MobileWritebackConfig.deviceToken, forHTTPHeaderField: "x-mobile-device-token")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "id": id,
            "title": title,
        ])

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MC2MobileWritebackError.httpError(0)
        }

        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        if http.statusCode != 200 {
            let message = object?["error"] as? String
            throw MC2MobileWritebackError.serverError(message ?? "MC2 mobile writeback failed.")
        }
        guard let object else { throw MC2MobileWritebackError.unexpectedResponse }
        guard object["ok"] as? Bool == true else {
            throw MC2MobileWritebackError.serverError((object["error"] as? String) ?? "MC2 rejected todo completion.")
        }
        return true
    }

    @discardableResult
    func removeTodo(id: String) async throws -> Bool {
        if !MC2MobileWritebackConfig.isConfigured {
            #if os(iOS)
                let deviceName = "Vogel Vault iOS"
            #else
                let deviceName = "Vogel Vault macOS"
            #endif
            try await claimBundledPairing(deviceName: deviceName)
        }

        guard let baseURL = MC2MobileWritebackConfig.baseURL,
              !MC2MobileWritebackConfig.deviceID.isEmpty,
              !MC2MobileWritebackConfig.deviceToken.isEmpty
        else { throw MC2MobileWritebackError.notConfigured }

        guard Self.isConvexBaseURL(baseURL) else {
            throw MC2MobileWritebackError.serverError("This mobile writeback endpoint cannot delete todos.")
        }

        return try await removeTodoViaConvex(baseURL: baseURL, id: id)
    }

    @discardableResult
    func upsertTodo(_ todo: MC2TodoItem) async throws -> Bool {
        if !MC2MobileWritebackConfig.isConfigured {
            #if os(iOS)
                let deviceName = "Vogel Vault iOS"
            #else
                let deviceName = "Vogel Vault macOS"
            #endif
            try await claimBundledPairing(deviceName: deviceName)
        }

        guard let baseURL = MC2MobileWritebackConfig.baseURL,
              !MC2MobileWritebackConfig.deviceID.isEmpty,
              !MC2MobileWritebackConfig.deviceToken.isEmpty
        else { throw MC2MobileWritebackError.notConfigured }

        guard Self.isConvexBaseURL(baseURL) else {
            throw MC2MobileWritebackError.serverError("This mobile writeback endpoint cannot upsert todos.")
        }

        return try await upsertTodoViaConvex(baseURL: baseURL, todo: todo)
    }

    private func claimConvexPairing(
        baseURL: URL,
        pair: (pairID: String, proofHash: String),
        deviceName: String,
    ) async throws {
        let deviceID = try Self.randomBase64URL(byteCount: 14)
        let deviceToken = try Self.randomBase64URL(byteCount: 32)
        let value = try await convexMutation(baseURL: baseURL, path: "dataFiles:claimMobilePairing", args: [
            "pairId": pair.pairID,
            "proofHash": pair.proofHash,
            "deviceName": deviceName,
            "deviceId": deviceID,
            "deviceToken": deviceToken,
        ])
        guard let object = value as? [String: Any], object["ok"] as? Bool == true else {
            throw MC2MobileWritebackError.unexpectedResponse
        }

        MC2MobileWritebackConfig.save(
            baseURL: baseURL.absoluteString,
            deviceID: deviceID,
            deviceToken: deviceToken,
        )
    }

    private func setTodoDoneViaConvex(baseURL: URL, id: String, title: String, isDone: Bool) async throws -> Bool {
        let value = try await convexMutation(baseURL: baseURL, path: "dataFiles:completeTodoFromMobile", args: [
            "deviceId": MC2MobileWritebackConfig.deviceID,
            "deviceToken": MC2MobileWritebackConfig.deviceToken,
            "id": id,
            "title": title,
            "done": isDone,
        ])
        guard let object = value as? [String: Any], object["ok"] as? Bool == true else {
            throw MC2MobileWritebackError.unexpectedResponse
        }
        return true
    }

    private func upsertTodoViaConvex(baseURL: URL, todo: MC2TodoItem) async throws -> Bool {
        let value = try await convexMutation(baseURL: baseURL, path: "dataFiles:upsertTodoFromMobile", args: [
            "deviceId": MC2MobileWritebackConfig.deviceID,
            "deviceToken": MC2MobileWritebackConfig.deviceToken,
            "todo": todo.convexJSONObject(),
        ])
        guard let object = value as? [String: Any], object["ok"] as? Bool == true else {
            throw MC2MobileWritebackError.unexpectedResponse
        }
        return true
    }

    private func removeTodoViaConvex(baseURL: URL, id: String) async throws -> Bool {
        let value = try await convexMutation(baseURL: baseURL, path: "dataFiles:removeTodoFromMobile", args: [
            "deviceId": MC2MobileWritebackConfig.deviceID,
            "deviceToken": MC2MobileWritebackConfig.deviceToken,
            "id": id,
        ])
        guard let object = value as? [String: Any], object["ok"] as? Bool == true else {
            throw MC2MobileWritebackError.unexpectedResponse
        }
        return true
    }

    private func convexMutation(baseURL: URL, path: String, args: [String: Any]) async throws -> Any {
        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("mutation")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "path": path,
            "args": args,
            "format": "json",
        ])

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MC2MobileWritebackError.httpError(0)
        }
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        if http.statusCode != 200 {
            throw MC2MobileWritebackError.httpError(http.statusCode)
        }
        if object?["status"] as? String == "error" {
            // ConvexError application errors carry the real reason in errorData;
            // errorMessage is the prod-masked "Server Error" string (SAT-1508).
            let detail = (object?["errorData"] as? String)
                ?? (object?["errorMessage"] as? String)
                ?? "Convex mobile writeback failed."
            throw MC2MobileWritebackError.serverError(detail)
        }
        guard object?["status"] as? String == "success" else {
            throw MC2MobileWritebackError.unexpectedResponse
        }
        return object?["value"] ?? [:]
    }

    private static func isConvexBaseURL(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return host == "convex.cloud" || host.hasSuffix(".convex.cloud")
    }

    private static func randomBase64URL(byteCount: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw MC2MobileWritebackError.unexpectedResponse
        }
        return Data(bytes)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func pairFragment(from url: URL) -> (pairID: String, proofHash: String)? {
        guard let fragment = url.fragment,
              let components = URLComponents(string: "mc2://pair?\(fragment)"),
              let rawPair = components.queryItems?.first(where: { $0.name == "pair" })?.value
        else { return nil }

        let parts = rawPair.split(separator: ".", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }

        let digest = SHA256.hash(data: Data(rawPair.utf8))
        let proofHash = digest.map { String(format: "%02x", $0) }.joined()
        return (pairID: parts[0], proofHash: proofHash)
    }
}

/// Errors specific to Convex operations.
enum ConvexError: LocalizedError {
    case notConfigured
    case networkError(Error)
    case httpError(Int)
    case decodeFailed(String, Error)
    case noData(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            "Convex backend not configured. Please set up in Settings."
        case let .networkError(error):
            "Network error: \(error.localizedDescription)"
        case let .httpError(code):
            "Server returned HTTP \(code)"
        case let .decodeFailed(name, error):
            "Failed to decode \(name): \(error.localizedDescription)"
        case let .noData(name):
            "No data found for '\(name)'"
        }
    }
}

/// Response envelope from the Convex HTTP API.
private struct ConvexQueryResponse: Decodable {
    let status: String
    let value: AnyCodable?
    let errorMessage: String?
}

/// Type-erased Codable wrapper for Convex responses.
struct AnyCodable: Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int64.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unsupported type"),
            )
        }
    }
}

/// HTTP client for the Convex backend.
/// Handles query and mutation calls via the Convex HTTP API.
final class ConvexClient: Sendable {
    private let deploymentURL: URL
    private let session: URLSession
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "Convex")

    init(deploymentURL: URL) {
        self.deploymentURL = deploymentURL
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        session = URLSession(configuration: config)
    }

    /// Fetch a data file from Convex and decode it as the given type.
    func fetchFile<T: Decodable>(_ name: String, as type: T.Type) async throws -> T {
        let rawData = try await query("dataFiles:get", args: ["name": name])

        // rawData is the raw JSON value returned by Convex
        // Re-encode it to Data so we can use JSONDecoder with our DTOs
        let jsonData = try JSONSerialization.data(withJSONObject: rawData)
        do {
            return try JSONDecoder().decode(type, from: jsonData)
        } catch {
            throw ConvexError.decodeFailed(name, error)
        }
    }

    /// Fetch a data file without decoding it so callers can handle legacy or mixed schemas.
    func fetchFileValue(_ name: String) async throws -> Any {
        try await query("dataFiles:get", args: ["name": name])
    }

    /// Fetch current data file versions (lightweight change detection).
    func fetchVersions() async throws -> [String: Double] {
        let raw = try await query("dataFiles:getVersions", args: [:])
        guard let versions = raw as? [String: Any] else { return [:] }
        var result: [String: Double] = [:]
        for (key, val) in versions {
            if let v = val as? Double { result[key] = v }
            else if let v = val as? Int { result[key] = Double(v) }
        }
        return result
    }

    /// Replace a whole data file payload and bump its sync version.
    @discardableResult
    func syncFile(name: String, data: Any) async throws -> Double {
        let raw = try await mutation("dataFiles:sync", args: [
            "name": name,
            "data": data,
        ])
        guard let result = raw as? [String: Any] else { return 0 }
        if let version = result["version"] as? Double { return version }
        if let version = result["version"] as? Int { return Double(version) }
        return 0
    }

    /// Push one app-created transaction into the shared MC2 transactions document.
    @discardableResult
    func appendTransaction(_ transaction: MC2Transaction, to name: String = "transactions") async throws -> Double {
        let raw = try await mutation("dataFiles:appendTransaction", args: [
            "name": name,
            "transaction": transaction.convexJSONObject(),
        ])
        guard let result = raw as? [String: Any] else { return 0 }
        if let version = result["version"] as? Double { return version }
        if let version = result["version"] as? Int { return Double(version) }
        return 0
    }

    /// Upsert one app-created or app-edited todo into the shared MC2 todos document.
    @discardableResult
    func upsertTodo(_ todo: MC2TodoItem, to name: String = "todos") async throws -> Double {
        let raw = try await mutation("dataFiles:upsertTodo", args: [
            "name": name,
            "todo": todo.convexJSONObject(),
        ])
        guard let result = raw as? [String: Any] else { return 0 }
        if let version = result["version"] as? Double { return version }
        if let version = result["version"] as? Int { return Double(version) }
        return 0
    }

    @discardableResult
    func removeTodo(id: String) async throws -> Bool {
        let raw = try await mutation("dataFiles:removeTodo", args: [
            "todoId": id,
        ])
        guard let result = raw as? [String: Any] else { return false }
        return result["removed"] as? Bool ?? false
    }

    /// Push one app-created bill pay into the bitcoin-bill-pays document.
    @discardableResult
    func appendBillPay(_ billPay: MC2BTCBillPay) async throws -> Double {
        let data = try JSONEncoder().encode(billPay)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ConvexError.decodeFailed("billPay", NSError(domain: "MC2BTCBillPay", code: -1))
        }
        let raw = try await mutation("dataFiles:appendBillPay", args: [
            "billPay": object,
        ])
        guard let result = raw as? [String: Any] else { return 0 }
        if let version = result["version"] as? Double { return version }
        if let version = result["version"] as? Int { return Double(version) }
        return 0
    }

    // MARK: - Internal

    /// Execute a Convex query and return the raw result.
    private func query(_ path: String, args: [String: Any]) async throws -> Any {
        try await call(endpoint: "api/query", path: path, args: args)
    }

    /// Execute a Convex mutation and return the raw result.
    private func mutation(_ path: String, args: [String: Any]) async throws -> Any {
        try await call(endpoint: "api/mutation", path: path, args: args)
    }

    private func call(endpoint: String, path: String, args: [String: Any]) async throws -> Any {
        let url = deploymentURL.appendingPathComponent(endpoint)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var finalArgs = args
        if endpoint == "api/mutation" {
            let token = ConvexConfig.syncToken
            if !token.isEmpty {
                finalArgs["token"] = token
            }
        }

        let body: [String: Any] = [
            "path": path,
            "args": finalArgs,
            "format": "json",
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw ConvexError.httpError(0)
        }
        guard http.statusCode == 200 else {
            log.error("Convex call failed: HTTP \(http.statusCode)")
            throw ConvexError.httpError(http.statusCode)
        }

        // Parse the Convex response envelope
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let status = json?["status"] as? String else {
            throw ConvexError.decodeFailed(path, NSError(domain: "Convex", code: -1))
        }

        if status == "error" {
            let msg = json?["errorMessage"] as? String ?? "Unknown error"
            log.error("Convex call error: \(msg)")
            throw ConvexError.decodeFailed(path, NSError(domain: "Convex", code: -1, userInfo: [
                NSLocalizedDescriptionKey: msg,
            ]))
        }

        guard let value = json?["value"] else {
            throw ConvexError.noData(path)
        }

        // Convex returns NSNull for null values
        if value is NSNull {
            throw ConvexError.noData(path)
        }

        return value
    }
}
