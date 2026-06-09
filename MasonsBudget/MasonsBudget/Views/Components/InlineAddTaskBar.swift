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
    /// Optional writeback callback for surfaces that report sync failures.
    var onResult: (@MainActor @Sendable (Bool) -> Void)?

    @Binding var isExpanded: Bool
    @State private var draftText = ""
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
                        .font(AppFont.bodyRegular)
                        .foregroundStyle(theme.text)
                        .focused($draftFocused)
                        .onSubmit(addTask)
                    Button("Add", action: addTask)
                        .font(AppFont.labelStrong)
                        .foregroundStyle(theme.accent)
                        .buttonStyle(.plain)
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
                            .font(AppFont.bodyStrong)
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
        .onChange(of: isExpanded) { _, expanded in
            if expanded { draftFocused = true }
        }
    }

    private func addTask() {
        let trimmed = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let todo = TodoItem(
            id: UUID().uuidString,
            title: trimmed,
            dueDate: defaultDueDate,
            isFlagged: defaultFlagged,
            owner: activeMember,
            createdBy: "app",
        )
        modelContext.insert(todo)
        try? modelContext.save()
        AppWriteSyncService.pushTodo(todo, onResult: onResult)
        draftText = ""
        isExpanded = false
    }
}
