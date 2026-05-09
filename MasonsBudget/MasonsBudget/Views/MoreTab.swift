import SwiftData
import SwiftUI

struct MoreTab: View {
    @Query private var todos: [TodoItem]
    @Query private var accounts: [BTCAccount]
    @Query private var holdings: [HoldingAccount]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var visibleTodos: [TodoItem] {
        todos.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var visibleAccounts: [BTCAccount] {
        accounts.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var visibleHoldings: [HoldingAccount] {
        holdings.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private func projectKey(for todo: TodoItem) -> String {
        let trimmed = todo.project?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false) ? trimmed! : "Inbox"
    }

    private var projects: [(String, Int)] {
        let grouped = Dictionary(grouping: visibleTodos.filter { !$0.isDone }, by: projectKey(for:))
        return grouped
            .map { ($0.key, $0.value.count) }
            .sorted { $0.0 < $1.0 }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AppTheme.cardSpacing) {
                    header
                    focusGrid
                    projectsSection
                    NavigationLink {
                        SettingsTab()
                    } label: {
                        HStack {
                            Label("Settings", systemImage: "gearshape.fill")
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundStyle(AppTheme.secondaryText)
                        }
                        .foregroundStyle(AppTheme.primaryText)
                        .glassCard()
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 16)
                .padding(.bottom, 32)
            }
            .background(AppTheme.background.ignoresSafeArea())
            .navigationTitle("More")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Areas of Focus")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(AppTheme.accentColor)
                .textCase(.uppercase)
            Text("Projects")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(AppTheme.primaryText)
            Text("Todo, stack, and profile controls stay synced with MC2.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var focusGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            focusCard("Inbox", count: visibleTodos.filter { !$0.isDone && projectKey(for: $0) == "Inbox" }.count, icon: "tray.fill")
            focusCard("Today", count: visibleTodos.filter { todo in
                guard !todo.isDone else { return false }
                guard let due = todo.dueDate else { return true }
                return Calendar.current.isDateInToday(due)
            }.count, icon: "target")
            focusCard("Flagged", count: visibleTodos.filter { $0.isFlagged && !$0.isDone }.count, icon: "flag.fill")
            focusCard("Assets", count: visibleAccounts.count + visibleHoldings.count, icon: "vault.fill")
        }
    }

    private func focusCard(_ title: String, count: Int, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: icon)
                .font(.headline)
                .foregroundStyle(AppTheme.accentColor)
                .frame(width: 32, height: 32)
                .background(AppTheme.warmGlow, in: RoundedRectangle(cornerRadius: 9))
            Text(title)
                .font(.subheadline)
                .foregroundStyle(AppTheme.secondaryText)
            Text("\(count)")
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .foregroundStyle(AppTheme.primaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    private var projectsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Projects")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(AppTheme.secondaryText)
                .textCase(.uppercase)
            VStack(spacing: 0) {
                if projects.isEmpty {
                    Text("No synced projects yet")
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.secondaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 12)
                } else {
                    ForEach(Array(projects.enumerated()), id: \.element.0) { index, project in
                        HStack(spacing: 12) {
                            Image(systemName: "folder.fill")
                                .foregroundStyle(AppTheme.accentColor)
                            Text(project.0)
                                .foregroundStyle(AppTheme.primaryText)
                            Spacer()
                            Text("\(project.1)")
                                .font(AppTheme.monoCaption)
                                .foregroundStyle(AppTheme.secondaryText)
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(AppTheme.secondaryText)
                        }
                        .padding(.vertical, 12)
                        if index < projects.count - 1 { Divider().overlay(AppTheme.cardBorder) }
                    }
                }
            }
            .glassCard()
        }
    }
}

#Preview {
    MoreTab()
}
