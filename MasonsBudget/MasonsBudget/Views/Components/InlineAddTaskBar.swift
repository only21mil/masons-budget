import SwiftData
import SwiftUI

/// Shared "add a task" affordance (SAT-1508). Collapsed it renders as a
/// prominent accent "New Task" row; expanded it shows the draft field.
/// Used by TodayView, TasksView, and TaskSmartListView so every task surface has a
/// visible place to create a todo manually.
struct InlineAddTaskBar: View {
    @Environment(\.theme) var theme
    @Environment(\.modelContext) private var modelContext
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    /// Pre-filled due date for the created task (e.g. today inside the Today list).
    var defaultDueDate: Date?
    /// Pre-set flag for the created task (e.g. inside the Flagged list).
    var defaultFlagged = false
    /// Optional writeback callback for surfaces that report sync failures. Carries
    /// the CAUSE of a rejection, not a bare success flag.
    var onResult: (@MainActor @Sendable (ConvexWriteResult) -> Void)?

    @Binding var isExpanded: Bool
    @State private var draftText = ""
    @State private var isSaving = false
    @State private var pendingTodo: TodoItem?
    @State private var writeMessage: String?
    @State private var showSetup = false
    @FocusState private var draftFocused: Bool

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    var body: some View {
        VStack(spacing: 0) {
            if isExpanded {
                HStack(spacing: 10) {
                    Image(systemName: AppIcon.checkOpen)
                        .font(AppFont.iconSmall)
                        .foregroundStyle(theme.borderStrong)
                    TextField("New task", text: $draftText)
                        .textFieldStyle(.plain)
                        .ledgerType(.textInput)
                        .foregroundStyle(theme.text)
                        .focused($draftFocused)
                        .disabled(isSaving || pendingTodo != nil)
                        .onSubmit(addTask)
                    if AppWritebackConfig.canWriteTasks {
                        Button(isSaving ? "Saving" : "Add", action: addTask)
                            .ledgerType(.button)
                            .foregroundStyle(theme.accent)
                            .buttonStyle(.plain)
                            .disabled(isSaving || draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    } else {
                        Button("Open Sync Setup") { showSetup = true }
                            .ledgerType(.button)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .glassCard(padding: 0)
            } else {
                Button {
                    isExpanded = true
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "plus.circle.fill")
                            .font(AppFont.iconMedium)
                            .foregroundStyle(theme.accent)
                        Text("New Task")
                            .ledgerType(.button)
                            .foregroundStyle(theme.accent)
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .glassCard(padding: 0)
                .overlay(
                    RoundedRectangle(cornerRadius: AppLayout.radiusLarge)
                        .stroke(theme.accent.opacity(0.35), lineWidth: 1),
                )
            }
        }
        .sheet(isPresented: $showSetup) { NavigationStack { SyncSetupView() } }
        .overlay(alignment: .bottomLeading) {
            if let writeMessage { Text(writeMessage).ledgerType(.rowMeta).foregroundStyle(theme.warn).offset(y: 22) }
        }
        .onChange(of: selectedMemberRaw) { _, _ in
            draftText = ""
            pendingTodo = nil
            writeMessage = nil
            isSaving = false
            isExpanded = false
        }
        .onChange(of: isExpanded) { _, expanded in
            if expanded { draftFocused = true }
        }
    }

    @MainActor
    private func addTask() {
        let trimmed = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSaving else { return }
        guard AppWritebackConfig.canWriteTasks else {
            writeMessage = ConvexWriteResult.notConfigured.userMessage(operation: "Task")
            return
        }
        let attemptMemberRaw = selectedMemberRaw
        isSaving = true
        writeMessage = nil
        let todo = pendingTodo ?? TodoItem(
            id: UUID().uuidString,
            title: trimmed,
            dueDate: defaultDueDate,
            isFlagged: defaultFlagged,
            owner: activeMember,
            createdBy: "app",
        )
        if pendingTodo == nil { modelContext.insert(todo) }
        pendingTodo = todo
        let started = TaskMutationSave.perform(operation: "Todo", in: modelContext, rollbackMutation: {
            modelContext.delete(todo)
        }, remoteWrite: { completion in
            AppWriteSyncService.pushTodo(todo) { result in
                completion(result)
                guard selectedMemberRaw == attemptMemberRaw else { return }
                isSaving = false
                if !result.isRetryable { pendingTodo = nil }
                if result.isOk {
                    if draftText.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed {
                        draftText = ""
                        isExpanded = false
                    }
                } else {
                    writeMessage = result.userMessage(operation: "Task")
                }
                onResult?(result)
            }
        })
        if !started {
            isSaving = false
            pendingTodo = nil
        }
    }
}
