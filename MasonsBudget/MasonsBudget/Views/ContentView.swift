import SwiftUI

struct ContentView: View {
    @State private var selectedTab: AppTab = .dashboard

    var body: some View {
        #if os(macOS)
        let sidebarBinding = Binding<AppTab?>(
            get: { selectedTab },
            set: { if let tab = $0 { selectedTab = tab } }
        )
        NavigationSplitView {
            List(AppTab.allCases, selection: sidebarBinding) { tab in
                Label(tab.title, systemImage: tab.icon)
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
        } detail: {
            switch selectedTab {
            case .dashboard: DashboardTab(selectedTab: $selectedTab)
            case .money: MoneyTab()
            case .spending: SpendingTab()
            case .settings: SettingsTab()
            }
        }
        .tint(AppTheme.accentColor)
        #else
        TabView(selection: $selectedTab) {
            DashboardTab(selectedTab: $selectedTab)
                .tabItem {
                    Label(AppTab.dashboard.title, systemImage: AppTab.dashboard.icon)
                }
                .tag(AppTab.dashboard)

            MoneyTab()
                .tabItem {
                    Label(AppTab.money.title, systemImage: AppTab.money.icon)
                }
                .tag(AppTab.money)

            SpendingTab()
                .tabItem {
                    Label(AppTab.spending.title, systemImage: AppTab.spending.icon)
                }
                .tag(AppTab.spending)

            SettingsTab()
                .tabItem {
                    Label(AppTab.settings.title, systemImage: AppTab.settings.icon)
                }
                .tag(AppTab.settings)
        }
        .tint(AppTheme.accentColor)
        #endif
    }
}

enum AppTab: String, CaseIterable, Identifiable {
    case dashboard, money, spending, settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .dashboard: "Dashboard"
        case .money:     "Money"
        case .spending:  "Spending"
        case .settings:  "Settings"
        }
    }

    var icon: String {
        switch self {
        case .dashboard: "chart.bar.fill"
        case .money:     "bitcoinsign.circle.fill"
        case .spending:  "creditcard.fill"
        case .settings:  "gearshape.fill"
        }
    }
}

#Preview {
    ContentView()
}
