import Foundation
import XCTest

final class ConvexConfigTests: XCTestCase {
    private let syncTokenKey = "convex_sync_token"
    private var previousSyncToken: Any?

    override func setUp() {
        super.setUp()
        previousSyncToken = UserDefaults.standard.object(forKey: syncTokenKey)
        UserDefaults.standard.removeObject(forKey: syncTokenKey)
    }

    override func tearDown() {
        if let previousSyncToken {
            UserDefaults.standard.set(previousSyncToken, forKey: syncTokenKey)
        } else {
            UserDefaults.standard.removeObject(forKey: syncTokenKey)
        }
        previousSyncToken = nil
        super.tearDown()
    }

    func testSetSyncTokenTrimsAndStoresRuntimeCredential() {
        ConvexConfig.setSyncToken("  runtime-token\n")

        XCTAssertEqual(ConvexConfig.syncToken, "runtime-token")
    }

    func testSetSyncTokenWithOnlyWhitespaceClearsStoredCredential() {
        UserDefaults.standard.set("existing-token", forKey: syncTokenKey)

        ConvexConfig.setSyncToken(" \n\t ")

        XCTAssertTrue(ConvexConfig.syncToken.isEmpty)
        XCTAssertNil(UserDefaults.standard.object(forKey: syncTokenKey))
    }

    func testRemoveSyncTokenClearsStoredCredential() {
        UserDefaults.standard.set("existing-token", forKey: syncTokenKey)

        ConvexConfig.removeSyncToken()

        XCTAssertTrue(ConvexConfig.syncToken.isEmpty)
        XCTAssertNil(UserDefaults.standard.object(forKey: syncTokenKey))
    }
}
