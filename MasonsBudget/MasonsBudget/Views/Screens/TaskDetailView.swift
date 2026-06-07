import SwiftData
import SwiftUI

/// Edit a single todo (SAT-1335). Todos were previously uneditable — this is the
/// authoring surface: title, optional due date, project/area, priority, flag, plus
/// delete-with-confirmation. Saves stamp `updatedAt` and push through the
/// multi-profile writeback path (sync status is surfaced by AppWriteSyncService).
struct TaskDetailView: View {
    @Environment(\.theme) var theme
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss

    let todo: TodoItem

    @State private var title: String
    @State private var hasDueDate: Bool
    @State private var dueDate: Date
    @State private var project: String
    @State private var area: String
    @State private var priority: Int
    @State private var isFlagged: Bool
    @State private var showDeleteConfirm = false

    init(todo: TodoItem) {
        self.todo = todo
        _title = State(initialValue: todo.title)
        _hasDueDate = State(initialValue: todo.dueDate != nil)
        _dueDate = State(initialValue: todo.dueDate ?? Date())
        _project = State(initialValue: todo.project ?? "")
        _area = State(initialValue: todo.area ?? "")
        _priority = State(initialValue: todo.priority)
        _isFlagged = State(initialValue: todo.isFlagged)
    }

    private static let priorityLabels = ["None", "Low", "Medium", "High"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: "Task", eyebrow: todo.isDone ? "Completed" : "Editing")

                fieldCard("TITLE") {
                    TextField("Task title", text: $title, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(theme.text)
                }

                fieldCard("DUE DATE") {
                    Toggle(isOn: $hasDueDate.animation()) {
                        Text("Has a due date")
                            .font(.system(size: 14))
                            .foregroundStyle(theme.text)
                    }
                    .tint(theme.accent)
                    if hasDueDate {
                        DatePicker("Due", selection: $dueDate, displayedComponents: .date)
                            .datePickerStyle(.compact)
                            .tint(theme.accent)
                            .labelsHidden()
                    }
                }

                fieldCard("PROJECT") {
                    TextField("None", text: $project)
                        .textFieldStyle(.plain)
                        .font(.system(size: 15))
                        .foregroundStyle(theme.text)
                }

                fieldCard("AREA") {
                    TextField("None", text: $area)
                        .textFieldStyle(.plain)
                        .font(.system(size: 15))
                        .foregroundStyle(theme.text)
                }

                fieldCard("PRIORITY") {
                    Picker("Priority", selection: $priority) {
                        ForEach(0 ..< Self.priorityLabels.count, id: \.self) { i in
                            Text(Self.priorityLabels[i]).tag(i)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                fieldCard("FLAG") {
                    Toggle(isOn: $isFlagged) {
                        HStack(spacing: 8) {
                            Image(systemName: AppIcon.flagFilled)
                                .foregroundStyle(theme.accent)
                            Text("Flagged")
                                .font(.system(size: 14))
                                .foregroundStyle(theme.text)
                        }
                    }
                    .tint(theme.accent)
                }

                saveButton
                deleteButton
            }
            .padding(.horizontal, AppLayout.sectionPadding)
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .confirmationDialog("Delete this task?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete task", role: .destructive, action: deleteTask)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(todo.title)
        }
    }

    private func fieldCard(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.system(size: 11, weight: .bold))
                .tracking(0.88)
                .foregroundStyle(theme.textMuted)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassCard(padding: 0)
    }

    private var saveButton: some View {
        Button(action: save) {
            Text("Save changes")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(theme.accent)
                .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .opacity(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.5 : 1)
    }

    private var deleteButton: some View {
        Button(role: .destructive) {
            showDeleteConfirm = true
        } label: {
            Text("Delete task")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(theme.danger)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
        }
        .buttonStyle(.plain)
    }

    private func save() {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        todo.title = trimmed
        todo.dueDate = hasDueDate ? dueDate : nil
        todo.project = project.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : project
        todo.area = area.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : area
        todo.priority = priority
        todo.isFlagged = isFlagged
        todo.updatedAt = .now
        try? modelContext.save()
        AppWriteSyncService.pushTodo(todo)
        dismiss()
    }

    private func deleteTask() {
        modelContext.delete(todo)
        try? modelContext.save()
        AppWriteSyncService.deleteTodo(todo)
        dismiss()
    }
}
