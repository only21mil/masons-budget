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

    private struct RetainedFailure {
        let operation: String
        let message: String
        let result: ConvexWriteResult?
        let localFailure: LocalSaveFailure?
        let retryAction: (@MainActor @Sendable () -> Void)?
    }

    private var activeOperationIDs: Set<UUID> = []
    private var retainedFailures: [UUID: RetainedFailure] = [:]
    private var failureOrder: [UUID] = []
    private var displayedFailureID: UUID?

    @discardableResult
    func begin(_ operation: String) -> UUID {
        let id = UUID()
        begin(operation, id: id)
        return id
    }

    func begin(_ operation: String, id: UUID) {
        activeOperationIDs.insert(id)
        pendingCount = activeOperationIDs.count
        if retainedFailures.isEmpty {
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
        id: UUID,
        result: ConvexWriteResult,
        retry: (@MainActor @Sendable () -> Void)? = nil,
    ) {
        activeOperationIDs.remove(id)
        pendingCount = activeOperationIDs.count

        if result.isOk {
            removeFailure(id: id)
            refreshPresentation(fallbackOperation: operation)
        } else {
            retainFailure(
                id: id,
                operation: operation,
                message: result.userMessage(operation: operation) ?? "\(operation) did not sync",
                result: result,
                localFailure: nil,
                retry: result.isRetryable ? retry : nil,
            )
        }
    }

    /// Records a local database rejection. It cannot be represented as a remote
    /// result because writeback was deliberately never started.
    func recordLocalFailure(_ operation: String, failure: LocalSaveFailure) {
        retainFailure(
            id: UUID(),
            operation: operation,
            message: failure.userMessage(operation: operation),
            result: nil,
            localFailure: failure,
            retry: nil,
        )
    }

    func retry() {
        guard let id = displayedFailureID,
              let retryAction = retainedFailures[id]?.retryAction
        else { return }
        removeFailure(id: id)
        refreshPresentation()
        retryAction()
    }

    func dismissFailure() {
        guard let id = displayedFailureID else { return }
        removeFailure(id: id)
        refreshPresentation()
    }

    var retainedFailureCount: Int {
        retainedFailures.count
    }

    func resetForTesting() {
        activeOperationIDs.removeAll()
        retainedFailures.removeAll()
        failureOrder.removeAll()
        displayedFailureID = nil
        pendingCount = 0
        lastOperation = nil
        lastError = nil
        lastResult = nil
        lastLocalFailure = nil
        canRetry = false
        phase = .idle
    }

    private func retainFailure(
        id: UUID,
        operation: String,
        message: String,
        result: ConvexWriteResult?,
        localFailure: LocalSaveFailure?,
        retry: (@MainActor @Sendable () -> Void)?,
    ) {
        if retainedFailures[id] == nil {
            failureOrder.append(id)
        }
        retainedFailures[id] = RetainedFailure(
            operation: operation,
            message: message,
            result: result,
            localFailure: localFailure,
            retryAction: retry,
        )
        if displayedFailureID == nil {
            displayedFailureID = id
        }
        refreshPresentation()
    }

    private func removeFailure(id: UUID) {
        retainedFailures.removeValue(forKey: id)
        failureOrder.removeAll { $0 == id }
        if displayedFailureID == id {
            displayedFailureID = nil
        }
    }

    private func refreshPresentation(fallbackOperation: String? = nil) {
        if displayedFailureID == nil {
            displayedFailureID = failureOrder.first(where: { retainedFailures[$0] != nil })
        }

        if let id = displayedFailureID,
           let failure = retainedFailures[id]
        {
            lastOperation = failure.operation
            lastError = failure.message
            lastResult = failure.result
            lastLocalFailure = failure.localFailure
            canRetry = failure.retryAction != nil
            phase = .failed
            return
        }

        lastOperation = fallbackOperation ?? lastOperation
        lastError = nil
        lastResult = nil
        lastLocalFailure = nil
        canRetry = false
        phase = pendingCount > 0 ? .syncing : .idle
    }
}
