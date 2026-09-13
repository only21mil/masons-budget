// The Vogel Vault — Convex HTTP Client
// Communicates with the Convex backend to fetch and sync financial data.

import CryptoKit
import Foundation
import os
import Security

/// Configuration for the Convex deployment.
enum ConvexConfig {
    private static let rowReadsEnabledKey = "convex_row_reads_enabled"
    private static let writesEnabledKey = "convex_writes_enabled"
    private static let readTokenKey = "convex_read_token"
    private static let syncTokenKey = "convex_sync_token"
    private static var readTokenStore: MigratingKeychainTokenStore {
        makeReadTokenStore(
            userDefaults: .standard,
            keychain: ProtectedCredentialStore.make(
                service: "com.sats21m.vogel-vault.convex",
                account: "read-token",
            ),
        )
    }
    private static var syncTokenStore: MigratingKeychainTokenStore {
        MigratingKeychainTokenStore(
            userDefaults: .standard,
            legacyKey: syncTokenKey,
            keychain: ProtectedCredentialStore.make(
                service: "com.sats21m.vogel-vault.convex",
                account: "sync-token",
            ),
        )
    }

    /// Injection seam for testing the production read-token migration wiring.
    static func makeReadTokenStore(
        userDefaults: UserDefaults,
        keychain: CredentialStoring,
    ) -> MigratingKeychainTokenStore {
        MigratingKeychainTokenStore(
            userDefaults: userDefaults,
            legacyKey: readTokenKey,
            keychain: keychain,
        )
    }

    /// The audited production deployment. A mutable preference here allowed a
    /// local setting or stale migration value to redirect authenticated traffic.
    static var deploymentURL: URL {
        URL(string: "https://keen-elephant-452.convex.cloud")!
    }

    // Resolving a token performs Security-framework I/O (and the Wave-1
    // migration side effect) on every read of the migrating store. Memoize the
    // resolved values and invalidate on explicit set/remove so the per-request
    // `call()` no longer hits the Keychain twice per HTTP round trip, and so
    // presence checks stay cheap. The empty token is cached too: an
    // unconfigured build must not re-probe the Keychain on every request.
    private static let tokenCacheLock = NSLock()
    private static var cachedSyncToken: String?
    private static var cachedReadToken: String?

    /// Optional sync token for an authorized write path. NEVER hardcode a shared secret here
    /// (see AGENTS.md). Stored in the Keychain after runtime injection; empty by default so
    /// native writes stay fail-closed (the server rejects an empty/invalid token).
    ///
    /// The first read also attempts to migrate the Wave 1 UserDefaults value, if
    /// present. A failed Keychain write discards that cleartext value and leaves writes
    /// unauthorized instead of authenticating from insecure storage.
    static var syncToken: String {
        tokenCacheLock.lock()
        defer { tokenCacheLock.unlock() }
        if let cached = cachedSyncToken { return cached }
        let resolved = syncTokenStore.token
        cachedSyncToken = resolved
        return resolved
    }

    /// Presence-only view for UI status. UI callers must not retain or render the credential.
    static var hasSyncToken: Bool {
        !syncToken.isEmpty
    }

    @discardableResult
    static func setSyncToken(_ token: String) -> Bool {
        tokenCacheLock.lock()
        cachedSyncToken = nil
        tokenCacheLock.unlock()
        return syncTokenStore.set(token)
    }

    @discardableResult
    static func removeSyncToken() -> Bool {
        tokenCacheLock.lock()
        cachedSyncToken = nil
        tokenCacheLock.unlock()
        return syncTokenStore.remove()
    }

    /// Optional read token.
    ///
    /// Reads were unauthenticated until 2026-07-26 — the deployment URL alone was
    /// enough to pull the household's entire financial history. The server is now
    /// fail-closed on reads too.
    ///
    /// Same rules as `syncToken`: never hardcode it, never bundle it in the app,
    /// never commit it. Stored in the device-only Keychain after runtime injection
    /// and empty by default, so an unconfigured build fails closed.
    ///
    /// Reading this property attempts to migrate the legacy UserDefaults value. A failed
    /// Keychain write discards that cleartext value and leaves reads unauthenticated
    /// instead of authenticating from insecure storage. Resolution is memoized;
    /// see the cache note above `syncToken`.
    static var readToken: String {
        tokenCacheLock.lock()
        defer { tokenCacheLock.unlock() }
        if let cached = cachedReadToken { return cached }
        let resolved = readTokenStore.token
        cachedReadToken = resolved
        return resolved
    }

    /// Presence-only view for UI status. UI callers must not retain or render the credential.
    static var hasReadToken: Bool {
        !readToken.isEmpty
    }

    @discardableResult
    static func setReadToken(_ token: String) -> Bool {
        tokenCacheLock.lock()
        cachedReadToken = nil
        tokenCacheLock.unlock()
        return readTokenStore.set(token)
    }

    @discardableResult
    static func removeReadToken() -> Bool {
        tokenCacheLock.lock()
        cachedReadToken = nil
        tokenCacheLock.unlock()
        return readTokenStore.remove()
    }

    /// Runtime kill switch for the public row API. Row reads are now the
    /// authoritative default; an explicit false retains the emergency blob
    /// fallback without making old installs silently stay on stale blobs.
    static var rowReadsEnabled: Bool {
        rowReadsEnabled(in: .standard)
    }

    static func rowReadsEnabled(in defaults: UserDefaults) -> Bool {
        defaults.object(forKey: rowReadsEnabledKey) as? Bool ?? true
    }

    static func setRowReadsEnabled(_ enabled: Bool, in defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: rowReadsEnabledKey)
    }

    /// Runtime kill switch for every app-originated write.
    ///
    /// Android has one and its `ConvexResult.Disabled` depends on it; without a
    /// write switch here that state would be unreachable on Apple and the two
    /// clients would disagree about the cause set. Absent key means enabled.
    static var writesEnabled: Bool {
        UserDefaults.standard.object(forKey: writesEnabledKey) as? Bool ?? true
    }

    static func setWritesEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: writesEnabledKey)
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
            // Never authenticate from UserDefaults. If secure migration fails,
            // discard the cleartext credential and fail closed; the write path
            // reports `.unauthorized` and Sync Setup shows the missing credential.
            userDefaults.removeObject(forKey: legacyKey)
            return ""
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
        // Clearing a text field is not authorization to destroy the credential.
        // Callers must use the explicit remove action for that state change.
        guard !trimmed.isEmpty else { return false }
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

