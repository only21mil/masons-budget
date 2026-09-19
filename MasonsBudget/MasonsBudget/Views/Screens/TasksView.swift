import SwiftData
import SwiftUI

/// iOS "Tasks" tab (SAT-1333): folds the smart-list grid, Today / This Week / Long Term
/// task sections, and the Projects + Areas lists into a single hub. Reuses `TaskRowView`
/// and `TaskSmartListView` so the row/list behaviour stays in one place for SAT-1335.
struct TasksView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    @Environment(\.theme) var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \TodoItem.priority, order: .reverse) private var allTodos: [TodoItem]
    @Query(sort: \TodoProject.createdAt) private var projects: [TodoProject]
    @Query private var areas: [TodoArea]

    @State private var showingDraft = false

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var myTodos: [TodoItem] {
        allTodos.filter { activeMember.canAccessTodo(ownedBy: $0.ownerMember) && !$0.isDone }
    }

    private func count(_ filter: SmartListFilter) -> Int {
        let cal = Calendar.current
        let now = LedgerClock.now
        return myTodos.count(where: { filter.matches($0, now: now, calendar: cal) })
    }

    private var todayTodos: [TodoItem] {
        let cal = Calendar.current, now = LedgerClock.now
        return myTodos.filter { SmartListFilter.today.matches($0, now: now, calendar: cal) }
    }

    private var thisWeekTodos: [TodoItem] {
        let cal = Calendar.current
        let now = LedgerClock.now
        let weekFromNow = cal.date(byAdding: .day, value: 7, to: now) ?? now
        return myTodos.filter { todo in
            guard let due = todo.dueDate else { return false }
            return due > now && !cal.isDate(due, inSameDayAs: now) && due <= weekFromNow
        }
    }

    private var longTermTodos: [TodoItem] {
        let cal = Calendar.current
        let now = LedgerClock.now
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
        allTodos.filter { activeMember.canAccessTodo(ownedBy: $0.ownerMember) }
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
                .filter { activeMember.canAccessTodo(ownedBy: $0.ownerMember) }
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
                .filter { activeMember.canAccessTodo(ownedBy: $0.ownerMember) }
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

    private static let eyebrowFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "EEEE · MMM d"
        return df
    }()

    private var eyebrow: String {
        Self.eyebrowFormatter.string(from: LedgerClock.now)
    }

    var body: some View {
        List {
            ScreenHeader(title: "Tasks", eyebrow: eyebrow)
                .listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
            shortcutGrid.listRowSeparator(.hidden)
            InlineAddTaskBar(isExpanded: $showingDraft).listRowSeparator(.hidden)
            if !todayTodos.isEmpty { section(title: "Today", todos: todayTodos) }
            if !thisWeekTodos.isEmpty { section(title: "This week", todos: thisWeekTodos) }
            if !longTermTodos.isEmpty { section(title: "Long term", todos: longTermTodos) }
            projectsList.listRowSeparator(.hidden)
            areasList.listRowSeparator(.hidden)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(theme.bg)
        .modifier(LedgerListRefresh())
    }

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
                            .ledgerType(.kpiLabel)
                            .foregroundStyle(theme.textMuted)
                        Text("\(count(filter))")
                            .ledgerType(.screenTitle)
                            .foregroundStyle(theme.text)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassCard(padding: AppLayout.paddingCompact, radius: AppLayout.radiusMedium)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Task Section

    private func section(title: String, todos: [TodoItem]) -> some View {
        Section(title) {
            ForEach(todos) { todo in
                TaskRowView(todo: todo)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(theme.surface)
            }
        }
    }

    // MARK: - Projects / Areas

    private var projectsList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PROJECTS")
                .ledgerType(.sectionLabel)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter + 4)

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
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)
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
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.text)
                if summary.owner != activeMember {
                    Text(summary.owner.displayName)
                        .ledgerType(.rowMeta)
                        .foregroundStyle(theme.textMuted)
                }
            }
            Spacer()
            Text("\(summary.openCount)")
                .ledgerType(.rowFigure)
                .foregroundStyle(theme.textMuted)
            Image(systemName: AppIcon.arrowRight)
                .font(AppFont.icon(size: 12, weight: .regular))
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
                .ledgerType(.rowPrimary)
                .foregroundStyle(theme.text)
            Text(message)
                .ledgerType(.body)
                .foregroundStyle(theme.textMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .padding(.horizontal, ledgerTokens.metrics.screenGutter)
        .glassCard(padding: 0)
        .padding(.horizontal, ledgerTokens.metrics.screenGutter)
    }

    private var areasList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("AREAS")
                .ledgerType(.sectionLabel)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter + 4)

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
                                        .ledgerType(.rowPrimary)
                                        .foregroundStyle(theme.text)
                                    if area.owner != activeMember {
                                        Text(area.owner.displayName)
                                            .ledgerType(.rowMeta)
                                            .foregroundStyle(theme.textMuted)
                                    }
                                }
                                Spacer()
                                Text("\(area.openCount)")
                                    .ledgerType(.rowFigure)
                                    .foregroundStyle(theme.textMuted)
                                Image(systemName: AppIcon.arrowRight)
                                    .font(AppFont.icon(size: 12, weight: .regular))
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
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)
            }
        }
    }
}
