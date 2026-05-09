import SwiftUI
import SwiftData

struct ContentView: View {
    @State private var selectedTab: AppTab = .home
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    #if os(macOS)
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    #endif

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    var body: some View {
        #if os(macOS)
        macOSBody
        #else
        iOSBody
        #endif
    }

    // MARK: - iOS

    #if os(iOS)
    private var iOSBody: some View {
        TabView(selection: $selectedTab) {
            DashboardTab(selectedTab: $selectedTab)
                .tabItem { Label(AppTab.home.title, systemImage: AppTab.home.icon) }
                .tag(AppTab.home)

            if currentMember.showsFullBudget {
                SpendingTab()
                    .tabItem { Label(AppTab.budget.title, systemImage: AppTab.budget.icon) }
                    .tag(AppTab.budget)
            }

            TodayTab()
                .tabItem { Label(AppTab.today.title, systemImage: AppTab.today.icon) }
                .tag(AppTab.today)

            RetirementTab()
                .tabItem { Label(AppTab.stack.title, systemImage: AppTab.stack.icon) }
                .tag(AppTab.stack)

            ProjectsTab()
                .tabItem { Label(AppTab.more.title, systemImage: AppTab.more.icon) }
                .tag(AppTab.more)
        }
        .tint(AppTheme.accentColor)
        .preferredColorScheme(.dark)
    }
    #endif

    // MARK: - macOS

    #if os(macOS)
    private var macOSBody: some View {
        let sidebarBinding = Binding<AppTab?>(
            get: { selectedTab },
            set: { if let tab = $0 { selectedTab = tab } }
        )

        return NavigationSplitView(columnVisibility: $columnVisibility) {
            VStack(spacing: 0) {
                macOSSidebarContent(selection: sidebarBinding)
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 200, ideal: 220)
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    Button {
                        columnVisibility = (columnVisibility == .detailOnly) ? .all : .detailOnly
                    } label: {
                        Label("Toggle Sidebar", systemImage: "sidebar.left")
                    }
                    .keyboardShortcut("s", modifiers: [.command, .control])
                }
            }
        } detail: {
            NavigationStack {
                macOSDetail
            }
            .id(selectedTab)
        }
        .navigationSplitViewStyle(.balanced)
        .tint(AppTheme.accentColor)
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var macOSDetail: some View {
        switch selectedTab {
        case .home:    DashboardTab(selectedTab: $selectedTab)
        case .budget:  SpendingTab()
        case .today:   TodayTab()
        case .stack:   RetirementTab()
        case .more:    ProjectsTab()
        case .settings: SettingsTab()
        }
    }

    private func macOSSidebarContent(selection: Binding<AppTab?>) -> some View {
        List(selection: selection) {
            Section("Money") {
                Label(AppTab.home.title, systemImage: AppTab.home.icon)
                    .tag(AppTab.home)
                if currentMember.showsFullBudget {
                    Label(AppTab.budget.title, systemImage: AppTab.budget.icon)
                        .tag(AppTab.budget)
                }
                Label(AppTab.stack.title, systemImage: AppTab.stack.icon)
                    .tag(AppTab.stack)
            }

            Section("Tasks") {
                Label(AppTab.today.title, systemImage: AppTab.today.icon)
                    .tag(AppTab.today)
                Label(AppTab.more.title, systemImage: AppTab.more.icon)
                    .tag(AppTab.more)
            }

            Section {
                Label(AppTab.settings.title, systemImage: AppTab.settings.icon)
                    .tag(AppTab.settings)
            }
        }
    }
    #endif
}

// MARK: - Tab enum

enum AppTab: String, CaseIterable, Identifiable {
    case home, budget, today, stack, more, settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home:     "Home"
        case .budget:   "Budget"
        case .today:    "Today"
        case .stack:    "Stack"
        case .more:     "More"
        case .settings: "Settings"
        }
    }

    var icon: String {
        switch self {
        case .home:     "bitcoinsign.circle.fill"
        case .budget:   "chart.bar.fill"
        case .today:    "checkmark.circle.fill"
        case .stack:    "building.columns.fill"
        case .more:     "ellipsis.circle.fill"
        case .settings: "gearshape.fill"
        }
    }
}

#Preview {
    ContentView()
}