/// Migrates the macOS file Keychain item onto the Data Protection Keychain.
///
/// The primary value is always read first. A legacy value remains usable while
/// migration is attempted, and is deleted only after the primary store returns
/// the exact value that was written. That ordering prevents a transient
/// Security-framework failure from destroying the only credential.
struct MigratingCredentialStore: CredentialStoring {
    let primary: any CredentialStoring
    let legacy: any CredentialStoring

    func read() -> String? {
        if let primaryToken = normalized(primary.read()) {
            _ = legacy.clear()
            return primaryToken
        }

        guard let legacyToken = normalized(legacy.read()) else { return nil }
        if primary.save(legacyToken),
           normalized(primary.read()) == legacyToken
        {
            _ = legacy.clear()
        }
        return legacyToken
    }

    @discardableResult
    func save(_ token: String) -> Bool {
        guard let normalizedToken = normalized(token),
              primary.save(normalizedToken),
              normalized(primary.read()) == normalizedToken
        else { return false }
        _ = legacy.clear()
        return true
    }

    @discardableResult
    func clear() -> Bool {
        let primaryCleared = primary.clear()
        let legacyCleared = legacy.clear()
        return primaryCleared && legacyCleared
    }

    private func normalized(_ token: String?) -> String? {
        guard let trimmed = token?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else { return nil }
        return trimmed
    }
}

struct KeychainCredentialStore {
    let service: String
    let account: String
    let usesDataProtectionKeychain: Bool

    init(
        service: String,
        account: String,
        usesDataProtectionKeychain: Bool = true
    ) {
        self.service = service
        self.account = account
        self.usesDataProtectionKeychain = usesDataProtectionKeychain
    }

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
        guard let attributes = writeAttributes(for: token) else {
            return clear()
        }

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

    func writeAttributes(for token: String) -> [String: Any]? {
        guard let data = token.data(using: .utf8), !token.isEmpty else { return nil }
        return [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
    }

    @discardableResult
    func clear() -> Bool {
        let status = SecItemDelete(baseQuery as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    /// The exact query used by every Security-framework operation. Internal
    /// visibility lets the unit test guard the macOS data-protection opt-in
    /// without replacing the production SecItem path with a test-only helper.
    var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if usesDataProtectionKeychain {
            query[kSecUseDataProtectionKeychain as String] = true
        }
        return query
    }
}

enum ProtectedCredentialStore {
    static func make(service: String, account: String) -> any CredentialStoring {
        let primary = KeychainCredentialStore(service: service, account: account)
#if os(macOS)
        // Omitting kSecUseDataProtectionKeychain addresses the legacy file
        // Keychain on macOS. This branch is not compiled on iOS.
        let legacy = KeychainCredentialStore(
            service: service,
            account: account,
            usesDataProtectionKeychain: false,
        )
        return MigratingCredentialStore(primary: primary, legacy: legacy)
#else
        return primary
#endif
    }
}

enum AppWritebackConfig {
    // Preserve deployed storage keys so existing paired devices keep working.
    private static let baseURLKey = "mc2_mobile_base_url"
    private static let deviceIDKey = "mc2_mobile_device_id"
    private static let deviceTokenKey = "mc2_mobile_device_token"
    private static let deviceProfileKey = "vogel_vault_mobile_device_profile"
    private static let deviceCapabilitiesKey = "vogel_vault_mobile_device_capabilities"

    static var activeProfile: FamilyMember {
        let raw = UserDefaults.standard.string(forKey: ConvexSyncService.selectedMemberKey)
        return raw.flatMap(FamilyMember.init(rawValue:)) ?? .victor
    }

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

    // Memoized like ConvexConfig's tokens: every read performed Keychain I/O
    // plus the legacy-migration probe, and task writes resolve this per write.
    // `save`/`clear` are the only mutation points and invalidate the cache.
    private static let deviceTokenCacheLock = NSLock()
    private static var cachedDeviceToken: String?

    static var deviceToken: String {
        deviceTokenCacheLock.lock()
        defer { deviceTokenCacheLock.unlock() }
        if let cached = cachedDeviceToken { return cached }
        var resolved = ""
        if let token = AppWritebackDeviceTokenStore.store.read(), !token.isEmpty {
            resolved = token
        } else {
            let legacyToken = UserDefaults.standard.string(forKey: deviceTokenKey)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !legacyToken.isEmpty {
                guard AppWritebackDeviceTokenStore.store.save(legacyToken) else {
                    return ""
                }
                // The protected store verifies its own read before returning true.
                UserDefaults.standard.removeObject(forKey: deviceTokenKey)
            }
            resolved = legacyToken
        }
        cachedDeviceToken = resolved
        return resolved
    }

    /// Presence-only view of the credential for UI status. Callers that do not
    /// need to authenticate must not retain or render `deviceToken`.
    static var hasDeviceToken: Bool {
        !deviceToken.isEmpty
    }

    static var boundProfile: FamilyMember? {
        UserDefaults.standard.string(forKey: deviceProfileKey)
            .flatMap(FamilyMember.init(rawValue:))
    }

    /// A pre-cutover credential can be present but has no profile binding. Keep
    /// that state distinct so task writes report PROFILE_BINDING_REQUIRED and do
    /// not silently claim or use a different credential. This local value is a
    /// consistency check only; the server-stored credential profile is authority.
    static var hasStoredCredential: Bool {
        baseURL != nil && !deviceID.isEmpty && hasDeviceToken
    }

    static var isConfigured: Bool {
        hasStoredCredential
    }

    static var grantedCapabilities: [String]? { UserDefaults.standard.stringArray(forKey: deviceCapabilitiesKey) }

    static func allows(_ capability: String, granted: [String]?) -> Bool {
        // Older installs did not retain the receipt. The server remains the
        // authority for those devices; an unknown receipt permits a checked request.
        granted?.contains(capability) ?? true
    }

    static var canWriteTasks: Bool {
        isConfigured && boundProfile == activeProfile && allows("todos:write", granted: grantedCapabilities)
    }

    static var canWriteLedger: Bool {
        isConfigured && boundProfile?.sharesNetWorth(with: activeProfile) == true
    }

    static var canWriteBitcoin: Bool {
        canWriteLedger && allows("bitcoin:write", granted: grantedCapabilities)
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

    @discardableResult
    static func save(
        baseURL: String,
        deviceID: String,
        deviceToken: String,
        profile: FamilyMember = activeProfile,
        capabilities: [String]? = nil,
        credentialStore: any CredentialStoring = AppWritebackDeviceTokenStore.store,
    ) -> Bool {
        let trimmedBaseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedDeviceID = deviceID.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedDeviceToken = deviceToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBaseURL.isEmpty, !trimmedDeviceID.isEmpty, !trimmedDeviceToken.isEmpty else {
            return false
        }
        guard credentialStore.save(trimmedDeviceToken) else { return false }
        UserDefaults.standard.set(trimmedBaseURL, forKey: baseURLKey)
        UserDefaults.standard.set(trimmedDeviceID, forKey: deviceIDKey)
        UserDefaults.standard.set(profile.rawValue, forKey: deviceProfileKey)
        if let capabilities { UserDefaults.standard.set(capabilities, forKey: deviceCapabilitiesKey) }
        else { UserDefaults.standard.removeObject(forKey: deviceCapabilitiesKey) }
        UserDefaults.standard.removeObject(forKey: deviceTokenKey)
        deviceTokenCacheLock.lock()
        cachedDeviceToken = nil
        deviceTokenCacheLock.unlock()
        return true
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: baseURLKey)
        UserDefaults.standard.removeObject(forKey: deviceIDKey)
        UserDefaults.standard.removeObject(forKey: deviceTokenKey)
        UserDefaults.standard.removeObject(forKey: deviceProfileKey)
        UserDefaults.standard.removeObject(forKey: deviceCapabilitiesKey)
        AppWritebackDeviceTokenStore.store.clear()
        deviceTokenCacheLock.lock()
        cachedDeviceToken = nil
        deviceTokenCacheLock.unlock()
    }
}

enum AppWritebackDeviceTokenStore {
    // Preserve the deployed Keychain service as a credential migration boundary.
    private static let service = "com.sats21m.vogel-vault.mc2-mobile"
    private static let account = "device-token"

    static var dataProtectionStore: KeychainCredentialStore {
        KeychainCredentialStore(service: service, account: account)
    }

    static var store: any CredentialStoring {
        ProtectedCredentialStore.make(service: service, account: account)
    }
}

enum AppWritebackError: LocalizedError {
    case notConfigured
    case invalidBaseURL
    case invalidPairingURL
    case httpError(Int)
    case serverError
    case credentialStorageFailed
    case unexpectedResponse
    case remote(AppWritebackRemoteErrorCode)

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
        case .serverError:
            "The writeback endpoint rejected the request."
        case .credentialStorageFailed:
            "The device credential could not be stored securely."
        case .unexpectedResponse:
            "The writeback endpoint returned an unexpected response."
        case let .remote(code):
            "The writeback endpoint rejected the request with \(code.rawValue)."
        }
    }
}

