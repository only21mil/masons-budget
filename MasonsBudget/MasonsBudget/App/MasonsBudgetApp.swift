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
    @AppStorage(ConvexSyncService.nextRetryKey) private var nextSyncRetryDeadline = 0.0
    @AppStorage("appearance_mode") private var appearanceModeRaw = AppearanceMode.system.rawValue
    @StateObject private var syncStatus = SyncStatusStore.shared
    @StateObject private var taskUndoStore = TaskUndoStore.shared
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var authentication = AppAuthenticationSession()
    @State private var priceTimer: Timer?
    @State private var syncRetry = ConvexSyncRetryController()
    @State private var syncWindows = ConvexSyncWindowPresence()
    @State private var foregroundSyncTask: Task<Void, Never>?
    @State private var profileSyncTask: Task<Void, Never>?
    @State private var foregroundSyncID = UUID()
    @State private var profileSyncID = UUID()

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
            ConvexSyncWindowScope(
                onAppear: { syncWindows.register($0) },
                onDisappear: { windowID in
                    syncWindows.windowDisappeared(windowID) { cancelSharedSync() }
                },
            ) { windowID in
            ZStack {
                if authentication.isUnlocked {
                    ContentView()
                        .task {
                            await syncFromConvex()
                            guard authentication.isUnlocked, !Task.isCancelled else { return }
                            startPriceRefresh()
                            await subscribeToVersions(windowID: windowID)
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
                startForegroundSync()
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
                ConvexSyncExecutionGate.shared.invalidateSession()
                authentication.profileChanged(to: member)
                syncRetry.cancel()
                cancelAppSyncTasks()
                if authentication.isUnlocked {
                    startProfileSync()
                }
            }
            .onChange(of: authentication.isUnlocked) { _, unlocked in
                if !unlocked {
                    ConvexSyncExecutionGate.shared.invalidateSession()
                    syncRetry.cancel()
                    cancelAppSyncTasks()
                }
            }
            .onChange(of: nextSyncRetryDeadline) { _, _ in
                // Manual Retry and pull-to-refresh also publish the persisted
                // deadline. Reconcile their one-shot timer without polling.
                guard authentication.isUnlocked else { return }
                let sync = ConvexSyncService(context: sharedModelContainer.mainContext)
                scheduleSyncRetry(using: sync, member: selectedMember)
            }
            .environmentObject(authentication)
            .environmentObject(syncStatus)
            .environmentObject(taskUndoStore)
            .themed()
            .preferredColorScheme(appearanceMode.colorScheme)
            }
        }
        .modelContainer(sharedModelContainer)
        #if os(macOS)
            .defaultSize(width: 1000, height: 700)
        #endif
    }

    // MARK: - Convex Sync

    @MainActor
    private func startForegroundSync() {
        foregroundSyncTask?.cancel()
        let id = UUID()
        foregroundSyncID = id
        foregroundSyncTask = Task { @MainActor in
            defer { if foregroundSyncID == id { foregroundSyncTask = nil } }
            await syncIfChanged()
        }
    }

    @MainActor
    private func startProfileSync() {
        profileSyncTask?.cancel()
        let id = UUID()
        profileSyncID = id
        profileSyncTask = Task { @MainActor in
            defer { if profileSyncID == id { profileSyncTask = nil } }
            await syncFromConvex()
        }
    }

    @MainActor
    private func cancelAppSyncTasks() {
        foregroundSyncTask?.cancel()
        foregroundSyncTask = nil
        foregroundSyncID = UUID()
        profileSyncTask?.cancel()
        profileSyncTask = nil
        profileSyncID = UUID()
    }

    @MainActor
    private func cancelSharedSync() {
        ConvexSyncExecutionGate.shared.invalidateSession()
        syncRetry.cancel()
        cancelAppSyncTasks()
    }

    @MainActor
    private func syncFromConvex() async {
        guard authentication.isUnlocked, !Task.isCancelled else { return }
        let member = selectedMember
        let epoch = ConvexSyncExecutionGate.shared.sessionEpoch
        await BTCPriceService.shared.refreshAndStore()
        await StockPriceService.shared.refreshAndStore()
        guard authentication.isUnlocked, selectedMember == member, !Task.isCancelled else { return }
        await ConvexSyncExecutionGate.shared.withSlot(expectedEpoch: epoch) {
            guard authentication.isUnlocked, selectedMember == member, !Task.isCancelled else { return }
            let sync = ConvexSyncService(context: sharedModelContainer.mainContext)
            await sync.syncAll()
            scheduleSyncRetry(using: sync, member: member)
        }
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
        guard authentication.isUnlocked else { return }
        let member = selectedMember
        let epoch = ConvexSyncExecutionGate.shared.sessionEpoch
        await ConvexSyncExecutionGate.shared.withSlot(expectedEpoch: epoch) {
            guard authentication.isUnlocked, selectedMember == member, !Task.isCancelled else { return }
            let sync = ConvexSyncService(context: sharedModelContainer.mainContext)
            let changed = await sync.hasUpdates()
            guard authentication.isUnlocked, selectedMember == member, !Task.isCancelled else { return }
            if changed {
                await sync.syncAll()
            }
            scheduleSyncRetry(using: sync, member: member)
        }
    }

    @MainActor
    private func scheduleSyncRetry(using sync: ConvexSyncService, member: String) {
        guard !Task.isCancelled, authentication.isUnlocked, selectedMember == member else { return }
        let epoch = ConvexSyncExecutionGate.shared.sessionEpoch
        guard let deadline = sync.retryDeadline else {
            syncRetry.cancelTimer()
            return
        }
        syncRetry.schedule(deadline: deadline, member: member) { versions, member in
            await retryFailedSync(versions: versions, member: member, epoch: epoch)
        }
    }

    @MainActor
    private func retryFailedSync(versions: [String: Double]?, member: String, epoch: Int) async {
        await ConvexSyncExecutionGate.shared.withSlot(expectedEpoch: epoch) {
            guard authentication.isUnlocked, selectedMember == member, !Task.isCancelled else { return }
            let sync = ConvexSyncService(context: sharedModelContainer.mainContext)
            let changed: Bool
            if let versions {
                changed = await sync.hasUpdates(remote: versions)
            } else {
                changed = await sync.hasUpdates()
            }
            guard authentication.isUnlocked, selectedMember == member, !Task.isCancelled else { return }
            if changed {
                await sync.syncAll()
            }
            scheduleSyncRetry(using: sync, member: member)
        }
    }

    @MainActor
    private func syncPushedVersions(_ versions: [String: Double], member: String, epoch: Int) async {
        await ConvexSyncExecutionGate.shared.withSlot(expectedEpoch: epoch) {
            guard authentication.isUnlocked, selectedMember == member, !Task.isCancelled else { return }
            let sync = ConvexSyncService(context: sharedModelContainer.mainContext)
            if await sync.hasUpdates(remote: versions) {
                guard authentication.isUnlocked, selectedMember == member, !Task.isCancelled else { return }
                await sync.syncAll()
            }
            scheduleSyncRetry(using: sync, member: member)
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
    private func subscribeToVersions(windowID: UUID) async {
        let client = ConvexSubscriptionClient()
        let retryController = syncRetry
        let windows = syncWindows
        defer {
            windows.subscriptionEnded(windowID) { retryController.cancel() }
        }
        let args = ConvexClient.authenticatedArguments(
            endpoint: "api/query",
            args: [:],
            syncToken: ConvexConfig.syncToken,
            readToken: ConvexConfig.readToken
        )
        await withTaskCancellationHandler {
            for await versions in client.subscribeVersions(authArgs: args) {
                guard authentication.isUnlocked, !Task.isCancelled else { break }
                let epoch = ConvexSyncExecutionGate.shared.sessionEpoch
                syncRetry.submitPush(versions, member: selectedMember) { latest, member in
                    await syncPushedVersions(latest, member: member, epoch: epoch)
                }
            }
            if authentication.isUnlocked, !Task.isCancelled {
                await syncRetry.waitForActiveSync()
            }
        } onCancel: {
            client.cancel()
            Task { @MainActor in
                windows.subscriptionEnded(windowID) { retryController.cancel() }
            }
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

private struct ConvexSyncWindowScope<Content: View>: View {
    @State private var windowID = UUID()
    let onAppear: @MainActor (UUID) -> Void
    let onDisappear: @MainActor (UUID) -> Void
    @ViewBuilder let content: (UUID) -> Content

    var body: some View {
        content(windowID)
            .onAppear { onAppear(windowID) }
            .onDisappear { onDisappear(windowID) }
    }
}
