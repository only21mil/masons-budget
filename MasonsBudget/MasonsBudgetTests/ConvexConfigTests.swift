import Foundation
import Security
import XCTest

final class ConvexConfigTests: XCTestCase {
    private let syncTokenKey = "convex_sync_token"
    private var suiteName: String!
    private var userDefaults: UserDefaults!
    private var keychain: KeychainCredentialStore!
    private var tokenStore: MigratingKeychainTokenStore!

    override func setUp() {
        super.setUp()
        suiteName = "ConvexConfigTests.\(UUID().uuidString)"
        userDefaults = UserDefaults(suiteName: suiteName)
        keychain = KeychainCredentialStore(
            service: "com.sats21m.vogel-vault.tests.\(UUID().uuidString)",
            account: "sync-token",
        )
        tokenStore = MigratingKeychainTokenStore(
            userDefaults: userDefaults,
            legacyKey: syncTokenKey,
            keychain: keychain,
        )
    }

    override func tearDown() {
        keychain.clear()
        userDefaults.removePersistentDomain(forName: suiteName)
        tokenStore = nil
        keychain = nil
        userDefaults = nil
        suiteName = nil
        super.tearDown()
    }

    // The migration tests exercise MigratingKeychainTokenStore against an
    // in-memory double.
    //
    // They deliberately do NOT touch the real Keychain: MasonsBudgetTests is a
    // bundle.unit-test target with no host application, so it has no keychain
    // access group and SecItemAdd always fails. A test written against the real
    // Keychain here does not merely fail — a test asserting a credential is
    // ABSENT passes trivially, which is worse, because it looks like proof and
    // is not. The migration and clearing logic is tested through the production
    // store, while the real SecItem query itself is asserted without executing
    // it so macOS's data-protection opt-in cannot regress.

    private func makeStore(
        legacyKey: String = "convex_sync_token",
        legacyValue: String? = nil,
        double: InMemoryCredentialStore = InMemoryCredentialStore(),
    ) -> (MigratingKeychainTokenStore, InMemoryCredentialStore, UserDefaults) {
        let suite = UserDefaults(suiteName: "sync-token-\(UUID().uuidString)")!
        if let legacyValue { suite.set(legacyValue, forKey: legacyKey) }
        let store = MigratingKeychainTokenStore(
            userDefaults: suite,
            legacyKey: legacyKey,
            keychain: double,
        )
        return (store, double, suite)
    }

    private func makeReadTokenStore(
        legacyValue: String? = nil,
        double: InMemoryCredentialStore = InMemoryCredentialStore(),
    ) -> (MigratingKeychainTokenStore, InMemoryCredentialStore, UserDefaults) {
        let suite = UserDefaults(suiteName: "read-token-\(UUID().uuidString)")!
        if let legacyValue { suite.set(legacyValue, forKey: "convex_read_token") }
        let store = ConvexConfig.makeReadTokenStore(
            userDefaults: suite,
            keychain: double,
        )
        return (store, double, suite)
    }

    func testSetSyncTokenTrimsAndStoresOnlyInTheCredentialStore() {
        let (store, double, suite) = makeStore()

        XCTAssertTrue(store.set("  vv-sync-abc  "))

        XCTAssertEqual(double.stored, "vv-sync-abc")
        XCTAssertNil(suite.string(forKey: "convex_sync_token"))
        XCTAssertEqual(store.token, "vv-sync-abc")
        XCTAssertTrue(store.hasToken)
    }

    func testKeychainStoreEnablesDataProtectionKeychainForDeviceOnlyAccessibility() {
        let query = KeychainCredentialStore(
            service: "com.sats21m.vogel-vault.convex",
            account: "sync-token",
        ).baseQuery

        XCTAssertEqual(
            query[kSecUseDataProtectionKeychain as String] as? Bool,
            true,
            "the production SecItem query must opt macOS into the Data Protection Keychain",
        )
    }

