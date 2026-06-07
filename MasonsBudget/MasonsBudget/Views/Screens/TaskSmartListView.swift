import SwiftData
import SwiftUI

// MARK: - Smart List Filter

/// The canonical "smart list" buckets shared by the iOS Tasks tab shortcut grid
/// and the macOS sidebar (SAT-1333).
enum SmartListFilter: String, CaseIterable, Identifiable {
    case today, inbox, upcoming, flagged

    var id: String {
        rawValue
    }

    var title: String {
        switch self {
        case .today: "Today"
        case .inbox: "Inbox"
        case .upcoming: "Upcoming"
        case .flagged: "Flagged"
        }
    }

    var icon: String {
        switch self {
        case .today: AppIcon.today
        case .inbox: AppIcon.inbox
        case .upcoming: AppIcon.calendar
        case .flagged: AppIcon.flagFilled
        }
    }

    /// Predicate for an open (not-done) todo the active member can see.
    func matches(_ todo: TodoItem, now: Date, calendar: Calendar) -> Bool {
        switch self {
        case .inbox:
            return todo.project == nil && todo.area == nil
        case .today:
            guard let due = todo.dueDate else { return false }
            return calendar.isDateInToday(due) || due < calendar.startOfDay(for: now)
        case .upcoming:
            guard let due = todo.dueDate else { return false }
            return due > now && !calendar.isDateInToday(due)
        case .flagged:
            return todo.isFlagged
        }
    }
}

// MARK: - Reusable Task Row

/// Single reusable todo row used by the Tasks tab, smart lists, and project lists.
/// SAT-1335 will layer swipe actions / detail navigation on top of this one row.
struct TaskRowView: View {
    let todo: TodoItem
    @Environment(\.theme) var theme
    @Environment(\.modelContext) private var modelContext
    @State private var showDeleteConfirm = false

    var body: some View {
        HStack(spacing: 12) {
            // Discrete tap-zone: completes without triggering row navigation.
            Button(action: toggleDone) {
                Image(systemName: todo.isDone ? AppIcon.checkDone : AppIcon.checkOpen)
                    .font(.system(size: 20))
                    .foregroundStyle(todo.isDone ? theme.accent : theme.borderStrong)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Full-row tap opens the editor.
            NavigationLink {
                TaskDetailView(todo: todo)
            } label: {
                rowContent
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contextMenu {
            Button(action: toggleDone) {
                Label(todo.isDone ? "Mark not done" : "Mark done",
                      systemImage: todo.isDone ? "arrow.uturn.backward" : "checkmark.circle")
            }
            Button(action: toggleFlag) {
                Label(todo.isFlagged ? "Remove flag" : "Flag", systemImage: AppIcon.flagFilled)
            }
            Button(role: .destructive) {
                showDeleteConfirm = true
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button(action: toggleDone) {
                Label(todo.isDone ? "Undo" : "Done",
                      systemImage: todo.isDone ? "arrow.uturn.backward" : "checkmark")
            }
            .tint(theme.accent)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                showDeleteConfirm = true
            } label: {
                Label("Delete", systemImage: "trash")
            }
            Button(action: toggleFlag) {
                Label(todo.isFlagged ? "Unflag" : "Flag", systemImage: AppIcon.flagFilled)
            }
            .tint(.orange)
        }
        .confirmationDialog("Delete this task?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete task", role: .destructive, action: deleteSelf)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(todo.title)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var rowContent: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(todo.title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(theme.text)
                    .strikethrough(todo.isDone, color: theme.textFaint)

                if let project = todo.project {
                    HStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(theme.accent.opacity(0.5))
                            .frame(width: 6, height: 6)
                        Text(project)
                            .font(.system(size: 11))
                            .foregroundStyle(theme.textMuted)
                    }
                }
            }

            Spacer()

            if let due = todo.dueDate {
                Text(Self.relativeDue(due))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Self.isOverdue(due) ? theme.danger : theme.accent)
            }

            if todo.isFlagged {
                Image(systemName: AppIcon.flagFilled)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.accent)
            }
        }
        .contentShape(Rectangle())
    }

    private var accessibilityText: String {
        var parts = [todo.title]
        if todo.isDone { parts.append("completed") }
        if let due = todo.dueDate { parts.append("due \(Self.relativeDue(due))") }
        if todo.isFlagged { parts.append("flagged") }
        return parts.joined(separator: ", ")
    }

    private func toggleDone() {
        withAnimation(.easeOut(duration: 0.25)) {
            todo.isDone.toggle()
            todo.updatedAt = .now
            try? modelContext.save()
            AppWriteSyncService.pushTodo(todo)
        }
    }

    private func toggleFlag() {
        todo.isFlagged.toggle()
        todo.updatedAt = .now
        try? modelContext.save()
        AppWriteSyncService.pushTodo(todo)
    }

    private func deleteSelf() {
        modelContext.delete(todo)
        try? modelContext.save()
        AppWriteSyncService.deleteTodo(todo)
    }

    static func isOverdue(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> Bool {
        date < calendar.startOfDay(for: now)
    }

    static func relativeDue(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInTomorrow(date) { return "Tomorrow" }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        if days < 0 { return "\(abs(days))d ago" }
        return "\(days)d"
    }
}

// MARK: - Smart List Screen

struct TaskSmartListView: View {
    let filter: SmartListFilter

    @Environment(\.theme) var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @Query(sort: \TodoItem.dueDate) private var allTodos: [TodoItem]

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var items: [TodoItem] {
        let cal = Calendar.current
        let now = Date()
        return allTodos.filter { todo in
            activeMember.canSee(dataOwnedBy: todo.ownerMember) &&
                !todo.isDone &&
                filter.matches(todo, now: now, calendar: cal)
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: filter.title, eyebrow: "Tasks")

                if items.isEmpty {
                    emptyState
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { idx, todo in
                            TaskRowView(todo: todo)
                            if idx < items.count - 1 {
                                Hairline(indent: 48)
                            }
                        }
                    }
                    .glassCard(padding: 0)
                    .padding(.horizontal, AppLayout.sectionPadding)
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 12)
                .fill(theme.accentSoft)
                .frame(width: 44, height: 44)
                .overlay(
                    Image(systemName: filter.icon)
                        .font(.system(size: 20))
                        .foregroundStyle(theme.accent),
                )
            Text("Nothing in \(filter.title)")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(theme.text)
            Text("You're all caught up here.")
                .font(.system(size: 13))
                .foregroundStyle(theme.textMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .padding(.horizontal, AppLayout.sectionPadding)
    }
}
