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

@MainActor
final class TaskUndoStore: ObservableObject {
    static let shared = TaskUndoStore()

    @Published private(set) var pending: DeletedTodoSnapshot?

    private var expiryTask: Task<Void, Never>?

    private init() {}

    func delete(_ todo: TodoItem, in modelContext: ModelContext) {
        let snapshot = DeletedTodoSnapshot(todo: todo)
        clearPending()
        modelContext.delete(todo)
        try? modelContext.save()
        present(snapshot)
        AppWriteSyncService.deleteTodo(id: snapshot.id)
    }

    func restore(in modelContext: ModelContext) {
        guard let snapshot = pending else { return }
        clearPending()
        let todo: TodoItem
        if let existing = existingTodo(id: snapshot.id, in: modelContext) {
            snapshot.apply(to: existing)
            todo = existing
        } else {
            let restored = snapshot.restoredTodo()
            modelContext.insert(restored)
            todo = restored
        }
        try? modelContext.save()
        AppWriteSyncService.pushTodo(todo)
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
}
