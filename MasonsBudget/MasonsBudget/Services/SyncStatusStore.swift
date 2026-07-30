import SwiftData
import SwiftUI

/// A failure before a user mutation ever reaches Convex.
///
/// This is deliberately separate from `ConvexWriteResult`: the remote service
/// cannot reject a write that was never committed to the device database.
enum LocalSaveFailure: Equatable {
    case persistence

    func userMessage(operation: String) -> String {
        switch self {
        case .persistence:
            "\(operation) was not saved on this device (the local database rejected the change)"
        }
    }
}

/// The narrow context surface needed to make local persistence a testable
/// production gate. `ModelContext` is the production implementation; tests use a
/// throwing context to prove a failed save cannot start remote writeback.
@MainActor
protocol LocalMutationContext: AnyObject {
    func save() throws
}

extension ModelContext: LocalMutationContext {}

/// Commits one user mutation locally before allowing its remote write to start.
///
/// Every app-originated mutation must pass through this function. Keeping the
/// local save and the remote closure in one production path prevents a caller
/// from ignoring a save error and continuing to Convex.
@MainActor
enum LocalMutationSave {
    @discardableResult
    static func perform(
        operation: String,
        in context: any LocalMutationContext,
        statusStore: SyncStatusStore? = nil,
        onFailure: ((LocalSaveFailure) -> Void)? = nil,
        rollbackMutation: () -> Void,
        remoteWrite: () -> Void,
    ) -> Bool {
        do {
            try context.save()
        } catch {
            // Undo only the mutation owned by this operation. ModelContext's
            // broad rollback would also discard unrelated pending edits.
            rollbackMutation()
            let failure = LocalSaveFailure.persistence
            (statusStore ?? .shared).recordLocalFailure(operation, failure: failure)
            onFailure?(failure)
            return false
        }

        remoteWrite()
        return true
    }
}

@MainActor
final class SyncStatusStore: ObservableObject {
    static let shared = SyncStatusStore()

    enum Phase: Equatable {
        case idle
        case syncing
        case failed
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var pendingCount = 0
    @Published private(set) var lastOperation: String?
    @Published private(set) var lastError: String?
    /// The cause of the current failure, for surfaces that branch on it rather
    /// than render `lastError`.
    @Published private(set) var lastResult: ConvexWriteResult?
    /// A device-database failure is not a Convex result: no remote write started.
    @Published private(set) var lastLocalFailure: LocalSaveFailure?
    /// Whether a Retry affordance should be offered. A rejected credential or an
    /// unwritable amount cannot be fixed by trying again.
    @Published private(set) var canRetry = false

    private var retryAction: (@MainActor @Sendable () -> Void)?
    private var activeOperationIDs: Set<UUID> = []
    private var queuedOperationIDs: [String: [UUID]] = [:]
    private var failedOperationID: UUID?

    func begin(_ operation: String) {
        let id = UUID()
        queuedOperationIDs[operation, default: []].append(id)
        begin(operation, id: id)
    }

    func begin(_ operation: String, id: UUID) {
        activeOperationIDs.insert(id)
        pendingCount = activeOperationIDs.count
        if phase != .failed {
            lastOperation = operation
            phase = .syncing
        }
    }

    /// Records the outcome of one write.
    ///
    /// Takes the cause, not a `Bool`: the banner used to read "<operation> did not
    /// sync" for a missing credential, an unauthorized profile and a rejected
    /// amount alike, which is the defect this type exists to remove.
    func complete(
        _ operation: String,
        result: ConvexWriteResult,
        retry: (@MainActor @Sendable () -> Void)? = nil,
    ) {
        let id: UUID
        if var queued = queuedOperationIDs[operation], !queued.isEmpty {
            id = queued.removeFirst()
            queuedOperationIDs[operation] = queued
        } else {
            id = UUID()
        }
        if queuedOperationIDs[operation]?.isEmpty == true {
            queuedOperationIDs.removeValue(forKey: operation)
        }
        complete(operation, id: id, result: result, retry: retry)
    }

    func complete(
        _ operation: String,
        id: UUID,
        result: ConvexWriteResult,
        retry: (@MainActor @Sendable () -> Void)? = nil,
    ) {
        activeOperationIDs.remove(id)
        pendingCount = activeOperationIDs.count

        if result.isOk {
            // A later success from another operation cannot erase this failure.
            guard failedOperationID == nil || failedOperationID == id else { return }
            failedOperationID = nil
            lastOperation = operation
            if pendingCount == 0 {
                phase = .idle
                lastError = nil
                lastResult = nil
                lastLocalFailure = nil
                retryAction = nil
                canRetry = false
            } else {
                phase = .syncing
            }
        } else {
            failedOperationID = id
            lastOperation = operation
            phase = .failed
            lastError = result.userMessage(operation: operation) ?? "\(operation) did not sync"
            lastResult = result
            lastLocalFailure = nil
            retryAction = result.isRetryable ? retry : nil
            canRetry = retryAction != nil
        }
    }

    /// Records a local database rejection. It cannot be represented as a remote
    /// result because writeback was deliberately never started.
    func recordLocalFailure(_ operation: String, failure: LocalSaveFailure) {
        lastOperation = operation
        phase = .failed
        lastError = failure.userMessage(operation: operation)
        lastResult = nil
        lastLocalFailure = failure
        // A local-save failure has no remote operation id, but it is still
        // sticky against unrelated remote completions until dismissed.
        failedOperationID = UUID()
        retryAction = nil
        canRetry = false
    }

    func retry() {
        guard let retryAction else { return }
        lastError = nil
        lastResult = nil
        lastLocalFailure = nil
        self.retryAction = nil
        failedOperationID = nil
        canRetry = false
        phase = pendingCount > 0 ? .syncing : .idle
        retryAction()
    }

    func dismissFailure() {
        guard phase == .failed else { return }
        lastError = nil
        lastResult = nil
        lastLocalFailure = nil
        retryAction = nil
        failedOperationID = nil
        canRetry = false
        phase = pendingCount > 0 ? .syncing : .idle
    }
}
