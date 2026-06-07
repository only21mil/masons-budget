import SwiftData
import SwiftUI

// MARK: - iOS Tabs

enum AppTab: String, CaseIterable, Identifiable {
    case home, budget, tasks, vault, more

    var id: String {
        rawValue
    }

    var label: String {
        switch self {
        case .home: "Home"
        case .budget: "Budget"
        case .tasks: "Tasks"
        case .vault: "Vault"
        case .more: "More"
        }
    }

    var icon: String {
        switch self {
        case .home: "bitcoinsign.circle"
        case .budget: "chart.bar.fill"
        case .tasks: "checklist"
        case .vault: "lock.shield.fill"
        case .more: "ellipsis.circle"
        }
    }
}

// MARK: - macOS Sidebar Navigation

enum MacNav: String, CaseIterable, Identifiable {
    case dashboard, budget, activity, btcBuys, billPay, retirement, netWorth
    case today, inbox, upcoming, flagged, projects, export

    var id: String {
        rawValue
    }

    var label: String {
        switch self {
        case .dashboard: "Dashboard"
        case .budget: "Budget"
        case .activity: "Activity"
        case .btcBuys: "Bitcoin Buys"
        case .billPay: "Bill Pay"
        case .retirement: "Retirement"
        case .netWorth: "Net Worth"
        case .today: "Today"
        case .inbox: "Inbox"
        case .upcoming: "Upcoming"
        case .flagged: "Flagged"
        case .projects: "Projects"
        case .export: "Export"
        }
    }

    var icon: String {
        switch self {
        case .dashboard: "bitcoinsign.circle"
        case .budget: "chart.bar.fill"
        case .activity: "bolt.fill"
        case .btcBuys: "bitcoinsign.circle.fill"
        case .billPay: "banknote.fill"
        case .retirement: "lock.shield.fill"
        case .netWorth: "target"
        case .today: "checkmark.circle"
        case .inbox: "tray"
        case .upcoming: "calendar"
        case .flagged: "flag.fill"
        case .projects: "tray.fill"
        case .export: "square.and.arrow.up"
        }
    }

    static let moneyItems: [MacNav] = [.dashboard, .budget, .activity, .btcBuys, .billPay, .retirement, .netWorth]
    static let taskItems: [MacNav] = [.today, .inbox, .upcoming, .flagged, .projects]
    static let toolItems: [MacNav] = [.export]
}

// MARK: - Content View

struct ContentView: View {
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("appearance_mode") private var appearanceModeRaw = AppearanceMode.system.rawValue
    @Environment(\.theme) var theme

    @Query private var btcAccounts: [BTCAccount]
    @Query private var holdingAccounts: [HoldingAccount]

