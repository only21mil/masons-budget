import SwiftData
import XCTest

final class ConvexSyncServiceTests: XCTestCase {
    @MainActor
    func testAdultNetWorthSnapshotExcludesChildBalance() throws {
        let defaults = UserDefaults.standard
        let previousMember = defaults.object(forKey: ConvexSyncService.selectedMemberKey)
        let previousBTCPrice = defaults.object(forKey: BTCPriceService.priceKey)
        defer {
            restore(previousMember, forKey: ConvexSyncService.selectedMemberKey, in: defaults)
            restore(previousBTCPrice, forKey: BTCPriceService.priceKey, in: defaults)
        }

        defaults.set(FamilyMember.rachel.rawValue, forKey: ConvexSyncService.selectedMemberKey)
        defaults.set(100_000, forKey: BTCPriceService.priceKey)

        let schema = Schema([
            BTCAccount.self,
            HoldingAccount.self,
            Holding.self,
            HoldingLot.self,
            NetWorthSnapshot.self,
        ])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [configuration])
        let context = ModelContext(container)

        context.insert(BTCAccount(
            key: "adult-btc",
            label: "Adult BTC",
            custody: .selfCustody,
            btc: 1,
            owner: .victor,
        ))
        context.insert(BTCAccount(
            key: "mason-btc",
            label: "Mason BTC",
            custody: .exchange,
            btc: 2,
            owner: .mason,
        ))
        context.insert(HoldingAccount(
            name: "adult-401k",
            provider: "Test",
            owner: .victor,
            totalValue: 10_000,
        ))
        context.insert(HoldingAccount(
            name: "mason-401k",
            provider: "Test",
            owner: .mason,
            totalValue: 20_000,
        ))

        try ConvexSyncService(context: context).recordNetWorthSnapshot()
        try context.save()

        let snapshots = try context.fetch(FetchDescriptor<NetWorthSnapshot>())
        let snapshot = try XCTUnwrap(snapshots.first)
        XCTAssertEqual(snapshots.count, 1)
        XCTAssertEqual(snapshot.ownerMember, .rachel)
        XCTAssertEqual(snapshot.btcValue, 100_000)
        XCTAssertEqual(snapshot.holdingsValue, 10_000)
        XCTAssertEqual(snapshot.totalValue, 110_000)
    }

    private func restore(_ value: Any?, forKey key: String, in defaults: UserDefaults) {
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
