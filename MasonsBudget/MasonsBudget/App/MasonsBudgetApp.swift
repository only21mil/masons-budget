import SwiftData
import SwiftUI
import os
#if os(macOS)
    import AppKit
#endif

@main
struct MasonsBudgetApp: App {
    private static let resetLog = Logger(subsystem: "com.sats21m.masonsbudget", category: "App")

    var sharedModelContainer: ModelContainer = {
        resetSwiftDataStoreIfNeeded()

        let schema = Schema([
            Transaction.self,
            BudgetCategory.self,
            MonthlyBudgetSnapshot.self,
            BTCAccount.self,
            BTCBuy.self,
            BTCBillPay.self,
            HoldingAccount.self,
            Holding.self,
            HoldingLot.self,
            SyncEvent.self,
            FamilyProfile.self,
            NetWorthSnapshot.self,
            TodoItem.self,
            TodoProject.self,
            TodoArea.self,
            CostBasisLot.self,
        ])
        let modelConfiguration = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: false,
        )

        do {
            return try ModelContainer(for: schema, configurations: [modelConfiguration])
        } catch {
            fatalError("Could not create ModelContainer: \(error)")
        }
    }()

    private static func resetSwiftDataStoreIfNeeded() {
        let resetKey = "swiftdata_store_reset_for_todo_item_schema_v2"
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: resetKey) else { return }

        guard let supportURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            defaults.set(true, forKey: resetKey)
            return
        }

        let storeURLs = [
            supportURL.appendingPathComponent("default.store"),
            supportURL.appendingPathComponent("default.store-shm"),
            supportURL.appendingPathComponent("default.store-wal"),
        ]

        for url in storeURLs where FileManager.default.fileExists(atPath: url.path) {
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                resetLog.error("SwiftData store reset skipped one file")
            }
        }

        defaults.set(true, forKey: resetKey)
    }

    @AppStorage("has_completed_onboarding") private var hasCompletedOnboarding = false
    @AppStorage("app_lock_enabled") private var appLockEnabled = true
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @AppStorage("appearance_mode") private var appearanceModeRaw = AppearanceMode.system.rawValue
    @StateObject private var syncStatus = SyncStatusStore.shared
    @StateObject private var taskUndoStore = TaskUndoStore.shared
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var authentication = AppAuthenticationSession()
    @State private var priceTimer: Timer?

    private var appearanceMode: AppearanceMode {
        AppearanceMode(rawValue: appearanceModeRaw) ?? .system
    }

    init() {
        #if os(iOS)
            LedgerChrome.install()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ZStack {
                if authentication.isUnlocked {
                    ContentView()
                        .task {
                            await syncFromConvex()
                            startPriceRefresh()
                            await subscribeToVersions()
                        }
                } else {
                    LockScreenView()
                        .transition(.opacity)
                }
            }
            #if os(iOS)
            .fullScreenCover(isPresented: Binding(
                get: { !hasCompletedOnboarding && authentication.isUnlocked },
                set: { if authentication.isUnlocked { hasCompletedOnboarding = !$0 } },
            )) {
                OnboardingView()
            }
            #else
            .sheet(isPresented: Binding(
                        get: { !hasCompletedOnboarding && authentication.isUnlocked },
                        set: { if authentication.isUnlocked { hasCompletedOnboarding = !$0 } },
                    )) {
                        OnboardingView()
                            .frame(minWidth: 500, minHeight: 600)
                    }
            #endif
            #if os(macOS)
            .frame(minWidth: 800, minHeight: 500)
            #endif
            .onChange(of: scenePhase, initial: true) { _, phase in
                authentication.profileChanged(to: selectedMember)
                authentication.setLockEnabled(appLockEnabled)
                authentication.transition(to: phase)
            }
            .onChange(of: appLockEnabled) { _, enabled in
                authentication.setLockEnabled(enabled)
            }
            #if os(iOS)
            .onReceive(NotificationCenter.default.publisher(for: UIScene.willEnterForegroundNotification)) { _ in
                Task { await syncIfChanged() }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataWillBecomeUnavailableNotification)) { _ in
                authentication.suspend(for: .protectedData)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in
                authentication.resume(from: .protectedData, scenePhase: scenePhase)
            }
            #elseif os(macOS)
            .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.sessionDidResignActiveNotification)) { _ in
                authentication.suspend(for: .inactiveSession)
            }
            .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.screensDidSleepNotification)) { _ in
                authentication.suspend(for: .screenSleep)
            }
            .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.sessionDidBecomeActiveNotification)) { _ in
                authentication.resume(from: .inactiveSession, scenePhase: scenePhase)
            }
            .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.screensDidWakeNotification)) { _ in
                authentication.resume(from: .screenSleep, scenePhase: scenePhase)
            }
            #endif
            .onChange(of: selectedMember) { _, member in
                authentication.profileChanged(to: member)
                Task { await syncFromConvex() }
            }
            .environmentObject(authentication)
            .environmentObject(syncStatus)
            .environmentObject(taskUndoStore)
            .themed()
            .preferredColorScheme(appearanceMode.colorScheme)
        }
        .modelContainer(sharedModelContainer)
        #if os(macOS)
            .defaultSize(width: 1000, height: 700)
        #endif
    }

    // MARK: - Convex Sync

    @MainActor
    private func syncFromConvex() async {
        await BTCPriceService.shared.refreshAndStore()
        await StockPriceService.shared.refreshAndStore()
        let sync = ConvexSyncService(context: sharedModelContainer.mainContext)
        await sync.syncAll()
    }

    /// Check if data has changed on Convex, and sync if so.
    ///
    /// Event-driven one-shot check for foreground/profile switches. The
    /// continuous watch is the versions subscription (see
    /// `subscribeToVersions`) — there is no poll loop anymore. Prices
    /// refresh on their own 5-minute cadence (and on foreground/profile
    /// switches via `syncFromConvex`).
    @MainActor
    private func syncIfChanged() async {
        let sync = ConvexSyncService(context: sharedModelContainer.mainContext)
        let changed = await sync.hasUpdates()
        if changed {
            await sync.syncAll()
        }
    }

    @MainActor
    private func refreshPrices() async {
        await BTCPriceService.shared.refreshAndStore()
        await StockPriceService.shared.refreshAndStore()
    }

    /// Subscribe to the Convex versions query over the sync-protocol
    /// WebSocket. This replaces the old 15-second poll: the server pushes
    /// a new versions snapshot only when data actually changes, and each
    /// push runs the same changed-versions → syncAll() path the poll used.
    /// The `.task` above cancels this when the view disappears (app lock),
    /// which tears down the socket through the cancellation handler.
    @MainActor
    private func subscribeToVersions() async {
        let client = ConvexSubscriptionClient()
        let args = ConvexClient.authenticatedArguments(
            endpoint: "api/query",
            args: [:],
            syncToken: ConvexConfig.syncToken,
            readToken: ConvexConfig.readToken
        )
        await withTaskCancellationHandler {
            for await versions in client.subscribeVersions(authArgs: args) {
                let sync = ConvexSyncService(context: sharedModelContainer.mainContext)
                if await sync.hasUpdates(remote: versions) {
                    await sync.syncAll()
                }
            }
        } onCancel: {
            client.cancel()
        }
    }

    /// Refresh prices on a long cadence to keep the radio/CPU cost
    /// bounded. Ledger data no longer polls — see `subscribeToVersions`.
    private func startPriceRefresh() {
        priceTimer?.invalidate()
        priceTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
            Task { @MainActor in
                await refreshPrices()
            }
        }
    }
}