    @State private var selectedTab: AppTab = .home
    @StateObject private var syncStatus = SyncStatusStore.shared
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
        DisplayUnit(rawValue: displayUnitRaw) ?? .btc
    }

    private var appearanceMode: AppearanceMode {
        AppearanceMode(rawValue: appearanceModeRaw) ?? .system
    }

    var body: some View {
        Group {
            #if os(iOS)
                iOSBody
            #else
                macOSBody
            #endif
        }
        .environmentObject(syncStatus)
        .overlay(alignment: .top) {
            syncFailureBanner
                .padding(.horizontal, AppLayout.sectionPadding)
                .padding(.top, 10)
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
                                        syncStatusGlyph
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

                    Section {
                        ForEach(MacNav.toolItems) { item in
                            Label(item.label, systemImage: item.icon).tag(item)
                        }
                    } header: {
                        Text("Tools")
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

        private var macDetail: some View {
            NavigationStack {
                switch macNav ?? .dashboard {
                case .dashboard: DashboardView()
                case .budget: BudgetView()
                case .activity: ActivityView()
                case .btcBuys: BTCBuysView()
                case .billPay: BTCBillPayView()
                case .retirement: RetirementView()
                case .netWorth: NetWorthView()
                case .today: TodayView()
                case .inbox: TaskSmartListView(filter: .inbox)
                case .upcoming: TaskSmartListView(filter: .upcoming)
                case .flagged: TaskSmartListView(filter: .flagged)
                case .projects: ProjectsView()
                case .export: ExportView()
                }
            }
            .id(macNav)
            .overlay(alignment: .topTrailing) {
                HStack(spacing: 8) {
                    syncStatusGlyph
                    appearanceToggle
                }
                .padding(.top, 12)
                .padding(.trailing, 20)
            }
        }

        private var appearanceToggle: some View {
            HStack(spacing: 0) {
                Button {
                    appearanceModeRaw = AppearanceMode.light.rawValue
                } label: {
                    Image(systemName: "sun.max.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(appearanceMode == .light ? .white : theme.textMuted)
                        .frame(width: 28, height: 24)
                        .background(appearanceMode == .light ? theme.accent : Color.clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)

                Button {
                    appearanceModeRaw = AppearanceMode.dark.rawValue
                } label: {
                    Image(systemName: "moon.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(appearanceMode == .dark ? .white : theme.textMuted)
                        .frame(width: 28, height: 24)
                        .background(appearanceMode == .dark ? theme.accent : Color.clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            .padding(2)
            .background(theme.surface2)
            .clipShape(Capsule())
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
                                .foregroundStyle(.white),
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
                    .stroke(theme.border, lineWidth: 1),
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

        private var sidebarNetWorth: String {
            let btcPrice = BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice
            let totalBtc = btcAccounts
                .filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
                .reduce(Decimal(0)) { $0 + $1.btc }
            let vooPrice = StockPriceService.vooPrice
            let ibitPrice = StockPriceService.ibitPrice
            let holdingsUsd = holdingAccounts
                .filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
                .reduce(Decimal(0)) { $0 + $1.liveValue(vooPrice: vooPrice, ibitPrice: ibitPrice) }
            let totalSats = (totalBtc * 100_000_000) + (btcPrice > 0 ? (holdingsUsd / btcPrice) * 100_000_000 : 0)
            return AppFormatter.formatAmount(sats: totalSats, unit: unit, btcPrice: btcPrice)
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

                    Text(sidebarNetWorth)
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
                        .foregroundStyle(.white),
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

    @ViewBuilder
    private var syncStatusGlyph: some View {
        if syncStatus.phase != .idle {
            Button {
                if syncStatus.phase == .failed {
                    syncStatus.retry()
                }
            } label: {
                Image(systemName: syncStatusIcon)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(syncStatus.phase == .failed ? theme.danger : theme.accent)
                    .frame(width: 32, height: 32)
                    .background(syncStatus.phase == .failed ? theme.dangerSoft : theme.accentSoft)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(alignment: .topTrailing) {
                        if syncStatus.pendingCount > 1 {
                            Text("\(syncStatus.pendingCount)")
                                .font(.system(size: 9, weight: .bold, design: .monospaced))
                                .foregroundStyle(.white)
                                .frame(minWidth: 14, minHeight: 14)
                                .background(theme.accent)
                                .clipShape(Circle())
                                .offset(x: 4, y: -4)
                        }
                    }
            }
            .buttonStyle(.plain)
        }
    }

    private var syncStatusIcon: String {
        switch syncStatus.phase {
        case .idle: "checkmark.icloud.fill"
        case .syncing: "arrow.triangle.2.circlepath.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    @ViewBuilder
    private var syncFailureBanner: some View {
        if syncStatus.phase == .failed, let message = syncStatus.lastError {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(theme.danger)

                VStack(alignment: .leading, spacing: 2) {
                    Text(message)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(theme.text)
                    Text("Saved locally. Retry sync when ready.")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.textMuted)
                }

                Spacer()

                Button("Retry") {
                    syncStatus.retry()
                }
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(theme.accent)
                .buttonStyle(.plain)

                Button {
                    syncStatus.dismissFailure()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(theme.textMuted)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(theme.danger.opacity(0.35), lineWidth: 1),
            )
            .shadow(color: Color.black.opacity(0.12), radius: 8, y: 4)
        }
    }

    // MARK: - Screen Routing

    @ViewBuilder
    private func screenForTab(_ tab: AppTab) -> some View {
        switch tab {
        case .home: DashboardView()
        case .budget: BudgetView()
        case .tasks: TasksView()
        case .vault: RetirementView()
        case .more: MoreMenuView()
        }
    }

    private var addTransactionSheet: some View {
        AddTransactionView()
            .presentationDetents([.large])
    }
}
