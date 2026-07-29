import SwiftUI

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
    /// Whether a Retry affordance should be offered. A rejected credential or an
    /// unwritable amount cannot be fixed by trying again.
    @Published private(set) var canRetry = false

    private var retryAction: (@MainActor @Sendable () -> Void)?

    func begin(_ operation: String) {
        if phase == .failed, lastOperation == operation, pendingCount == 0 {
            return
        }

        pendingCount += 1
        lastOperation = operation
        if phase != .failed {
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
        pendingCount = max(0, pendingCount - 1)
        lastOperation = operation

        if result.isOk {
            if pendingCount == 0 {
                phase = .idle
                lastError = nil
                lastResult = nil
                retryAction = nil
                canRetry = false
            } else if phase != .failed {
                phase = .syncing
            }
        } else {
            phase = .failed
            lastError = result.userMessage(operation: operation) ?? "\(operation) did not sync"
            lastResult = result
            retryAction = result.isRetryable ? retry : nil
            canRetry = retryAction != nil
        }
    }

    func retry() {
        guard let retryAction else { return }
        lastError = nil
        lastResult = nil
        self.retryAction = nil
        canRetry = false
        phase = pendingCount > 0 ? .syncing : .idle
        retryAction()
    }

    func dismissFailure() {
        guard phase == .failed else { return }
        lastError = nil
        lastResult = nil
        retryAction = nil
        canRetry = false
        phase = pendingCount > 0 ? .syncing : .idle
    }
}
