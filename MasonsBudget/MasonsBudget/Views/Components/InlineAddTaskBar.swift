import SwiftData
import SwiftUI

/// Shared "add a task" affordance (SAT-1508). Collapsed it renders as a
/// prominent accent "New Task" row; expanded it shows the draft field.
/// Used by TasksView and TaskSmartListView so every task surface has a
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
    @State private var draft = InlineTaskDraft()
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
                    TextField("New task", text: $draft.text)
                        .textFieldStyle(.plain)
                        .ledgerType(.textInput)
                        .foregroundStyle(theme.text)
                        .focused($draftFocused)
                        .disabled(draft.isSaving || draft.pendingTodo != nil)
                        .onSubmit(addTask)
                    if AppWritebackConfig.canWriteTasks {
                        Button(draft.isSaving ? "Saving" : "Add", action: addTask)
                            .ledgerType(.button)
                            .foregroundStyle(theme.accent)
                            .buttonStyle(.plain)
                            .disabled(draft.isSaving || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
            if let message = draft.message { Text(message).ledgerType(.rowMeta).foregroundStyle(theme.warn).offset(y: 22) }
        }
        .onChange(of: selectedMemberRaw) { _, _ in
            draft.reset()
            isExpanded = false
        }
        .onChange(of: isExpanded) { _, expanded in
            if expanded { draftFocused = true }
        }
    }

    @MainActor
    private func addTask() {
        let trimmed = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !draft.isSaving else { return }
        guard AppWritebackConfig.canWriteTasks else {
            draft.message = ConvexWriteResult.notConfigured.userMessage(operation: "Task")
            return
        }
        let attemptMemberRaw = selectedMemberRaw
        let todo = draft.pendingTodo ?? TodoItem(
            id: UUID().uuidString,
            title: trimmed,
            dueDate: defaultDueDate,
            isFlagged: defaultFlagged,
            owner: activeMember,
            createdBy: "app",
        )
        if draft.pendingTodo == nil { modelContext.insert(todo) }
        let requestID = draft.begin(todo: todo)
        let started = TaskMutationSave.perform(operation: "Todo", in: modelContext, rollbackMutation: {
            modelContext.delete(todo)
        }, remoteWrite: { completion in
            AppWriteSyncService.pushTodo(todo) { result in
                completion(result)
                guard selectedMemberRaw == attemptMemberRaw,
                      draft.finish(result, requestID: requestID) else { return }
                if result.isOk, draft.text.isEmpty { isExpanded = false }
                onResult?(result)
            }
        })
        if !started {
            draft.preparationFailed(requestID: requestID)
        }
    }
}

/// Owns each inline draft and its request across profile visits. Resetting a
/// visit invalidates every callback, even when the next visit has the same title.
@MainActor
struct InlineTaskDraft {
    var text = ""
    var message: String?
    private(set) var pendingTodo: TodoItem?
    private var request: (id: UUID, title: String)?
    private(set) var isSaving = false

    mutating func reset() {
        self = Self()
    }

    mutating func begin(todo: TodoItem) -> UUID {
        let id = UUID()
        request = (id, text.trimmingCharacters(in: .whitespacesAndNewlines))
        isSaving = true
        pendingTodo = todo
        message = nil
        return id
    }

    /// False means a previous request completed after its draft was reset.
    @discardableResult
    mutating func finish(_ result: ConvexWriteResult, requestID: UUID) -> Bool {
        guard let current = request, current.id == requestID else { return false }
        isSaving = false
        if !result.isRetryable {
            request = nil
            pendingTodo = nil
        }
        if result.isOk {
            if text.trimmingCharacters(in: .whitespacesAndNewlines) == current.title { text = "" }
        } else {
            message = result.userMessage(operation: "Task")
        }
        return true
    }

    mutating func preparationFailed(requestID: UUID) {
        guard request?.id == requestID else { return }
        request = nil
        isSaving = false
        pendingTodo = nil
    }
}
