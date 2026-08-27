import SwiftData
import XCTest

@MainActor
final class TaskRevisionPersistenceTests: XCTestCase {
    private struct WriteCall: Equatable {
        let id: String
        let operation: TodoDeviceWriteOperation
        let baseUpdatedAtMs: Double?
    }

    private final class Harness {
        var writes: [WriteCall] = []
        var revisions: [Double] = []
        var writeError: Error?
        var readError: Error?
        var results: [ConvexWriteResult] = []
    }

    func testAcceptedCreateAndUpdatePersistTheRevisionUsedByTheNextMutation() async throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: TodoItem.self, configurations: configuration)
        let context = ModelContext(container)
        let todo = TodoItem(
            id: "revision-chain",
            title: "Create",
            owner: .mason,
            createdBy: "app",
        )
        let harness = Harness()
        harness.revisions = [1_800_000_000_001, 1_800_000_000_002]
        context.insert(todo)

        XCTAssertTrue(runMutation(
            todo,
            operation: "Create todo",
            in: context,
            rollback: { context.delete(todo) },
            harness: harness,
            statusStore: SyncStatusStore(),
        ))
        await waitForResults(1, in: harness)

        XCTAssertEqual(harness.results, [.ok])
        XCTAssertEqual(
            harness.writes,
            [WriteCall(id: todo.id, operation: .create, baseUpdatedAtMs: nil)],
        )
        XCTAssertEqual(todo.updatedAtMs, 1_800_000_000_001)
        XCTAssertTrue(todo.hasServerAuthority)
        try assertPersisted(
            id: todo.id,
            title: "Create",
            revision: 1_800_000_000_001,
            authoritative: true,
            in: container,
        )

        let previous = DeletedTodoSnapshot(todo: todo)
        todo.title = "Update"
        todo.updatedAt = Date(timeIntervalSince1970: 1_800_000_001)
        todo.hasServerAuthority = false
        XCTAssertTrue(runMutation(
            todo,
            operation: "Update todo",
            in: context,
            rollback: { previous.apply(to: todo) },
            harness: harness,
            statusStore: SyncStatusStore(),
        ))
        await waitForResults(2, in: harness)

        XCTAssertEqual(harness.results, [.ok, .ok])
        XCTAssertEqual(
            harness.writes,
            [
                WriteCall(id: todo.id, operation: .create, baseUpdatedAtMs: nil),
                WriteCall(
                    id: todo.id,
                    operation: .update,
                    baseUpdatedAtMs: 1_800_000_000_001,
                ),
            ],
        )
        XCTAssertEqual(todo.updatedAtMs, 1_800_000_000_002)
        XCTAssertTrue(todo.hasServerAuthority)
        try assertPersisted(
            id: todo.id,
            title: "Update",
            revision: 1_800_000_000_002,
            authoritative: true,
            in: container,
        )
    }

    func testConflictAndRevisionFailureRestoreThePersistedAuthoritativeState() async throws {
        let errors: [(AppWritebackError, ConvexWriteResult)] = [
            (.remote(.entityConflict), .failed(.staleWrite)),
            (.remote(.revisionRequired), .failed(.revisionRequired)),
        ]

        for (index, expected) in errors.enumerated() {
            let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
            let container = try ModelContainer(for: TodoItem.self, configurations: configuration)
            let context = ModelContext(container)
            let revision = 1_900_000_000_000.0 + Double(index)
            let todo = TodoItem(
                id: "rejected-\(index)",
                title: "Authoritative",
                owner: .rachel,
                createdBy: "app",
                updatedAtMs: revision,
                hasServerAuthority: true,
            )
            context.insert(todo)
            try context.save()
            let previous = DeletedTodoSnapshot(todo: todo)
            todo.title = "Rejected optimistic value"
            todo.updatedAt = Date(timeIntervalSince1970: 1_900_000_001)
            todo.hasServerAuthority = false
            let harness = Harness()
            harness.writeError = expected.0

            XCTAssertTrue(runMutation(
                todo,
                operation: "Update todo",
                in: context,
                rollback: { previous.apply(to: todo) },
                harness: harness,
                statusStore: SyncStatusStore(),
            ))
            await waitForResults(1, in: harness)

            XCTAssertEqual(harness.results, [expected.1])
            XCTAssertEqual(
                harness.writes,
                [WriteCall(id: todo.id, operation: .update, baseUpdatedAtMs: revision)],
            )
            XCTAssertTrue(harness.revisions.isEmpty, "A rejected write must not run the authority refresh.")
            try assertPersisted(
                id: todo.id,
                title: "Authoritative",
                revision: revision,
                authoritative: true,
                in: container,
            )
        }
    }

    func testAcceptedWriteRemainsSuccessfulWhenTerminalRevisionReadFails() async throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: TodoItem.self, configurations: configuration)
        let context = ModelContext(container)
        let todo = TodoItem(
            id: "accepted-refresh-http-403",
            title: "Keep one create",
            owner: .maddox,
            createdBy: "app",
        )
        let harness = Harness()
        harness.readError = ConvexError.httpError(403)
        let statusStore = SyncStatusStore()
        context.insert(todo)

        XCTAssertTrue(runMutation(
            todo,
            operation: "Create todo",
            in: context,
            rollback: { context.delete(todo) },
            harness: harness,
            statusStore: statusStore,
        ))
        await waitForResults(1, in: harness)

        XCTAssertEqual(harness.results, [.ok])
        XCTAssertEqual(harness.writes.count, 1)
        XCTAssertFalse(todo.hasServerAuthority)
        XCTAssertFalse(statusStore.canRetry)
        XCTAssertNil(statusStore.lastError)

        harness.readError = nil
        harness.revisions = [1_800_000_000_003]
        statusStore.retry()

        XCTAssertEqual(harness.results, [.ok])
        XCTAssertEqual(harness.revisions, [1_800_000_000_003])
        XCTAssertEqual(
            harness.writes,
            [WriteCall(id: todo.id, operation: .create, baseUpdatedAtMs: nil)],
            "An accepted create must not surface a mutation retry.",
        )
        let reloaded = ModelContext(container)
        let rows = try reloaded.fetch(FetchDescriptor<TodoItem>())
        let persisted = try XCTUnwrap(rows.first(where: { $0.id == todo.id }))
        XCTAssertEqual(persisted.title, todo.title)
        XCTAssertNil(persisted.updatedAtMs)
        XCTAssertFalse(persisted.hasServerAuthority)
    }

    private func runMutation(
        _ todo: TodoItem,
        operation: String,
        in context: ModelContext,
        rollback: @escaping @MainActor @Sendable () -> Void,
        harness: Harness,
        statusStore: SyncStatusStore,
    ) -> Bool {
        TaskMutationSave.perform(
            operation: operation,
            in: context,
            rollbackMutation: rollback,
            remoteWrite: { completion in
                AppWriteSyncService.pushTodo(
                    todo,
                    statusStore: statusStore,
                    automaticRetries: 0,
                    retryDelayNanoseconds: 0,
                    preflight: { nil },
                    write: { payload, _, writeOperation, baseUpdatedAtMs in
                        harness.writes.append(WriteCall(
                            id: payload.id,
                            operation: writeOperation,
                            baseUpdatedAtMs: baseUpdatedAtMs,
                        ))
                        if let error = harness.writeError {
                            throw error
                        }
                    },
                    readRevision: { id, _ in
                        guard id == todo.id, !harness.revisions.isEmpty else {
                            throw harness.readError ?? AppWritebackError.unexpectedResponse
                        }
                        return harness.revisions.removeFirst()
                    },
                    onResult: completion,
                )
            },
            onResult: { harness.results.append($0) },
        )
    }

    private func assertPersisted(
        id: String,
        title: String,
        revision: Double,
        authoritative: Bool,
        in container: ModelContainer,
    ) throws {
        let reloaded = ModelContext(container)
        let rows = try reloaded.fetch(FetchDescriptor<TodoItem>())
        let todo = try XCTUnwrap(rows.first(where: { $0.id == id }))
        XCTAssertEqual(todo.title, title)
        XCTAssertEqual(todo.updatedAtMs, revision)
        XCTAssertEqual(todo.hasServerAuthority, authoritative)
    }

    private func waitForResults(_ count: Int, in harness: Harness) async {
        for _ in 0 ..< 100 {
            if harness.results.count >= count {
                return
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for \(count) task mutation results")
    }
}
