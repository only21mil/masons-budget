import SwiftUI

/// Per-screen state for one in-flight write and its outcome.
///
/// Exists so a view can consume a `ConvexWriteResult` callback without the
/// callback capturing the view. `AppWriteSyncService`'s `onResult` is
/// `@MainActor @Sendable`, and a SwiftUI `View` struct holding a `ModelContext`
/// is not `Sendable`; a `@MainActor` class is. That is also why `TodayView` had
/// to route its callback through a `static` function.
///
/// The behaviour it standardises: hold the sheet open while the write is in
/// flight, then show the CAUSE of a rejection instead of closing as if the save
/// had landed.
@MainActor
final class WriteFeedbackStore: ObservableObject {
    /// True while a write is in flight. Views disable their save affordance on it.
    @Published private(set) var isSaving = false

    /// The user-visible message for the last rejection, or nil.
    @Published private(set) var message: String?

    /// The last rejection cause, for views that branch rather than render.
    @Published private(set) var lastResult: ConvexWriteResult?

    /// A retry action owns the stable create ID and its persisted optimistic
    /// row. The add sheet disables a second Save until that action resolves.
    var isRetryPending: Bool { lastResult?.isRetryable == true }

    /// A local database rejection is separate from the remote result channel.
    @Published private(set) var lastLocalFailure: LocalSaveFailure?

    func begin() {
        isSaving = true
        message = nil
        lastResult = nil
        lastLocalFailure = nil
    }

    /// Records a local rejection that never reached the write seam.
    func reject(_ text: String) {
        isSaving = false
        message = text
        lastResult = nil
        lastLocalFailure = nil
    }

    func failLocal(_ failure: LocalSaveFailure, operation: String) {
        isSaving = false
        message = failure.userMessage(operation: operation)
        lastResult = nil
        lastLocalFailure = failure
    }

    /// Records a write outcome. Returns true only when the write was accepted,
    /// so callers can gate `dismiss()` on it.
    @discardableResult
    func finish(_ result: ConvexWriteResult, operation: String) -> Bool {
        isSaving = false
        lastResult = result
        lastLocalFailure = nil
        message = result.userMessage(operation: operation)
        return result.isOk
    }

    func clear() {
        message = nil
        lastResult = nil
        lastLocalFailure = nil
    }
}

/// Aggregate outcome of a batch of writes, e.g. a CSV import.
///
/// A batch used to be `transactions.forEach { push($0) }` with no result at all,
/// so an import could half-land and report "N transactions added" regardless.
@MainActor
final class WriteBatchTally: ObservableObject {
    @Published private(set) var expected = 0
    @Published private(set) var completed = 0
    @Published private(set) var succeeded = 0
    /// The first rejection cause seen. Batches fail for one shared reason far
    /// more often than for N different ones.
    @Published private(set) var firstFailure: ConvexWriteResult?
    /// A local batch save failure prevents every remote write from starting.
    @Published private(set) var localFailure: LocalSaveFailure?

    var failed: Int { localFailure == nil ? completed - succeeded : expected }
    var isFinished: Bool { expected > 0 && (localFailure != nil || completed >= expected) }
    var isRunning: Bool { expected > 0 && localFailure == nil && completed < expected }

    func start(expected count: Int) {
        expected = count
        completed = 0
        succeeded = 0
        firstFailure = nil
        localFailure = nil
    }

    func record(_ result: ConvexWriteResult) {
        completed += 1
        if result.isOk {
            succeeded += 1
        } else if firstFailure == nil {
            firstFailure = result
        }
    }

    func recordLocalFailure(_ failure: LocalSaveFailure) {
        completed = expected
        succeeded = 0
        firstFailure = nil
        localFailure = failure
    }

    /// The user-visible summary, or nil when every write in the batch landed.
    func summary(operation: String) -> String? {
        if let localFailure {
            return localFailure.userMessage(operation: operation)
        }
        guard failed > 0, let firstFailure else { return nil }
        let cause = firstFailure.userMessage(operation: operation) ?? "unknown cause"
        return "\(failed) of \(expected) did not sync — \(cause)"
    }
}
