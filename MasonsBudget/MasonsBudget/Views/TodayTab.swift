import SwiftUI
import SwiftData

struct TodayTab: View {
    @Query(sort: \TodoItem.sortOrder) private var allTodos: [TodoItem]
    @Environment(\.modelContext) private var modelContext
    @State private var draftText: String = ""
    @State private var showDraftField = false
    @FocusState private var draftFocused: Bool

    private var dayLabel: String {
        let fmt = DateFormatter()
        fmt.dateFormat = "EEEE · MMMM d"
        return fmt.string(from: Date())
    }

    private var todayTodos: [TodoItem] {
        allTodos.filter { $0.when == "Today" && !$0.isDone }
    }

    private var completedTodayTodos: [TodoItem] {
        allTodos.filter { $0.when == "Today" && $0.isDone }
    }

    private var upcomingTodos: [TodoItem] {
        allTodos.filter { $0.when != "Today" && !$0.isDone }
    }

    private var remainingCount: Int {
        todayTodos.filter { !$0.isDone }.count
    }

    var body: some View {
        #if os(iOS)
        NavigationStack {
            todayContent
                .toolbarColorScheme(.dark, for: .navigationBar)
        }
        #else
        todayContent
        #endif
    }

    private var todayContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AppTheme.cardSpacing) {
                screenHeader
                taskSection
                upcomingSection
            }
            .padding(.horizontal, AppTheme.horizontalPadding)
            .padding(.top, 8)
            .padding(.bottom, 100)
        }
        .background(AppTheme.background)
        .navigationTitle("Today")
    }

    // MARK: - Header

    private var screenHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(dayLabel.uppercased())
                .font(AppTheme.eyebrowFont)
                .tracking(1)
                .foregroundStyle(AppTheme.accentColor)
            Text("Today")
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(AppTheme.primaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    // MARK: - Tasks

    private var taskSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("TASKS")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(AppTheme.secondaryText)
                Spacer()
                Text("\(remainingCount) remaining")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.accentColor)
            }
            .padding(.horizontal, 4)

            VStack(spacing: 0) {
                ForEach(Array(todayTodos.enumerated()), id: \.element.id) { index, todo in
                    todoRow(todo)
                    if index < todayTodos.count - 1 {
                        Divider()
                            .background(AppTheme.cardBorder)
                            .padding(.leading, 48)
                    }
                }

                if todayTodos.isEmpty && !showDraftField {
                    HStack {
                        Text("No tasks for today")
                            .font(.system(size: 14))
                            .foregroundStyle(AppTheme.tertiaryText)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                }

                Divider().background(AppTheme.cardBorder)

                if showDraftField {
                    draftRow
                } else {
                    addTaskButton
                }
            }
            .background(AppTheme.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                    .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
            )

            if !completedTodayTodos.isEmpty {
                Text("COMPLETED")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(AppTheme.tertiaryText)
                    .padding(.horizontal, 4)
                    .padding(.top, 4)

                VStack(spacing: 0) {
                    ForEach(Array(completedTodayTodos.enumerated()), id: \.element.id) { index, todo in
                        todoRow(todo)
                        if index < completedTodayTodos.count - 1 {
                            Divider()
                                .background(AppTheme.cardBorder)
                                .padding(.leading, 48)
                        }
                    }
                }
                .background(AppTheme.cardBackground)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
                .overlay(
                    RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                        .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
                )
            }
        }
    }

    private func todoRow(_ todo: TodoItem) -> some View {
        HStack(spacing: 12) {
            Button {
                withAnimation(AppTheme.entryAnimation) {
                    todo.isDone.toggle()
                    try? modelContext.save()
                }
            } label: {
                Image(systemName: todo.isDone ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22))
                    .foregroundStyle(todo.isDone ? AppTheme.accentColor : AppTheme.borderStrong)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 2) {
                Text(todo.text)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(todo.isDone ? AppTheme.tertiaryText : AppTheme.primaryText)
                    .strikethrough(todo.isDone)
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(AppTheme.accentColor.opacity(0.5))
                        .frame(width: 6, height: 6)
                    Text(todo.project)
                        .font(.system(size: 11))
                        .foregroundStyle(AppTheme.tertiaryText)
                }
            }

            Spacer()

            if todo.isFlagged {
                Image(systemName: "flag.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(AppTheme.accentColor)
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 14)
        .contextMenu {
            Button {
                todo.isFlagged.toggle()
                try? modelContext.save()
            } label: {
                Label(todo.isFlagged ? "Unflag" : "Flag", systemImage: todo.isFlagged ? "flag.slash" : "flag.fill")
            }
            Button {
                todo.when = todo.when == "Today" ? "Upcoming" : "Today"
                try? modelContext.save()
            } label: {
                Label(todo.when == "Today" ? "Move to Upcoming" : "Move to Today", systemImage: "calendar")
            }
            Divider()
            Button(role: .destructive) {
                modelContext.delete(todo)
                try? modelContext.save()
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private var draftRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "circle")
                .font(.system(size: 22))
                .foregroundStyle(AppTheme.borderStrong)

            TextField("New task", text: $draftText)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(AppTheme.primaryText)
                .focused($draftFocused)
                .onSubmit { commitDraft() }
                #if os(iOS)
                .textInputAutocapitalization(.sentences)
                #endif
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 14)
        .onAppear { draftFocused = true }
    }

    private var addTaskButton: some View {
        Button {
            showDraftField = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "plus")
                    .font(.system(size: 20))
                    .foregroundStyle(AppTheme.accentColor)
                Text("Add task")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(AppTheme.accentColor)
                Spacer()
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
        }
        .buttonStyle(.plain)
    }

    private func commitDraft() {
        let trimmed = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            showDraftField = false
            return
        }
        let item = TodoItem(text: trimmed)
        modelContext.insert(item)
        try? modelContext.save()
        draftText = ""
        showDraftField = false
    }

    // MARK: - Upcoming

    private var upcomingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !upcomingTodos.isEmpty {
                Text("UPCOMING")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(AppTheme.secondaryText)
                    .padding(.horizontal, 4)

                VStack(spacing: 0) {
                    ForEach(Array(upcomingTodos.enumerated()), id: \.element.id) { index, todo in
                        HStack(spacing: 12) {
                            Button {
                                withAnimation(AppTheme.entryAnimation) {
                                    todo.isDone.toggle()
                                    try? modelContext.save()
                                }
                            } label: {
                                Image(systemName: todo.isDone ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 22))
                                    .foregroundStyle(todo.isDone ? AppTheme.accentColor : AppTheme.borderStrong)
                            }
                            .buttonStyle(.plain)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(todo.text)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(AppTheme.primaryText)
                                Text(todo.project)
                                    .font(.system(size: 11))
                                    .foregroundStyle(AppTheme.tertiaryText)
                            }

                            Spacer()

                            if todo.isFlagged {
                                Image(systemName: "flag.fill")
                                    .font(.system(size: 13))
                                    .foregroundStyle(AppTheme.accentColor)
                            }

                            Text(todo.when)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(AppTheme.accentColor)
                        }
                        .padding(.vertical, 12)
                        .padding(.horizontal, 14)
                        .contextMenu {
                            Button {
                                todo.when = "Today"
                                try? modelContext.save()
                            } label: {
                                Label("Move to Today", systemImage: "calendar")
                            }
                            Button(role: .destructive) {
                                modelContext.delete(todo)
                                try? modelContext.save()
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }

                        if index < upcomingTodos.count - 1 {
                            Divider()
                                .background(AppTheme.cardBorder)
                                .padding(.leading, 48)
                        }
                    }
                }
                .background(AppTheme.cardBackground)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
                .overlay(
                    RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                        .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
                )
            }
        }
    }
}
