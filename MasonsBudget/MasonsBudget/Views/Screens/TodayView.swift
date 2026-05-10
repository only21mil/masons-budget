import SwiftUI
import SwiftData

struct TodayView: View {
    @Environment(\.theme) var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \TodoItem.priority, order: .reverse) private var allTodos: [TodoItem]

    @State private var draftText = ""
    @State private var showingDraft = false

    @Environment(\.modelContext) private var modelContext

    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }

    private var todayTodos: [TodoItem] {
        let cal = Calendar.current
        return allTodos.filter { todo in
            activeMember.canSee(dataOwnedBy: todo.ownerMember) &&
            (todo.dueDate.map { cal.isDateInToday($0) } ?? false)
        }
    }

    private var upcomingTodos: [TodoItem] {
        let cal = Calendar.current
        return allTodos.filter { todo in
            activeMember.canSee(dataOwnedBy: todo.ownerMember) &&
            !todo.isDone &&
            (todo.dueDate.map { !cal.isDateInToday($0) && $0 > Date() } ?? false)
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

                if !upcomingTodos.isEmpty {
                    upcomingSection
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
    }

    // MARK: - Tasks Section

    private var tasksSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("TASKS")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.72)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                Text("\(todayTodos.filter { !$0.isDone }.count) remaining")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.textMuted)
            }
            .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                ForEach(Array(todayTodos.enumerated()), id: \.element.id) { idx, todo in
                    todoRow(todo: todo)
                    if idx < todayTodos.count - 1 {
                        Hairline(indent: 48)
                    }
                }

                addTaskRow
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private func todoRow(todo: TodoItem) -> some View {
        HStack(spacing: 12) {
            Button {
                todo.isDone.toggle()
                todo.updatedAt = .now
            } label: {
                Image(systemName: todo.isDone ? AppIcon.checkDone : AppIcon.checkOpen)
                    .font(.system(size: 22))
                    .foregroundStyle(todo.isDone ? theme.accent : theme.borderStrong)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 2) {
                Text(todo.title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(todo.isDone ? theme.textFaint : theme.text)
                    .strikethrough(todo.isDone)

                if let project = todo.project {
                    HStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(theme.accent.opacity(0.5))
                            .frame(width: 6, height: 6)
                        Text(project)
                            .font(.system(size: 11))
                            .foregroundStyle(theme.textFaint)
                    }
                }
            }

            Spacer()

            if todo.isFlagged {
                Image(systemName: AppIcon.flagFilled)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.accent)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private var addTaskRow: some View {
        Group {
            Hairline()
            if showingDraft {
                HStack(spacing: 12) {
                    Image(systemName: AppIcon.checkOpen)
                        .font(.system(size: 22))
                        .foregroundStyle(theme.borderStrong)
                    TextField("New task", text: $draftText)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(theme.text)
                        .onSubmit { addTask() }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            } else {
                Button { showingDraft = true } label: {
                    HStack(spacing: 12) {
                        Image(systemName: AppIcon.plus)
                            .font(.system(size: 20))
                            .foregroundStyle(theme.accent)
                        Text("Add task")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(theme.accent)
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func addTask() {
        guard !draftText.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let todo = TodoItem(
            id: UUID().uuidString,
            title: draftText,
            dueDate: Date(),
            owner: activeMember,
            createdBy: "app"
        )
        modelContext.insert(todo)
        draftText = ""
        showingDraft = false
    }

    // MARK: - Upcoming

    private var upcomingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("UPCOMING")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                ForEach(Array(upcomingTodos.prefix(5).enumerated()), id: \.element.id) { idx, todo in
                    HStack(spacing: 12) {
                        Image(systemName: AppIcon.checkOpen)
                            .font(.system(size: 22))
                            .foregroundStyle(theme.borderStrong)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(todo.title)
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(theme.text)
                            if let project = todo.project {
                                Text(project)
                                    .font(.system(size: 11))
                                    .foregroundStyle(theme.textFaint)
                            }
                        }
                        Spacer()
                        if todo.isFlagged {
                            Image(systemName: AppIcon.flagFilled)
                                .font(.system(size: 13))
                                .foregroundStyle(theme.accent)
                        }
                        if let due = todo.dueDate {
                            Text(relativeDue(due))
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(theme.accent)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)

                    if idx < min(upcomingTodos.count, 5) - 1 {
                        Hairline(indent: 48)
                    }
                }
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
        .padding(.top, AppLayout.cardSpacing)
    }

    private func relativeDue(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInTomorrow(date) { return "Tomorrow" }
        let days = cal.dateComponents([.day], from: Date(), to: date).day ?? 0
        if days <= 7 { return "\(days)d" }
        let df = DateFormatter()
        df.dateFormat = "MMM d"
        return df.string(from: date)
    }
}
