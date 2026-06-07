import SwiftData
import SwiftUI

/// iOS "Tasks" tab (SAT-1333): folds the smart-list grid, Today / This Week / Long Term
/// task sections, and the Projects + Areas lists into a single hub. Reuses `TaskRowView`
/// and `TaskSmartListView` so the row/list behaviour stays in one place for SAT-1335.
struct TasksView: View {
    @Environment(\.theme) var theme
    @Environment(\.modelContext) private var modelContext
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \TodoItem.priority, order: .reverse) private var allTodos: [TodoItem]
    @Query(sort: \TodoProject.createdAt) private var projects: [TodoProject]
    @Query private var areas: [TodoArea]

    @State private var draftText = ""
    @State private var showingDraft = false

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var myTodos: [TodoItem] {
        allTodos.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) && !$0.isDone }
    }

    private func count(_ filter: SmartListFilter) -> Int {
        let cal = Calendar.current
        let now = Date()
        return myTodos.count(where: { filter.matches($0, now: now, calendar: cal) })
    }

    private var todayTodos: [TodoItem] {
        let cal = Calendar.current, now = Date()
        return myTodos.filter { SmartListFilter.today.matches($0, now: now, calendar: cal) }
    }

    private var thisWeekTodos: [TodoItem] {
        let cal = Calendar.current
        let now = Date()
        let weekFromNow = cal.date(byAdding: .day, value: 7, to: now) ?? now
        return myTodos.filter { todo in
            guard let due = todo.dueDate else { return false }
            return due > now && !cal.isDateInToday(due) && due <= weekFromNow
        }
    }

    private var longTermTodos: [TodoItem] {
        let cal = Calendar.current
        let now = Date()
        let weekFromNow = cal.date(byAdding: .day, value: 7, to: now) ?? now
        return myTodos.filter { todo in
            guard let due = todo.dueDate else { return true }
            return due > weekFromNow
        }
    }

    // SAT-1334: Projects/Areas are derived from the project/area names that actually
    // appear on visible todos (TodoProject/TodoArea records were never populated).
    // Where a matching TodoProject record exists, its icon/color metadata is used.
    private struct ProjectSummary: Identifiable {
        let owner: FamilyMember
        let name: String
        let openCount: Int
        let meta: TodoProject?

        /// Composite (owner, name) so same-named projects from different owners stay distinct.
        var id: String {
            "\(owner.rawValue)|\(name)"
        }
    }

    private struct AreaSummary: Identifiable {
        let owner: FamilyMember
        let name: String
        let openCount: Int
        let meta: TodoArea?

        var id: String {
            "\(owner.rawValue)|\(name)"
        }
    }

    private var visibleTodos: [TodoItem] {
        allTodos.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private func projectName(for todo: TodoItem) -> String? {
        let trimmed = todo.project?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func areaName(for todo: TodoItem) -> String? {
        let trimmed = todo.area?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Distinct (owner, name) pairs from the viewer-visible todos, in a stable order.
    private func ownerNamePairs(_ nameOf: (TodoItem) -> String?) -> [(owner: FamilyMember, name: String)] {
        var seen = Set<String>()
        var ordered: [(owner: FamilyMember, name: String)] = []
        for todo in visibleTodos {
            guard let name = nameOf(todo) else { continue }
            if seen.insert("\(todo.ownerMember.rawValue)|\(name)").inserted {
                ordered.append((todo.ownerMember, name))
            }
        }
        return ordered.sorted { ($0.name, $0.owner.rawValue) < ($1.name, $1.owner.rawValue) }
    }

    private var derivedProjects: [ProjectSummary] {
        let metaByKey = Dictionary(
            projects
                .filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }
                .compactMap { project -> (String, TodoProject)? in
                    let name = project.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    return name.isEmpty ? nil : ("\(project.ownerMember.rawValue)|\(name)", project)
                },
            uniquingKeysWith: { a, _ in a },
        )
        return ownerNamePairs(projectName).map { pair in
            let open = visibleTodos.count(where: {
                $0.ownerMember == pair.owner && projectName(for: $0) == pair.name && !$0.isDone
            })
            return ProjectSummary(
                owner: pair.owner,
                name: pair.name,
                openCount: open,
                meta: metaByKey["\(pair.owner.rawValue)|\(pair.name)"],
            )
        }
    }

    private var derivedAreas: [AreaSummary] {
        let metaByKey = Dictionary(
            areas
                .filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }
                .compactMap { area -> (String, TodoArea)? in
                    let name = area.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    return name.isEmpty ? nil : ("\(area.ownerMember.rawValue)|\(name)", area)
                },
            uniquingKeysWith: { a, _ in a },
        )
        return ownerNamePairs(areaName).map { pair in
            AreaSummary(
                owner: pair.owner,
                name: pair.name,
                openCount: visibleTodos.count(where: {
                    $0.ownerMember == pair.owner && areaName(for: $0) == pair.name && !$0.isDone
                }),
                meta: metaByKey["\(pair.owner.rawValue)|\(pair.name)"],
            )
        }
    }

    private var eyebrow: String {
        let df = DateFormatter()
        df.dateFormat = "EEEE · MMM d"
        return df.string(from: Date())
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Tasks", eyebrow: eyebrow)

                shortcutGrid
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)

                addTaskBar
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)

                if !todayTodos.isEmpty {
                    section(title: "TODAY", todos: todayTodos)
                        .padding(.bottom, AppLayout.cardSpacing)
                }
                if !thisWeekTodos.isEmpty {
                    section(title: "THIS WEEK", todos: thisWeekTodos)
                        .padding(.bottom, AppLayout.cardSpacing)
                }
                if !longTermTodos.isEmpty {
                    section(title: "LONG TERM", todos: longTermTodos)
                        .padding(.bottom, AppLayout.cardSpacing)
                }

                projectsList
                    .padding(.bottom, AppLayout.cardSpacing)

                areasList
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
    }

    // MARK: - Shortcut Grid

    private var shortcutGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            ForEach(SmartListFilter.allCases) { filter in
                NavigationLink {
                    TaskSmartListView(filter: filter)
                } label: {
                    VStack(alignment: .leading, spacing: 10) {
                        RoundedRectangle(cornerRadius: 9)
                            .fill(theme.accentSoft)
                            .frame(width: 32, height: 32)
                            .overlay(
                                Image(systemName: filter.icon)
                                    .font(AppFont.iconSmall)
                                    .foregroundStyle(theme.accent),
                            )
                        Text(filter.title)
                            .font(AppFont.labelMedium)
                            .foregroundStyle(theme.textMuted)
                        Text("\(count(filter))")
                            .font(AppFont.title)
                            .foregroundStyle(theme.text)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassCard(padding: AppLayout.paddingCompact, radius: AppLayout.radiusMedium)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Inline Add

    private var addTaskBar: some View {
        VStack(spacing: 0) {
            if showingDraft {
                HStack(spacing: 10) {
                    Image(systemName: AppIcon.checkOpen)
                        .font(AppFont.iconSmall)
                        .foregroundStyle(theme.borderStrong)
                    TextField("New task", text: $draftText)
                        .textFieldStyle(.plain)
                        .font(AppFont.bodyRegular)
                        .foregroundStyle(theme.text)
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
                    showingDraft = true
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "plus.circle.fill")
                            .font(AppFont.iconSmall)
                            .foregroundStyle(theme.accent)
                        Text("Add task")
                            .font(AppFont.body)
                            .foregroundStyle(theme.textMuted)
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func addTask() {
        let trimmed = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // Inline-created tasks land in Inbox (no due date) per SAT-1335.
        let todo = TodoItem(
            id: UUID().uuidString,
            title: trimmed,
            dueDate: nil,
            owner: activeMember,
            createdBy: "app",
        )
        modelContext.insert(todo)
        try? modelContext.save()
        AppWriteSyncService.pushTodo(todo)
        draftText = ""
        showingDraft = false
    }

    // MARK: - Task Section

    private func section(title: String, todos: [TodoItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                ForEach(Array(todos.enumerated()), id: \.element.id) { idx, todo in
                    TaskRowView(todo: todo)
                    if idx < todos.count - 1 {
                        Hairline(indent: 48)
                    }
                }
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    // MARK: - Projects / Areas

    private var projectsList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PROJECTS")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            if derivedProjects.isEmpty {
                emptyState(icon: "tray", headline: "No projects yet",
                           message: "Tag a task with a project and it'll show up here.")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(derivedProjects.enumerated()), id: \.element.id) { idx, summary in
                        NavigationLink {
                            ProjectTodoListView(projectName: summary.name, owner: summary.owner)
                        } label: {
                            projectRow(summary)
                        }
                        .buttonStyle(.plain)
                        if idx < derivedProjects.count - 1 {
                            Hairline(indent: 58)
                        }
                    }
                }
                .glassCard(padding: 0)
                .padding(.horizontal, AppLayout.sectionPadding)
            }
        }
    }

    private func projectRow(_ summary: ProjectSummary) -> some View {
        let accent = summary.meta?.accentColor ?? theme.accent
        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 9)
                .fill(accent.opacity(0.15))
                .frame(width: 32, height: 32)
                .overlay(
                    Group {
                        if let meta = summary.meta {
                            CatGlyphView(kind: meta.icon, size: 16, color: accent)
                        } else {
                            Image(systemName: "folder")
                                .font(AppFont.iconTiny)
                                .foregroundStyle(accent)
                        }
                    },
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(summary.name)
                    .font(AppFont.body)
                    .foregroundStyle(theme.text)
                if summary.owner != activeMember {
                    Text(summary.owner.displayName)
                        .font(AppFont.labelSmallRegular)
                        .foregroundStyle(theme.textMuted)
                }
            }
            Spacer()
            Text("\(summary.openCount)")
                .font(AppFont.monoCaption)
                .foregroundStyle(theme.textMuted)
                .monospacedDigit()
            Image(systemName: AppIcon.arrowRight)
                .font(AppFont.labelSmallRegular)
                .foregroundStyle(theme.textMuted)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func emptyState(icon: String, headline: String, message: String) -> some View {
        VStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 10)
                .fill(theme.accentSoft)
                .frame(width: 40, height: 40)
                .overlay(Image(systemName: icon).font(AppFont.iconSmall).foregroundStyle(theme.accent))
            Text(headline)
                .font(AppFont.labelLarge)
                .foregroundStyle(theme.text)
            Text(message)
                .font(AppFont.labelSmallRegular)
                .foregroundStyle(theme.textMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .padding(.horizontal, AppLayout.sectionPadding)
        .glassCard(padding: 0)
        .padding(.horizontal, AppLayout.sectionPadding)
    }

    private var areasList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("AREAS")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            if derivedAreas.isEmpty {
                emptyState(icon: "square.stack.3d.up", headline: "No areas yet",
                           message: "Tag a task with an area to group it here.")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(derivedAreas.enumerated()), id: \.element.id) { idx, area in
                        NavigationLink {
                            AreaTodoListView(areaName: area.name, owner: area.owner)
                        } label: {
                            HStack(spacing: 12) {
                                RoundedRectangle(cornerRadius: 9)
                                    .fill(theme.surface2)
                                    .frame(width: 32, height: 32)
                                    .overlay(
                                        Image(systemName: area.meta?.icon ?? "square.stack.3d.up")
                                            .font(AppFont.iconTiny)
                                            .foregroundStyle(theme.textMuted),
                                    )
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(area.name)
                                        .font(AppFont.body)
                                        .foregroundStyle(theme.text)
                                    if area.owner != activeMember {
                                        Text(area.owner.displayName)
                                            .font(AppFont.labelSmallRegular)
                                            .foregroundStyle(theme.textMuted)
                                    }
                                }
                                Spacer()
                                Text("\(area.openCount)")
                                    .font(AppFont.monoCaption)
                                    .foregroundStyle(theme.textMuted)
                                    .monospacedDigit()
                                Image(systemName: AppIcon.arrowRight)
                                    .font(AppFont.labelSmallRegular)
                                    .foregroundStyle(theme.textMuted)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                        }
                        .buttonStyle(.plain)
                        if idx < derivedAreas.count - 1 {
                            Hairline(indent: 58)
                        }
                    }
                }
                .glassCard(padding: 0)
                .padding(.horizontal, AppLayout.sectionPadding)
            }
        }
    }
}
