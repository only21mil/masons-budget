import SwiftData
import SwiftUI

/// Edit a single todo (SAT-1335). Todos were previously uneditable — this is the
/// authoring surface: title, optional due date, project/area, priority, flag, plus
/// delete with undo. Saves stamp `updatedAt` and push through the
/// multi-profile writeback path (sync status is surfaced by AppWriteSyncService).
struct TaskDetailView: View {
    @Environment(\.theme) var theme
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

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

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    var body: some View {
        if activeMember.canAccessTodo(ownedBy: todo.ownerMember) {
            taskEditor
        } else {
            Color.clear.onAppear { dismiss() }
        }
    }

    private var taskEditor: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: "Task", eyebrow: todo.isDone ? "Completed" : "Editing")

                fieldCard("TITLE") {
                    TextField("Task title", text: $title, axis: .vertical)
                        .textFieldStyle(.plain)
                        .ledgerType(.textInput)
                        .foregroundStyle(theme.text)
                }

                fieldCard("DUE DATE") {
                    LedgerToggle(isOn: $hasDueDate.animation()) {
                        Text("Has a due date")
                            .ledgerType(.rowPrimary)
                            .foregroundStyle(theme.text)
                    }
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
                        .ledgerType(.textInput)
                        .foregroundStyle(theme.text)
                }

                fieldCard("AREA") {
                    TextField("None", text: $area)
                        .textFieldStyle(.plain)
                        .ledgerType(.textInput)
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
                    LedgerToggle(isOn: $isFlagged) {
                        HStack(spacing: 8) {
                            Image(systemName: AppIcon.flagFilled)
                                .foregroundStyle(theme.accent)
                            Text("Flagged")
                                .ledgerType(.rowPrimary)
                                .foregroundStyle(theme.text)
                        }
                    }
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
                .ledgerType(.sectionLabel)
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
                .ledgerType(.button)
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
                .ledgerType(.rowPrimary)
                .foregroundStyle(theme.danger)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
        }
        .buttonStyle(.plain)
    }

    private func save() {
        guard activeMember.canAccessTodo(ownedBy: todo.ownerMember) else {
            dismiss()
            return
        }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let previous = DeletedTodoSnapshot(todo: todo)
        todo.title = trimmed
        todo.dueDate = hasDueDate ? dueDate : nil
        todo.project = project.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : project
        todo.area = area.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : area
        todo.priority = priority
        todo.isFlagged = isFlagged
        todo.updatedAt = .now
        todo.hasServerAuthority = false
        guard TaskMutationSave.perform(operation: "Todo", in: modelContext, rollbackMutation: {
            previous.apply(to: todo)
        }, remoteWrite: { completion in
            AppWriteSyncService.pushTodo(todo, onResult: completion)
        }) else {
            return
        }
        dismiss()
    }

    private func deleteTask() {
        guard activeMember.canAccessTodo(ownedBy: todo.ownerMember) else {
            dismiss()
            return
        }
        if TaskUndoStore.shared.delete(todo, in: modelContext) {
            dismiss()
        }
    }
}
