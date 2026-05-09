import SwiftUI

struct ContentView: View {
    @State private var selectedTab: AppTab = .home
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    #if os(macOS)
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    #endif

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    /// Tabs available for the current profile
    private var availableTabs: [AppTab] {
        #if os(macOS)
        if currentMember.showsFullBudget {
            return AppTab.macMoneyTabs + AppTab.macTaskTabs + AppTab.macSystemTabs
        } else {
            return [.home, .today, .projects, .stack, .netWorth, .more]
        }
        #else
        if currentMember.showsFullBudget {
            return AppTab.iOSTabs
        } else {
            // Kids: Home, Today, Stack, More — no shared household budget tab
            return [.home, .today, .stack, .more]
        }
        #endif
    }

    var body: some View {
        #if os(macOS)
        let sidebarBinding = Binding<AppTab?>(
            get: { selectedTab },
            set: { if let tab = $0 { selectedTab = tab } }
        )
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List(selection: sidebarBinding) {
                Section {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(currentMember.displayName)
                            .font(.headline)
                        Text("The Bitcoin Standard")
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                    .padding(.vertical, 4)
                }

                Section("Money") {
                    ForEach(AppTab.macMoneyTabs.filter { availableTabs.contains($0) }) { tab in
                        Label(tab.macTitle, systemImage: tab.icon)
                            .tag(tab)
                    }
                }

                Section("Tasks") {
                    ForEach(AppTab.macTaskTabs.filter { availableTabs.contains($0) }) { tab in
                        Label(tab.macTitle, systemImage: tab.icon)
                            .tag(tab)
                    }
                }

                Section("System") {
                    ForEach(AppTab.macSystemTabs.filter { availableTabs.contains($0) }) { tab in
                        Label(tab.macTitle, systemImage: tab.icon)
                            .tag(tab)
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
        } detail: {
            switch selectedTab {
            case .home: DashboardTab(selectedTab: $selectedTab)
            case .budget: SpendingTab()
            case .activity: SpendingTab(title: "Activity")
            case .today: TodayTab()
            case .stack: MoneyTab()
            case .netWorth: MoneyTab(title: "Net Worth")
            case .projects: MoreTab(title: "Projects")
            case .more: MoreTab()
            }
        }
        .navigationSplitViewStyle(.balanced)
        .tint(AppTheme.accentColor)
        .onAppear(perform: ensureSelectedTabIsAvailable)
        .onChange(of: selectedMember) { _, _ in
            ensureSelectedTabIsAvailable()
        }
        #else
        TabView(selection: $selectedTab) {
            DashboardTab(selectedTab: $selectedTab)
                .tabItem {
                    Label(AppTab.home.title, systemImage: AppTab.home.icon)
                }
                .tag(AppTab.home)

            if currentMember.showsFullBudget {
                SpendingTab()
                    .tabItem {
                        Label(AppTab.budget.title, systemImage: AppTab.budget.icon)
                    }
                    .tag(AppTab.budget)
            }

            TodayTab()
                .tabItem {
                    Label(AppTab.today.title, systemImage: AppTab.today.icon)
                }
                .tag(AppTab.today)

            MoneyTab()
                .tabItem {
                    Label(AppTab.stack.title, systemImage: AppTab.stack.icon)
                }
                .tag(AppTab.stack)

            MoreTab()
                .tabItem {
                    Label(AppTab.more.title, systemImage: AppTab.more.icon)
                }
                .tag(AppTab.more)
        }
        .tint(AppTheme.accentColor)
        .preferredColorScheme(.dark)
        .onAppear(perform: ensureSelectedTabIsAvailable)
        .onChange(of: selectedMember) { _, _ in
            ensureSelectedTabIsAvailable()
        }
        #endif
    }

    private func ensureSelectedTabIsAvailable() {
        if !availableTabs.contains(selectedTab) {
            selectedTab = .home
        }
        #if os(macOS)
        columnVisibility = .all
        #endif
    }
}

enum AppTab: String, CaseIterable, Identifiable {
    case home, budget, activity, today, stack, netWorth, projects, more

    var id: AppTab { self }

    static let iOSTabs: [AppTab] = [.home, .budget, .today, .stack, .more]
    static let macMoneyTabs: [AppTab] = [.home, .budget, .activity, .stack, .netWorth]
    static let macTaskTabs: [AppTab] = [.today, .projects]
    static let macSystemTabs: [AppTab] = [.more]

    var title: String {
        switch self {
        case .home:     "Home"
        case .budget:   "Budget"
        case .activity: "Activity"
        case .today:    "Today"
        case .stack:    "Stack"
        case .netWorth: "Net Worth"
        case .projects: "Projects"
        case .more:     "More"
        }
    }

    var macTitle: String {
        switch self {
        case .home: "Dashboard"
        case .stack: "Retirement"
        default: title
        }
    }

    var icon: String {
        switch self {
        case .home:     "bitcoinsign.circle.fill"
        case .budget:   "chart.bar.xaxis"
        case .activity: "bolt.circle.fill"
        case .today:    "checkmark.circle.fill"
        case .stack:    "vault.fill"
        case .netWorth: "target"
        case .projects: "tray.full.fill"
        case .more:     "ellipsis.circle.fill"
        }
    }
}

#Preview {
    ContentView()
}
