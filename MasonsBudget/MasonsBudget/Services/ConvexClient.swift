// The Vogel Vault — Convex HTTP Client
// Communicates with the Convex backend to fetch and sync financial data.

import CryptoKit
import Foundation
import os
import Security

/// Configuration for the Convex deployment.
enum ConvexConfig {
    private static let rowReadsEnabledKey = "convex_row_reads_enabled"
    private static let syncTokenKey = "convex_sync_token"
    private static var syncTokenStore: MigratingKeychainTokenStore {
        MigratingKeychainTokenStore(
            userDefaults: .standard,
            legacyKey: syncTokenKey,
            keychain: KeychainCredentialStore(
                service: "com.sats21m.vogel-vault.convex",
                account: "sync-token",
            ),
        )
    }

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
    /// (see AGENTS.md). Stored in the Keychain after runtime injection; empty by default so
    /// native writes stay fail-closed (the server rejects an empty/invalid token).
    ///
    /// Reading this property also migrates the Wave 1 UserDefaults value, if present, and
    /// removes the cleartext copy only after the Keychain write succeeds.
    static var syncToken: String {
        syncTokenStore.token
    }

    /// Presence-only view for UI status. UI callers must not retain or render the credential.
    static var hasSyncToken: Bool {
        syncTokenStore.hasToken
    }

    @discardableResult
    static func setSyncToken(_ token: String) -> Bool {
        syncTokenStore.set(token)
    }

    @discardableResult
    static func removeSyncToken() -> Bool {
        syncTokenStore.remove()
    }

    /// Optional read token.
    ///
    /// Reads were unauthenticated until 2026-07-26 — the deployment URL alone was
    /// enough to pull the household's entire financial history. The server is now
    /// fail-closed on reads too.
    ///
    /// Same rules as `syncToken`: never hardcode it, never bundle it in the app,
    /// never commit it. Injected at runtime and empty by default, so a build that
    /// has not been configured fails closed against an enforcing deployment rather
    /// than silently carrying a secret.
    static var readToken: String {
        UserDefaults.standard.string(forKey: "convex_read_token") ?? ""
    }

    static func setReadToken(_ token: String) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            UserDefaults.standard.removeObject(forKey: "convex_read_token")
        } else {
            UserDefaults.standard.set(trimmed, forKey: "convex_read_token")
        }
    }

    /// Runtime gate for the public row API. Default-off until the row schema and
    /// backfill exist in production.
    static var rowReadsEnabled: Bool {
        UserDefaults.standard.bool(forKey: rowReadsEnabledKey)
    }

    static func setRowReadsEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: rowReadsEnabledKey)
    }
}

/// The seam that makes credential storage testable.
///
/// `MasonsBudgetTests` is a `bundle.unit-test` target with no host application,
/// so it has no keychain access group and every `SecItemAdd` fails with
/// `errSecMissingEntitlement`. Tests that talk to the real Keychain therefore
/// cannot pass — and, worse, a test asserting a credential is ABSENT passes
/// trivially there, proving nothing. Injecting the store lets the tests assert
/// the migration and clearing LOGIC against an in-memory double, which is the
/// part that actually has bugs in it.
protocol CredentialStoring {
    func read() -> String?
    @discardableResult func save(_ token: String) -> Bool
    @discardableResult func clear() -> Bool
}

extension KeychainCredentialStore: CredentialStoring {}

struct MigratingKeychainTokenStore {
    let userDefaults: UserDefaults
    let legacyKey: String
    let keychain: CredentialStoring

    var token: String {
        if let storedToken = keychain.read(), !storedToken.isEmpty {
            userDefaults.removeObject(forKey: legacyKey)
            return storedToken
        }

        let legacyToken = userDefaults.string(forKey: legacyKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !legacyToken.isEmpty else {
            userDefaults.removeObject(forKey: legacyKey)
            return ""
        }

        guard keychain.save(legacyToken) else {
            // Keep the only surviving copy when Keychain is unavailable. A later
            // read retries the migration instead of destroying the credential.
            return legacyToken
        }
        userDefaults.removeObject(forKey: legacyKey)
        return legacyToken
    }

    var hasToken: Bool {
        !token.isEmpty
    }

    @discardableResult
    func set(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return remove() }
        guard keychain.save(trimmed) else { return false }
        userDefaults.removeObject(forKey: legacyKey)
        return true
    }

