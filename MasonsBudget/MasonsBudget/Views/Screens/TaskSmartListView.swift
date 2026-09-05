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

    // Custom trailing swipe (SAT-1405): native .swipeActions only fire inside a List, but
    // the task screens render rows in a page-level ScrollView+VStack. This reveal works in
    // that context. The contextMenu (long-press) + checkbox remain as equivalent fallbacks.
    @State private var settledOffset: CGFloat = 0
    @GestureState private var dragOffset: CGFloat = 0
    private static let swipeActionWidth: CGFloat = 72
    private var revealWidth: CGFloat {
        Self.swipeActionWidth * 2
    }

    private var swipeOffset: CGFloat {
        min(0, max(-revealWidth, settledOffset + dragOffset))
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            trailingSwipeActions

            rowForeground
                .background(theme.surface)
                .offset(x: swipeOffset)
                .animation(.spring(response: 0.3, dampingFraction: 0.8), value: settledOffset)
                .gesture(swipeGesture)
        }
        .clipped()
        .contextMenu {
            Button(action: toggleDone) {
                Label(todo.isDone ? "Mark not done" : "Mark done",
                      systemImage: todo.isDone ? "arrow.uturn.backward" : "checkmark.circle")
            }
            Button(action: toggleFlag) {
                Label(todo.isFlagged ? "Remove flag" : "Flag", systemImage: AppIcon.flagFilled)
            }
            Button(role: .destructive) {
                deleteSelf()
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var rowForeground: some View {
        HStack(spacing: 12) {
            // Discrete tap-zone: completes without triggering row navigation.
            LedgerCheckbox(isOn: todo.isDone, action: toggleDone)
                .accessibilityLabel(todo.isDone ? "Mark task not done" : "Mark task done")

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
    }

    private var trailingSwipeActions: some View {
        HStack(spacing: 0) {
            swipeActionButton(
                label: todo.isFlagged ? "Unflag" : "Flag",
                icon: AppIcon.flagFilled,
                tint: .orange,
                action: toggleFlag,
            )
            swipeActionButton(
                label: "Delete",
                icon: "trash",
                tint: theme.danger,
                action: deleteSelf,
            )
        }
    }

    private func swipeActionButton(
        label: String,
        icon: String,
        tint: Color,
        action: @escaping () -> Void,
    ) -> some View {
        Button {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { settledOffset = 0 }
            action()
        } label: {
            VStack(spacing: 4) {
                Image(systemName: icon)
                    .font(AppFont.iconSmall)
                Text(label)
                    .ledgerType(.tabLabel)
            }
            .foregroundStyle(.white)
            .frame(width: Self.swipeActionWidth)
            .frame(maxHeight: .infinity)
            .background(tint)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 18, coordinateSpace: .local)
            .updating($dragOffset) { value, state, _ in
                // Only claim predominantly-horizontal drags so vertical scrolling passes through.
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                state = value.translation.width
            }
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let proposed = settledOffset + value.translation.width
                settledOffset = proposed < -revealWidth / 2 ? -revealWidth : 0
            }
    }

    private var rowContent: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(todo.title)
                    .strikethrough(todo.isDone, color: theme.textFaint)
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.text)

                if let project = todo.project {
                    HStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(theme.accent.opacity(0.5))
                            .frame(width: 6, height: 6)
                        Text(project)
                            .ledgerType(.rowMeta)
                            .foregroundStyle(theme.textMuted)
                    }
                }
            }

            Spacer()

            if let due = todo.dueDate {
                Text(Self.relativeDue(due))
                    .ledgerType(.rowMeta)
                    .foregroundStyle(Self.isOverdue(due) ? theme.danger : theme.accent)
            }

            if todo.isFlagged {
                Image(systemName: AppIcon.flagFilled)
                    .font(AppFont.icon(size: 13, weight: .regular))
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
        let previous = DeletedTodoSnapshot(todo: todo)
        withAnimation(.easeOut(duration: 0.25)) {
            todo.isDone.toggle()
            todo.updatedAt = .now
            todo.hasServerAuthority = false
            TaskMutationSave.perform(operation: "Todo completion", in: modelContext, rollbackMutation: {
                previous.apply(to: todo)
            }) { completion in
                AppWriteSyncService.setTodoCompletion(todo, onResult: completion)
            }
        }
    }

    private func toggleFlag() {
        let previous = DeletedTodoSnapshot(todo: todo)
        todo.isFlagged.toggle()
        todo.updatedAt = .now
        todo.hasServerAuthority = false
        TaskMutationSave.perform(operation: "Todo flag", in: modelContext, rollbackMutation: {
            previous.apply(to: todo)
        }) { completion in
            AppWriteSyncService.pushTodo(todo, onResult: completion)
        }
    }

    private func deleteSelf() {
        TaskUndoStore.shared.delete(todo, in: modelContext)
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
    @State private var showingDraft = false

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var items: [TodoItem] {
        let cal = Calendar.current
        let now = Date()
        return allTodos.filter { todo in
            activeMember.canAccessTodo(ownedBy: todo.ownerMember) &&
                !todo.isDone &&
                filter.matches(todo, now: now, calendar: cal)
        }
    }

    private var defaultDueDate: Date? {
        let calendar = Calendar.current
        switch filter {
        case .today:
            return calendar.startOfDay(for: Date())
        case .upcoming:
            return calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date()))
        case .inbox, .flagged:
            return nil
        }
    }

    private var defaultFlagged: Bool {
        filter == .flagged
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: filter.title, eyebrow: "Tasks")

                InlineAddTaskBar(
                    defaultDueDate: defaultDueDate,
                    defaultFlagged: defaultFlagged,
                    isExpanded: $showingDraft,
                )
                .padding(.horizontal, AppLayout.sectionPadding)
                .padding(.bottom, AppLayout.cardSpacing)

                if items.isEmpty {
                    emptyState
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { idx, todo in
                            TaskRowView(todo: todo)
                                .ledgerRowReveal(index: idx)
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
                        .font(AppFont.iconMedium)
                        .foregroundStyle(theme.accent),
                )
            Text("Nothing in \(filter.title)")
                .ledgerType(.rowPrimary)
                .foregroundStyle(theme.text)
            Text("You're all caught up here.")
                .ledgerType(.rowPrimary)
                .foregroundStyle(theme.textMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .padding(.horizontal, AppLayout.sectionPadding)
    }
}
