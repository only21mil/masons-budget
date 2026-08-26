import SwiftData
import SwiftUI

// MARK: - iOS Tabs

enum AppTab: String, CaseIterable, Identifiable {
    case home, budget, today, vault, more

    var id: String {
        rawValue
    }

    var label: String {
        switch self {
        case .home: "Bitcoin"
        case .budget: "Budget"
        case .today: "Today"
        case .vault: "Vault"
        case .more: "More"
        }
    }

    var icon: String {
        switch self {
        case .home: "bitcoinsign.circle"
        case .budget: "chart.bar.fill"
        case .today: "checkmark.circle.fill"
        case .vault: "lock.shield.fill"
        case .more: "ellipsis.circle"
        }
    }
}

// MARK: - macOS Sidebar Navigation

enum MacNav: String, CaseIterable, Identifiable {
    case dashboard, price, budget, activity, btcBuys, billPay, transfer, retirement, netWorth
    case today, inbox, upcoming, flagged, projects, family, awards, settings, syncSetup, export

    var id: String {
        rawValue
    }

    var label: String {
        switch self {
        case .dashboard: "Bitcoin"
        case .price: "Price"
        case .budget: "Budget"
        case .activity: "Activity"
        case .btcBuys: "Bitcoin Buys"
        case .billPay: "Bill Pay"
        case .transfer: "Transfer"
        case .retirement: "Retirement"
        case .netWorth: "Net Worth"
        case .today: "Today"
        case .inbox: "Inbox"
        case .upcoming: "Upcoming"
        case .flagged: "Flagged"
        case .projects: "Projects"
        case .family: "Family"
        case .awards: "Awards"
        case .settings: "Settings"
        case .syncSetup: "Sync Setup"
        case .export: "Export"
        }
    }

    var icon: String {
        switch self {
        case .dashboard: "bitcoinsign.circle"
        case .price: "chart.xyaxis.line"
        case .budget: "chart.bar.fill"
        case .activity: "bolt.fill"
        case .btcBuys: "bitcoinsign.circle.fill"
        case .billPay: "banknote.fill"
        case .transfer: "arrow.left.arrow.right"
        case .retirement: "lock.shield.fill"
        case .netWorth: "target"
        case .today: "checkmark.circle"
        case .inbox: "tray"
        case .upcoming: "calendar"
        case .flagged: "flag.fill"
        case .projects: "tray.fill"
        case .family: "person.3.fill"
        case .awards: "medal.fill"
        case .settings: "gearshape"
        case .syncSetup: "arrow.triangle.2.circlepath"
        case .export: "square.and.arrow.up"
        }
    }

    static let moneyItems: [MacNav] = [.dashboard, .price, .budget, .activity, .btcBuys, .billPay, .transfer, .retirement, .netWorth]
    static let taskItems: [MacNav] = [.today, .inbox, .upcoming, .flagged, .projects]
    static let toolItems: [MacNav] = [.family, .awards, .settings, .syncSetup, .export]
}

// MARK: - Content View

struct ContentView: View {
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("appearance_mode") private var appearanceModeRaw = AppearanceMode.system.rawValue
    @Environment(\.theme) var theme

    @Query private var holdingAccounts: [HoldingAccount]

    @State private var selectedTab: AppTab = .home
    @State private var canonicalFinancials = CanonicalFinancialSourceStore()
    @StateObject private var syncStatus = SyncStatusStore.shared
    @StateObject private var taskUndoStore = TaskUndoStore.shared
    @State private var showAddTransaction = false
    @State private var showProfileSwitcher = false

    #if os(macOS)
        @State private var macNav: MacNav? = .dashboard
    #endif

    var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    var unit: DisplayUnit {
        DisplayUnit(rawValue: displayUnitRaw) ?? .btc
    }

