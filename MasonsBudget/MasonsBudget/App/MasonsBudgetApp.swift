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

    var body: some Scene {
        WindowGroup {
            ContentView()
                .task {
                    await syncFromMC2()
                }
        }
        .modelContainer(sharedModelContainer)
    }

    @MainActor
    private func syncFromMC2() async {
        let mc2URL = mc2FolderURL()
        guard FileManager.default.fileExists(atPath: mc2URL.path) else { return }
        let reader = MC2Reader(baseURL: mc2URL)
        let sync = MC2SyncService(reader: reader, context: sharedModelContainer.mainContext)
        await sync.syncAll()
    }

    private func mc2FolderURL() -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return docs.appendingPathComponent("mission-control")
    }
}
