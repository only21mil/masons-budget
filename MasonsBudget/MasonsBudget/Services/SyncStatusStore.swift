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

    func complete(
        _ operation: String,
        success: Bool,
        retry: (@MainActor @Sendable () -> Void)? = nil,
    ) {
        pendingCount = max(0, pendingCount - 1)
        lastOperation = operation

        if success {
            if pendingCount == 0 {
                phase = .idle
                lastError = nil
                retryAction = nil
            } else if phase != .failed {
                phase = .syncing
            }
        } else {
            phase = .failed
            lastError = "\(operation) did not sync"
            retryAction = retry
        }
    }

    func retry() {
        guard let retryAction else { return }
        lastError = nil
        self.retryAction = nil
        phase = pendingCount > 0 ? .syncing : .idle
        retryAction()
    }

    func dismissFailure() {
        guard phase == .failed else { return }
        lastError = nil
        retryAction = nil
        phase = pendingCount > 0 ? .syncing : .idle
    }
}
