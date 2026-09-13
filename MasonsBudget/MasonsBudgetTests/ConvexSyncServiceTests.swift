import SwiftData
import XCTest

final class ConvexSyncServiceTests: XCTestCase {
    @MainActor
    func testSuccessfulSyncPublishesVersionsAsFinalCompletionMarker() {
        let store = RecordingSyncMetadataStore()

        ConvexSyncService.publishSuccessfulSync(
            versions: ["todos": 42],
            totalEntities: 7,
            timestamp: 123,
            to: store,
        )

        XCTAssertEqual(
            store.mutations,
            [
                "set:\(ConvexSyncService.lastSyncKey)",
                "set:\(ConvexSyncService.syncCountKey)",
                "remove:\(ConvexSyncService.lastSyncErrorKey)",
                "set:\(ConvexSyncService.dataVersionsKey)",
            ],
        )
        XCTAssertEqual(store.mutations.last, "set:\(ConvexSyncService.dataVersionsKey)")
    }

    @MainActor
    func testAdultNetWorthSnapshotExcludesChildBalance() throws {
        let defaults = UserDefaults.standard
        let previousMember = defaults.object(forKey: ConvexSyncService.selectedMemberKey)
        let previousQuoteSnapshot = defaults.object(forKey: MarketQuoteService.cacheKey)
        defer {
            restore(previousMember, forKey: ConvexSyncService.selectedMemberKey, in: defaults)
            restore(previousQuoteSnapshot, forKey: MarketQuoteService.cacheKey, in: defaults)
        }

        defaults.set(FamilyMember.rachel.rawValue, forKey: ConvexSyncService.selectedMemberKey)
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let quoteSnapshot = MarketQuoteSnapshot(quotes: [
            MarketQuote(symbol: .btc, priceCents: 10_000_000, source: "Unit test", fetchedAt: timestamp, status: .live),
            MarketQuote(symbol: .voo, priceCents: nil, source: "Unit test", fetchedAt: nil, status: .unavailable),
            MarketQuote(symbol: .ibit, priceCents: nil, source: "Unit test", fetchedAt: nil, status: .unavailable),
        ], complete: true)
        defaults.set(try JSONEncoder().encode(quoteSnapshot), forKey: MarketQuoteService.cacheKey)
        XCTAssertEqual(try XCTUnwrap(BTCPriceService.storedPrice), 100_000)

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

    @MainActor
    func testPartialFailurePublishesSuccessfulFileAndSkipsItOnRetry() async throws {
        let store = RecordingSyncMetadataStore()
        store.set("victor", forKey: ConvexSyncService.selectedMemberKey)
        store.set("victor", forKey: ConvexSyncService.versionsMemberKey)
        store.set(["transactions": 7.0], forKey: ConvexSyncService.dataVersionsKey)
        let requests = SyncRequestRecorder()
        let client = ConvexClient(
            deploymentURL: try XCTUnwrap(URL(string: "https://example.invalid")),
            requestExecutor: { request in
                let body = try XCTUnwrap(request.httpBody)
                let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                let path = object["path"] as? String
                let args = object["args"] as? [String: Any]
                let name = args?["name"] as? String ?? "versions"
                await requests.record(name)
                let value: Any
                if path == "dataFiles:getVersions" {
                    value = ["todos": 42, "transactions": 7]
                } else if name == "todos" {
                    value = [Any]()
                } else {
                    throw URLError(.notConnectedToInternet)
                }
                let data = try JSONSerialization.data(withJSONObject: ["status": "success", "value": value])
                let response = try XCTUnwrap(HTTPURLResponse(
                    url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil,
                ))
                return (data, response)
            },
        )
        let schema = Schema([
            TodoItem.self, TodoProject.self, TodoArea.self, BTCAccount.self,
            HoldingAccount.self, Holding.self, HoldingLot.self, NetWorthSnapshot.self,
        ])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [configuration])
        let reader = ConvexDataReader(client: client, rowReadsEnabled: { false })
        let context = ModelContext(container)
        await ConvexSyncService(reader: reader, context: context, metadataStore: store).syncAll()
        XCTAssertEqual(store.dictionary(forKey: ConvexSyncService.dataVersionsKey) as? [String: Double], ["todos": 42, "transactions": 7])
        XCTAssertNil(store.object(forKey: ConvexSyncService.lastSyncKey))
        XCTAssertNotNil(store.string(forKey: ConvexSyncService.lastSyncErrorKey))

        // Backoff survives the new instance created by each polling tick.
        let retry = ConvexSyncService(reader: reader, context: context, metadataStore: store)
        let blocked = await retry.hasUpdates()
        XCTAssertFalse(blocked)
        store.set(0.0, forKey: ConvexSyncService.nextRetryKey)
        let changed = await retry.hasUpdates()
        XCTAssertTrue(changed)
        await retry.syncAll()
        let counts = await requests.counts
        XCTAssertEqual(counts["todos"], 1)
        XCTAssertEqual(counts["transactions"], 2)
    }

