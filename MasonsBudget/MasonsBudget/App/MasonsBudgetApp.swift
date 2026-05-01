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

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(fileObserver)
                .task {
                    await syncFromMC2()
                    startFileObservation()
                    BudgetNotificationManager.shared.requestPermission()
                }
                #if os(iOS)
                .fullScreenCover(isPresented: Binding(
                    get: { !hasCompletedOnboarding },
                    set: { hasCompletedOnboarding = !$0 }
                )) {
                    OnboardingView()
                }
                #else
                .sheet(isPresented: Binding(
                    get: { !hasCompletedOnboarding },
                    set: { hasCompletedOnboarding = !$0 }
                )) {
                    OnboardingView()
                        .frame(minWidth: 500, minHeight: 600)
                }
                #endif
                #if os(macOS)
                .frame(minWidth: 800, minHeight: 500)
                #endif
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
