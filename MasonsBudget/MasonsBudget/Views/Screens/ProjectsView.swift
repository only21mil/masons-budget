import SwiftData
import SwiftUI

struct ProjectsView: View {
    @Environment(\.theme) var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query private var allTodos: [TodoItem]
    @Query(sort: \TodoProject.createdAt) private var projects: [TodoProject]
    @Query private var areas: [TodoArea]

    @State private var searchText = ""

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var trimmedSearch: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var searchableTodos: [TodoItem] {
        allTodos.filter {
            activeMember.canSee(dataOwnedBy: $0.ownerMember) &&
                SearchMatcher.matches(todo: $0, query: searchText)
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

    private struct ProjectSummary: Identifiable {
        let name: String
        let openCount: Int
        let meta: TodoProject?

        var id: String {
            name
        }
    }

    private struct AreaSummary: Identifiable {
        let name: String
        let openCount: Int
        let meta: TodoArea?

        var id: String {
            name
        }
    }

    private var derivedProjects: [ProjectSummary] {
        let names = Set(
            visibleTodos.compactMap(projectName),
        )
        let metaByName = Dictionary(
            projects
                .filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }
                .map { ($0.name, $0) },
            uniquingKeysWith: { a, _ in a },
        )
        return names.sorted().map { name in
            ProjectSummary(
                name: name,
                openCount: visibleTodos.count(where: { projectName(for: $0) == name && !$0.isDone }),
                meta: metaByName[name],
            )
        }
    }

    private var derivedAreas: [AreaSummary] {
        let names = Set(
            visibleTodos.compactMap(areaName),
        )
        let metaByName = Dictionary(
            areas
                .filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }
                .map { ($0.name, $0) },
            uniquingKeysWith: { a, _ in a },
        )
        return names.sorted().map { name in
            AreaSummary(
                name: name,
                openCount: visibleTodos.count(where: { areaName(for: $0) == name && !$0.isDone }),
                meta: metaByName[name],
            )
        }
    }

    private var inboxCount: Int {
        allTodos.count(where: {
            activeMember.canSee(dataOwnedBy: $0.ownerMember) &&
                !$0.isDone &&
                projectName(for: $0) == nil &&
                areaName(for: $0) == nil
        })
    }

    private var todayCount: Int {
        let cal = Calendar.current
        let now = Date()
        return allTodos.count(where: { todo in
            activeMember.canSee(dataOwnedBy: todo.ownerMember) && !todo.isDone &&
                SmartListFilter.today.matches(todo, now: now, calendar: cal)
        })
    }

    private var upcomingCount: Int {
        let cal = Calendar.current
        let now = Date()
        return allTodos.count(where: { todo in
            activeMember.canSee(dataOwnedBy: todo.ownerMember) && !todo.isDone &&
                SmartListFilter.upcoming.matches(todo, now: now, calendar: cal)
        })
    }