    @discardableResult
    func remove() -> Bool {
        let removed = keychain.clear()
        userDefaults.removeObject(forKey: legacyKey)
        return removed
    }
}

struct KeychainCredentialStore {
    let service: String
    let account: String

    func read() -> String? {
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

    @discardableResult
    func save(_ token: String) -> Bool {
        guard let data = token.data(using: .utf8), !token.isEmpty else {
            return clear()
        }

        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(
            baseQuery as CFDictionary,
            attributes as CFDictionary,
        )
        if updateStatus == errSecSuccess {
            return true
        }
        guard updateStatus == errSecItemNotFound else { return false }

        var item = baseQuery
        attributes.forEach { item[$0.key] = $0.value }
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    func clear() -> Bool {
        let status = SecItemDelete(baseQuery as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

enum AppWritebackConfig {
    // Preserve deployed storage keys so existing paired devices keep working.
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
        if let token = AppWritebackDeviceTokenStore.read(), !token.isEmpty {
            return token
        }
        let legacyToken = UserDefaults.standard.string(forKey: deviceTokenKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !legacyToken.isEmpty {
            AppWritebackDeviceTokenStore.save(legacyToken)
            UserDefaults.standard.removeObject(forKey: deviceTokenKey)
        }
        return legacyToken
    }

    /// Presence-only view of the credential for UI status. Callers that do not
    /// need to authenticate must not retain or render `deviceToken`.
    static var hasDeviceToken: Bool {
        !deviceToken.isEmpty
    }

    static var isConfigured: Bool {
        baseURL != nil && !deviceID.isEmpty && hasDeviceToken
    }

    static var bundledPairingURLs: [String] {
        let encodedPayload = Bundle.main.object(
            forInfoDictionaryKey: "VogelVaultBundledPairingURLsB64",
        ) as? String ?? Bundle.main.object(
            forInfoDictionaryKey: "MC2BundledPairingURLsB64",
        ) as? String
        if let encoded = encodedPayload,
           !encoded.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let data = Data(base64Encoded: encoded.trimmingCharacters(in: .whitespacesAndNewlines)),
           let urls = try? JSONDecoder().decode([String].self, from: data)
        {
            return urls.filter { URL(string: $0) != nil }
        }

        let rawPayload = Bundle.main.object(
            forInfoDictionaryKey: "VogelVaultBundledPairingURLs",
        ) as? String ?? Bundle.main.object(
            forInfoDictionaryKey: "MC2BundledPairingURLs",
        ) as? String
        if let raw = rawPayload {
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
        // A blank token must NOT leave the previous one in place. baseURL and
        // deviceID above have already been overwritten, so keeping the old
        // secret would pair this device's new host with the OLD host's
        // credential and still report isConfigured == true — a failed pairing
        // that looks like a successful one. Clear instead, so the state is
        // honestly unconfigured and the user is asked to pair again.
        let trimmedDeviceToken = deviceToken.trimmingCharacters(in: .whitespacesAndNewlines)
        AppWritebackDeviceTokenStore.save(trimmedDeviceToken)
        UserDefaults.standard.removeObject(forKey: deviceTokenKey)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: baseURLKey)
        UserDefaults.standard.removeObject(forKey: deviceIDKey)
        UserDefaults.standard.removeObject(forKey: deviceTokenKey)
        AppWritebackDeviceTokenStore.clear()
    }
}

private enum AppWritebackDeviceTokenStore {
    // Preserve the deployed Keychain service as a credential migration boundary.
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

enum AppWritebackError: LocalizedError {
    case notConfigured
    case invalidBaseURL
    case invalidPairingURL
    case httpError(Int)
    case serverError(String)
    case unexpectedResponse

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            "App writeback is not configured."
        case .invalidBaseURL:
            "The writeback URL is invalid."
        case .invalidPairingURL:
            "The device pairing URL is invalid or expired."
        case let .httpError(code):
            "The writeback endpoint returned HTTP \(code)."
        case let .serverError(message):
            message
        case .unexpectedResponse:
            "The writeback endpoint returned an unexpected response."
        }
    }
}

final class AppWritebackClient: Sendable {
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
            throw AppWritebackError.invalidPairingURL
        }

        var baseComponents = URLComponents()
        baseComponents.scheme = scheme
        baseComponents.host = host
        baseComponents.port = url.port
        guard let baseURL = baseComponents.url else {
            throw AppWritebackError.invalidPairingURL
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
            throw AppWritebackError.invalidBaseURL
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
            throw AppWritebackError.httpError(0)
        }
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        if http.statusCode != 200 {
            let message = object?["error"] as? String
            throw AppWritebackError.serverError(message ?? "Device pairing failed.")
        }
        guard let deviceID = object?["deviceId"] as? String,
              let deviceToken = object?["deviceToken"] as? String
        else {
            throw AppWritebackError.unexpectedResponse
        }

        AppWritebackConfig.save(
            baseURL: baseURL.absoluteString,
            deviceID: deviceID,
            deviceToken: deviceToken,
        )
    }

    func claimBundledPairing(deviceName: String) async throws {
        if AppWritebackConfig.isConfigured { return }

        let urls = AppWritebackConfig.bundledPairingURLs
        guard !urls.isEmpty else {
            throw AppWritebackError.serverError("This build does not include a mobile pairing slot.")
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

        throw lastError ?? AppWritebackError.invalidPairingURL
    }

    @discardableResult
    func completeTodo(id: String, title: String) async throws -> Bool {
        try await setTodoDone(id: id, title: title, isDone: true)
    }

    @discardableResult
    func setTodoDone(id: String, title: String, isDone: Bool) async throws -> Bool {
        if !AppWritebackConfig.isConfigured {
            #if os(iOS)
                let deviceName = "Vogel Vault iOS"
            #else
                let deviceName = "Vogel Vault macOS"
            #endif
            try await claimBundledPairing(deviceName: deviceName)
        }

        guard let baseURL = AppWritebackConfig.baseURL,
              !AppWritebackConfig.deviceID.isEmpty,
              !AppWritebackConfig.deviceToken.isEmpty
        else { throw AppWritebackError.notConfigured }

        if Self.isConvexBaseURL(baseURL) {
            return try await setTodoDoneViaConvex(baseURL: baseURL, id: id, title: title, isDone: isDone)
        }

        guard isDone else {
            throw AppWritebackError.serverError("This mobile writeback endpoint cannot reopen todos.")
        }

        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("mobile")
            .appendingPathComponent("todos")
            .appendingPathComponent("complete")
        guard endpoint.scheme == "https" || endpoint.host == "localhost" || endpoint.host == "127.0.0.1" else {
            throw AppWritebackError.invalidBaseURL
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(AppWritebackConfig.deviceID, forHTTPHeaderField: "x-mobile-device-id")
        request.setValue(AppWritebackConfig.deviceToken, forHTTPHeaderField: "x-mobile-device-token")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "id": id,
            "title": title,
        ])

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AppWritebackError.httpError(0)
        }

        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        if http.statusCode != 200 {
            let message = object?["error"] as? String
            throw AppWritebackError.serverError(message ?? "App writeback failed.")
        }
        guard let object else { throw AppWritebackError.unexpectedResponse }
        guard object["ok"] as? Bool == true else {
            throw AppWritebackError.serverError((object["error"] as? String) ?? "The writeback endpoint rejected todo completion.")
        }
        return true
    }

    @discardableResult
    func removeTodo(id: String) async throws -> Bool {
        if !AppWritebackConfig.isConfigured {
            #if os(iOS)
                let deviceName = "Vogel Vault iOS"
            #else
                let deviceName = "Vogel Vault macOS"
            #endif
            try await claimBundledPairing(deviceName: deviceName)
        }

        guard let baseURL = AppWritebackConfig.baseURL,
              !AppWritebackConfig.deviceID.isEmpty,
              !AppWritebackConfig.deviceToken.isEmpty
        else { throw AppWritebackError.notConfigured }

        guard Self.isConvexBaseURL(baseURL) else {
            throw AppWritebackError.serverError("This mobile writeback endpoint cannot delete todos.")
        }

        return try await removeTodoViaConvex(baseURL: baseURL, id: id)
    }

    @discardableResult
    func upsertTodo(_ todo: LegacyTodoDTO) async throws -> Bool {
        if !AppWritebackConfig.isConfigured {
            #if os(iOS)
                let deviceName = "Vogel Vault iOS"
            #else
                let deviceName = "Vogel Vault macOS"
            #endif
            try await claimBundledPairing(deviceName: deviceName)
        }

        guard let baseURL = AppWritebackConfig.baseURL,
              !AppWritebackConfig.deviceID.isEmpty,
              !AppWritebackConfig.deviceToken.isEmpty
        else { throw AppWritebackError.notConfigured }

        guard Self.isConvexBaseURL(baseURL) else {
            throw AppWritebackError.serverError("This mobile writeback endpoint cannot upsert todos.")
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
            throw AppWritebackError.unexpectedResponse
        }

        AppWritebackConfig.save(
            baseURL: baseURL.absoluteString,
            deviceID: deviceID,
            deviceToken: deviceToken,
        )
    }

    private func setTodoDoneViaConvex(baseURL: URL, id: String, title: String, isDone: Bool) async throws -> Bool {
        let value = try await convexMutation(baseURL: baseURL, path: "dataFiles:completeTodoFromMobile", args: [
            "deviceId": AppWritebackConfig.deviceID,
            "deviceToken": AppWritebackConfig.deviceToken,
            "id": id,
            "title": title,
            "done": isDone,
        ])
        guard let object = value as? [String: Any], object["ok"] as? Bool == true else {
            throw AppWritebackError.unexpectedResponse
        }
        return true
    }

    private func upsertTodoViaConvex(baseURL: URL, todo: LegacyTodoDTO) async throws -> Bool {
        let value = try await convexMutation(baseURL: baseURL, path: "dataFiles:upsertTodoFromMobile", args: [
            "deviceId": AppWritebackConfig.deviceID,
            "deviceToken": AppWritebackConfig.deviceToken,
            "todo": todo.convexJSONObject(),
        ])
        guard let object = value as? [String: Any], object["ok"] as? Bool == true else {
            throw AppWritebackError.unexpectedResponse
        }
        return true
    }

    private func removeTodoViaConvex(baseURL: URL, id: String) async throws -> Bool {
        let value = try await convexMutation(baseURL: baseURL, path: "dataFiles:removeTodoFromMobile", args: [
            "deviceId": AppWritebackConfig.deviceID,
            "deviceToken": AppWritebackConfig.deviceToken,
            "id": id,
        ])
        guard let object = value as? [String: Any], object["ok"] as? Bool == true else {
            throw AppWritebackError.unexpectedResponse
        }
        return true
    }

    private func convexMutation(baseURL: URL, path: String, args: [String: Any]) async throws -> Any {
        guard baseURL.scheme?.lowercased() == "https" else {
            throw AppWritebackError.invalidBaseURL
        }

        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("mutation")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "path": path,
            "args": args,
            "format": "convex_encoded_json",
        ])

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AppWritebackError.httpError(0)
        }
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        if http.statusCode != 200 {
            throw AppWritebackError.httpError(http.statusCode)
        }
        if object?["status"] as? String == "error" {
            // ConvexError application errors carry the real reason in errorData;
            // errorMessage is the prod-masked "Server Error" string (SAT-1508).
            let detail = (object?["errorData"] as? String)
                ?? (object?["errorMessage"] as? String)
                ?? "Convex mobile writeback failed."
            throw AppWritebackError.serverError(detail)
        }
        guard object?["status"] as? String == "success" else {
            throw AppWritebackError.unexpectedResponse
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
            throw AppWritebackError.unexpectedResponse
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
    case serverError(path: String)
    case unauthorized(path: String)
    case rowAPIUnavailable(path: String)

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
        case let .serverError(path):
            "Convex query '\(path)' failed."
        case let .unauthorized(path):
            "Convex query '\(path)' was unauthorized."
        case let .rowAPIUnavailable(path):
            "Convex row query '\(path)' is not deployed."
        }
    }

    /// The only row-query failure that may fall back to the legacy blob path.
    ///
    /// Auth failures and invalid financial rows are deliberately excluded. A
    /// fallback for either would hide a security or data-integrity defect.
    var isRowAPIUnavailable: Bool {
        if case .rowAPIUnavailable = self { return true }
        return false
    }
}

