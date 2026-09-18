import SwiftData
import SwiftUI

// MARK: - iOS Tabs

enum AppTab: String, CaseIterable, Identifiable {
    case home, budget, activity, bitcoin, tasks

    var id: String {
        rawValue
    }

    var label: String {
        switch self {
        case .home: "Home"
        case .budget: "Budget"
        case .activity: "Activity"
        case .bitcoin: "Bitcoin"
        case .tasks: "Tasks"
        }
    }

    var icon: String {
        switch self {
        case .home: "house.fill"
        case .budget: "chart.bar.fill"
        case .activity: "bolt.fill"
        case .bitcoin: "bitcoinsign.circle.fill"
        case .tasks: "checkmark.circle.fill"
        }
    }

    /// The tab bar renders its own strings, so the tab label role's uppercase
    /// is applied here rather than through `.ledgerType`.
    var tabTitle: String {
        label.uppercased()
    }
}

// MARK: - macOS Sidebar Navigation

enum MacNav: String, CaseIterable, Identifiable {
    case home, budget, activity, bitcoin, tasks

    var id: String {
        rawValue
    }

    var label: String {
        switch self {
        case .home: "Home"
        case .budget: "Budget"
        case .activity: "Activity"
        case .bitcoin: "Bitcoin"
        case .tasks: "Tasks"
        }
    }

    var icon: String {
        switch self {
        case .home: "house.fill"
        case .budget: "chart.bar.fill"
        case .activity: "bolt.fill"
        case .bitcoin: "bitcoinsign.circle.fill"
        case .tasks: "checkmark.circle.fill"
        }
    }

    static let primaryItems = allCases
}

enum GearDestination: String, CaseIterable, Identifiable {
    case family, settings, export

    var id: String {
        rawValue
    }
}

// MARK: - Content View

struct ContentView: View {
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("appearance_mode") private var appearanceModeRaw = AppearanceMode.system.rawValue
    @Environment(\.theme) var theme
    @Environment(\.modelContext) private var modelContext

    @Query private var holdingAccounts: [HoldingAccount]

    @State private var selectedTab: AppTab = .home
    @State private var profileSyncPending = false
    @State private var canonicalFinancials = CanonicalFinancialSourceStore()
    @StateObject private var syncStatus = SyncStatusStore.shared
    @StateObject private var taskUndoStore = TaskUndoStore.shared
    @AppStorage(ConvexSyncService.versionsMemberKey) private var syncedMember = ""
    @AppStorage(ConvexSyncService.lastSyncErrorKey) private var lastReadError = ""
    @AppStorage(ConvexSyncService.lastSyncKey) private var lastReadSuccess: Double = 0
    @State private var showSyncSetup = false
    @State private var retryingRead = false
    @State private var readRetryTask: Task<Void, Never>?
    @State private var showAddTransaction = false
    @State private var showProfileSwitcher = false
    @State private var gearDestination: GearDestination?
    @State private var showTaskEntry = false
    @State private var showAddChoices = false
    @State private var entryUnavailable = false
    @State private var showEntrySetup = false
    @State private var addType: TransactionActivityType = .spend

