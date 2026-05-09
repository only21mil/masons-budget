import SwiftUI
import SwiftData

struct ProjectsTab: View {
    @Query private var todos: [TodoItem]

    private var inboxCount: Int {
        todos.filter { $0.project == "Inbox" && !$0.isDone }.count
    }

    private var todayCount: Int {
        todos.filter { $0.when == "Today" && !$0.isDone }.count
    }

    private var upcomingCount: Int {
        todos.filter { $0.when != "Today" && !$0.isDone }.count
    }

    private var flaggedCount: Int {
        todos.filter { $0.isFlagged && !$0.isDone }.count
    }

    private var projectNames: [String] {
        let names = Set(todos.map(\.project)).sorted()
        return names.filter { $0 != "Inbox" }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AppTheme.cardSpacing) {
                    screenHeader
                    shortcutGrid
                    projectsList
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 8)
                .padding(.bottom, 100)
            }
            .background(AppTheme.background)
            .navigationTitle("More")
            #if os(iOS)
            .toolbarColorScheme(.dark, for: .navigationBar)
            #endif
        }
    }

    // MARK: - Header

    private var screenHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("AREAS OF FOCUS")
                .font(AppTheme.eyebrowFont)
                .tracking(1)
                .foregroundStyle(AppTheme.accentColor)
            Text("Projects")
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(AppTheme.primaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    // MARK: - Shortcuts

    private var shortcutGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            shortcutCard(label: "Inbox", count: inboxCount, icon: "tray.fill")
            shortcutCard(label: "Today", count: todayCount, icon: "target")
            shortcutCard(label: "Upcoming", count: upcomingCount, icon: "calendar")
            shortcutCard(label: "Flagged", count: flaggedCount, icon: "flag.fill")
        }
    }

    private func shortcutCard(label: String, count: Int, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundStyle(AppTheme.accentColor)
                .frame(width: 32, height: 32)
                .background(AppTheme.accentSoft)
                .clipShape(RoundedRectangle(cornerRadius: 9))

            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(AppTheme.secondaryText)

            Text("\(count)")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(AppTheme.primaryText)
        }
        .glassCard()
    }

    // MARK: - Projects List

    private var projectsList: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !projectNames.isEmpty {
                Text("PROJECTS")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(AppTheme.secondaryText)
                    .padding(.horizontal, 4)

                VStack(spacing: 0) {
                    ForEach(Array(projectNames.enumerated()), id: \.element) { index, project in
                        let count = todos.filter { $0.project == project && !$0.isDone }.count

                        HStack(spacing: 12) {
                            RoundedRectangle(cornerRadius: 9)
                                .fill(AppTheme.accentSoft)
                                .frame(width: 32, height: 32)
                                .overlay(
                                    Image(systemName: "folder.fill")
                                        .font(.system(size: 14))
                                        .foregroundStyle(AppTheme.accentColor)
                                )

                            Text(project)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(AppTheme.primaryText)

                            Spacer()

                            Text("\(count)")
                                .font(.system(size: 13))
                                .foregroundStyle(AppTheme.tertiaryText)

                            Image(systemName: "chevron.right")
                                .font(.system(size: 12))
                                .foregroundStyle(AppTheme.tertiaryText)
                        }
                        .padding(.vertical, 12)
                        .padding(.horizontal, 14)

                        if index < projectNames.count - 1 {
                            Divider()
                                .background(AppTheme.cardBorder)
                                .padding(.leading, 58)
                        }
                    }
                }
                .background(AppTheme.cardBackground)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
                .overlay(
                    RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                        .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
                )
            } else {
                Text("Create tasks in Today to see projects here.")
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.secondaryText)
                    .glassCard()
            }
        }
    }
}
