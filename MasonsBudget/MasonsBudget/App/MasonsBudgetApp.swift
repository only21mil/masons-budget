import SwiftUI
import SwiftData

@main
struct MasonsBudgetApp: App {
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
        ])
        let modelConfiguration = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: false
        )

        do {
            return try ModelContainer(for: schema, configurations: [modelConfiguration])
        } catch {
            fatalError("Could not create ModelContainer: \(error)")
        }
    }()

    private static func resetSwiftDataStoreIfNeeded() {
        let resetKey = "swiftdata_store_reset_for_owner_strings_v1"
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
                print("SwiftData store reset skipped \(url.lastPathComponent): \(error)")
            }
        }

        defaults.set(true, forKey: resetKey)
    }

    @AppStorage("has_completed_onboarding") private var hasCompletedOnboarding = false
    @AppStorage("app_lock_enabled") private var appLockEnabled = true
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @State private var isUnlocked = false
    @State private var syncTimer: Timer?

    var body: some Scene {
        WindowGroup {
            ZStack {
                ContentView()
                    .task {
                        await syncFromConvex()
                        startPeriodicSync()
                        BudgetNotificationManager.shared.requestPermission()
                    }
                    .opacity(isUnlocked || !appLockEnabled ? 1 : 0)

                if appLockEnabled && !isUnlocked {
                    LockScreenView(isUnlocked: $isUnlocked)
                        .transition(.opacity)
                }
            }
            #if os(iOS)
            .fullScreenCover(isPresented: Binding(
                get: { !hasCompletedOnboarding && isUnlocked },
                set: { hasCompletedOnboarding = !$0 }
            )) {
                OnboardingView()
            }
            #else
            .sheet(isPresented: Binding(
                get: { !hasCompletedOnboarding && isUnlocked },
                set: { hasCompletedOnboarding = !$0 }
            )) {
                OnboardingView()
                    .frame(minWidth: 500, minHeight: 600)
            }
            #endif
            #if os(macOS)
            .frame(minWidth: 800, minHeight: 500)
            #endif
            .onAppear {
                if !appLockEnabled {
                    isUnlocked = true
                }
            }
            #if os(iOS)
            .onReceive(NotificationCenter.default.publisher(for: UIScene.willEnterForegroundNotification)) { _ in
                Task { await syncIfChanged() }
            }
            #endif
            .onChange(of: selectedMember) { _, _ in
                Task { await syncFromConvex() }
            }
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
        guard ConvexConfig.isConfigured else { return }
        let sync = MC2SyncService(context: sharedModelContainer.mainContext)
        await sync.syncAll()
    }

    /// Check if data has changed on Convex, and sync if so.
    @MainActor
    private func syncIfChanged() async {
        await BTCPriceService.shared.refreshAndStore()
        guard ConvexConfig.isConfigured else { return }
        let sync = MC2SyncService(context: sharedModelContainer.mainContext)
        let changed = await sync.hasUpdates()
        if changed {
            await sync.syncAll()
        }
    }

    /// Poll for changes every 15 seconds while the app is in the foreground.
    /// This provides near-real-time updates for BTC buys, transactions, etc.
    private func startPeriodicSync() {
        syncTimer?.invalidate()
        syncTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in
            Task { @MainActor in
                await syncIfChanged()
            }
        }
    }
}
