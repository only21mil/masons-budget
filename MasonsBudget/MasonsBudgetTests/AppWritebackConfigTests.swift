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

    func testBlankDeviceTokenEntryPreservesStoredCredential() {
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

        XCTAssertEqual(AppWritebackConfig.baseURL?.absoluteString, "https://second.example")
        XCTAssertEqual(AppWritebackConfig.deviceID, "device-two")
        XCTAssertTrue(AppWritebackConfig.hasDeviceToken)
        XCTAssertEqual(AppWritebackConfig.deviceToken, "test-device-token")
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
