import Foundation
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
            profile: .mason,
            credentialStore: credentials,
        ))

        XCTAssertFalse(AppWritebackConfig.save(
            baseURL: "https://second.example",
            deviceID: "device-two",
            deviceToken: "   ",
            profile: .victor,
            credentialStore: credentials,
        ))

        XCTAssertEqual(AppWritebackConfig.baseURL?.absoluteString, "https://first.example")
        XCTAssertEqual(AppWritebackConfig.deviceID, "device-one")
        XCTAssertEqual(credentials.stored, "test-device-token")
        XCTAssertEqual(AppWritebackConfig.boundProfile, .mason)
    }

    func testFailedCredentialReplacementPreservesPreviousPairing() {
        let credentials = InMemoryCredentialStore()
        XCTAssertTrue(AppWritebackConfig.save(
            baseURL: "https://first.example",
            deviceID: "device-one",
            deviceToken: "old-token",
            profile: .rachel,
            credentialStore: credentials,
        ))
        credentials.refuseWrites = true

        XCTAssertFalse(AppWritebackConfig.save(
            baseURL: "https://second.example",
            deviceID: "device-two",
            deviceToken: "new-token",
            profile: .victor,
            credentialStore: credentials,
        ))

        XCTAssertEqual(AppWritebackConfig.baseURL?.absoluteString, "https://first.example")
        XCTAssertEqual(AppWritebackConfig.deviceID, "device-one")
        XCTAssertEqual(credentials.stored, "old-token")
        XCTAssertEqual(AppWritebackConfig.boundProfile, .rachel)
    }

    func testClearRemovesStoredCredentialAndIdentifiers() {
        AppWritebackConfig.save(
            baseURL: "https://example.com",
            deviceID: "device-one",
            deviceToken: "test-device-token",
            profile: .maddox,
        )

        AppWritebackConfig.clear()

        XCTAssertNil(AppWritebackConfig.baseURL)
        XCTAssertTrue(AppWritebackConfig.deviceID.isEmpty)
        XCTAssertFalse(AppWritebackConfig.hasDeviceToken)
        XCTAssertNil(AppWritebackConfig.boundProfile)
    }

    func testTaskCredentialMustHaveAndMatchAProfileBinding() {
        XCTAssertNil(AppWritebackClient.taskProfileBindingError(
            hasStoredCredential: false,
            boundProfile: nil,
            activeProfile: .mason,
        ))
        XCTAssertEqual(
            AppWritebackClient.taskProfileBindingError(
                hasStoredCredential: true,
                boundProfile: nil,
                activeProfile: .mason,
            ),
            .profileBindingRequired,
        )
        XCTAssertEqual(
            AppWritebackClient.taskProfileBindingError(
                hasStoredCredential: true,
                boundProfile: .victor,
                activeProfile: .mason,
            ),
            .ownerMismatch,
        )
        XCTAssertNil(AppWritebackClient.taskProfileBindingError(
            hasStoredCredential: true,
            boundProfile: .mason,
            activeProfile: .mason,
        ))
    }

    func testTaskCreatePayloadUsesDeviceRouteAndOmitsRevision() throws {
        XCTAssertEqual(AppWritebackClient.todoUpsertPath, "tables:upsertTodoFromDevice")
        XCTAssertEqual(AppWritebackClient.todoDeletePath, "tables:deleteTodoFromDevice")
        XCTAssertEqual(AppWritebackClient.todoRestorePath, "tables:restoreTodoFromDevice")
        let payload = try TodoDeviceWritePayload(LegacyTodoDTO(
            id: "fresh-task",
            title: "Pack lunch",
            project: "School",
            area: "Family",
            dueDate: "2026-08-26",
            priority: 2,
            flag: true,
            owner: FamilyMember.mason.rawValue,
            createdAt: "2026-08-26T12:00:00.000Z",
            updatedAt: "2026-08-26T12:00:00.000Z",
        ))
        let args = try AppWritebackClient.todoUpsertArguments(
            payload,
            activeProfile: .mason,
            operation: .create,
            baseUpdatedAtMs: nil,
            deviceID: "device-id",
            deviceToken: "device-token",
        )

        XCTAssertEqual(args["activeProfile"] as? String, "mason")
        XCTAssertEqual(args["owner"] as? String, "mason")
        XCTAssertEqual(args["sourceFile"] as? String, "todos")
        XCTAssertEqual(args["operation"] as? String, "create")
        XCTAssertNil(args["baseUpdatedAtMs"])
        let todo = try XCTUnwrap(args["todo"] as? [String: Any])
        XCTAssertEqual(
            Set(todo.keys),
            Set([
                "id", "owner", "title", "done", "flagged", "project", "area", "due", "priority",
                "createdAt", "updatedAt",
            ]),
        )
        XCTAssertEqual(
            todo["priority"] as? [String: String],
            ConvexTaggedInt64Encoder.encode(2),
        )
        XCTAssertNil(todo["category"])
        XCTAssertNil(todo["assignee"])
        XCTAssertNil(todo["updatedAtMs"])
    }

    func testTaskUpdateRequiresAndEchoesExactAuthoritativeRevision() throws {
        let revision = 1_777_777_777_777.0
        let payload = try TodoDeviceWritePayload(LegacyTodoDTO(
            id: "existing-task",
            title: "Updated",
            owner: FamilyMember.rachel.rawValue,
            updatedAtMs: revision,
        ))
        let args = try AppWritebackClient.todoUpsertArguments(
            payload,
            activeProfile: .rachel,
            operation: .update,
            baseUpdatedAtMs: revision,
            deviceID: "device-id",
            deviceToken: "device-token",
        )

        XCTAssertEqual(args["operation"] as? String, "update")
        XCTAssertEqual(args["baseUpdatedAtMs"] as? Double, revision)
        XCTAssertThrowsError(try AppWritebackClient.todoUpsertArguments(
            payload,
            activeProfile: .rachel,
            operation: .update,
            baseUpdatedAtMs: nil,
            deviceID: "device-id",
            deviceToken: "device-token",
        )) { error in
            Self.assertRemoteCode(error, .revisionRequired)
        }
        XCTAssertThrowsError(try AppWritebackClient.todoUpsertArguments(
            payload,
            activeProfile: .rachel,
            operation: .update,
            baseUpdatedAtMs: 1.5,
            deviceID: "device-id",
            deviceToken: "device-token",
        )) { error in
            Self.assertRemoteCode(error, .validationFailed)
        }
    }

    func testDeleteAndRestoreSendOnlyIdentityEchoesAndRevision() throws {
        let revision = 1_888_888_888_888.0
        let delete = try AppWritebackClient.todoDeleteArguments(
            id: "task-1",
            activeProfile: .maddox,
            owner: .maddox,
            baseUpdatedAtMs: revision,
            deviceID: "device-id",
            deviceToken: "device-token",
        )
        let restore = try AppWritebackClient.todoRestoreArguments(
            id: "task-1",
            activeProfile: .maddox,
            owner: .maddox,
            baseUpdatedAtMs: revision,
            deviceID: "device-id",
            deviceToken: "device-token",
        )

        let expectedKeys = Set([
            "deviceId", "deviceToken", "activeProfile", "owner", "sourceFile", "entityId", "baseUpdatedAtMs",
        ])
        XCTAssertEqual(Set(delete.keys), expectedKeys)
        XCTAssertEqual(Set(restore.keys), expectedKeys)
        XCTAssertNil(restore["todo"], "Restore must use the server-owned capsule.")
        XCTAssertEqual(restore["baseUpdatedAtMs"] as? Double, revision)
    }

    func testLegacyRevisionlessDeleteAndRestoreFailClosed() {
        for builder in [AppWritebackClient.todoDeleteArguments, AppWritebackClient.todoRestoreArguments] {
            XCTAssertThrowsError(try builder(
                "legacy-task",
                .victor,
                .victor,
                nil,
                "device-id",
                "device-token",
            )) { error in
                Self.assertRemoteCode(error, .revisionRequired)
            }
        }
    }

    func testTaskOwnerEchoMustMatchTheActiveProfile() throws {
        let payload = try TodoDeviceWritePayload(LegacyTodoDTO(
            id: "private-task",
            title: "Private",
            owner: FamilyMember.mason.rawValue,
        ))
        XCTAssertThrowsError(try AppWritebackClient.todoUpsertArguments(
            payload,
            activeProfile: .victor,
            operation: .create,
            baseUpdatedAtMs: nil,
            deviceID: "device-id",
            deviceToken: "device-token",
        )) { error in
            Self.assertRemoteCode(error, .ownerMismatch)
        }
    }

    func testTaskRemoteErrorsKeepSecurityAndConflictCodes() {
        XCTAssertEqual(
            AppWritebackClient.remoteErrorCode(from: [
                "code": "PROFILE_BINDING_REQUIRED",
                "message": "masked",
            ]),
            .profileBindingRequired,
        )
        XCTAssertEqual(
            AppWritebackClient.remoteErrorCode(from: "{\"code\":\"REVISION_REQUIRED\",\"message\":\"masked\"}"),
            .revisionRequired,
        )
        XCTAssertNil(AppWritebackClient.remoteErrorCode(from: ["code": "UNKNOWN_SERVER_CODE"]))

        XCTAssertEqual(
            ConvexWriteResult.classify(AppWritebackError.remote(.profileBindingRequired)).diagnosticCode,
            "PROFILE_BINDING_REQUIRED",
        )
        XCTAssertEqual(
            ConvexWriteResult.classify(AppWritebackError.remote(.revisionRequired)).diagnosticCode,
            "REVISION_REQUIRED",
        )
        XCTAssertEqual(
            ConvexWriteResult.classify(AppWritebackError.remote(.entityConflict)),
            .failed(.staleWrite),
        )
    }

    @MainActor
    func testTaskContractFailuresAreNeverRetried() async {
        let errors: [(AppWritebackError, ConvexWriteResult)] = [
            (.remote(.profileBindingRequired), .failed(.profileBindingRequired)),
            (.remote(.revisionRequired), .failed(.revisionRequired)),
            (.remote(.entityConflict), .failed(.staleWrite)),
        ]
        for (error, expected) in errors {
            var attempts = 0
            let result = await AppWriteSyncService.withRetry(
                label: "task contract",
                maxRetryCount: 2,
                retryDelayNanoseconds: 0,
            ) {
                attempts += 1
                throw error
            }
            XCTAssertEqual(result, expected)
            XCTAssertEqual(attempts, 1)
        }
    }

    @MainActor
    func testTransportRetryKeepsTheSameTaskPayloadAndRevision() async throws {
        let payload = try TodoDeviceWritePayload(LegacyTodoDTO(
            id: "retry-task",
            title: "Retry exactly",
            owner: FamilyMember.mason.rawValue,
        ))
        let arguments = try AppWritebackClient.todoUpsertArguments(
            payload,
            activeProfile: .mason,
            operation: .update,
            baseUpdatedAtMs: 42,
            deviceID: "device-id",
            deviceToken: "device-token",
        )
        var attempts: [[String: Any]] = []
        let result = await AppWriteSyncService.withRetry(
            label: "task retry",
            maxRetryCount: 1,
            retryDelayNanoseconds: 0,
        ) {
            attempts.append(arguments)
            if attempts.count == 1 { throw URLError(.timedOut) }
        }

        XCTAssertEqual(result, .ok)
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(
            try JSONSerialization.data(withJSONObject: attempts[0]),
            try JSONSerialization.data(withJSONObject: attempts[1]),
        )
    }

    private static func assertRemoteCode(
        _ error: Error,
        _ expected: AppWritebackRemoteErrorCode,
        file: StaticString = #filePath,
        line: UInt = #line,
    ) {
        guard case let AppWritebackError.remote(actual) = error else {
            return XCTFail("Expected remote task error, received \(error)", file: file, line: line)
        }
        XCTAssertEqual(actual, expected, file: file, line: line)
    }
}