    #if os(macOS)
        @State private var macNav: MacNav? = .home
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
        let financialLoadID = canonicalFinancials.loadID(viewer: activeMember, lastReadSuccess: lastReadSuccess)
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
        .overlay { LedgerTextureOverlay() }
        .task(id: financialLoadID) {
            await canonicalFinancials.load(viewer: financialLoadID.viewer)
        }
        .onChange(of: activeMember) { _, _ in
            profileSyncPending = true
            cancelReadRetry()
        }
        .onChange(of: lastReadSuccess) { _, _ in
            if syncedMember == selectedMemberRaw { profileSyncPending = false }
        }
        .onDisappear { cancelReadRetry() }
        #if os(macOS)
        .safeAreaInset(edge: .top, spacing: 0) { syncBanner }
        .safeAreaInset(edge: .bottom) { undoBanner }
        #endif
        .sheet(isPresented: $showAddTransaction) {
            addTransactionSheet
        }
        .sheet(isPresented: $showSyncSetup, onDismiss: canonicalFinancials.requestReload) {
            NavigationStack { SyncSetupView() }
        }
        .sheet(isPresented: $showProfileSwitcher) {
            ProfileSwitcherView()
        }
        .sheet(item: $gearDestination) { destination in
            NavigationStack {
                gearDestinationView(destination)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { gearDestination = nil }
                        }
                    }
            }
        }
        .sheet(isPresented: $showTaskEntry) {
            NavigationStack {
                TaskSmartListView(filter: .inbox, initiallyAdding: true)
                    // Keep recovery visible on pushed destinations, above the native tab bar.
                    .safeAreaInset(edge: .bottom) { undoBanner }
                    .environment(\.ledgerRootTitle, "")
                    .navigationTitle("New task")
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { showTaskEntry = false } } }
            }
        }
        .alert("Entry unavailable", isPresented: $entryUnavailable) {
            Button("Open Sync Setup") { showEntrySetup = true }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This device needs permission for that entry in the selected profile.")
        }
        .sheet(isPresented: $showEntrySetup) { NavigationStack { SyncSetupView() } }
        .confirmationDialog("Add entry", isPresented: $showAddChoices, titleVisibility: .visible) {
            addChoices
        }
    }

    // MARK: - iOS

    #if os(iOS)
        private var iOSBody: some View {
            TabView(selection: $selectedTab) {
                ForEach(AppTab.allCases) { tab in
                    VStack(spacing: 0) {
                        // Keep status above both roots and destinations without relying on
                        // NavigationStack to forward a safe-area inset to its scroll content.
                        syncBanner
                        NavigationStack {
                            screenForTab(tab, selection: $selectedTab)
                                .environment(\.ledgerRootTitle, tab.label)
                                .environment(\.ledgerRootAccessory, AnyView(HStack(spacing: 8) {
                                    profileButton
                                    gearMenuButton
                                    syncStatusGlyph
                                    addButton
                                }))
                                .toolbar(.hidden, for: .navigationBar)
                        }
                        .safeAreaInset(edge: .bottom) { undoBanner }
                    }
                    .tabItem {
                        Image(systemName: tab.icon)
                        Text(tab.tabTitle)
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
                    .padding(.bottom, 12)

                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(MacNav.primaryItems) { item in
                            macSidebarRow(item)
                        }
                    }
                    .padding(.horizontal, 8)
                }

                macSidebarFooter
            }
            .background(theme.bg)
        }

        private func macSidebarRow(_ item: MacNav) -> some View {
            let isSelected = (macNav ?? .home) == item
            return Button {
                macNav = item
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: item.icon)
                        .font(AppFont.icon(size: 13, weight: .medium))
                        .foregroundStyle(isSelected ? theme.accent : theme.textMuted)
                        .frame(width: 18)
                    Text(item.label)
                        .ledgerType(.rowPrimary)
                        .foregroundStyle(isSelected ? theme.text : theme.textMuted)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(isSelected ? theme.accentSoft : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .contentShape(RoundedRectangle(cornerRadius: 6))
            }
            .buttonStyle(.plain)
            .ledgerAnimation(.chipAndNavigation, value: isSelected)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
        }

        private var macTabBinding: Binding<AppTab> {
            Binding(
                get: { AppTab(rawValue: (macNav ?? .home).rawValue) ?? .home },
                set: { macNav = MacNav(rawValue: $0.rawValue) ?? .home },
            )
        }

        private var macDetail: some View {
            let tab = macTabBinding.wrappedValue
            return NavigationStack {
                screenForTab(tab, selection: macTabBinding)
                    .environment(\.ledgerRootTitle, tab.label)
                    .environment(\.ledgerRootAccessory, AnyView(HStack(spacing: 8) {
                        gearMenuButton
                        syncStatusGlyph
                        appearanceToggle
                    }))
            }
            .id(macNav)
        }

        private var appearanceToggle: some View {
            HStack(spacing: 0) {
                Button {
                    appearanceModeRaw = AppearanceMode.light.rawValue
                } label: {
                    Image(systemName: "sun.max.fill")
                        .font(AppFont.icon(size: 11, weight: .semibold))
                        .foregroundStyle(appearanceMode == .light ? theme.onAccent : theme.textMuted)
                        .frame(width: 28, height: 24)
                        .background(appearanceMode == .light ? theme.accentFill : Color.clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Use light appearance")

                Button {
                    appearanceModeRaw = AppearanceMode.dark.rawValue
                } label: {
                    Image(systemName: "moon.fill")
                        .font(AppFont.icon(size: 11, weight: .semibold))
                        .foregroundStyle(appearanceMode == .dark ? theme.onAccent : theme.textMuted)
                        .frame(width: 28, height: 24)
                        .background(appearanceMode == .dark ? theme.accentFill : Color.clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Use dark appearance")
            }
            .padding(2)
            .background(theme.surface2)
            .clipShape(Capsule())
            .ledgerAnimation(.chipAndNavigation, value: appearanceMode)
        }

        private var workspaceSwitcher: some View {
            Button {
                showProfileSwitcher = true
            } label: {
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(theme.accentFill)
                        .frame(width: 22, height: 22)
                        .overlay(
                            Text(String(activeMember.displayName.prefix(1)))
                                .ledgerType(.chip)
                                .foregroundStyle(theme.onAccent),
                        )

                    VStack(alignment: .leading, spacing: 1) {
                        Text(activeMember.displayName)
                            .ledgerType(.rowPrimary)
                            .foregroundStyle(theme.text)
                        Text("Vogel Vault")
                            .ledgerType(.rowMeta)
                            .foregroundStyle(theme.textMuted)
                    }

                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(AppFont.icon(size: 10, weight: .regular))
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
                        .font(AppFont.icon(size: 13, weight: .semibold))
                    Text("New transaction")
                        .ledgerType(.rowPrimary)
                    Spacer()
                    Text("\u{2318}N")
                        .ledgerType(.rowMeta)
                }
                .foregroundStyle(theme.onAccent)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(theme.accentFill)
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
                Hairline()

                VStack(alignment: .leading, spacing: 6) {
                    Text("NET WORTH")
                        .ledgerType(.sectionLabel)
                        .foregroundStyle(theme.textMuted)
                        .padding(.horizontal, 6)

                    Text(sidebarNetWorth)
                        .ledgerType(.kpiValue)
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

    private var profileButton: some View {
        Button {
            showProfileSwitcher = true
        } label: {
            RoundedRectangle(cornerRadius: 10)
                .fill(theme.accentFill)
                .frame(width: 32, height: 32)
                .overlay(
                    Text(String(activeMember.displayName.prefix(1)))
                        .ledgerType(.rowFigure)
                        .foregroundStyle(theme.onAccent),
                )
                .frame(minWidth: LedgerMetrics.minimumHitTarget, minHeight: LedgerMetrics.minimumHitTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(minWidth: LedgerMetrics.minimumHitTarget, minHeight: LedgerMetrics.minimumHitTarget)
        .accessibilityLabel("Switch profile")
    }

    private var gearMenuButton: some View {
        Menu {
            Button("Family", systemImage: "person.3.fill") { gearDestination = .family }
            Button("Settings", systemImage: "gearshape") { gearDestination = .settings }
            Button("Export", systemImage: "square.and.arrow.up") { gearDestination = .export }
        } label: {
            Image(systemName: "gearshape")
                .font(AppFont.icon(size: 14, weight: .semibold))
                .foregroundStyle(theme.textMuted)
                .frame(width: 32, height: 32)
                .background(theme.surface2)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .frame(minWidth: LedgerMetrics.minimumHitTarget, minHeight: LedgerMetrics.minimumHitTarget)
        }
        .menuStyle(.borderlessButton)
        .accessibilityLabel("Family, settings, and export")
    }

    @ViewBuilder
    private func gearDestinationView(_ destination: GearDestination) -> some View {
        switch destination {
        case .family:
            LedgerDrilldown(title: "Family") { FamilyView() }
        case .settings:
            LedgerDrilldown(title: "Settings") { SettingsView() }
        case .export:
            LedgerDrilldown(title: "Export") { ExportView() }
        }
    }

    private var addButton: some View {
        Menu {
            addChoices
        } label: {
            Image(systemName: "plus")
                .font(AppFont.icon(size: 14, weight: .semibold))
                .foregroundStyle(theme.onAccent)
                .frame(width: 32, height: 32)
                .background(theme.accentFill)
                .clipShape(RoundedRectangle(cornerRadius: 3))
                .frame(minWidth: LedgerMetrics.minimumHitTarget, minHeight: LedgerMetrics.minimumHitTarget)
        } primaryAction: {
            if selectedTab == .tasks { openTask() }
            else { openAdd(.spend) }
        }
        .accessibilityLabel(selectedTab == .tasks ? "Add task" : "Add expense")
        .accessibilityAction(named: "Choose entry type") { showAddChoices = true }
    }

    @ViewBuilder
    private var addChoices: some View {
        Button("Expense", systemImage: "minus.circle") { openAdd(.spend) }
        Button("Income", systemImage: "plus.circle") { openAdd(.income) }
        Button("Buy BTC", systemImage: "bitcoinsign.circle") { openAdd(.btcBuy) }
        Button("Task", systemImage: "checkmark.circle") { openTask() }
    }

    private func openTask() {
        guard AppWritebackConfig.canWriteTasks else { entryUnavailable = true; return }
        showTaskEntry = true
    }

    private func openAdd(_ type: TransactionActivityType) {
        let allowed = type == .btcBuy
            ? activeMember.isAdult && AppWritebackConfig.canWriteBitcoin
            : AppWritebackConfig.canWriteLedger
        guard allowed else { entryUnavailable = true; return }
        addType = type
        showAddTransaction = true
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
            .font(AppFont.icon(size: 13, weight: .bold))
            .foregroundStyle(syncStatus.phase == .failed ? theme.danger : theme.accent)
            .frame(width: 32, height: 32)
            .background(syncStatus.phase == .failed ? theme.dangerSoft : theme.accentSoft)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(alignment: .topTrailing) {
                if syncStatus.pendingCount > 1 {
                    Text("\(syncStatus.pendingCount)")
                        .ledgerType(.chip)
                        .foregroundStyle(theme.onAccent)
                        .frame(minWidth: 14, minHeight: 14)
                        .background(theme.accentFill)
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

    private var undoBanner: some View {
        TaskUndoBanner()
            .padding(.horizontal, AppLayout.sectionPadding)
    }

    private var syncBanner: some View {
        VStack(spacing: 6) {
            if profileSyncPending && ConvexConfig.hasReadToken && lastReadError.isEmpty {
                ProgressView("Syncing profile…")
                    .ledgerType(.rowMeta)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("Syncing \(activeMember.displayName)’s profile")
            }
            syncFailureBanner
        }
        .padding(.horizontal, AppLayout.sectionPadding)
        .padding(.top, 10)
    }

    @ViewBuilder
    private var syncFailureBanner: some View {
        if let message = Self.readSyncMessage(hasReadToken: ConvexConfig.hasReadToken, lastError: lastReadError) {
            VStack(alignment: .leading, spacing: 6) {
                Text(message)
                    .ledgerType(.rowPrimary)
                if lastReadSuccess > 0 {
                    Text("Last synced \(Date(timeIntervalSince1970: lastReadSuccess).formatted(date: .abbreviated, time: .shortened))")
                        .ledgerType(.rowMeta)
                        .foregroundStyle(theme.textMuted)
                }
                HStack {
                    Button("Open Sync Setup") { showSyncSetup = true }
                        .frame(minHeight: 44)
                    if ConvexConfig.hasReadToken {
                        Button(retryingRead ? "Refreshing…" : "Retry") {
                            retryRead()
                        }
                        .frame(minHeight: 44)
                        .disabled(retryingRead)
                    }
                }
                .ledgerType(.button)
                .foregroundStyle(theme.accent)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(theme.surface)
        } else if syncStatus.phase == .failed, let message = syncStatus.lastError {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(AppFont.icon(size: 14, weight: .bold))
                    .foregroundStyle(theme.danger)

                VStack(alignment: .leading, spacing: 2) {
                    Text(message)
                        .ledgerType(.rowPrimary)
                        .foregroundStyle(theme.text)
                    Text(syncStatus.canRetry
                        ? "Saved locally. Retry sync when ready."
                        : "Saved on this device only.")
                        .ledgerType(.body)
                        .foregroundStyle(theme.textMuted)
                }

                Spacer()

                // Hidden for causes another attempt cannot fix — a missing or
                // rejected credential, an unwritable amount, a profile mismatch.
                if syncStatus.canRetry {
                    Button("Retry") {
                        syncStatus.retry()
                    }
                    .ledgerType(.button)
                    .foregroundStyle(theme.accent)
                    .buttonStyle(.plain)
                }

                Button {
                    syncStatus.dismissFailure()
                } label: {
                    Image(systemName: "xmark")
                        .font(AppFont.icon(size: 11, weight: .bold))
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

    private func retryRead() {
        cancelReadRetry()
        let viewer = activeMember
        retryingRead = true
        readRetryTask = Task {
            await ConvexSyncService(context: modelContext).syncAll()
            guard !Task.isCancelled, activeMember == viewer else { return }
            // A failed download still gets a canonical retry. A successful
            // download also reloads through the lastReadSuccess task identity.
            canonicalFinancials.requestReload()
            retryingRead = false
            readRetryTask = nil
        }
    }

    private func cancelReadRetry() {
        readRetryTask?.cancel()
        readRetryTask = nil
        retryingRead = false
    }

    static func readSyncMessage(hasReadToken: Bool, lastError: String) -> String? {
        if !hasReadToken { return "Connect this device to load your household data." }
        if !lastError.isEmpty { return "Some household data could not refresh. Your last downloaded data is still available." }
        return nil
    }

    // MARK: - Screen Routing

    @ViewBuilder
    private func screenForTab(_ tab: AppTab, selection: Binding<AppTab>) -> some View {
        switch tab {
        case .home: HomeDashboardView(hasReadToken: ConvexConfig.hasReadToken, selectedTab: selection)
        case .budget: BudgetView()
        case .activity: ActivityView()
        case .bitcoin: BitcoinOverviewView()
        case .tasks: TasksView()
        }
    }

    private var addTransactionSheet: some View {
        AddTransactionView(initialType: addType)
            .presentationDetents([.large])
    }
}