enum AppWritebackRemoteErrorCode: String, Sendable, Equatable {
    case profileBindingRequired = "PROFILE_BINDING_REQUIRED"
    case revisionRequired = "REVISION_REQUIRED"
    case entityConflict = "ENTITY_CONFLICT"
    case entityDeleted = "ENTITY_DELETED"
    case entityNotFound = "ENTITY_NOT_FOUND"
    case ownerMismatch = "OWNER_MISMATCH"
    case ownerSourceMismatch = "OWNER_SOURCE_MISMATCH"
    case deviceUnauthorized = "DEVICE_UNAUTHORIZED"
    case validationFailed = "VALIDATION_FAILED"
}

enum TodoDeviceWriteOperation: String, Sendable, Equatable {
    case create
    case update
}

/// Strict task payload for `tables:upsertTodoFromDevice`. The legacy blob DTO
/// contains compatibility aliases that the row mutation deliberately rejects.
struct TodoDeviceWritePayload: Sendable, Equatable {
    let id: String
    let owner: FamilyMember
    let title: String
    let done: Bool
    let flagged: Bool
    let project: String?
    let area: String?
    let due: String?
    let notes: String?
    let priority: Int?
    let createdAt: String?
    let updatedAt: String?
    let completedAt: String?

    init(_ todo: LegacyTodoDTO) throws {
        guard let owner = todo.effectiveOwner else {
            throw AppWritebackError.remote(.ownerMismatch)
        }
        id = todo.id
        self.owner = owner
        title = todo.effectiveTitle
        done = todo.effectiveDone
        flagged = todo.effectiveFlagged
        project = todo.project
        area = todo.area
        due = todo.effectiveDueDate
        notes = todo.text
        priority = todo.priority
        createdAt = todo.createdAt
        updatedAt = todo.updatedAt
        completedAt = todo.completedAt
    }

    func convexJSONObject() -> [String: Any] {
        var object: [String: Any] = [
            "id": id,
            "owner": owner.rawValue,
            "title": title,
            "done": done,
            "flagged": flagged,
        ]
        if let project { object["project"] = project }
        if let area { object["area"] = area }
        if let due { object["due"] = due }
        if let notes { object["notes"] = notes }
        if let priority { object["priority"] = ConvexTaggedInt64Encoder.encode(Int64(priority)) }
        if let createdAt { object["createdAt"] = createdAt }
        if let updatedAt { object["updatedAt"] = updatedAt }
        if let completedAt { object["completedAt"] = completedAt }
        return object
    }
}

struct BitcoinAccountDocument: Decodable, Sendable {
    struct Account: Decodable, Sendable {
        let key: String
        let label: String
        let custody: BTCCustody
        let sats: Int64
    }
    let owner: FamilyMember
    let asOf: String
    let updatedAtMs: Double
    let accounts: [Account]
}

struct BitcoinDeviceEntry: Decodable, Identifiable, Sendable {
    let buyId: String?
    let transferId: String?
    let key: String?
    let owner: FamilyMember
    let date: String?
    let label: String?
    let source: String?
    let custody: BTCCustody?
    let asOf: String?
    let fromAccountKey: String?
    let toAccountKey: String?
    let sats: Int64
    let updatedAtMs: Double

    var id: String { buyId ?? transferId ?? key ?? "" }
    var title: String { label ?? source ?? "\(fromAccountKey ?? "") → \(toAccountKey ?? "")" }
}