    private var unitBinding: Binding<DisplayUnit> {
        Binding(
            get: { unit },
            set: { displayUnitRaw = $0.rawValue },
        )
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
        .environment(canonicalFinancials)
        .environmentObject(syncStatus)
        .environmentObject(taskUndoStore)
        .task(id: activeMember) {
            await canonicalFinancials.load(viewer: activeMember)
        }
        .overlay(alignment: .top) {
            syncFailureBanner
                .padding(.horizontal, AppLayout.sectionPadding)
                .padding(.top, 10)
        }
        .overlay(alignment: .bottom) {
            TaskUndoBanner()
                .padding(.horizontal, AppLayout.sectionPadding)
                .padding(.bottom, taskUndoBottomPadding)
        }
        .sheet(isPresented: $showAddTransaction) {
            addTransactionSheet
        }
        .sheet(isPresented: $showProfileSwitcher) {
            ProfileSwitcherView()
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
                                    UnitToggleView(unit: unitBinding, size: .sm)
                                }
                                ToolbarItem(placement: .topBarTrailing) {
                                    HStack(spacing: 8) {
                                        syncStatusGlyph
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
                    .badge(tab == .more ? AppleMoreScreen.allCases.count : 0)
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
                            .foregroundStyle(theme.textMuted)
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
                            .foregroundStyle(theme.textMuted)
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
                            .foregroundStyle(theme.textMuted)
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
                case .dashboard: BitcoinOverviewView()
                case .price: BitcoinPriceView()
                case .budget: BudgetView()
                case .activity: ActivityView()
                case .btcBuys: BTCBuysView()
                case .billPay: BTCBillPayView()
                case .transfer: BitcoinTransferView()
                case .retirement: RetirementView()
                case .netWorth: NetWorthView()
                case .today: TodayView()
                case .inbox: TaskSmartListView(filter: .inbox)
                case .upcoming: TaskSmartListView(filter: .upcoming)
                case .flagged: TaskSmartListView(filter: .flagged)
                case .projects: ProjectsView()
                case .family: FamilyView()
                case .awards: AwardsView()
                case .settings: SettingsView()
                case .syncSetup: SyncSetupView()
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
                        .font(AppFont.sectionHeaderMedium)
                        .foregroundStyle(appearanceMode == .light ? .white : theme.textMuted)
                        .frame(width: 28, height: 24)
                        .background(appearanceMode == .light ? theme.accent : Color.clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Use light appearance")

                Button {
                    appearanceModeRaw = AppearanceMode.dark.rawValue
                } label: {
                    Image(systemName: "moon.fill")
                        .font(AppFont.sectionHeaderMedium)
                        .foregroundStyle(appearanceMode == .dark ? .white : theme.textMuted)
                        .frame(width: 28, height: 24)
                        .background(appearanceMode == .dark ? theme.accent : Color.clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Use dark appearance")
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
                                .font(AppFont.sectionHeader)
                                .foregroundStyle(.white),
                        )

                    VStack(alignment: .leading, spacing: 1) {
                        Text(activeMember.displayName)
                            .font(AppFont.labelSmall)
                            .foregroundStyle(theme.text)
                        Text("Vogel Vault")
                            .font(AppFont.micro)
                            .foregroundStyle(theme.textMuted)
                    }

                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(AppFont.micro)
                        .foregroundStyle(theme.textMuted)
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
                        .font(AppFont.label)
                    Text("New transaction")
                        .font(AppFont.labelSmall)
                    Spacer()
                    Text("\u{2318}N")
                        .font(AppFont.monoMicro)
                        .foregroundStyle(.white.opacity(0.85))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(theme.accent)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .keyboardShortcut("n", modifiers: .command)
            .shadow(color: Color(hex: 0xF7931A).opacity(0.35), radius: 3, y: 2)
        }

        private var sidebarNetWorth: String {
            guard let btcBalance = canonicalFinancials.btcBalance.value else {
                return "Unavailable"
            }
            let btcPrice = BTCPriceService.storedPrice ?? BTCPriceService.fallbackPriceUSD
            let vooPrice = StockPriceService.vooPrice
            let ibitPrice = StockPriceService.ibitPrice
            let holdingsUsd = holdingAccounts
                .filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
                .reduce(Decimal(0)) { $0 + $1.liveValue(vooPrice: vooPrice, ibitPrice: ibitPrice) }
            let totalSats = Decimal(btcBalance.totalSats) +
                (btcPrice > 0 ? (holdingsUsd / btcPrice) * 100_000_000 : 0)
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
                        .foregroundStyle(theme.textMuted)
                        .padding(.horizontal, 6)

                    Text(sidebarNetWorth)
                        .font(AppFont.mediumNumberMono)
                        .foregroundStyle(theme.text)
                        .padding(.horizontal, 6)
                }
                .padding(.horizontal, 10)

                HStack(spacing: 6) {
                    UnitToggleView(unit: unitBinding, size: .sm)
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
                        .font(AppFont.labelStrong)
                        .foregroundStyle(.white),
                )
                .shadow(color: Color(hex: 0xF7931A).opacity(0.35), radius: 3, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Switch profile")
    }

    private var addButton: some View {
        Button {
            showAddTransaction = true
        } label: {
            Image(systemName: "plus")
                .font(AppFont.labelLarge)
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(theme.accent)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .shadow(color: Color(hex: 0xF7931A).opacity(0.35), radius: 3, y: 2)
        }
        .accessibilityLabel("New transaction")
    }

    @ViewBuilder
    private var syncStatusGlyph: some View {
        if syncStatus.phase != .idle {
            if syncStatus.phase == .failed, syncStatus.canRetry {
                Button {
                    syncStatus.retry()
                } label: {
                    syncStatusGlyphImage
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Retry sync")
            } else {
                syncStatusGlyphImage
                    .accessibilityLabel(syncStatus.phase == .failed ? "Sync failed" : "Sync status")
            }
        }
    }

    private var syncStatusGlyphImage: some View {
        Image(systemName: syncStatusIcon)
            .font(AppFont.labelStrong)
            .foregroundStyle(syncStatus.phase == .failed ? theme.danger : theme.accent)
            .frame(width: 32, height: 32)
            .background(syncStatus.phase == .failed ? theme.dangerSoft : theme.accentSoft)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(alignment: .topTrailing) {
                if syncStatus.pendingCount > 1 {
                    Text("\(syncStatus.pendingCount)")
                        .font(AppFont.monoNanoStrong)
                        .foregroundStyle(.white)
                        .frame(minWidth: 14, minHeight: 14)
                        .background(theme.accent)
                        .clipShape(Circle())
                        .offset(x: 4, y: -4)
                }
            }
    }

    private var syncStatusIcon: String {
        switch syncStatus.phase {
        case .idle: "checkmark.icloud.fill"
        case .syncing: "arrow.triangle.2.circlepath.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    private var taskUndoBottomPadding: CGFloat {
        #if os(iOS)
            84
        #else
            18
        #endif
    }

    @ViewBuilder
    private var syncFailureBanner: some View {
        if syncStatus.phase == .failed, let message = syncStatus.lastError {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(AppFont.labelLargeStrong)
                    .foregroundStyle(theme.danger)

                VStack(alignment: .leading, spacing: 2) {
                    Text(message)
                        .font(AppFont.labelStrong)
                        .foregroundStyle(theme.text)
                    Text(syncStatus.canRetry
                        ? "Saved locally. Retry sync when ready."
                        : "Saved on this device only.")
                        .font(AppFont.smallRegular)
                        .foregroundStyle(theme.textMuted)
                }

                Spacer()

                // Hidden for causes another attempt cannot fix — a missing or
                // rejected credential, an unwritable amount, a profile mismatch.
                if syncStatus.canRetry {
                    Button("Retry") {
                        syncStatus.retry()
                    }
                    .font(AppFont.labelSmallStrong)
                    .foregroundStyle(theme.accent)
                    .buttonStyle(.plain)
                }

                Button {
                    syncStatus.dismissFailure()
                } label: {
                    Image(systemName: "xmark")
                        .font(AppFont.sectionHeader)
                        .foregroundStyle(theme.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss sync failure")
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
        case .home: BitcoinOverviewView()
        case .budget: BudgetView()
        case .today: TodayView()
        case .vault: RetirementView()
        case .more: MoreMenuView()
        }
    }

    private var addTransactionSheet: some View {
        AddTransactionView()
            .presentationDetents([.large])
    }
}
