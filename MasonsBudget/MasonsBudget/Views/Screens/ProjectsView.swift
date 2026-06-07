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

    private var inboxCount: Int {
        allTodos.count(where: {
            activeMember.canSee(dataOwnedBy: $0.ownerMember) &&
                !$0.isDone &&
                $0.project == nil &&
                $0.area == nil
        })
    }

    private var todayCount: Int {
        let cal = Calendar.current
        return allTodos.count(where: { todo in
            activeMember.canSee(dataOwnedBy: todo.ownerMember) && !todo.isDone &&
                (todo.dueDate.map { cal.isDateInToday($0) } ?? false)
        })
    }

    private var upcomingCount: Int {
        allTodos.count(where: { todo in
            activeMember.canSee(dataOwnedBy: todo.ownerMember) && !todo.isDone &&
                (todo.dueDate.map { $0 > Date() } ?? false)
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
                                .font(.system(size: 18))
                                .foregroundStyle(theme.accent),
                        )

                    Text(item.label)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(theme.textMuted)

                    Text("\(item.count)")
                        .font(.system(size: 22, weight: .bold))
                        .tracking(-0.44)
                        .foregroundStyle(theme.text)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard(padding: AppLayout.paddingCompact, radius: AppLayout.radiusMedium)
            }
        }
    }

    // MARK: - Projects List

    private var projectsList: some View {
        let visible = projects.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }

        return VStack(alignment: .leading, spacing: 8) {
            Text("PROJECTS")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            if visible.isEmpty {
                Text("No projects yet")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.textFaint)
                    .padding(.horizontal, AppLayout.sectionPadding)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.element.projectId) { idx, project in
                        NavigationLink {
                            ProjectTodoListView(projectName: project.name)
                        } label: {
                            projectRow(project: project)
                        }
                        .buttonStyle(.plain)
                        if idx < visible.count - 1 {
                            Hairline(indent: 58)
                        }
                    }
                }
                .glassCard(padding: 0)
                .padding(.horizontal, AppLayout.sectionPadding)
            }
        }
    }

    private func projectRow(project: TodoProject) -> some View {
        let count = allTodos.count(where: {
            activeMember.canSee(dataOwnedBy: $0.ownerMember) &&
                $0.project == project.name &&
                !$0.isDone
        })
        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 9)
                .fill(project.accentColor.opacity(0.15))
                .frame(width: 32, height: 32)
                .overlay(
                    CatGlyphView(kind: project.icon, size: 16, color: project.accentColor),
                )

            Text(project.name)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(theme.text)

            Spacer()

            Text("\(count)")
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(theme.textFaint)
                .monospacedDigit()

            Image(systemName: AppIcon.arrowRight)
                .font(.system(size: 12))
                .foregroundStyle(theme.textFaint)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    // MARK: - Search Results

    private var taskSearchResults: some View {
        LazyVStack(alignment: .leading, spacing: AppLayout.cardSpacing) {
            Text("TASKS")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            if searchableTodos.isEmpty {
                Text("No matching tasks")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.textFaint)
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
        let visible = areas.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }

        return VStack(alignment: .leading, spacing: 8) {
            Text("AREAS")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            if visible.isEmpty {
                Text("No areas defined yet")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.textFaint)
                    .padding(.horizontal, AppLayout.sectionPadding)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.element.areaId) { idx, area in
                        areaRow(area: area)
                        if idx < visible.count - 1 {
                            Hairline(indent: 58)
                        }
                    }
                }
                .glassCard(padding: 0)
                .padding(.horizontal, AppLayout.sectionPadding)
            }
        }
    }

    private func areaRow(area: TodoArea) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 9)
                .fill(theme.surface2)
                .frame(width: 32, height: 32)
                .overlay(
                    CatGlyphView(kind: area.icon, size: 16, color: theme.textMuted),
                )

            Text(area.name)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(theme.text)

            Spacer()

            Image(systemName: AppIcon.arrowRight)
                .font(.system(size: 12))
                .foregroundStyle(theme.textFaint)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }
}
