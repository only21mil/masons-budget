import XCTest

final class AppWritebackConfigTests: XCTestCase {
    override func setUp() {
        super.setUp()
        AppWritebackConfig.clear()
    }

    override func tearDown() {
        AppWritebackConfig.clear()
        super.tearDown()
    }

    func testBlankDeviceTokenCannotMixNewIdentifiersWithOldCredential() {
        let credentials = InMemoryCredentialStore()
        XCTAssertTrue(AppWritebackConfig.save(
            baseURL: "https://first.example",
            deviceID: "device-one",
            deviceToken: "test-device-token",
            credentialStore: credentials,
        ))

        XCTAssertFalse(AppWritebackConfig.save(
            baseURL: "https://second.example",
            deviceID: "device-two",
            deviceToken: "   ",
            credentialStore: credentials,
        ))

        XCTAssertEqual(AppWritebackConfig.baseURL?.absoluteString, "https://first.example")
        XCTAssertEqual(AppWritebackConfig.deviceID, "device-one")
        XCTAssertEqual(credentials.stored, "test-device-token")
    }

    func testFailedCredentialReplacementPreservesPreviousPairing() {
        let credentials = InMemoryCredentialStore()
        XCTAssertTrue(AppWritebackConfig.save(
            baseURL: "https://first.example",
            deviceID: "device-one",
            deviceToken: "old-token",
            credentialStore: credentials,
        ))
        credentials.refuseWrites = true

        XCTAssertFalse(AppWritebackConfig.save(
            baseURL: "https://second.example",
            deviceID: "device-two",
            deviceToken: "new-token",
            credentialStore: credentials,
        ))

        XCTAssertEqual(AppWritebackConfig.baseURL?.absoluteString, "https://first.example")
        XCTAssertEqual(AppWritebackConfig.deviceID, "device-one")
        XCTAssertEqual(credentials.stored, "old-token")
    }

    func testClearRemovesStoredCredentialAndIdentifiers() {
        AppWritebackConfig.save(
            baseURL: "https://example.com",
            deviceID: "device-one",
            deviceToken: "test-device-token",
        )

        AppWritebackConfig.clear()

        XCTAssertNil(AppWritebackConfig.baseURL)
        XCTAssertTrue(AppWritebackConfig.deviceID.isEmpty)
        XCTAssertFalse(AppWritebackConfig.hasDeviceToken)
    }
}
