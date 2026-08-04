import SwiftData

/// The complete lifecycle of one Save tap, shared by the add-entry views and
/// their regression tests so the tested path IS the shipped path: optimistic
/// insert, local save with rollback on persistence failure, remote push, and
/// rollback of the saved rows on any non-accepted remote result.
///
/// The rollback on rejection is what makes the stable per-session create ID
/// safe: the retry re-inserts the same ID against a clean store instead of
/// colliding with the leftover optimistic row, while the server dedupes the
/// re-sent ID on its side. An ambiguous result (transport loss after a server
/// commit) also rolls back locally — the retry or the next sync refresh
/// restores the row from the server's authoritative copy.
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
                if !result.isOk {
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
