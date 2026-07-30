import Foundation
import Security
import XCTest

final class KeychainMigrationTests: XCTestCase {
    private var primary: KeychainCredentialStore!
    private var legacy: KeychainCredentialStore!

    override func setUp() {
        super.setUp()
        let identity = UUID().uuidString
        let service = "com.sats21m.vogel-vault.keychain-migration-tests.\(identity)"
        let account = "migration-\(identity)"
        primary = KeychainCredentialStore(service: service, account: account)
        legacy = KeychainCredentialStore(
            service: service,
            account: account,
            usesDataProtectionKeychain: false,
        )

        XCTAssertTrue(primary.clear(), "failed to clear the unique Data Protection test item")
        XCTAssertTrue(legacy.clear(), "failed to clear the unique legacy test item")
    }

    override func tearDown() {
        // XCTest invokes tearDown after assertion failures, so both keychain
        // implementations are cleaned even when a migration assertion fails.
        XCTAssertTrue(primary.clear(), "failed to remove the Data Protection test item")
        XCTAssertTrue(legacy.clear(), "failed to remove the legacy test item")
        primary = nil
        legacy = nil
        super.tearDown()
    }

    func testLegacyFileItemMigratesOnlyAfterDataProtectionVerification() {
        let sentinel = "keychain-migration-sentinel-\(UUID().uuidString)"
        var legacyItem = legacy.baseQuery
        legacyItem[kSecValueData as String] = Data(sentinel.utf8)
        XCTAssertEqual(
            SecItemAdd(legacyItem as CFDictionary, nil),
            errSecSuccess,
            "failed to seed the legacy file Keychain",
        )
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
}
