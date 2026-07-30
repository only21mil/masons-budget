import Foundation
import Security
import XCTest

final class KeychainMigrationTests: XCTestCase {
    private var primary: KeychainCredentialStore!
    private var legacy: KeychainCredentialStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        let identity = UUID().uuidString
        let service = "com.sats21m.vogel-vault.keychain-migration-tests.\(identity)"
        let account = "migration-\(identity)"
        primary = KeychainCredentialStore(service: service, account: account)
        legacy = KeychainCredentialStore(
            service: service,
            account: account,
            usesDataProtectionKeychain: false,
        )

        try clear(primary, implementation: "Data Protection")
        try clear(legacy, implementation: "legacy file")
    }

    override func tearDownWithError() throws {
        // XCTest invokes tearDown after assertion failures, so both keychain
        // implementations are cleaned even when a migration assertion fails.
        let cleanupErrors = [
            clearError(primary, implementation: "Data Protection"),
            clearError(legacy, implementation: "legacy file"),
        ].compactMap { $0 }
        primary = nil
        legacy = nil
        try super.tearDownWithError()
        if !cleanupErrors.isEmpty {
            XCTFail(cleanupErrors.map(\.localizedDescription).joined(separator: "\n"))
        }
    }

    func testLegacyFileItemMigratesOnlyAfterDataProtectionVerification() throws {
        let sentinel = "keychain-migration-sentinel-\(UUID().uuidString)"
        var legacyItem = legacy.baseQuery
        legacyItem[kSecValueData as String] = Data(sentinel.utf8)
        let addStatus = SecItemAdd(legacyItem as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainTestError(
                operation: "seed",
                implementation: "legacy file",
                status: addStatus,
            )
        }
        XCTAssertEqual(legacy.read(), sentinel)
        XCTAssertNil(primary.read())

        let migrating = MigratingCredentialStore(
            primary: primary,
            legacy: legacy,
        )

        XCTAssertEqual(migrating.read(), sentinel)
        XCTAssertEqual(
            primary.read(),
            sentinel,
            "the value must be readable from the Data Protection Keychain before cleanup",
        )
        XCTAssertNil(
            legacy.read(),
            "the legacy copy must be removed only after the protected read verifies",
        )
    }

    private func clear(
        _ store: KeychainCredentialStore,
        implementation: String
    ) throws {
        if let error = clearError(store, implementation: implementation) {
            throw error
        }
    }

    private func clearError(
        _ store: KeychainCredentialStore?,
        implementation: String
    ) -> KeychainTestError? {
        guard let store else { return nil }
        let status = SecItemDelete(store.baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            return KeychainTestError(
                operation: "clear",
                implementation: implementation,
                status: status,
            )
        }
        return nil
    }
}

private struct KeychainTestError: LocalizedError {
    let operation: String
    let implementation: String
    let status: OSStatus

    var errorDescription: String? {
        let message =
            SecCopyErrorMessageString(status, nil) as String?
            ?? "unknown Security-framework error"
        return "\(operation) \(implementation) Keychain item failed: \(status) (\(message))"
    }
}