/// Response envelope from the Convex HTTP API.
private struct ConvexQueryResponse: Decodable {
    let status: String
    let value: AnyCodable?
    let errorMessage: String?
}

/// Strictly converts Convex's tagged int64 wire values into Swift `Int64` values.
///
/// Convex serializes `v.int64()` as an object containing one `$integer` key whose
/// value is the canonical base64 encoding of eight little-endian bytes. Any object
/// that attempts to use that reserved key but does not match the exact shape is
/// rejected instead of being treated as ordinary JSON.
enum ConvexTaggedInt64Decoder {
    enum DecodeError: LocalizedError, Equatable {
        case malformedTag
        case malformedPayload

        var errorDescription: String? {
            switch self {
            case .malformedTag:
                "Convex int64 tags must contain only a string-valued $integer field."
            case .malformedPayload:
                "Convex int64 payloads must be canonical base64 containing exactly eight bytes."
            }
        }
    }

    static func decode(_ value: Any) throws -> Any {
        if let object = value as? [String: Any] {
            if object.keys.contains("$integer") {
                return try decodeTaggedValue(object)
            }
            return try object.mapValues(decode)
        }

        if let array = value as? [Any] {
            return try array.map(decode)
        }

        return value
    }

    static func decodeTaggedValue(_ value: Any) throws -> Int64 {
        guard let object = value as? [String: Any],
              object.count == 1,
              let encoded = object["$integer"] as? String
        else {
            throw DecodeError.malformedTag
        }
        return try decodePayload(encoded)
    }

