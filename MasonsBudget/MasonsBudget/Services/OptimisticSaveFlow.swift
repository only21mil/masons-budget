import SwiftData

/// The complete lifecycle of one Save tap, shared by the add-entry views and
/// their regression tests so the tested path IS the shipped path: optimistic
/// insert, local save with rollback on persistence failure, remote push, and
/// rollback of the saved rows on a terminal remote rejection.
///
/// The rollback on rejection is what makes the stable per-session create ID
/// safe: a corrected Save tap re-inserts the same ID against a clean store
/// instead of colliding with a rejected optimistic row. Retryable and ambiguous
/// failures deliberately keep the local row, because AppWriteSyncService retains
/// a payload-only retry closure. Keeping the model attached lets a successful
/// retry install the accepted revision without waiting for a later full sync.
@MainActor
enum OptimisticSaveFlow {
    @discardableResult
    static func run(
        models: [any PersistentModel],
        operation: String,
        in context: ModelContext,
        feedback: WriteFeedbackStore,
        push: (@escaping @MainActor @Sendable (ConvexWriteResult) -> Void) -> Void,
        afterResult: @escaping @MainActor (ConvexWriteResult) -> Void,
    ) -> Bool {
        for model in models { context.insert(model) }
        feedback.begin()
        return LocalMutationSave.perform(
            operation: operation,
            in: context,
            onFailure: { failure in
                feedback.failLocal(failure, operation: operation)
            },
            rollbackMutation: {
                for model in models { context.delete(model) }
            },
        ) {
            push { result in
                if !result.isOk, !result.isRetryable {
                    for model in models { context.delete(model) }
                    do {
                        try context.save()
                    } catch {
                        SyncStatusStore.shared.recordLocalFailure(
                            operation,
                            failure: .persistence,
                        )
                    }
                }
                _ = feedback.finish(result, operation: operation)
                afterResult(result)
            }
        }
    }
}