    @MainActor
    func testAdultSyncReplacesMasonAccountsOnlyFromMasonSnapshot() async throws {
        for rowReads in [true, false] {
            let store = RecordingSyncMetadataStore()
            store.set("rachel", forKey: ConvexSyncService.selectedMemberKey)
            let client = ConvexClient(
                deploymentURL: try XCTUnwrap(URL(string: "https://example.invalid")),
                requestExecutor: { request in
                    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
                    let path = object["path"] as? String
                    let args = object["args"] as? [String: Any]
                    let value: Any
                    if path == "tables:listBtcBalanceDocuments" {
                        XCTAssertEqual(args?["viewer"] as? String, "rachel")
                        let scope = args?["scope"] as? String
                        let owners = scope == "visible" ? ["victor", "mason"] : ["victor"]
                        value = ["complete": true, "rows": owners.map { owner -> [String: Any] in
                            ["owner": owner, "schemaVersion": 2, "asOf": "2026-09-01",
                             "accounts": [["key": owner + "-wallet", "label": owner, "custody": "exchange", "sats": 100_000_000]],
                             "totals": ["sats": 100_000_000, "exchangeSats": 100_000_000, "selfCustodySats": 0]]
                        }]
                    } else if path == "tables:listBtcAccounts" {
                        XCTAssertEqual(args?["viewer"] as? String, "rachel")
                        XCTAssertEqual(args?["scope"] as? String, "visible")
                        value = ["complete": true, "rows": ["victor", "mason"].map { owner -> [String: Any] in
                            ["owner": owner, "schemaVersion": 2, "asOf": "2026-09-01",
                             "key": owner + "-wallet", "label": owner, "custody": "exchange", "sats": 100_000_000]
                        }]
                    } else if path == "dataFiles:get", args?["name"] as? String == "son-balances" {
                        value = ["strike": 1, "river": 0, "coldcard": 0, "total": 1, "lastUpdated": "2026-09-01"]
                    } else {
                        throw URLError(.notConnectedToInternet)
                    }
                    let data = try JSONSerialization.data(withJSONObject: ["status": "success", "value": value])
                    let response = try XCTUnwrap(HTTPURLResponse(
                        url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil,
                    ))
                    return (data, response)
                },
            )
            let schema = Schema([BTCAccount.self, HoldingAccount.self, Holding.self, HoldingLot.self, NetWorthSnapshot.self])
            let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
            let container = try ModelContainer(for: schema, configurations: [configuration])
            let context = ModelContext(container)
            context.insert(BTCAccount(key: "victor-wallet", label: "Adult", custody: .exchange, btc: 1, owner: .victor))
            context.insert(BTCAccount(key: "obsolete-mason", label: "Old child", custody: .exchange, btc: 2, owner: .mason))
            try context.save()
            let reader = ConvexDataReader(client: client, rowReadsEnabled: { rowReads })
            await ConvexSyncService(reader: reader, context: context, metadataStore: store).syncAll()
            let accounts = try context.fetch(FetchDescriptor<BTCAccount>())
            XCTAssertEqual(accounts.filter { $0.ownerMember == .victor }.map(\.key), ["victor-wallet"])
            let child = accounts.filter { $0.ownerMember == .mason }
            XCTAssertEqual(child.reduce(Decimal(0)) { $0 + $1.btc }, 1)
            XCTAssertFalse(child.contains { $0.key == "obsolete-mason" })
            XCTAssertTrue(child.contains { $0.key == (rowReads ? "mason-wallet" : "son-strike-mason") })
        }
    }

