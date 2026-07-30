import Foundation
import Security

/// The seam that makes credential storage testable.
///
/// The iOS simulator test bundle has no host application or keychain access
/// group, so migration logic there uses in-memory stores. The dedicated macOS
/// keychain test target compiles this file directly and exercises the real
/// Security-framework path in a user session with unique test-only identities.
protocol CredentialStoring {
    func read() -> String?
    @discardableResult func save(_ token: String) -> Bool
    @discardableResult func clear() -> Bool
}

extension KeychainCredentialStore: CredentialStoring {}

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
    /// visibility lets tests guard the macOS data-protection opt-in while the
    /// native target also executes the production query.
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
