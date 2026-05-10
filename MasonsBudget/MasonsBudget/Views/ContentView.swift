import SwiftUI
import SwiftData

// MARK: - iOS Tabs

enum AppTab: String, CaseIterable, Identifiable {
    case home, budget, today, stack, more

    var id: String { rawValue }

    var label: String {
        switch self {
        case .home: "Home"
        case .budget: "Budget"
        case .today: "Today"
        case .stack: "Stack"
        case .more: "More"
        }
    }

    var icon: String {
        switch self {
        case .home: "bitcoinsign.circle"
        case .budget: "chart.bar.fill"
        case .today: "checkmark.circle"
        case .stack: "lock.shield.fill"
        case .more: "ellipsis.circle"
        }
    }
}

// MARK: - macOS Sidebar Navigation

enum MacNav: String, CaseIterable, Identifiable {
    case dashboard, budget, activity, retirement, netWorth
    case today, projects

    var id: String { rawValue }

    var label: String {
        switch self {
        case .dashboard: "Dashboard"
        case .budget: "Budget"
        case .activity: "Activity"
        case .retirement: "Retirement"
        case .netWorth: "Net Worth"
        case .today: "Today"
        case .projects: "Projects"
        }
    }

    var icon: String {
        switch self {
        case .dashboard: "bitcoinsign.circle"
        case .budget: "chart.bar.fill"
        case .activity: "bolt.fill"
        case .retirement: "lock.shield.fill"
        case .netWorth: "target"
        case .today: "checkmark.circle"
        case .projects: "tray.fill"
        }
    }

    static let moneyItems: [MacNav] = [.dashboard, .budget, .activity, .retirement, .netWorth]
    static let taskItems: [MacNav] = [.today, .projects]
}

// MARK: - Content View

struct ContentView: View {
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @Environment(\.theme) var theme

    @State private var selectedTab: AppTab = .home
    @State private var showAddTransaction = false
    @State private var showProfileSwitcher = false
    @State private var showVoiceTransaction = false

    #if os(macOS)
    @State private var macNav: MacNav? = .dashboard
    #endif

    var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    var unit: DisplayUnit {
        get { DisplayUnit(rawValue: displayUnitRaw) ?? .btc }
    }

    var body: some View {
        Group {
            #if os(iOS)
            iOSBody
            #else
            macOSBody
            #endif
        }
        .sheet(isPresented: $showAddTransaction) {
            addTransactionSheet
        }
        .sheet(isPresented: $showProfileSwitcher) {
            ProfileSwitcherView()
        }
        .sheet(isPresented: $showVoiceTransaction) {
            VoiceTransactionView()
        }
    }

    // MARK: - iOS