    @MainActor
    func testFailedFileKeepsItsOldVersionAndBackoffIsBounded() {
        XCTAssertEqual(ConvexSyncService.completedVersions(
            previous: ["todos": 1, "transactions": 2],
            remote: ["todos": 3, "transactions": 4],
            completed: ["todos"],
        ), ["todos": 3, "transactions": 2])
        XCTAssertEqual([1, 2, 3, 4, 5, 6, 100].map {
            ConvexSyncService.retryDelay(failureCount: $0)
        }, [15, 30, 60, 120, 240, 300, 300])
        let store = RecordingSyncMetadataStore()
        ConvexSyncService.recordFailure("Offline", at: 100, to: store)
        ConvexSyncService.recordFailure("Offline", at: 115, to: store)
        XCTAssertEqual(store.object(forKey: ConvexSyncService.nextRetryKey) as? Double, 145)
    }

    @MainActor
    func testTransactionOnlyRefreshPreservesBudgetPaychecks() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: Transaction.self, configurations: configuration)
        let context = ModelContext(container)
        context.insert(Transaction(
            id: "paycheck", date: .now, merchant: "Paycheck", amount: 500,
            category: "Income", owner: .victor, createdBy: "mc2", sourceFile: "budget.json",
        ))
        context.insert(Transaction(
            id: "old-expense", date: .now, merchant: "Old expense", amount: 10,
            category: "Other", owner: .victor, createdBy: "mc2", sourceFile: "transactions.json",
        ))
        try context.save()
        try ConvexSyncService(context: context).replaceTransactions(ownedBy: [.victor], with: [])
        try context.save()
        XCTAssertEqual(try context.fetch(FetchDescriptor<Transaction>()).map(\.id), ["paycheck"])
    }

    @MainActor
    func testReadBannerCoversFreshInstallAndFailureButHidesAfterSuccess() {
        XCTAssertNotNil(ContentView.readSyncMessage(hasReadToken: false, lastError: ""))
        XCTAssertNotNil(ContentView.readSyncMessage(hasReadToken: true, lastError: "Offline"))
        XCTAssertNil(ContentView.readSyncMessage(hasReadToken: true, lastError: ""))
    }

    private func restore(_ value: Any?, forKey key: String, in defaults: UserDefaults) {
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}

private final class RecordingSyncMetadataStore: SyncMetadataStoring {
    private var values: [String: Any] = [:]
    private(set) var mutations: [String] = []

    func object(forKey defaultName: String) -> Any? {
        values[defaultName]
    }

    func string(forKey defaultName: String) -> String? {
        values[defaultName] as? String
    }

    func dictionary(forKey defaultName: String) -> [String: Any]? {
        values[defaultName] as? [String: Any]
    }

    func set(_ value: Any?, forKey defaultName: String) {
        mutations.append("set:\(defaultName)")
        values[defaultName] = value
    }

    func removeObject(forKey defaultName: String) {
        mutations.append("remove:\(defaultName)")
        values.removeValue(forKey: defaultName)
    }
}

private actor SyncRequestRecorder {
    private(set) var counts: [String: Int] = [:]

    func record(_ name: String) {
        counts[name, default: 0] += 1
    }
}
