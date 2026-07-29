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
        //
        // HONEST LIMIT: this target is a bundle.unit-test with no host app, so
        // it has no keychain access group and every SecItemAdd fails. The two
        // identifier assertions below are real. The hasDeviceToken assertion is
        // NOT proof of the clearing behaviour here — it would also pass if the
        // first save had never stored anything, which is exactly what happens
        // in this environment. The clearing logic is proved against an
        // injectable double in ConvexConfigTests; this case is kept only for
        // the identifier half. Do not read it as coverage of the Keychain.
        XCTAssertEqual(AppWritebackConfig.baseURL?.absoluteString, "https://second.example")
        XCTAssertEqual(AppWritebackConfig.deviceID, "device-two")
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
