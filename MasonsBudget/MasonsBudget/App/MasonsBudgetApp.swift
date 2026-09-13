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
    @State private var syncTimer: Timer?
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
                            startPeriodicSync()
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
                authentication.lock()
            }
            #elseif os(macOS)
            .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.sessionDidResignActiveNotification)) { _ in
                authentication.lock()
            }
            .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.screensDidSleepNotification)) { _ in
                authentication.lock()
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
    /// The poll loop must stay a single lightweight versions query: refreshing
    /// prices here ran the full BTC + stock price chains ~5,760 times per day
    /// even with zero data changes. Prices refresh on their own 5-minute
    /// cadence (and on foreground/profile switches via `syncFromConvex`).
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

    /// Poll the versions endpoint every 15 seconds while the app is in the
    /// foreground so ledger changes stay near-real-time; refresh prices on a
    /// separate, much longer cadence to keep the radio/CPU cost bounded.
    private func startPeriodicSync() {
        syncTimer?.invalidate()
        syncTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in
            Task { @MainActor in
                await syncIfChanged()
            }
        }
        priceTimer?.invalidate()
        priceTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
            Task { @MainActor in
                await refreshPrices()
            }
        }
    }
}
