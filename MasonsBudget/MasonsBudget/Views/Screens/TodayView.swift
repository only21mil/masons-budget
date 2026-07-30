import os
import SwiftData
import SwiftUI

struct TodayView: View {
    private static let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "TodayTodos")

    @Environment(\.theme) var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \TodoItem.priority, order: .reverse) private var allTodos: [TodoItem]

    @State private var showingDraft = false

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var myTodos: [TodoItem] {
        allTodos.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) && !$0.isDone }
    }

    private var todayTodos: [TodoItem] {
        let cal = Calendar.current
        let now = Date()
        return myTodos.filter { todo in
            Self.isDueTodayOrOverdue(todo.dueDate, now: now, calendar: cal)
        }
    }

    private var shortTermTodos: [TodoItem] {
        let cal = Calendar.current
        let weekFromNow = cal.date(byAdding: .day, value: 7, to: Date()) ?? Date()
        return myTodos.filter { todo in
            guard let due = todo.dueDate else { return false }
            return !cal.isDateInToday(due) && due <= weekFromNow && due > Date()
        }
    }

    private var longTermTodos: [TodoItem] {
        let cal = Calendar.current
        let weekFromNow = cal.date(byAdding: .day, value: 7, to: Date()) ?? Date()
        return myTodos.filter { todo in
            if let due = todo.dueDate {
                return due > weekFromNow
            }
            return true
        }
    }

    private var todayEyebrow: String {
        let df = DateFormatter()
        df.dateFormat = "EEEE · MMM d"
        return df.string(from: Date())
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Today", eyebrow: todayEyebrow)

                tasksSection
                    .padding(.bottom, AppLayout.cardSpacing)

                if !shortTermTodos.isEmpty {
                    shortTermSection
                        .padding(.bottom, AppLayout.cardSpacing)
                }

                if !longTermTodos.isEmpty {
                    longTermSection
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
    }

    static func isDueTodayOrOverdue(_ dueDate: Date?, now: Date = Date(), calendar: Calendar = .current) -> Bool {
        guard let dueDate else { return false }
        return calendar.startOfDay(for: dueDate) <= calendar.startOfDay(for: now)
    }

    // MARK: - Today Tasks

    private var tasksSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("TODAY")
                    .font(AppFont.labelSmallStrong)
                    .tracking(AppFont.sectionTracking)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                Text("\(todayTodos.count) remaining")
                    .font(AppFont.labelSmallRegular)
                    .foregroundStyle(theme.textMuted)
            }
            .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                if todayTodos.isEmpty {
                    HStack {
                        Image(systemName: "checkmark.circle")
                            .font(AppFont.iconSmall)
                            .foregroundStyle(theme.success)
                        Text("All clear for today")
                            .font(AppFont.labelLarge)
                            .foregroundStyle(theme.textMuted)
                        Spacer()
                    }
                    .padding(14)
                } else {
                    ForEach(Array(todayTodos.enumerated()), id: \.element.id) { idx, todo in
                        TaskRowView(todo: todo)
                        if idx < todayTodos.count - 1 {
                            Hairline(indent: 48)
                        }
                    }
                }

                addTaskRow
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    // MARK: - Short Term (This Week)

    private var shortTermSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("THIS WEEK")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                ForEach(Array(shortTermTodos.enumerated()), id: \.element.id) { idx, todo in
                    TaskRowView(todo: todo)
                    if idx < shortTermTodos.count - 1 {
                        Hairline(indent: 48)
                    }
                }
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    // MARK: - Long Term

    private var longTermSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("LONG TERM")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                ForEach(Array(longTermTodos.enumerated()), id: \.element.id) { idx, todo in
                    TaskRowView(todo: todo)
                    if idx < longTermTodos.count - 1 {
                        Hairline(indent: 48)
                    }
                }
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private var addTaskRow: some View {
        Group {
            Hairline()
            InlineAddTaskBar(
                defaultDueDate: Calendar.current.startOfDay(for: Date()),
                onResult: Self.reportTodoWriteback,
                isExpanded: $showingDraft,
            )
        }
    }

    /// The user-visible report is `ContentView`'s sync banner, which now renders
    /// the cause. This log line names it for diagnosis.
    @MainActor
    private static func reportTodoWriteback(_ result: ConvexWriteResult) {
        guard !result.isOk else { return }
        let cause = result.userMessage(operation: "Save todo") ?? "unknown cause"
        log.error("Todo writeback rejected: \(cause, privacy: .public)")
    }
}
