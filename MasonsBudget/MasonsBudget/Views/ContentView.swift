import SwiftUI

struct ContentView: View {
    @State private var selectedTab: AppTab = .home
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    /// Tabs available for the current profile
    private var availableTabs: [AppTab] {
        if currentMember.showsFullBudget {
            return AppTab.allCases
        } else {
            // Kids: Home, Today, Stack, More — no shared household budget tab
            return [.home, .today, .stack, .more]
        }
    }

    var body: some View {
        #if os(macOS)
        let sidebarBinding = Binding<AppTab?>(
            get: { selectedTab },
            set: { if let tab = $0 { selectedTab = tab } }
        )
        NavigationSplitView {
            List(availableTabs, selection: sidebarBinding) { tab in
                Label(tab.title, systemImage: tab.icon)
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
        } detail: {
            switch selectedTab {
            case .home: DashboardTab(selectedTab: $selectedTab)
            case .budget: SpendingTab()
            case .today: TodayTab()
            case .stack: MoneyTab()
            case .more: MoreTab()
            }
        }
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
    }
}

enum AppTab: String, CaseIterable, Identifiable {
    case home, budget, today, stack, more

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home:   "Home"
        case .budget: "Budget"
        case .today:  "Today"
        case .stack:  "Stack"
        case .more:   "More"
        }
    }

    var icon: String {
        switch self {
        case .home:   "bitcoinsign.circle.fill"
        case .budget: "chart.bar.xaxis"
        case .today:  "checkmark.circle.fill"
        case .stack:  "vault.fill"
        case .more:   "ellipsis.circle.fill"
        }
    }
}

#Preview {
    ContentView()
}