final class AppWritebackClient: Sendable {
    static let todoUpsertPath = "tables:upsertTodoFromDevice"
    static let todoDeletePath = "tables:deleteTodoFromDevice"
    static let todoRestorePath = "tables:restoreTodoFromDevice"

    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func bitcoinAccountDocument(profile: FamilyMember) async throws -> BitcoinAccountDocument? {
        let device = try await ledgerSession(activeProfile: profile)
        let value = try await convexMutation(baseURL: device.baseURL, path: "tables:listBtcBalanceDocuments", args: [
            "deviceId": device.deviceID, "deviceToken": device.deviceToken,
            "viewer": (AppWritebackConfig.boundProfile ?? profile).rawValue, "scope": "netWorth",
        ], endpointKind: "query")
        let data = try JSONSerialization.data(withJSONObject: ConvexTaggedInt64Decoder.decode(value))
        let rows = try JSONDecoder().decode(ConvexRowEnvelope<BitcoinAccountDocument>.self, from: data).completeRows()
        guard rows.count <= 1, rows.allSatisfy({ profile.sharesNetWorth(with: $0.owner) }) else {
            throw AppWritebackError.remote(.ownerMismatch)
        }
        return rows.first
    }

    func bitcoinEntries(kind: String, profile: FamilyMember) async throws -> [BitcoinDeviceEntry] {
        if kind == "BtcAccount" {
            guard let document = try await bitcoinAccountDocument(profile: profile) else { return [] }
            return document.accounts.map {
                BitcoinDeviceEntry(buyId: nil, transferId: nil, key: $0.key, owner: document.owner,
                                   date: nil, label: $0.label, source: nil, custody: $0.custody, asOf: document.asOf,
                                   fromAccountKey: nil, toAccountKey: nil, sats: $0.sats, updatedAtMs: document.updatedAtMs)
            }
        }
        let path: String
        switch kind {
        case "BtcBuy": path = "tables:listBtcBuys"
        case "BtcTransfer": path = "tables:listBtcTransfers"
        case "BtcAccount": path = "tables:listBtcAccounts"
        default: throw AppWritebackError.unexpectedResponse
        }
        let device = try await ledgerSession(activeProfile: profile)
        let value = try await convexMutation(baseURL: device.baseURL, path: path, args: [
            "deviceId": device.deviceID, "deviceToken": device.deviceToken,
            "viewer": (AppWritebackConfig.boundProfile ?? profile).rawValue, "scope": "netWorth",
        ], endpointKind: "query")
        let decoded = try ConvexTaggedInt64Decoder.decode(value)
        let data = try JSONSerialization.data(withJSONObject: decoded)
        let envelope = try JSONDecoder().decode(ConvexRowEnvelope<BitcoinDeviceEntry>.self, from: data)
        let rows = try envelope.completeRows()
        guard rows.allSatisfy({ profile.sharesNetWorth(with: $0.owner) && !$0.id.isEmpty }) else {
            throw AppWritebackError.remote(.ownerMismatch)
        }
        return rows
    }

    /// Money routes share the same profile-bound device session as tasks.
    /// The owner stays canonical to Victor for the adult household.
    func writeLedger(
        path: String,
        owner: FamilyMember,
        entityID: String,
        arguments: [String: Any],
        deleting: Bool = false,
    ) async throws {
        let capability: String
        if path.contains("Btc") { capability = "bitcoin:write" }
        else if path.contains("Budget") { capability = "budget:write" }
        else { capability = "transactions:write" }
        guard AppWritebackConfig.allows(capability, granted: AppWritebackConfig.grantedCapabilities) else {
            throw AppWritebackError.remote(.deviceUnauthorized)
        }
        let activeProfile = AppWritebackConfig.activeProfile
        let device = try await ledgerSession(activeProfile: activeProfile)
        let args = try Self.ledgerArguments(
            owner: owner, activeProfile: activeProfile, arguments: arguments,
            deviceID: device.deviceID, deviceToken: device.deviceToken,
        )
        let value = try await convexMutation(baseURL: device.baseURL, path: path, args: args)
        try Self.validateLedgerResponse(value, entityID: entityID, deleting: deleting)
    }

    static func ledgerArguments(
        owner: FamilyMember,
        activeProfile: FamilyMember,
        arguments: [String: Any],
        deviceID: String,
        deviceToken: String,
    ) throws -> [String: Any] {
        guard activeProfile.sharesNetWorth(with: owner) else {
            throw AppWritebackError.remote(.ownerMismatch)
        }
        var args = arguments
        args.removeValue(forKey: "token")
        args["owner"] = owner.ledgerOwner.rawValue
        args["deviceId"] = deviceID
        args["deviceToken"] = deviceToken
        return args
    }

    static func validateLedgerResponse(_ value: Any, entityID: String, deleting: Bool) throws {
        guard let result = value as? [String: Any], result["ok"] as? Bool == true,
              result["entityId"] as? String == entityID else {
            throw AppWritebackError.unexpectedResponse
        }
        if deleting {
            guard result["removed"] is Bool else { throw AppWritebackError.unexpectedResponse }
        } else {
            guard let outcome = result["outcome"] as? String,
                  ["inserted", "updated"].contains(outcome) else {
                throw AppWritebackError.unexpectedResponse
            }
        }
    }

    func claimPairing(
        pairingURL rawURL: String,
        deviceName: String,
        profile: FamilyMember = AppWritebackConfig.activeProfile,
    ) async throws {
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
            try await claimConvexPairing(
                baseURL: baseURL,
                pair: pair,
                deviceName: deviceName,
                profile: profile,
            )
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
            throw AppWritebackError.serverError
        }
        guard let deviceID = object?["deviceId"] as? String,
              let deviceToken = object?["deviceToken"] as? String
        else {
            throw AppWritebackError.unexpectedResponse
        }

