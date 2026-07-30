import Foundation
import SwiftData
import SwiftUI

struct DeletedTodoSnapshot: Identifiable {
    let id: String
    let title: String
    let project: String?
    let area: String?
    let dueDate: Date?
    let priority: Int
    let isFlagged: Bool
    let isDone: Bool
    let owner: String
    let createdBy: String
    let updatedAt: Date
    let sourceFile: String?

    init(todo: TodoItem) {
        id = todo.id
        title = todo.title
        project = todo.project
        area = todo.area
        dueDate = todo.dueDate
        priority = todo.priority
        isFlagged = todo.isFlagged
        isDone = todo.isDone
        owner = todo.owner
        createdBy = todo.createdBy
        updatedAt = todo.updatedAt
        sourceFile = todo.sourceFile
    }

    func restoredTodo() -> TodoItem {
        let todo = TodoItem(
            id: id,
            title: title,
            project: project,
            area: area,
            dueDate: dueDate,
            priority: priority,
            isFlagged: isFlagged,
            isDone: isDone,
            owner: FamilyMember(rawValue: owner) ?? .victor,
            createdBy: createdBy,
            updatedAt: updatedAt,
            sourceFile: sourceFile,
        )
        todo.owner = owner
        return todo
    }

    func apply(to todo: TodoItem) {
        todo.title = title
        todo.project = project
        todo.area = area
        todo.dueDate = dueDate
        todo.priority = priority
        todo.isFlagged = isFlagged
        todo.isDone = isDone
        todo.owner = owner
        todo.createdBy = createdBy
        todo.updatedAt = updatedAt
        todo.sourceFile = sourceFile
    }
}

/// Owns the narrow SwiftData undo group for one attempted todo deletion.
///
/// A temporary undo manager restores the registered model instance if the save
/// fails, without rolling back unrelated pending edits or changing the caller's
/// existing undo history.
@MainActor
final class TodoDeleteRollback {
    private let modelContext: ModelContext
    private let undoManager: UndoManager
    private let previousUndoManager: UndoManager?
    private var isActive = true

    init(todo: TodoItem, in modelContext: ModelContext) {
        self.modelContext = modelContext
        previousUndoManager = modelContext.undoManager
        undoManager = UndoManager()
        undoManager.groupsByEvent = false

        // Flush earlier edits before installing the operation-local manager so
        // the delete is the only change captured by this undo group.
        modelContext.processPendingChanges()
        modelContext.undoManager = undoManager
        undoManager.beginUndoGrouping()
        modelContext.delete(todo)
        modelContext.processPendingChanges()
        undoManager.endUndoGrouping()
    }

    func restore() {
        guard isActive else { return }
        undoManager.undo()
        modelContext.processPendingChanges()
        finish()
    }

    func commit() {
        guard isActive else { return }
        finish()
    }

    private func finish() {
        modelContext.undoManager = previousUndoManager
        isActive = false
    }
}

@MainActor
final class TaskUndoStore: ObservableObject {
    static let shared = TaskUndoStore()

    @Published private(set) var pending: DeletedTodoSnapshot?

    private var expiryTask: Task<Void, Never>?

    private init() {}

    @discardableResult
    func delete(_ todo: TodoItem, in modelContext: ModelContext) -> Bool {
        let snapshot = DeletedTodoSnapshot(todo: todo)
        let rollback = Self.beginTrackedDelete(todo, in: modelContext)
        return LocalMutationSave.perform(operation: "Delete todo", in: modelContext, rollbackMutation: {
            Self.restoreFailedDelete(rollback)
        }) {
            rollback.commit()
            clearPending()
            present(snapshot)
            AppWriteSyncService.deleteTodo(id: snapshot.id)
        }
    }

    func restore(in modelContext: ModelContext) {
        guard let snapshot = pending else { return }
        let previous: DeletedTodoSnapshot?
        let todo: TodoItem
        if let existing = existingTodo(id: snapshot.id, in: modelContext) {
            previous = DeletedTodoSnapshot(todo: existing)
            snapshot.apply(to: existing)
            todo = existing
        } else {
            previous = nil
            let restored = snapshot.restoredTodo()
            modelContext.insert(restored)
            todo = restored
        }
        LocalMutationSave.perform(operation: "Restore todo", in: modelContext, rollbackMutation: {
            if let previous {
                previous.apply(to: todo)
            } else {
                modelContext.delete(todo)
            }
        }) {
            clearPending()
            AppWriteSyncService.pushTodo(todo)
        }
    }

    func dismiss() {
        clearPending()
    }

    private func present(_ snapshot: DeletedTodoSnapshot) {
        expiryTask?.cancel()
        pending = snapshot
        expiryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.clearPending(matching: snapshot.id)
            }
        }
    }

    private func clearPending(matching id: String? = nil) {
        if let id, pending?.id != id { return }
        expiryTask?.cancel()
        expiryTask = nil
        pending = nil
    }

    private func existingTodo(id: String, in modelContext: ModelContext) -> TodoItem? {
        let descriptor = FetchDescriptor<TodoItem>(
            predicate: #Predicate { todo in
                todo.id == id
            },
        )
        return try? modelContext.fetch(descriptor).first
    }

    static func beginTrackedDelete(
        _ todo: TodoItem,
        in modelContext: ModelContext,
    ) -> TodoDeleteRollback {
        TodoDeleteRollback(todo: todo, in: modelContext)
    }

    static func restoreFailedDelete(_ rollback: TodoDeleteRollback) {
        rollback.restore()
    }
}