    static func decodePayload(_ encoded: String) throws -> Int64 {
        guard let bytes = Data(base64Encoded: encoded),
              bytes.count == MemoryLayout<Int64>.size,
              bytes.base64EncodedString() == encoded
        else {
            throw DecodeError.malformedPayload
        }

        var bits: UInt64 = 0
        for (index, byte) in bytes.enumerated() {
            bits |= UInt64(byte) << (index * 8)
        }
        return Int64(bitPattern: bits)
    }
}

/// Encodes Swift `Int64` values for Convex's `convex_encoded_json` request format.
///
/// Row mutations accept `v.int64()`, which is not a JSON number. Sending an
/// `NSNumber` here would either lose precision above 2^53 or be rejected by
/// Convex. Keep the exact little-endian tag at the request boundary.
enum ConvexTaggedInt64Encoder {
    static func encode(_ value: Int64) -> [String: String] {
        var littleEndian = value.littleEndian
        let bytes = withUnsafeBytes(of: &littleEndian) { Data($0) }
        return ["$integer": bytes.base64EncodedString()]
    }
}

enum ConvexRowMutationError: LocalizedError, Equatable {
    case fractionalMinorUnit(field: String)
    case minorUnitOverflow(field: String)
    case ownerMismatch(field: String, expected: FamilyMember, actual: String?)
    case unexpectedResponse(path: String)

