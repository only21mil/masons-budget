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

    func testBlankDeviceTokenEntryClearsStoredCredential() {
        AppWritebackConfig.save(
            baseURL: "https://first.example",
            deviceID: "device-one",
            deviceToken: "test-device-token",
        )

        AppWritebackConfig.save(
            baseURL: "https://second.example",
            deviceID: "device-two",
            deviceToken: "   ",
        )

        // baseURL and deviceID have already moved to the new host. Keeping the
        // OLD host's token would pair them together and still report configured
        // — a failed pairing wearing a success. Fail closed instead.
        XCTAssertEqual(AppWritebackConfig.baseURL?.absoluteString, "https://second.example")
        XCTAssertEqual(AppWritebackConfig.deviceID, "device-two")
        XCTAssertFalse(AppWritebackConfig.hasDeviceToken)
        XCTAssertFalse(AppWritebackConfig.isConfigured)
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
