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
        resolveResult: @escaping @MainActor @Sendable (ConvexWriteResult) -> ConvexWriteResult = { $0 },
        afterResult: @escaping @MainActor (ConvexWriteResult) -> Void,
    ) -> Bool {
        guard !feedback.isSaving, !feedback.isRetryPending else { return false }
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
                let resolvedResult = resolveResult(result)
                if !resolvedResult.isOk, !resolvedResult.isRetryable {
                    for model in models { context.delete(model) }
                    do {
                        try context.save()
                    } catch {
                        SyncStatusStore.shared.recordLocalFailure(
                            operation,
                            failure: .persistence,
                        )
                    }
                } else {
                    // A remote writer may install accepted metadata or a
                    // durable retry-pending marker before delivering its
                    // result. Persist any such state now; otherwise an app exit
                    // can lose the evidence needed to resolve a local-only row.
                    do {
                        try context.save()
                    } catch {
                        SyncStatusStore.shared.recordLocalFailure(
                            operation,
                            failure: .persistence,
                        )
                    }
                }
                _ = feedback.finish(resolvedResult, operation: operation)
                afterResult(resolvedResult)
            }
        }
    }

    /// A complete authoritative row snapshot can prove that an ambiguous create
    /// landed before its retained retry later receives a terminal response.
    /// Preserve that proven server row instead of rolling it back locally.
    static func resolveCreateResult(
        _ result: ConvexWriteResult,
        acceptedRevision: Double?,
    ) -> ConvexWriteResult {
        guard !result.isOk, !result.isRetryable, acceptedRevision != nil else {
            return result
        }
        return .ok
    }
}
