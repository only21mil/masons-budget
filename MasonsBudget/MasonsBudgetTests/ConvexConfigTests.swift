import Foundation
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

    func testSetSyncTokenTrimsAndStoresRuntimeCredentialOnlyInKeychain() {
        XCTAssertTrue(tokenStore.set("  runtime-token\n"))

        XCTAssertEqual(tokenStore.token, "runtime-token")
        XCTAssertEqual(keychain.read(), "runtime-token")
        XCTAssertNil(userDefaults.object(forKey: syncTokenKey))
    }

    func testReadingLegacySyncTokenMigratesItToKeychainAndRemovesCleartext() {
        userDefaults.set("  existing-token\n", forKey: syncTokenKey)

        XCTAssertEqual(tokenStore.token, "existing-token")
        XCTAssertEqual(keychain.read(), "existing-token")
        XCTAssertNil(userDefaults.object(forKey: syncTokenKey))
    }

    func testSetSyncTokenWithOnlyWhitespaceClearsStoredCredential() {
        userDefaults.set("existing-token", forKey: syncTokenKey)

        XCTAssertTrue(tokenStore.set(" \n\t "))

        XCTAssertTrue(tokenStore.token.isEmpty)
        XCTAssertNil(keychain.read())
        XCTAssertNil(userDefaults.object(forKey: syncTokenKey))
    }

    func testRemoveSyncTokenClearsKeychainAndLegacyCredential() {
        XCTAssertTrue(keychain.save("keychain-token"))
        userDefaults.set("legacy-token", forKey: syncTokenKey)

        XCTAssertTrue(tokenStore.remove())

        XCTAssertTrue(tokenStore.token.isEmpty)
        XCTAssertNil(keychain.read())
        XCTAssertNil(userDefaults.object(forKey: syncTokenKey))
    }
}
