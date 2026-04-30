import SwiftUI

struct ContentView: View {
    @State private var selectedTab: AppTab = .dashboard

    var body: some View {
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