    #if os(iOS)
    @ViewBuilder
    private var iOSBody: some View {
        TabView(selection: $selectedTab) {
            ForEach(AppTab.allCases) { tab in
                NavigationStack {
                    screenForTab(tab)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                avatarButton
                            }
                            ToolbarItem(placement: .principal) {
                                unitToggleCompact
                            }
                            ToolbarItem(placement: .topBarTrailing) {
                                HStack(spacing: 8) {
                                    voiceButton
                                    addButton
                                }
                            }
                        }
                        .toolbarBackground(theme.bg, for: .navigationBar)
                }
                .tabItem {
                    Image(systemName: tab.icon)
                    Text(tab.label)
                }
                .tag(tab)
            }
        }
        .tint(theme.accent)
    }
    #endif

    // MARK: - macOS

    #if os(macOS)
    @ViewBuilder
    private var macOSBody: some View {
        NavigationSplitView {
            macSidebar
        } detail: {
            macDetail
        }
        .navigationSplitViewColumnWidth(min: 200, ideal: AppLayout.sidebarWidth, max: 280)
    }

    private var macSidebar: some View {
        VStack(spacing: 0) {
            workspaceSwitcher
                .padding(.horizontal, 8)
                .padding(.bottom, 12)

            newTransactionButton
                .padding(.horizontal, 8)
                .padding(.bottom, 8)

            voiceTransactionButton
                .padding(.horizontal, 8)
                .padding(.bottom, 12)

            List(selection: $macNav) {
                Section {
                    ForEach(MacNav.moneyItems) { item in
                        Label(item.label, systemImage: item.icon).tag(item)
                    }
                } header: {
                    Text("Money")
                        .font(AppFont.sectionHeader)
                        .tracking(AppFont.sectionTracking)
                        .textCase(.uppercase)
                        .foregroundStyle(theme.textFaint)
                }

                Section {
                    ForEach(MacNav.taskItems) { item in
                        Label(item.label, systemImage: item.icon).tag(item)
                    }
                } header: {
                    Text("Tasks")
                        .font(AppFont.sectionHeader)
                        .tracking(AppFont.sectionTracking)
                        .textCase(.uppercase)
                        .foregroundStyle(theme.textFaint)
                }
            }
            .listStyle(.sidebar)

            Spacer()

            macSidebarFooter
        }
    }

    @ViewBuilder
    private var macDetail: some View {
        switch macNav ?? .dashboard {
        case .dashboard:  DashboardView()
        case .budget:     BudgetView()
        case .activity:   ActivityView()
        case .retirement: RetirementView()
        case .netWorth:   NetWorthView()
        case .today:      TodayView()
        case .projects:   ProjectsView()
        }
    }

    private var workspaceSwitcher: some View {
        Button {
            showProfileSwitcher = true
        } label: {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 6)
                    .fill(LinearGradient(colors: [theme.accent, theme.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 22, height: 22)
                    .overlay(
                        Text(String(activeMember.displayName.prefix(1)))
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.white)
                    )

                VStack(alignment: .leading, spacing: 1) {
                    Text(activeMember.displayName)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(theme.text)
                    Text("Vogel Vault")
                        .font(.system(size: 10))
                        .foregroundStyle(theme.textFaint)
                }

                Spacer()
                Image(systemName: "chevron.down")
                    .font(.system(size: 10))
                    .foregroundStyle(theme.textFaint)
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay(
            RoundedRectangle(cornerRadius: 7)
                .stroke(theme.border, lineWidth: 1)
        )
    }

    private var newTransactionButton: some View {
        Button {
            showAddTransaction = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "plus")
                    .font(.system(size: 13, weight: .semibold))
                Text("New transaction")
                    .font(.system(size: 12.5, weight: .semibold))
                Spacer()
                Text("\u{2318}N")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.85))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(theme.accent)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .shadow(color: Color(hex: 0xF7931A).opacity(0.35), radius: 3, y: 2)
    }

    private var voiceTransactionButton: some View {
        Button {
            showVoiceTransaction = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "mic.fill")
                    .font(.system(size: 13, weight: .semibold))
                Text("Voice transaction")
                    .font(.system(size: 12.5, weight: .semibold))
                Spacer()
            }
            .foregroundStyle(theme.accent)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(theme.accentSoft)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }

    private var macSidebarFooter: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
                .background(theme.border)

            VStack(alignment: .leading, spacing: 6) {
                Text("NET WORTH")
                    .font(AppFont.sectionHeader)
                    .tracking(AppFont.sectionTracking)
                    .foregroundStyle(theme.textFaint)
                    .padding(.horizontal, 6)

                Text("--")
                    .font(.system(size: 18, weight: .bold, design: .monospaced))
                    .foregroundStyle(theme.text)
                    .padding(.horizontal, 6)
            }
            .padding(.horizontal, 10)

            HStack(spacing: 6) {
                unitToggleCompact
                Spacer()
            }
            .padding(.horizontal, 10)
        }
        .padding(.bottom, 10)
    }
    #endif

    // MARK: - Shared Components

    private var avatarButton: some View {
        Button {
            showProfileSwitcher = true
        } label: {
            RoundedRectangle(cornerRadius: 10)
                .fill(LinearGradient(colors: [theme.accent, theme.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 32, height: 32)
                .overlay(
                    Text(String(activeMember.displayName.prefix(1)))
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white)
                )
                .shadow(color: Color(hex: 0xF7931A).opacity(0.35), radius: 3, y: 2)
        }
        .buttonStyle(.plain)
    }

    private var addButton: some View {
        Button {
            showAddTransaction = true
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(theme.accent)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .shadow(color: Color(hex: 0xF7931A).opacity(0.35), radius: 3, y: 2)
        }
    }

    private var voiceButton: some View {
        Button {
            showVoiceTransaction = true
        } label: {
            Image(systemName: "mic.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(theme.accent)
                .frame(width: 32, height: 32)
                .background(theme.accentSoft)
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    private var unitToggleCompact: some View {
        HStack(spacing: 0) {
            ForEach(DisplayUnit.allCases) { u in
                Button {
                    displayUnitRaw = u.rawValue
                } label: {
                    Text(u.label)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(unit == u ? .white : theme.textMuted)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(unit == u ? theme.accent : Color.clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(theme.surface2)
        .clipShape(Capsule())
    }

    // MARK: - Screen Routing

    @ViewBuilder
    private func screenForTab(_ tab: AppTab) -> some View {
        switch tab {
        case .home:   DashboardView()
        case .budget: BudgetView()
        case .today:  TodayView()
        case .stack:  RetirementView()
        case .more:   NetWorthView()
        }
    }

    @ViewBuilder
    private var addTransactionSheet: some View {
        AddTransactionView()
            .presentationDetents([.large])
    }
}