    private var flaggedCount: Int {
        allTodos.count(where: {
            activeMember.canSee(dataOwnedBy: $0.ownerMember) &&
                !$0.isDone &&
                $0.isFlagged
        })
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Projects", eyebrow: "Areas of focus")

                if trimmedSearch.isEmpty {
                    shortcutGrid
                        .padding(.horizontal, AppLayout.sectionPadding)
                        .padding(.bottom, AppLayout.cardSpacing)

                    projectsList
                        .padding(.bottom, AppLayout.cardSpacing)

                    areasList
                } else {
                    taskSearchResults
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .searchable(text: $searchText, prompt: "Search tasks")
    }

    // MARK: - Shortcut Grid

    private var shortcutGrid: some View {
        let items: [(label: String, count: Int, icon: String)] = [
            ("Inbox", inboxCount, AppIcon.inbox),
            ("Today", todayCount, AppIcon.today),
            ("Upcoming", upcomingCount, AppIcon.calendar),
            ("Flagged", flaggedCount, AppIcon.flagFilled),
        ]

        return LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            ForEach(items, id: \.label) { item in
                VStack(alignment: .leading, spacing: 10) {
                    RoundedRectangle(cornerRadius: 9)
                        .fill(theme.accentSoft)
                        .frame(width: 32, height: 32)
                        .overlay(
                            Image(systemName: item.icon)
                                .font(AppFont.iconSmall)
                                .foregroundStyle(theme.accent),
                        )

                    Text(item.label)
                        .font(AppFont.labelMedium)
                        .foregroundStyle(theme.textMuted)

                    Text("\(item.count)")
                        .font(AppFont.title)
                        .foregroundStyle(theme.text)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard(padding: AppLayout.paddingCompact, radius: AppLayout.radiusMedium)
            }
        }
    }

    // MARK: - Projects List

    private var projectsList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PROJECTS")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            if derivedProjects.isEmpty {
                emptyState(
                    icon: "tray",
                    headline: "No projects yet",
                    message: "Tag a task with a project and it'll show up here.",
                )
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(derivedProjects.enumerated()), id: \.element.id) { idx, project in
                        NavigationLink {
                            ProjectTodoListView(projectName: project.name)
                        } label: {
                            projectRow(project: project)
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

    private func projectRow(project: ProjectSummary) -> some View {
        let accent = project.meta?.accentColor ?? theme.accent
        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 9)
                .fill(accent.opacity(0.15))
                .frame(width: 32, height: 32)
                .overlay(
                    Group {
                        if let meta = project.meta {
                            CatGlyphView(kind: meta.icon, size: 16, color: accent)
                        } else {
                            Image(systemName: "folder")
                                .font(AppFont.iconTiny)
                                .foregroundStyle(accent)
                        }
                    },
                )

            Text(project.name)
                .font(AppFont.body)
                .foregroundStyle(theme.text)

            Spacer()

            Text("\(project.openCount)")
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
                .overlay(
                    Image(systemName: icon)
                        .font(AppFont.iconSmall)
                        .foregroundStyle(theme.accent),
                )

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

    // MARK: - Search Results

    private var taskSearchResults: some View {
        LazyVStack(alignment: .leading, spacing: AppLayout.cardSpacing) {
            Text("TASKS")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            if searchableTodos.isEmpty {
                Text("No matching tasks")
                    .font(AppFont.labelRegular)
                    .foregroundStyle(theme.textMuted)
                    .frame(maxWidth: .infinity)
                    .padding(20)
                    .glassCard(padding: 0)
                    .padding(.horizontal, AppLayout.sectionPadding)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(searchableTodos.enumerated()), id: \.element.id) { idx, todo in
                        TaskRowView(todo: todo)
                        if idx < searchableTodos.count - 1 {
                            Hairline(indent: 46)
                        }
                    }
                }
                .glassCard(padding: 0)
                .padding(.horizontal, AppLayout.sectionPadding)
            }
        }
    }

    // MARK: - Areas List

    private var areasList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("AREAS")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            if derivedAreas.isEmpty {
                emptyState(
                    icon: "square.stack.3d.up",
                    headline: "No areas yet",
                    message: "Tag a task with an area to group it here.",
                )
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(derivedAreas.enumerated()), id: \.element.id) { idx, area in
                        NavigationLink {
                            AreaTodoListView(areaName: area.name)
                        } label: {
                            areaRow(area: area)
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

    private func areaRow(area: AreaSummary) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 9)
                .fill(theme.surface2)
                .frame(width: 32, height: 32)
                .overlay(
                    Group {
                        if let meta = area.meta {
                            CatGlyphView(kind: meta.icon, size: 16, color: theme.textMuted)
                        } else {
                            Image(systemName: "square.stack.3d.up")
                                .font(AppFont.iconTiny)
                                .foregroundStyle(theme.textMuted)
                        }
                    },
                )

            Text(area.name)
                .font(AppFont.body)
                .foregroundStyle(theme.text)

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
}
