import SwiftUI
import SwiftData

@main
struct MasonsBudgetApp: App {
    var sharedModelContainer: ModelContainer = {
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

    @StateObject private var fileObserver = MC2FileObserver()
    @AppStorage("has_completed_onboarding") private var hasCompletedOnboarding = false
    @AppStorage("app_lock_enabled") private var appLockEnabled = true
    @State private var isUnlocked = false

    var body: some Scene {
        WindowGroup {
            ZStack {
                ContentView()
                    .environmentObject(fileObserver)
                    .task {
                        // Auto-connect iCloud if not already connected
                        let folder = MC2FolderManager.shared
                        if !folder.isAccessible {
                            folder.autoConnectICloud()
                        }
                        await syncFromMC2()
                        startFileObservation()
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
        }
        .modelContainer(sharedModelContainer)
        #if os(macOS)
        .defaultSize(width: 1000, height: 700)
        #endif
    }

    @MainActor
    private func syncFromMC2() async {
        let folder = MC2FolderManager.shared
        guard let mc2URL = folder.folderURL, folder.isAccessible else { return }
        let reader = MC2Reader(baseURL: mc2URL)
        let sync = MC2SyncService(reader: reader, context: sharedModelContainer.mainContext)
        await sync.syncAll()
    }

    @MainActor
    private func startFileObservation() {
        let folder = MC2FolderManager.shared
        guard let mc2URL = folder.folderURL, folder.isAccessible else { return }

        fileObserver.onFilesChanged = { [self] in
            await syncFromMC2()
        }
        fileObserver.startObserving(folderURL: mc2URL)
    }
}
