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

    static func isDueTodayOrOverdue(_ dueDate: Date?, now: Date = LedgerClock.now, calendar: Calendar = .current) -> Bool {
        guard let dueDate else { return false }
        return calendar.startOfDay(for: dueDate) <= calendar.startOfDay(for: now)
    }

    static func wasCompletedToday(_ todo: TodoItem, now: Date = LedgerClock.now, calendar: Calendar = .current) -> Bool {
        guard todo.isDone else { return false }
        if let completedAt = todo.completedAt {
            return calendar.isDate(completedAt, inSameDayAs: now)
        }
        return todo.dueDate.map { calendar.isDate($0, inSameDayAs: now) } ?? false
    }

    func completedTodayItems(
        _ todos: [TodoItem], viewer: FamilyMember, now: Date, calendar: Calendar
    ) -> [TodoItem] {
        guard self == .today else { return [] }
        return todos.filter {
            viewer.canAccessTodo(ownedBy: $0.ownerMember) &&
                Self.wasCompletedToday($0, now: now, calendar: calendar)
        }
    }

    /// Predicate for an open (not-done) todo the active member can see.
    func matches(_ todo: TodoItem, now: Date, calendar: Calendar) -> Bool {
        switch self {
        case .inbox:
            return todo.project == nil && todo.area == nil
        case .today:
            return Self.isDueTodayOrOverdue(todo.dueDate, now: now, calendar: calendar)
        case .upcoming:
            guard let due = todo.dueDate else { return false }
            return due > now && !calendar.isDate(due, inSameDayAs: now)
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
    @Environment(\.ledgerEffects) private var effects
    @Environment(\.theme) var theme
    @Environment(\.modelContext) private var modelContext

    var body: some View {
        rowForeground
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive, action: deleteSelf) { Label("Delete", systemImage: "trash") }
            Button(action: toggleFlag) { Label(todo.isFlagged ? "Unflag" : "Flag", systemImage: AppIcon.flagFilled) }
                .tint(theme.accentFill)
        }
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
        .accessibilityAction(named: todo.isDone ? "Mark not done" : "Mark done", toggleDone)
        .accessibilityAction(named: todo.isFlagged ? "Unflag" : "Flag", toggleFlag)
        .accessibilityAction(named: "Delete", deleteSelf)
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
        withAnimation(LedgerMotionToken.chipAndNavigation.animation(reduceMotion: effects.reduceMotion)) {
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

    static func isOverdue(_ date: Date, now: Date = LedgerClock.now, calendar: Calendar = .current) -> Bool {
        date < calendar.startOfDay(for: now)
    }

    static func relativeDue(_ date: Date, now: Date = LedgerClock.now, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if calendar.isDate(date, inSameDayAs: calendar.date(byAdding: .day, value: 1, to: now) ?? now) { return "Tomorrow" }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        if days < 0 { return "\(abs(days))d ago" }
        return "\(days)d"
    }
}

// MARK: - Smart List Screen

struct TaskSmartListView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    let filter: SmartListFilter

    @Environment(\.theme) var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @Query(sort: \TodoItem.dueDate) private var allTodos: [TodoItem]
    @State private var showingDraft = false

    init(filter: SmartListFilter, initiallyAdding: Bool = false) {
        self.filter = filter
        _showingDraft = State(initialValue: initiallyAdding)
    }

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

    private var completedToday: [TodoItem] {
        filter.completedTodayItems(allTodos, viewer: activeMember, now: Date(), calendar: .current)
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
        List {
            ScreenHeader(title: filter.title, eyebrow: "Tasks")
                .listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
            InlineAddTaskBar(
                defaultDueDate: defaultDueDate,
                defaultFlagged: defaultFlagged,
                isExpanded: $showingDraft
            )
            .listRowSeparator(.hidden)
            if items.isEmpty { emptyState.listRowSeparator(.hidden) }
            ForEach(items) { todo in
                TaskRowView(todo: todo)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(theme.surface)
            }
            if !completedToday.isEmpty {
                Section("Completed today") {
                    ForEach(completedToday) { todo in
                        TaskRowView(todo: todo)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(theme.surface)
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(theme.bg)
        .modifier(LedgerListRefresh())
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
        .padding(.horizontal, ledgerTokens.metrics.screenGutter)
    }
}

/// All list refresh gestures share one in-flight gate. The sync service retains
/// its profile/authority guards; source reload follows only the same viewer.
@MainActor
private enum LedgerListRefreshGate {
    static var isRefreshing = false
}

struct LedgerListRefresh: ViewModifier {
    @Environment(\.modelContext) private var context
    @Environment(CanonicalFinancialSourceStore.self) private var financials
    @AppStorage("selected_family_member") private var memberRaw = FamilyMember.victor.rawValue

    func body(content: Content) -> some View {
        content.refreshable {
            guard !LedgerListRefreshGate.isRefreshing else { return }
            LedgerListRefreshGate.isRefreshing = true
            defer { LedgerListRefreshGate.isRefreshing = false }
            let viewer = memberRaw
            await ConvexSyncService(context: context).syncAll()
            guard !Task.isCancelled, memberRaw == viewer else { return }
            financials.requestReload()
        }
    }
}

struct LedgerRefreshButton: View {
    @Environment(\.refresh) private var refresh
    var body: some View {
        Button("Retry") { Task { await refresh?() } }
            .disabled(refresh == nil)
    }
}