        guard AppWritebackConfig.save(
            baseURL: baseURL.absoluteString,
            deviceID: deviceID,
            deviceToken: deviceToken,
            profile: profile,
        ) else { throw AppWritebackError.credentialStorageFailed }
    }

    func claimBundledPairing(
        deviceName: String,
        profile: FamilyMember = AppWritebackConfig.activeProfile,
    ) async throws {
        if AppWritebackConfig.isConfigured { return }

        let urls = AppWritebackConfig.bundledPairingURLs
        guard !urls.isEmpty else {
            throw AppWritebackError.serverError
        }

        var lastError: Error?
        for url in urls {
            do {
                try await claimPairing(pairingURL: url, deviceName: deviceName, profile: profile)
                return
            } catch {
                lastError = error
            }
        }

        throw lastError ?? AppWritebackError.invalidPairingURL
    }

    @discardableResult
    func removeTodo(
        id: String,
        activeProfile: FamilyMember,
        owner: FamilyMember,
        baseUpdatedAtMs: Double?,
    ) async throws -> Bool {
        let taskSession = try await taskSession(activeProfile: activeProfile)
        let args = try Self.todoDeleteArguments(
            id: id,
            activeProfile: activeProfile,
            owner: owner,
            baseUpdatedAtMs: baseUpdatedAtMs,
            deviceID: taskSession.deviceID,
            deviceToken: taskSession.deviceToken,
        )
        let value = try await convexMutation(
            baseURL: taskSession.baseURL,
            path: Self.todoDeletePath,
            args: args,
        )
        guard let object = value as? [String: Any],
              object["ok"] as? Bool == true,
              object["entityId"] as? String == id,
              let removed = object["removed"] as? Bool
        else { throw AppWritebackError.unexpectedResponse }
        return removed
    }

    @discardableResult
    func upsertTodo(
        _ todo: LegacyTodoDTO,
        activeProfile: FamilyMember,
        operation: TodoDeviceWriteOperation,
        baseUpdatedAtMs: Double?,
    ) async throws -> Bool {
        let taskSession = try await taskSession(activeProfile: activeProfile)
        let args = try Self.todoUpsertArguments(
            try TodoDeviceWritePayload(todo),
            activeProfile: activeProfile,
            operation: operation,
            baseUpdatedAtMs: baseUpdatedAtMs,
            deviceID: taskSession.deviceID,
            deviceToken: taskSession.deviceToken,
        )
        let value = try await convexMutation(
            baseURL: taskSession.baseURL,
            path: Self.todoUpsertPath,
            args: args,
        )
        guard let object = value as? [String: Any],
              object["ok"] as? Bool == true,
              object["entityId"] as? String == todo.id,
              object["outcome"] as? String == (operation == .create ? "inserted" : "updated")
        else { throw AppWritebackError.unexpectedResponse }
        return true
    }

    /// Fetches the exact canonical revision after an accepted create or update.
    /// The device mutation response deliberately contains only its outcome, so
    /// callers must not derive authority from the optimistic `updatedAt` value.
    func todoRevision(
        id: String,
        activeProfile: FamilyMember,
    ) async throws -> Double {
        let taskSession = try await taskSession(activeProfile: activeProfile)
        let reader = ConvexRowReader(client: ConvexClient(
            deploymentURL: taskSession.baseURL,
            session: session,
        ))
        let matches = try await reader.todos(viewer: activeProfile).filter { todo in
            todo.id == id && todo.effectiveOwner == activeProfile
        }
        guard matches.count == 1,
              let revision = matches[0].updatedAtMs,
              Self.isValidTaskRevision(revision)
        else { throw AppWritebackError.unexpectedResponse }
        return revision
    }

    func restoreTodo(
        id: String,
        activeProfile: FamilyMember,
        owner: FamilyMember,
        baseUpdatedAtMs: Double?,
    ) async throws -> Double {
        let taskSession = try await taskSession(activeProfile: activeProfile)
        let args = try Self.todoRestoreArguments(
            id: id,
            activeProfile: activeProfile,
            owner: owner,
            baseUpdatedAtMs: baseUpdatedAtMs,
            deviceID: taskSession.deviceID,
            deviceToken: taskSession.deviceToken,
        )
        let value = try await convexMutation(
            baseURL: taskSession.baseURL,
            path: Self.todoRestorePath,
            args: args,
        )
        guard let object = value as? [String: Any],
              object["ok"] as? Bool == true,
              object["entityId"] as? String == id,
              let revision = object["updatedAtMs"] as? Double,
              Self.isValidTaskRevision(revision)
        else { throw AppWritebackError.unexpectedResponse }
        return revision
    }

    @discardableResult
    func deleteBudgetCategory(_ intent: BudgetCategoryDeletionIntent) async throws -> Bool {
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
            throw AppWritebackError.serverError
        }

        let value = try await convexMutation(
            baseURL: baseURL,
            path: "tables:deleteBudgetCategoryFromDevice",
            args: Self.budgetCategoryDeletionArguments(
                intent,
                deviceID: AppWritebackConfig.deviceID,
                deviceToken: AppWritebackConfig.deviceToken,
            ),
        )
        guard let object = value as? [String: Any],
              object["ok"] as? Bool == true,
              object["entityId"] as? String == intent.categoryName,
              let removed = object["removed"] as? Bool
        else {
            throw AppWritebackError.unexpectedResponse
        }
        return removed
    }

    func copyBudgetPlanForward(
        _ intent: BudgetPlanCarryIntent,
        activeProfile: FamilyMember,
    ) async throws {
        guard BudgetPlanCarry.canonicalIdentity(for: activeProfile)?.owner == intent.owner else {
            throw AppWritebackError.remote(.ownerMismatch)
        }
        let device = try await taskSession(activeProfile: activeProfile)
        let value = try await convexMutation(
            baseURL: device.baseURL,
            path: BudgetPlanCarry.mutationPath,
            args: Self.budgetPlanCarryArguments(intent, deviceID: device.deviceID, deviceToken: device.deviceToken),
        )
        try Self.validateBudgetPlanCarryResponse(value, intent: intent)
    }

    static func budgetPlanCarryArguments(
        _ intent: BudgetPlanCarryIntent,
        deviceID: String,
        deviceToken: String,
    ) -> [String: Any] {
        [
            "deviceId": deviceID,
            "deviceToken": deviceToken,
            "owner": intent.owner.rawValue,
            "sourceFile": intent.sourceFile,
            "fromMonth": intent.fromMonth,
            "toMonth": intent.toMonth,
            "baseUpdatedAtMs": intent.baseUpdatedAtMs,
        ]
    }

    static func validateBudgetPlanCarryResponse(_ value: Any?, intent: BudgetPlanCarryIntent) throws {
        guard let object = value as? [String: Any],
              object["ok"] as? Bool == true,
              let outcome = object["outcome"] as? String,
              ["copied", "already-copied"].contains(outcome),
              object["sourceFile"] as? String == intent.sourceFile,
              object["fromMonth"] as? String == intent.fromMonth,
              object["toMonth"] as? String == intent.toMonth,
              let count = object["categoryCount"] as? Double,
              count.isFinite, count >= 0, count.rounded(.towardZero) == count,
              let revision = object["updatedAtMs"] as? Double,
              BudgetPlanCarry.isExactRevision(revision),
              revision > Double(intent.baseUpdatedAtMs)
        else { throw AppWritebackError.unexpectedResponse }
    }

    static func budgetCategoryDeletionArguments(
        _ intent: BudgetCategoryDeletionIntent,
        deviceID: String,
        deviceToken: String,
    ) -> [String: Any] {
        [
            "deviceId": deviceID,
            "deviceToken": deviceToken,
            "owner": intent.owner.rawValue,
            "sourceFile": intent.source,
            "month": intent.month,
            "entityId": intent.categoryName,
            "baseUpdatedAtMs": intent.baseUpdatedAtMs,
        ]
    }

    static func todoUpsertArguments(
        _ todo: TodoDeviceWritePayload,
        activeProfile: FamilyMember,
        operation: TodoDeviceWriteOperation,
        baseUpdatedAtMs: Double?,
        deviceID: String,
        deviceToken: String,
    ) throws -> [String: Any] {
        guard todo.owner == activeProfile else {
            throw AppWritebackError.remote(.ownerMismatch)
        }
        switch operation {
        case .create:
            guard baseUpdatedAtMs == nil else {
                throw AppWritebackError.remote(.validationFailed)
            }
        case .update:
            guard let baseUpdatedAtMs else {
                throw AppWritebackError.remote(.revisionRequired)
            }
            guard isValidTaskRevision(baseUpdatedAtMs) else {
                throw AppWritebackError.remote(.validationFailed)
            }
        }

        var args: [String: Any] = [
            "deviceId": deviceID,
            "deviceToken": deviceToken,
            "activeProfile": activeProfile.rawValue,
            "owner": todo.owner.rawValue,
            "sourceFile": "todos",
            "operation": operation.rawValue,
            "todo": todo.convexJSONObject(),
        ]
        if let baseUpdatedAtMs { args["baseUpdatedAtMs"] = baseUpdatedAtMs }
        return args
    }

    static func todoDeleteArguments(
        id: String,
        activeProfile: FamilyMember,
        owner: FamilyMember,
        baseUpdatedAtMs: Double?,
        deviceID: String,
        deviceToken: String,
    ) throws -> [String: Any] {
        try todoIdentityArguments(
            id: id,
            activeProfile: activeProfile,
            owner: owner,
            baseUpdatedAtMs: baseUpdatedAtMs,
            deviceID: deviceID,
            deviceToken: deviceToken,
        )
    }

    static func todoRestoreArguments(
        id: String,
        activeProfile: FamilyMember,
        owner: FamilyMember,
        baseUpdatedAtMs: Double?,
        deviceID: String,
        deviceToken: String,
    ) throws -> [String: Any] {
        try todoIdentityArguments(
            id: id,
            activeProfile: activeProfile,
            owner: owner,
            baseUpdatedAtMs: baseUpdatedAtMs,
            deviceID: deviceID,
            deviceToken: deviceToken,
        )
    }

    private static func todoIdentityArguments(
        id: String,
        activeProfile: FamilyMember,
        owner: FamilyMember,
        baseUpdatedAtMs: Double?,
        deviceID: String,
        deviceToken: String,
    ) throws -> [String: Any] {
        guard owner == activeProfile else {
            throw AppWritebackError.remote(.ownerMismatch)
        }
        guard let baseUpdatedAtMs else {
            throw AppWritebackError.remote(.revisionRequired)
        }
        guard isValidTaskRevision(baseUpdatedAtMs) else {
            throw AppWritebackError.remote(.validationFailed)
        }
        return [
            "deviceId": deviceID,
            "deviceToken": deviceToken,
            "activeProfile": activeProfile.rawValue,
            "owner": owner.rawValue,
            "sourceFile": "todos",
            "entityId": id,
            "baseUpdatedAtMs": baseUpdatedAtMs,
        ]
    }

    static func isValidTaskRevision(_ value: Double) -> Bool {
        value.isFinite &&
            value >= 0 &&
            value <= Double(BudgetCategoryDeletionIntent.maximumExactJSONRevision) &&
            value.rounded(.towardZero) == value
    }

    static func taskProfileBindingError(
        hasStoredCredential: Bool,
        boundProfile: FamilyMember?,
        activeProfile: FamilyMember,
    ) -> AppWritebackRemoteErrorCode? {
        guard hasStoredCredential else { return nil }
        guard let boundProfile else { return .profileBindingRequired }
        return boundProfile == activeProfile ? nil : .ownerMismatch
    }

    static func ledgerProfileBindingError(boundProfile: FamilyMember?, activeProfile: FamilyMember) -> AppWritebackRemoteErrorCode? {
        guard let boundProfile else { return .profileBindingRequired }
        return boundProfile.sharesNetWorth(with: activeProfile) ? nil : .ownerMismatch
    }

    private func ledgerSession(
        activeProfile: FamilyMember,
    ) async throws -> (baseURL: URL, deviceID: String, deviceToken: String) {
        if !AppWritebackConfig.hasStoredCredential {
            try await claimBundledPairing(deviceName: "Vogel Vault Apple", profile: activeProfile)
        }
        guard AppWritebackConfig.hasStoredCredential, let baseURL = AppWritebackConfig.baseURL else {
            throw AppWritebackError.notConfigured
        }
        if let error = Self.ledgerProfileBindingError(boundProfile: AppWritebackConfig.boundProfile, activeProfile: activeProfile) {
            throw AppWritebackError.remote(error)
        }
        guard Self.isConvexBaseURL(baseURL) else { throw AppWritebackError.invalidBaseURL }
        return (baseURL, AppWritebackConfig.deviceID, AppWritebackConfig.deviceToken)
    }

    private func taskSession(
        activeProfile: FamilyMember,
    ) async throws -> (baseURL: URL, deviceID: String, deviceToken: String) {
        if !AppWritebackConfig.hasStoredCredential {
            #if os(iOS)
                let deviceName = "Vogel Vault iOS"
            #else
                let deviceName = "Vogel Vault macOS"
            #endif
            try await claimBundledPairing(deviceName: deviceName, profile: activeProfile)
        }

        guard AppWritebackConfig.hasStoredCredential,
              let baseURL = AppWritebackConfig.baseURL
        else { throw AppWritebackError.notConfigured }
        if let bindingError = Self.taskProfileBindingError(
            hasStoredCredential: AppWritebackConfig.hasStoredCredential,
            boundProfile: AppWritebackConfig.boundProfile,
            activeProfile: activeProfile,
        ) {
            throw AppWritebackError.remote(bindingError)
        }
        guard Self.isConvexBaseURL(baseURL) else {
            throw AppWritebackError.invalidBaseURL
        }
        return (
            baseURL,
            AppWritebackConfig.deviceID,
            AppWritebackConfig.deviceToken
        )
    }

    private func claimConvexPairing(
        baseURL: URL,
        pair: (pairID: String, proofHash: String),
        deviceName: String,
        profile: FamilyMember,
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

        guard AppWritebackConfig.save(
            baseURL: baseURL.absoluteString,
            deviceID: deviceID,
            deviceToken: deviceToken,
            profile: profile,
            capabilities: object["capabilities"] as? [String],
        ) else { throw AppWritebackError.credentialStorageFailed }
    }

    private func convexMutation(baseURL: URL, path: String, args: [String: Any], endpointKind: String = "mutation") async throws -> Any {
        guard baseURL.scheme?.lowercased() == "https" else {
            throw AppWritebackError.invalidBaseURL
        }

        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent(endpointKind)
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
            if let code = Self.remoteErrorCode(from: object?["errorData"]) {
                throw AppWritebackError.remote(code)
            }
            // Never surface errorMessage. Production masks it inconsistently,
            // and an upstream message is not safe user-facing diagnostic text.
            throw AppWritebackError.serverError
        }
        guard object?["status"] as? String == "success" else {
            throw AppWritebackError.unexpectedResponse
        }
        return object?["value"] ?? [:]
    }

    static func remoteErrorCode(from raw: Any?) -> AppWritebackRemoteErrorCode? {
        let object: [String: Any]?
        if let dictionary = raw as? [String: Any] {
            object = dictionary
        } else if let string = raw as? String,
                  string.utf8.count <= 2_048,
                  let data = string.data(using: .utf8)
        {
            object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        } else {
            object = nil
        }
        guard let code = object?["code"] as? String else { return nil }
        return AppWritebackRemoteErrorCode(rawValue: code)
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
    /// A Bitcoin-native payment source must post typed sats to a named
    /// account. Derived sats, a missing account, or a blank account key are
    /// refused here rather than sent — the server would debit or credit an
    /// exact sat amount the row does not honestly carry.
    case bitcoinPostingRequiresTypedSatsAndAccount

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
        case .bitcoinPostingRequiresTypedSatsAndAccount:
            "A Bitcoin payment source requires an amount entered in sats and a Bitcoin account."
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
    typealias LedgerExecutor = @Sendable (String, FamilyMember, String, [String: Any], Bool) async throws -> Void
    private let ledgerExecutor: LedgerExecutor?
    private let requestExecutor: RequestExecutor?
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "Convex")

    init(
        deploymentURL: URL,
        session: URLSession? = nil,
        requestExecutor: RequestExecutor? = nil,
        ledgerExecutor: LedgerExecutor? = nil,
    ) {
        self.deploymentURL = deploymentURL
        self.requestExecutor = requestExecutor
        self.ledgerExecutor = ledgerExecutor
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 30
            config.timeoutIntervalForResource = 60
            self.session = URLSession(configuration: config)
        }
    }

    private func writeDeviceLedger(
        path: String, owner: FamilyMember, entityID: String, arguments: [String: Any], deleting: Bool = false,
    ) async throws {
        if let ledgerExecutor {
            try await ledgerExecutor(path, owner, entityID, arguments, deleting)
        } else {
            try await AppWritebackClient(session: session).writeLedger(
                path: path, owner: owner, entityID: entityID, arguments: arguments, deleting: deleting,
            )
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
    @discardableResult
    func upsertTransactionRow(
        _ transaction: LegacyTransactionDTO,
        owner: FamilyMember,
        sourceFile: String,
        fromDevice: Bool = false,
    ) async throws -> Double? {
        let canonicalOwner = owner.ledgerOwner
        guard transaction.owner == canonicalOwner else {
            throw ConvexRowMutationError.ownerMismatch(
                field: "transaction.owner",
                expected: canonicalOwner,
                actual: transaction.owner?.rawValue,
            )
        }
        guard sourceFile == canonicalOwner.transactionsDataFileName else {
            throw ConvexRowMutationError.ownerMismatch(
                field: "transaction.sourceFile",
                expected: canonicalOwner,
                actual: sourceFile,
            )
        }
        let amountCents = try Self.exactMinorUnits(transaction.amount, field: "transaction.amount")
        let kind = transaction.category == "Income" || amountCents < 0 ? "credit" : "spend"
        var row: [String: Any] = [
            "id": transaction.id,
            "date": transaction.date,
            "merchant": transaction.merchant,
            "amountCents": ConvexTaggedInt64Encoder.encode(amountCents),
            "kind": kind,
            "category": transaction.category,
            "owner": canonicalOwner.rawValue,
        ]
        if let card = transaction.card { row["card"] = card }
        if let note = transaction.note { row["note"] = note }
        // Sats reach the server only when somebody actually typed them, never
        // when they were derived from a dollar amount and a price quote — the
        // server posts this field as exact sat movements on an account, so a
        // derived value would move money nobody received or spent.
        //
        // Two shapes qualify:
        //  - Income the user typed in BTC/sats (the original rule, unchanged);
        //  - a Bitcoin-native payment source, which the server requires to
        //    carry positive amountSats AND a bitcoinAccountKey. The form blocks
        //    a Bitcoin-native save without typed sats, so a derived value never
        //    reaches this branch; the guard here is the backstop, and a
        //    Bitcoin-native row failing it throws rather than sending sats
        //    the row does not honestly carry.
        let isBitcoinNativeSource = transaction.card
            .flatMap { TransactionSourceCatalog.option(forWire: $0)?.classification.isBitcoinNative } == true

        if isBitcoinNativeSource {
            // Trim only for the emptiness test. The STORED value goes on the
            // wire verbatim: the server keys postings by exact string, so an
            // edited row whose stored key carries whitespace must round-trip
            // byte-for-byte — normalising here would credit one account and
            // debit a whitespace-twin the app renders as the same name.
            // Linux forwards this field untrimmed for the same reason.
            guard let storedAccountKey = transaction.bitcoinAccountKey,
                  !storedAccountKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else {
                throw ConvexRowMutationError.bitcoinPostingRequiresTypedSatsAndAccount
            }
            guard let amountSats = transaction.amountSats,
                  transaction.enteredInBitcoin == true,
                  amountSats > 0
            else {
                throw ConvexRowMutationError.bitcoinPostingRequiresTypedSatsAndAccount
            }
            row["amountSats"] = ConvexTaggedInt64Encoder.encode(amountSats)
            row["bitcoinAccountKey"] = storedAccountKey
        } else if let amountSats = transaction.amountSats,
                  transaction.category == "Income",
                  transaction.enteredInBitcoin == true,
                  amountSats > 0 {
            row["amountSats"] = ConvexTaggedInt64Encoder.encode(amountSats)
        }

        let path = "tables:upsertTransaction"
        var args: [String: Any] = [
            "sourceFile": sourceFile,
            "transaction": row,
        ]
        if let updatedAtMs = transaction.updatedAtMs {
            args["baseUpdatedAtMs"] = updatedAtMs
        }
        if fromDevice {
            try await writeDeviceLedger(
                path: "tables:upsertTransactionFromDevice", owner: canonicalOwner,
                entityID: transaction.id, arguments: args,
            )
            // A device acknowledgement carries no revision. A failed read must
            // not turn an accepted write into another mutation retry.
            return try? await ConvexRowReader(client: self).transactions(viewer: owner)
                .first { $0.id == transaction.id && $0.owner == canonicalOwner }?.updatedAtMs
        }
        let raw = try await mutation(path, args: args)
        guard let result = raw as? [String: Any],
              result["txId"] as? String == transaction.id
        else {
            throw ConvexRowMutationError.unexpectedResponse(path: path)
        }
        // Hand back the revision the server actually accepted. The next edit or
        // delete of this row is fenced on it, so a caller that does not install
        // it cannot edit what it just created until a later sync refreshes it.
        return Self.acceptedRevision(result["updatedAtMs"])
    }

    static func acceptedRevision(_ value: Any?) -> Double? {
        if let accepted = value as? Double { return accepted }
        if let accepted = value as? Int64 { return Double(accepted) }
        if let accepted = value as? Int { return Double(accepted) }
        return nil
    }

    /// Delete one transaction row without reading or rewriting its neighbours.
    func deleteTransactionRow(
        id: String,
        owner: FamilyMember,
        sourceFile: String,
        baseUpdatedAtMs: Double? = nil,
        fromDevice: Bool = false,
    ) async throws {
        let canonicalOwner = owner.ledgerOwner
        guard sourceFile == canonicalOwner.transactionsDataFileName else {
            throw ConvexRowMutationError.ownerMismatch(
                field: "transaction.sourceFile",
                expected: canonicalOwner,
                actual: sourceFile,
            )
        }
        let path = "tables:deleteTransaction"
        var args: [String: Any] = [
            "txId": id,
            "owner": canonicalOwner.rawValue,
            "sourceFile": sourceFile,
        ]
        if let baseUpdatedAtMs { args["baseUpdatedAtMs"] = baseUpdatedAtMs }
        if fromDevice {
            guard let baseUpdatedAtMs, baseUpdatedAtMs.isFinite, baseUpdatedAtMs > 0 else {
                throw AppWritebackError.remote(.revisionRequired)
            }
            args.removeValue(forKey: "txId")
            args["entityId"] = id
            try await writeDeviceLedger(
                path: "tables:deleteTransactionFromDevice", owner: canonicalOwner,
                entityID: id, arguments: args, deleting: true,
            )
            return
        }
        let raw = try await mutation(path, args: args)
        guard let result = raw as? [String: Any],
              result["txId"] as? String == id,
              result["removed"] is Bool
        else {
            throw ConvexRowMutationError.unexpectedResponse(path: path)
        }
    }

    /// Insert or replace one Bitcoin purchase row using exact cents and sats.
    @discardableResult
    func upsertBTCBuyRow(
        _ buy: LegacyBTCBuyDTO,
        owner: FamilyMember,
        sourceFile: String = "bitcoin-buys",
        fromDevice: Bool = false,
    ) async throws -> Double? {
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
        let feeUsdCents = try ExactMoney.manualFeeCents(
            from: buy.feeUsd,
            field: "btcBuy.feeUsd",
        )
        row["feeUsdCents"] = ConvexTaggedInt64Encoder.encode(feeUsdCents)
        // Adult blob rows are canonical to Victor and resolved from sourceFile.
        // Children must carry their own owner even when no dedicated legacy buy
        // file exists (Maddox), or their balance would enter the adult ledger.
        if !owner.isAdult { row["owner"] = owner.rawValue }

        let path = "tables:upsertBtcBuy"
        var args: [String: Any] = [
            "sourceFile": sourceFile,
            "buy": row,
        ]
        if let baseUpdatedAtMs = buy.updatedAtMs {
            args["baseUpdatedAtMs"] = baseUpdatedAtMs
        }
        if fromDevice {
            row["owner"] = owner.ledgerOwner.rawValue
            args["buy"] = row
            try await writeDeviceLedger(
                path: "tables:upsertBtcBuyFromDevice", owner: owner,
                entityID: buy.id, arguments: args,
            )
            return try? await ConvexRowReader(client: self).btcBuys(viewer: owner, scope: .netWorth)
                .first { $0.id == buy.id && $0.owner == owner.ledgerOwner.rawValue }?.updatedAtMs
        }
        let raw = try await mutation(path, args: args)
        guard let result = raw as? [String: Any],
              result["buyId"] as? String == buy.id
        else {
            throw ConvexRowMutationError.unexpectedResponse(path: path)
        }
        return Self.acceptedRevision(result["updatedAtMs"])
    }

    /// Admin-only compatibility write. Interactive app tasks use the
    /// profile-bound device methods on `AppWritebackClient`.
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

    /// Admin-only compatibility delete. Interactive app tasks use the
    /// profile-bound device methods on `AppWritebackClient`.
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
        fromDevice: Bool = false,
    ) async throws {
        let envelope = try await fetchRows(
            .budget(viewer: viewer),
            as: ConvexBudgetDocumentEnvelope.self,
        )
        let document = try envelope.completeDocument()
        let budgetCents = try Self.exactMinorUnits(budget, field: "budgetCategory.budget")
        let path = "tables:upsertBudgetCategory"
        if fromDevice {
            var args: [String: Any] = [
                "sourceFile": viewer.isAdult ? "budget" : "mason-budget",
                "month": document.month,
                "category": ["name": name, "icon": icon,
                             "budgetCents": ConvexTaggedInt64Encoder.encode(budgetCents)],
            ]
            if let revision = document.updatedAtMs { args["baseUpdatedAtMs"] = revision }
            try await writeDeviceLedger(
                path: "tables:upsertBudgetCategoryFromDevice", owner: viewer,
                entityID: name, arguments: args,
            )
            return
        }
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