    func testSetSyncTokenWithOnlyWhitespaceClearsStoredCredential() {
        let (store, double, _) = makeStore()
        XCTAssertTrue(store.set("vv-sync-abc"))

        XCTAssertTrue(store.set("   "))

        XCTAssertNil(double.stored)
        XCTAssertFalse(store.hasToken)
    }

    func testRemoveSyncTokenClearsBothTheStoreAndTheLegacyCleartextCopy() {
        let (store, double, suite) = makeStore(legacyValue: "vv-legacy")

        XCTAssertTrue(store.remove())

        XCTAssertNil(double.stored)
        XCTAssertNil(suite.string(forKey: "convex_sync_token"))
        XCTAssertFalse(store.hasToken)
    }

    func testReadingMigratesTheLegacyCleartextTokenThenDeletesIt() {
        let (store, double, suite) = makeStore(legacyValue: "vv-legacy")

        XCTAssertEqual(store.token, "vv-legacy")

        XCTAssertEqual(double.stored, "vv-legacy", "the token must land in the credential store")
        XCTAssertNil(suite.string(forKey: "convex_sync_token"), "the cleartext copy must be gone")
    }

    func testAFailedSyncTokenMigrationDeletesCleartextAndRefusesCredential() {
        let refusing = InMemoryCredentialStore()
        refusing.refuseWrites = true
        let (store, _, suite) = makeStore(legacyValue: "vv-legacy", double: refusing)

        XCTAssertEqual(store.token, "")
        XCTAssertNil(suite.string(forKey: "convex_sync_token"))
        XCTAssertFalse(store.hasToken)
    }

    func testReadTokenMigrationMovesLegacyCleartextIntoCredentialStore() {
        let key = "convex_read_token"
        let (store, double, suite) = makeReadTokenStore(legacyValue: "  vv-read-legacy  ")

        XCTAssertEqual(store.token, "vv-read-legacy")

        XCTAssertEqual(double.stored, "vv-read-legacy")
        XCTAssertNil(suite.string(forKey: key), "the cleartext read token must be gone")
        XCTAssertTrue(store.hasToken)
    }

    func testSettingReadTokenStoresNoCleartextCopy() {
        let key = "convex_read_token"
        let (store, double, suite) = makeReadTokenStore()

        XCTAssertTrue(store.set("  vv-read-new  "))

        XCTAssertEqual(double.stored, "vv-read-new")
        XCTAssertNil(suite.string(forKey: key))
        XCTAssertEqual(store.token, "vv-read-new")
    }

    func testReadTokenMigrationFailsClosedWhenCredentialWriteFails() {
        let key = "convex_read_token"
        let refusing = InMemoryCredentialStore()
        refusing.refuseWrites = true
        let (store, _, suite) = makeReadTokenStore(
            legacyValue: "vv-read-legacy",
            double: refusing,
        )

        XCTAssertEqual(store.token, "")
        XCTAssertNil(suite.string(forKey: key))
    }

    func testRemovingReadTokenClearsCredentialAndLegacyCopy() {
        let key = "convex_read_token"
        let (store, double, suite) = makeReadTokenStore(legacyValue: "vv-read-legacy")
        XCTAssertEqual(store.token, "vv-read-legacy")

        XCTAssertTrue(store.remove())

        XCTAssertNil(double.stored)
        XCTAssertNil(suite.string(forKey: key))
        XCTAssertFalse(store.hasToken)
    }
}

/// An in-memory stand-in for the Keychain, so the migration logic is testable
/// in a unit-test bundle that has no keychain access group.
final class InMemoryCredentialStore: CredentialStoring {
    private(set) var stored: String?
    var refuseWrites = false

    func read() -> String? { stored }

    @discardableResult
    func save(_ token: String) -> Bool {
        guard !refuseWrites else { return false }
        stored = token
        return true
    }

    @discardableResult
    func clear() -> Bool {
        stored = nil
        return true
    }
}