    var errorDescription: String? {
        switch self {
        case let .fractionalMinorUnit(field):
            "\(field) has precision smaller than one cent and cannot be written exactly."
        case let .minorUnitOverflow(field):
            "\(field) does not fit in the Convex Int64 money contract."
        case let .ownerMismatch(field, expected, actual):
            "\(field) owner '\(actual ?? "missing")' does not match \(expected.rawValue)."
        case let .unexpectedResponse(path):
            "\(path) returned an unexpected response."
        }
    }
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
    /// Optional transport edge for deterministic request-boundary tests. The
    /// default remains URLSession for every production call site.
    typealias RequestExecutor = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let deploymentURL: URL
    private let session: URLSession
    private let requestExecutor: RequestExecutor?
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "Convex")

    init(
        deploymentURL: URL,
        session: URLSession? = nil,
        requestExecutor: RequestExecutor? = nil,
    ) {
        self.deploymentURL = deploymentURL
        self.requestExecutor = requestExecutor
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 30
            config.timeoutIntervalForResource = 60
            self.session = URLSession(configuration: config)
        }
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

    /// Execute one member of the closed public row-query catalogue.
    func fetchRows<T: Decodable>(_ request: ConvexRowQuery, as type: T.Type) async throws -> T {
        let raw = try await query(request.path, args: request.arguments)
        guard JSONSerialization.isValidJSONObject(raw) else {
            throw ConvexError.decodeFailed(
                request.path,
                NSError(
                    domain: "ConvexRows",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Response is not valid JSON."],
                ),
            )
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: raw)
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw ConvexError.decodeFailed(request.path, error)
        }
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

    /// Insert or replace one transaction row. The source file is the ownership
    /// boundary: adult rows stay canonical to Victor while child rows remain
    /// isolated in their own files.
    func upsertTransactionRow(
        _ transaction: LegacyTransactionDTO,
        sourceFile: String = "transactions",
    ) async throws {
        let amountCents = try Self.exactMinorUnits(transaction.amount, field: "transaction.amount")
        let kind = transaction.category == "Income" || amountCents < 0 ? "credit" : "spend"
        var row: [String: Any] = [
            "id": transaction.id,
            "date": transaction.date,
            "merchant": transaction.merchant,
            "amountCents": ConvexTaggedInt64Encoder.encode(amountCents),
            "kind": kind,
            "category": transaction.category,
        ]
        if let card = transaction.card { row["card"] = card }
        if let note = transaction.note { row["note"] = note }

        let path = "tables:upsertTransaction"
        let raw = try await mutation(path, args: [
            "sourceFile": sourceFile,
            "transaction": row,
        ])
        guard let result = raw as? [String: Any],
              result["txId"] as? String == transaction.id
        else {
            throw ConvexRowMutationError.unexpectedResponse(path: path)
        }
    }

    /// Delete one transaction row without reading or rewriting its neighbours.
    func deleteTransactionRow(id: String, sourceFile: String = "transactions") async throws {
        let path = "tables:deleteTransaction"
        let raw = try await mutation(path, args: [
            "txId": id,
            "sourceFile": sourceFile,
        ])
        guard let result = raw as? [String: Any],
              result["txId"] as? String == id,
              result["removed"] is Bool
        else {
            throw ConvexRowMutationError.unexpectedResponse(path: path)
        }
    }

    /// Insert or replace one Bitcoin purchase row using exact cents and sats.
    func upsertBTCBuyRow(
        _ buy: LegacyBTCBuyDTO,
        owner: FamilyMember,
        sourceFile: String = "bitcoin-buys",
    ) async throws {
        guard buy.owner == owner.rawValue else {
            throw ConvexRowMutationError.ownerMismatch(
                field: "btcBuy",
                expected: owner,
                actual: buy.owner,
            )
        }
        let priceUsdCents = try Self.exactMinorUnits(buy.priceUsd, field: "btcBuy.priceUsd")
        let usdCents = try Self.exactMinorUnits(buy.usd, field: "btcBuy.usd")
        var row: [String: Any] = [
            "id": buy.id,
            "date": buy.date,
            "source": buy.source,
            "sats": ConvexTaggedInt64Encoder.encode(buy.amountSats),
            "priceUsdCents": ConvexTaggedInt64Encoder.encode(priceUsdCents),
            "usdCents": ConvexTaggedInt64Encoder.encode(usdCents),
        ]
        if let note = buy.note { row["note"] = note }
        if let status = buy.status { row["status"] = status }
        if let costBasisStatus = buy.costBasisStatus { row["costBasisStatus"] = costBasisStatus }
        if let loggedBy = buy.loggedBy { row["loggedBy"] = loggedBy }
        if let requestID = buy.archimedesRequestId { row["archimedesRequestId"] = requestID }
        // Adult blob rows are canonical to Victor and resolved from sourceFile.
        // Children must carry their own owner even when no dedicated legacy buy
        // file exists (Maddox), or their balance would enter the adult ledger.
        if !owner.isAdult { row["owner"] = owner.rawValue }

        let path = "tables:upsertBtcBuy"
        let raw = try await mutation(path, args: [
            "sourceFile": sourceFile,
            "buy": row,
        ])
        guard let result = raw as? [String: Any],
              result["buyId"] as? String == buy.id
        else {
            throw ConvexRowMutationError.unexpectedResponse(path: path)
        }
    }

    /// Upsert one app-created or app-edited todo row.
    func upsertTodoRow(_ todo: LegacyTodoDTO) async throws {
        let path = "tables:upsertTodo"
        let raw = try await mutation(path, args: [
            "todo": todo.convexJSONObject(),
        ])
        guard let result = raw as? [String: Any],
              result["todoId"] as? String == todo.id
        else {
            throw ConvexRowMutationError.unexpectedResponse(path: path)
        }
    }

    /// Delete one todo row. A missing row is still a successful idempotent delete.
    func deleteTodoRow(id: String) async throws {
        let path = "tables:deleteTodo"
        let raw = try await mutation(path, args: [
            "todoId": id,
        ])
        guard let result = raw as? [String: Any],
              result["todoId"] as? String == id,
              result["removed"] is Bool
        else {
            throw ConvexRowMutationError.unexpectedResponse(path: path)
        }
    }

    /// Update one category in the viewer's current row-backed budget document.
    /// The read supplies the server's exact month guard; guessing the current
    /// month locally could edit the wrong document around a rollover.
    func upsertBudgetCategoryRow(
        name: String,
        icon: String,
        budget: Decimal,
        viewer: FamilyMember,
    ) async throws {
        let envelope = try await fetchRows(
            .budget(viewer: viewer),
            as: ConvexBudgetDocumentEnvelope.self,
        )
        let document = try envelope.completeDocument()
        let budgetCents = try Self.exactMinorUnits(budget, field: "budgetCategory.budget")
        let path = "tables:upsertBudgetCategory"
        let raw = try await mutation(path, args: [
            "viewer": viewer.rawValue,
            "month": document.month,
            "category": [
                "name": name,
                "icon": icon,
                "budgetCents": ConvexTaggedInt64Encoder.encode(budgetCents),
            ],
        ])
        guard let result = raw as? [String: Any],
              result["name"] as? String == name,
              result["month"] as? String == document.month
        else {
            throw ConvexRowMutationError.unexpectedResponse(path: path)
        }
    }

    // MARK: - Internal

    static func exactMinorUnits(_ value: Decimal, field: String) throws -> Int64 {
        var scaled = value * 100
        var integral = Decimal()
        NSDecimalRound(&integral, &scaled, 0, .plain)
        guard scaled == integral else {
            throw ConvexRowMutationError.fractionalMinorUnit(field: field)
        }

        let number = NSDecimalNumber(decimal: integral)
        guard number != NSDecimalNumber.notANumber,
              number.compare(NSDecimalNumber(string: String(Int64.min))) != .orderedAscending,
              number.compare(NSDecimalNumber(string: String(Int64.max))) != .orderedDescending
        else {
            throw ConvexRowMutationError.minorUnitOverflow(field: field)
        }
        return number.int64Value
    }

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

        // Attached centrally so every read and write path is covered; a new call
        // site cannot forget its token.
        let finalArgs = Self.authenticatedArguments(
            endpoint: endpoint,
            args: args,
            syncToken: ConvexConfig.syncToken,
            readToken: ConvexConfig.readToken,
        )

        let body: [String: Any] = [
            "path": path,
            "args": finalArgs,
            "format": "convex_encoded_json",
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let result: (Data, URLResponse)
        if let requestExecutor {
            result = try await requestExecutor(request)
        } else {
            result = try await session.data(for: request)
        }
        let (data, response) = result

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
            let diagnostic = json?["errorData"] as? String ?? msg
            log.error("Convex call failed for \(path, privacy: .public)")
            if path.hasPrefix("tables:"), Self.isMissingRowAPIDiagnostic(diagnostic) {
                // `errorData` can contain server-side values. It is used only
                // for classification and is never stored, logged or surfaced.
                throw ConvexError.rowAPIUnavailable(path: path)
            }
            if diagnostic.localizedCaseInsensitiveContains("unauthorized") {
                throw ConvexError.unauthorized(path: path)
            }
            throw ConvexError.serverError(path: path)
        }

        guard let value = json?["value"] else {
            throw ConvexError.noData(path)
        }

        // Convex returns NSNull for null values
        if value is NSNull {
            throw ConvexError.noData(path)
        }

        do {
            return try ConvexTaggedInt64Decoder.decode(value)
        } catch {
            throw ConvexError.decodeFailed(path, error)
        }
    }

    /// Pure request-boundary helper kept visible to tests so every row request
    /// can prove it uses the same enforced read credential as legacy reads.
    static func authenticatedArguments(
        endpoint: String,
        args: [String: Any],
        syncToken: String,
        readToken: String,
    ) -> [String: Any] {
        var finalArgs = args
        let token: String?
        switch endpoint {
        case "api/mutation":
            token = syncToken
        case "api/query":
            token = readToken
        default:
            token = nil
        }
        if let token, !token.isEmpty {
            finalArgs["token"] = token
        }
        return finalArgs
    }

    static func isMissingRowAPIDiagnostic(_ diagnostic: String) -> Bool {
        let normalized = diagnostic.lowercased()
        let missingFunction =
            normalized.contains("could not find public function")
                || normalized.contains("public function not found")
                || normalized.contains("no public function")
        let missingTable =
            normalized.contains("table")
                && (normalized.contains("does not exist")
                    || normalized.contains("not found")
                    || normalized.contains("unknown table"))
        return missingFunction || missingTable
    }
}
