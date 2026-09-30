import SwiftData
import SwiftUI
import XCTest
#if os(iOS)
import UIKit
#endif

final class ConvexSyncServiceTests: XCTestCase {
    #if os(iOS)
    @MainActor
    func testActivityRetrySurvivesUnavailableButtonDisappearingAfterPartialRows() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        defaults.set(false, forKey: "app_lock_enabled")
        let authentication = AppAuthenticationSession(defaults: defaults)
        let financials = CanonicalFinancialSourceStore()
        let model = PartialRowsRefreshModel()
        let partial = expectation(description: "transactions appeared before remaining files")
        let buttonGone = expectation(description: "unavailable Retry button disappeared")
        let completed = expectation(description: "remaining files finished")
        let releaseRemaining = RetryActionGate()
        let schema = Schema([TodoItem.self])
        let container = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)],
        )
        let root = PartialRowsRefreshHarness(model: model, buttonGone: { buttonGone.fulfill() })
            .modifier(LedgerListRefresh(syncOperation: { _ in
                model.applied.append("transactions")
                model.hasRows = true
                partial.fulfill()
                await releaseRemaining.wait() // later file response can ignore cancellation
                if !Task.isCancelled {
                    model.applied.append(contentsOf: ["budget", "finances", "versions"])
                    completed.fulfill()
                }
            }))
            .environmentObject(authentication)
            .environment(financials)
            .modelContainer(container)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = UIHostingController(rootView: root)
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        await fulfillment(of: [partial, buttonGone], timeout: 3)
        XCTAssertEqual(model.applied, ["transactions"])
        releaseRemaining.open()
        await fulfillment(of: [completed], timeout: 3)
        XCTAssertEqual(model.applied, ["transactions", "budget", "finances", "versions"])
    }

    @MainActor
    func testActivityRetryTapCannotLaunchInNewSessionAfterQueuedStart() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        defaults.set(false, forKey: "app_lock_enabled")
        let authentication = AppAuthenticationSession(defaults: defaults)
        let financials = CanonicalFinancialSourceStore()
        let model = PartialRowsRefreshModel()
        let tapped = expectation(description: "Retry action submitted")
        let staleRead = expectation(description: "old tap did not start in new session")
        staleRead.isInverted = true
        let schema = Schema([TodoItem.self])
        let container = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)],
        )
        let root = PartialRowsRefreshHarness(
            model: model, buttonGone: {}, invalidateAfterStart: true, actionSubmitted: { tapped.fulfill() },
        )
            .modifier(LedgerListRefresh(syncOperation: { _ in staleRead.fulfill() }))
            .environmentObject(authentication)
            .environment(financials)
            .modelContainer(container)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = UIHostingController(rootView: root)
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        await fulfillment(of: [tapped, staleRead], timeout: 0.2)
        XCTAssertFalse(model.hasRows)
    }
    #endif

    @MainActor
    func testClosingOneWindowPreservesConsumedAndQueuedPushInBothCallbackOrders() async {
        for socketFirst in [true, false] {
            let windows = ConvexSyncWindowPresence()
            let closing = UUID(), survivor = UUID()
            windows.register(closing)
            windows.register(survivor)
            let releaseFirst = RetryActionGate()
            let firstEntered = expectation(description: "first push entered")
            let replayed = expectation(description: "latest push replayed")
            var applied: [Double] = []
            let controller = ConvexSyncRetryController(now: { 100 }, sleep: { _ in })
            controller.submitPush(["todos": 1], member: "victor") { versions, _ in
                firstEntered.fulfill()
                await releaseFirst.wait()
                applied.append(versions["todos"] ?? -1)
            }
            await fulfillment(of: [firstEntered], timeout: 1)
            controller.submitPush(["todos": 2], member: "victor") { versions, _ in
                applied.append(versions["todos"] ?? -1)
                replayed.fulfill()
            }
            if socketFirst {
                windows.subscriptionEnded(closing) { controller.cancel() }
                windows.windowDisappeared(closing) { controller.cancel() }
            } else {
                windows.windowDisappeared(closing) { controller.cancel() }
                windows.subscriptionEnded(closing) { controller.cancel() }
            }
            XCTAssertEqual(windows.count, 1)
            XCTAssertTrue(controller.isSyncRunning)
            releaseFirst.open()
            await fulfillment(of: [replayed], timeout: 1)
            XCTAssertEqual(applied, [1, 2])
            controller.cancel()
        }
    }

    @MainActor
    func testClosingOneWindowPreservesOneShotRetryInBothCallbackOrders() async {
        for socketFirst in [true, false] {
            let windows = ConvexSyncWindowPresence()
            let closing = UUID(), survivor = UUID()
            windows.register(closing)
            windows.register(survivor)
            let timerDue = RetryActionGate()
            let fired = expectation(description: "retry timer fired")
            let controller = ConvexSyncRetryController(now: { 100 }, sleep: { _ in await timerDue.wait() })
            controller.schedule(deadline: 115, member: "victor") { _, _ in fired.fulfill() }
            if socketFirst {
                windows.subscriptionEnded(closing) { controller.cancel() }
                windows.windowDisappeared(closing) { controller.cancel() }
            } else {
                windows.windowDisappeared(closing) { controller.cancel() }
                windows.subscriptionEnded(closing) { controller.cancel() }
            }
            timerDue.open()
            await fulfillment(of: [fired], timeout: 1)
            controller.cancel()
        }
    }

    @MainActor
    func testLastWindowCleanupAndIdempotenceInBothCallbackOrders() async {
        for socketFirst in [true, false] {
            let windows = ConvexSyncWindowPresence()
            let closing = UUID()
            windows.register(closing)
            windows.register(closing)
            let gate = ConvexSyncExecutionGate()
            let oldEpoch = gate.sessionEpoch
            let release = RetryActionGate()
            let entered = expectation(description: "active read entered")
            var activeSawCancellation = false
            var queuedRuns = 0
            let active = Task { @MainActor in
                await gate.withSlot(expectedEpoch: oldEpoch) {
                    entered.fulfill()
                    await release.wait()
                    activeSawCancellation = Task.isCancelled
                }
            }
            await fulfillment(of: [entered], timeout: 1)
            let queued = Task { @MainActor in
                await gate.withSlot(expectedEpoch: oldEpoch) { queuedRuns += 1 }
            }
            for _ in 0 ..< 100 where gate.queuedCount == 0 { await Task.yield() }
            XCTAssertEqual(gate.queuedCount, 1)
            let controller = ConvexSyncRetryController(now: { 100 }, sleep: { _ in })
            let foregroundRelease = RetryActionGate()
            let profileRelease = RetryActionGate()
            let foreground = Task { await foregroundRelease.wait() }
            let profile = Task { await profileRelease.wait() }
            var cleanupCount = 0
            let cleanup = {
                cleanupCount += 1
                gate.invalidateSession()
                controller.cancel()
                foreground.cancel()
                profile.cancel()
            }
            if socketFirst {
                windows.subscriptionEnded(closing, cancelShared: cleanup)
                windows.windowDisappeared(closing, cancelShared: cleanup)
            } else {
                windows.windowDisappeared(closing, cancelShared: cleanup)
                windows.subscriptionEnded(closing, cancelShared: cleanup)
            }
            windows.windowDisappeared(closing, cancelShared: cleanup) // duplicate callback
            XCTAssertEqual(windows.count, 0)
            XCTAssertGreaterThanOrEqual(cleanupCount, 1)
            XCTAssertTrue(foreground.isCancelled)
            XCTAssertTrue(profile.isCancelled)
            await active.value
            await queued.value
            XCTAssertEqual(queuedRuns, 0)
            release.open()
            foregroundRelease.open()
            profileRelease.open()
            await foreground.value
            await profile.value
            // A fresh window cannot execute the old epoch, even if the old
            // transport returns after the new window registers.
            let reopened = UUID()
            windows.register(reopened)
            await gate.withSlot(expectedEpoch: oldEpoch) { queuedRuns += 1 }
            XCTAssertEqual(queuedRuns, 0)
            XCTAssertTrue(activeSawCancellation)
        }
    }

    @MainActor
    func testLastWindowCancelsActiveQueuedPushAndPendingRetryInBothCallbackOrders() async {
        for socketFirst in [true, false] {
            let windows = ConvexSyncWindowPresence()
            let closing = UUID()
            windows.register(closing)
            let release = RetryActionGate()
            let entered = expectation(description: "active push entered")
            let finished = expectation(description: "cancelled push exited")
            var sawCancellation = false
            var queuedRuns = 0
            let controller = ConvexSyncRetryController(now: { 100 }, sleep: { _ in })
            controller.submitPush(["todos": 1], member: "victor") { _, _ in
                entered.fulfill()
                await release.wait() // transport ignores cancellation
                sawCancellation = Task.isCancelled
                finished.fulfill()
            }
            await fulfillment(of: [entered], timeout: 1)
            controller.submitPush(["todos": 2], member: "victor") { _, _ in queuedRuns += 1 }
            controller.schedule(deadline: 115, member: "victor") { _, _ in queuedRuns += 1 }
            let cleanup = { controller.cancel() }
            if socketFirst {
                windows.subscriptionEnded(closing, cancelShared: cleanup)
                windows.windowDisappeared(closing, cancelShared: cleanup)
            } else {
                windows.windowDisappeared(closing, cancelShared: cleanup)
                windows.subscriptionEnded(closing, cancelShared: cleanup)
            }
            release.open()
            await fulfillment(of: [finished], timeout: 1)
            for _ in 0 ..< 10 { await Task.yield() }
            XCTAssertTrue(sawCancellation)
            XCTAssertEqual(queuedRuns, 0)
            XCTAssertFalse(controller.isSyncRunning)
        }
    }

    @MainActor
    func testExecutionGateSerializesEveryManualEntryAgainstPushAndRetryInBothOrders() async {
        for manual in ["startup", "foreground", "profile", "read-retry", "list-refresh"] {
          for automatic in ["push", "retry"] {
           for manualFirst in [true, false] {
            let firstName = manualFirst ? manual : automatic
            let secondName = manualFirst ? automatic : manual
            let gate = ConvexSyncExecutionGate()
            let releaseFirst = RetryActionGate()
            let firstEntered = expectation(description: "\(firstName) entered")
            let secondSubmitted = expectation(description: "\(secondName) submitted")
            let secondEntered = expectation(description: "\(secondName) entered")
            var active = 0
            var order: [String] = []
            let first = Task { @MainActor in
                await gate.withSlot {
                    active += 1
                    order.append("\(firstName)-start")
                    firstEntered.fulfill()
                    await releaseFirst.wait()
                    active -= 1
                    order.append("\(firstName)-end")
                }
            }
            await fulfillment(of: [firstEntered], timeout: 1)
            let second = Task { @MainActor in
                secondSubmitted.fulfill()
                await gate.withSlot {
                    XCTAssertEqual(active, 0)
                    active += 1
                    order.append(secondName)
                    active -= 1
                    secondEntered.fulfill()
                }
            }
            await fulfillment(of: [secondSubmitted], timeout: 1)
            for _ in 0 ..< 100 where gate.queuedCount == 0 { await Task.yield() }
            XCTAssertEqual(gate.queuedCount, 1)
            releaseFirst.open()
            await fulfillment(of: [secondEntered], timeout: 1)
            await first.value
            await second.value
            XCTAssertEqual(order, ["\(firstName)-start", "\(firstName)-end", secondName])
           }
          }
        }
    }

    @MainActor
    func testExecutionGateSessionInvalidationCancelsActiveAndQueuedAndFencesReentry() async {
        let gate = ConvexSyncExecutionGate()
        let oldEpoch = gate.sessionEpoch
        let releaseOld = RetryActionGate()
        let oldEntered = expectation(description: "old read entered")
        let nextEntered = expectation(description: "new session read entered")
        var oldSawCancellation = false
        var oldQueuedRuns = 0
        let old = Task { @MainActor in
            await gate.withSlot(expectedEpoch: oldEpoch) {
                oldEntered.fulfill()
                await releaseOld.wait() // transport ignores cancellation
                oldSawCancellation = Task.isCancelled
            }
        }
        await fulfillment(of: [oldEntered], timeout: 1)
        let queued = Task { @MainActor in
            await gate.withSlot(expectedEpoch: oldEpoch) { oldQueuedRuns += 1 }
        }
        for _ in 0 ..< 100 where gate.queuedCount == 0 { await Task.yield() }
        XCTAssertEqual(gate.queuedCount, 1)
        gate.invalidateSession() // profile away or lock
        await old.value // Caller returns before the transport does.
        await queued.value
        XCTAssertEqual(oldQueuedRuns, 0)
        let lateOld = Task { @MainActor in
            await gate.withSlot(expectedEpoch: oldEpoch) { oldQueuedRuns += 1 }
        }
        await lateOld.value // Same profile can be selected again; epoch still fences old work.
        let next = Task { @MainActor in
            await gate.withSlot(expectedEpoch: gate.sessionEpoch) { nextEntered.fulfill() }
        }
        for _ in 0 ..< 100 where gate.queuedCount == 0 { await Task.yield() }
        XCTAssertEqual(gate.queuedCount, 1)
        releaseOld.open()
        await fulfillment(of: [nextEntered], timeout: 1)
        await next.value
        XCTAssertTrue(oldSawCancellation)
        XCTAssertEqual(oldQueuedRuns, 0)
    }

    @MainActor
    func testExecutionGateCancelsQueuedManualWithoutCancellingActivePush() async {
        let gate = ConvexSyncExecutionGate()
        let releasePush = RetryActionGate()
        let pushEntered = expectation(description: "push entered")
        let manualReturned = expectation(description: "queued manual task returned on cancellation")
        let manualEntered = expectation(description: "cancelled manual task did not run")
        manualEntered.isInverted = true
        var pushWasCancelled = false
        let push = Task { @MainActor in
            await gate.withSlot {
                pushEntered.fulfill()
                await releasePush.wait()
                pushWasCancelled = Task.isCancelled
            }
        }
        await fulfillment(of: [pushEntered], timeout: 1)
        let manual = Task { @MainActor in
            await gate.withSlot { manualEntered.fulfill() }
            manualReturned.fulfill()
        }
        for _ in 0 ..< 100 where gate.queuedCount == 0 { await Task.yield() }
        XCTAssertEqual(gate.queuedCount, 1)
        manual.cancel()
        await fulfillment(of: [manualReturned], timeout: 1)
        XCTAssertFalse(pushWasCancelled)
        releasePush.open()
        await push.value
        await fulfillment(of: [manualEntered], timeout: 0.1)
        XCTAssertFalse(pushWasCancelled)
    }

    @MainActor
    func testExecutionGateCancelsActiveManualWithoutCancellingQueuedPush() async {
        let gate = ConvexSyncExecutionGate()
        let releaseManual = RetryActionGate()
        let manualEntered = expectation(description: "manual read entered")
        let pushEntered = expectation(description: "queued push entered")
        var manualSawCancellation = false
        var pushSawCancellation = true
        let manual = Task { @MainActor in
            await gate.withSlot {
                manualEntered.fulfill()
                await releaseManual.wait() // ignores cancellation
                manualSawCancellation = Task.isCancelled
            }
        }
        await fulfillment(of: [manualEntered], timeout: 1)
        let push = Task { @MainActor in
            await gate.withSlot {
                pushSawCancellation = Task.isCancelled
                pushEntered.fulfill()
            }
        }
        for _ in 0 ..< 100 where gate.queuedCount == 0 { await Task.yield() }
        XCTAssertEqual(gate.queuedCount, 1)
        manual.cancel()
        await manual.value // The disappearing view returns promptly.
        XCTAssertEqual(gate.queuedCount, 1) // Still serializes the late manual read.
        releaseManual.open()
        await fulfillment(of: [pushEntered], timeout: 1)
        await push.value
        XCTAssertTrue(manualSawCancellation)
        XCTAssertFalse(pushSawCancellation)
    }

    @MainActor
    func testProfileSwitchDiscardsLateForegroundVersionsResponse() async throws {
        let entered = expectation(description: "foreground versions read started")
        let finished = expectation(description: "late foreground response exited")
        let transport = RetryActionGate()
        let execution = ConvexSyncExecutionGate()
        let store = RecordingSyncMetadataStore()
        store.set("victor", forKey: ConvexSyncService.selectedMemberKey)
        store.set("victor", forKey: ConvexSyncService.versionsMemberKey)
        store.set(["todos": 1.0], forKey: ConvexSyncService.dataVersionsKey)
        let client = ConvexClient(
            deploymentURL: try XCTUnwrap(URL(string: "https://example.invalid")),
            requestExecutor: { request in
                entered.fulfill()
                await transport.wait() // completes after the profile changes
                let data = try JSONSerialization.data(withJSONObject: [
                    "status": "success", "value": ["todos": 42],
                ])
                let response = try XCTUnwrap(HTTPURLResponse(
                    url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil,
                ))
                return (data, response)
            },
        )
        let schema = Schema([TodoItem.self, TodoProject.self, TodoArea.self])
        let container = try ModelContainer(for: schema, configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)])
        let reader = ConvexDataReader(client: client, rowReadsEnabled: { false })
        let sync = ConvexSyncService(reader: reader, context: ModelContext(container), metadataStore: store)
        var changed = true
        let check = Task { @MainActor in
            await execution.withSlot(expectedEpoch: execution.sessionEpoch) {
                changed = await sync.hasUpdates()
                finished.fulfill()
            }
        }
        await fulfillment(of: [entered], timeout: 1)
        store.set("mason", forKey: ConvexSyncService.selectedMemberKey)
        execution.invalidateSession()
        store.set("victor", forKey: ConvexSyncService.selectedMemberKey) // switch back before stale response
        await check.value
        transport.open()
        await fulfillment(of: [finished], timeout: 1)
        XCTAssertFalse(changed)
        XCTAssertEqual(store.string(forKey: ConvexSyncService.versionsMemberKey), "victor")
        XCTAssertNil(store.object(forKey: ConvexSyncService.nextRetryKey))
    }

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
        XCTAssertEqual(snapshot.ownerMember, .victor)
        XCTAssertEqual(snapshot.btcValue, 100_000)
        XCTAssertEqual(snapshot.holdingsValue, 10_000)
        XCTAssertEqual(snapshot.totalValue, 110_000)
    }

    @MainActor
    func testDailyNetWorthSnapshotsUseCanonicalHouseholdAndChildOwners() throws {
        let defaults = UserDefaults.standard
        let previousMember = defaults.object(forKey: ConvexSyncService.selectedMemberKey)
        defer { restore(previousMember, forKey: ConvexSyncService.selectedMemberKey, in: defaults) }

        let schema = Schema([
            BTCAccount.self, HoldingAccount.self, Holding.self, HoldingLot.self, NetWorthSnapshot.self,
        ])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [configuration])
        let context = ModelContext(container)

        for member in [FamilyMember.victor, .rachel] {
            defaults.set(member.rawValue, forKey: ConvexSyncService.selectedMemberKey)
            try ConvexSyncService(context: context).recordNetWorthSnapshot()
            try context.save()
        }
        let householdSnapshots = try context.fetch(FetchDescriptor<NetWorthSnapshot>())
        XCTAssertEqual(householdSnapshots.count, 1)
        XCTAssertEqual(householdSnapshots.first?.ownerMember, .victor)

        for member in [FamilyMember.mason, .maddox, .mason, .rachel] {
            defaults.set(member.rawValue, forKey: ConvexSyncService.selectedMemberKey)
            try ConvexSyncService(context: context).recordNetWorthSnapshot()
            try context.save()
        }
        let snapshots = try context.fetch(FetchDescriptor<NetWorthSnapshot>())
        XCTAssertEqual(snapshots.count, 3)
        XCTAssertEqual(Set(snapshots.map(\.ownerMember)), Set([.victor, .mason, .maddox]))
    }

    @MainActor
    func testPartialFailurePublishesSuccessfulFileAndSkipsItOnRetry() async throws {
        var now: TimeInterval = 100
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
        await ConvexSyncService(reader: reader, context: context, metadataStore: store, now: { now }).syncAll()
        XCTAssertEqual(store.dictionary(forKey: ConvexSyncService.dataVersionsKey) as? [String: Double], ["todos": 42, "transactions": 7])
        XCTAssertNil(store.object(forKey: ConvexSyncService.lastSyncKey))
        XCTAssertNotNil(store.string(forKey: ConvexSyncService.lastSyncErrorKey))

        // The pushed version stays unchanged. The one-shot timer must replay
        // that snapshot when backoff expires, without waiting for a new push
        // or fetching versions over HTTP.
        let retry = ConvexSyncService(reader: reader, context: context, metadataStore: store, now: { now })
        let remote = ["todos": 42.0, "transactions": 7.0]
        let blocked = await retry.hasUpdates(remote: remote)
        XCTAssertFalse(blocked)
        let fired = expectation(description: "unchanged-version retry fired")
        let controller = ConvexSyncRetryController(now: { now }, sleep: { seconds in
            XCTAssertEqual(seconds, 15)
        })
        controller.noteSnapshot(remote)
        controller.schedule(deadline: try XCTUnwrap(retry.retryDeadline), member: "victor") { versions, member in
            XCTAssertEqual(member, "victor")
            let changed = await retry.hasUpdates(remote: versions ?? [:])
            XCTAssertTrue(changed)
            await retry.syncAll()
            fired.fulfill()
        }
        now = 115
        await fulfillment(of: [fired], timeout: 1)
        let counts = await requests.counts
        XCTAssertEqual(counts["versions"], 1)
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
    func testRetryUsesLatestPushAndCancelsOnLock() async {
        let updated = expectation(description: "latest pushed versions used")
        let controller = ConvexSyncRetryController(now: { 100 }, sleep: { seconds in
            XCTAssertEqual(seconds, 15)
        })
        controller.noteSnapshot(["todos": 42])
        controller.schedule(deadline: 115, member: "victor") { versions, _ in
            XCTAssertEqual(versions, ["todos": 43])
            updated.fulfill()
        }
        controller.noteSnapshot(["todos": 43])
        await fulfillment(of: [updated], timeout: 1)

        let cancelled = expectation(description: "cancelled timer does not retry")
        cancelled.isInverted = true
        controller.schedule(deadline: 115, member: "victor") { _, _ in
            cancelled.fulfill()
        }
        controller.cancel() // app lock tears down the subscription and timer
        await fulfillment(of: [cancelled], timeout: 0.1)
    }

    @MainActor
    func testRunningRetryIsCancelledOnLock() async {
        let entered = expectation(description: "retry action started")
        let finished = expectation(description: "cancelled action finished")
        let gate = RetryActionGate()
        let controller = ConvexSyncRetryController(now: { 100 }, sleep: { _ in })
        var sawCancellation = false
        controller.schedule(deadline: 115, member: "victor") { _, _ in
            entered.fulfill()
            await gate.wait()
            sawCancellation = Task.isCancelled
            finished.fulfill()
        }
        await fulfillment(of: [entered], timeout: 1)
        XCTAssertTrue(controller.isSyncRunning)
        controller.cancel()
        // The handle stays live until the action exits, so a new push can
        // still be queued instead of starting a concurrent read.
        XCTAssertTrue(controller.isSyncRunning)
        gate.open()
        await fulfillment(of: [finished], timeout: 1)
        XCTAssertTrue(sawCancellation)
        XCTAssertFalse(controller.isSyncRunning)
    }

    @MainActor
    func testCancellingStreamWaitReleasesCallerAndActivePush() async {
        let entered = expectation(description: "owned push entered")
        let pushDone = expectation(description: "cancelled push exited")
        let waitReturned = expectation(description: "stream wait returned on cancellation")
        let gate = RetryActionGate()
        let controller = ConvexSyncRetryController(now: { 100 }, sleep: { _ in })
        var pushWasCancelled = false
        controller.submitPush(["todos": 42], member: "victor") { _, _ in
            entered.fulfill()
            await gate.wait()
            pushWasCancelled = Task.isCancelled
            pushDone.fulfill()
        }
        await fulfillment(of: [entered], timeout: 1)
        let waiter = Task { @MainActor in
            await controller.waitForActiveSync()
            waitReturned.fulfill()
        }
        for _ in 0 ..< 100 where controller.idleWaiterCount == 0 { await Task.yield() }
        XCTAssertEqual(controller.idleWaiterCount, 1)
        waiter.cancel()
        await fulfillment(of: [waitReturned], timeout: 1)
        XCTAssertTrue(controller.isSyncRunning)
        gate.open()
        // A cancelled outer window task must cancel the separately owned
        // push before its late response can be applied.
        await fulfillment(of: [pushDone], timeout: 1)
        XCTAssertTrue(pushWasCancelled)
    }

    @MainActor
    func testPushDuringRetryReplaysLatestSnapshotAfterRead() async {
        let entered = expectation(description: "retry action started")
        let replayed = expectation(description: "latest push replayed")
        let gate = RetryActionGate()
        let controller = ConvexSyncRetryController(now: { 100 }, sleep: { _ in })
        var readFinished = false
        var retryCount = 0
        var pushCount = 0
        controller.noteSnapshot(["todos": 42])
        controller.schedule(deadline: 115, member: "victor") { versions, _ in
            retryCount += 1
            XCTAssertEqual(versions, ["todos": 42])
            entered.fulfill()
            await gate.wait()
            readFinished = true
        }
        await fulfillment(of: [entered], timeout: 1)
        controller.submitPush(["todos": 43], member: "victor") { versions, member in
            pushCount += 1
            XCTAssertEqual(member, "victor")
            XCTAssertTrue(readFinished)
            XCTAssertEqual(versions, ["todos": 43])
            replayed.fulfill()
        }
        controller.submitPush(["todos": 44], member: "victor") { versions, member in
            pushCount += 1
            XCTAssertEqual(member, "victor")
            XCTAssertTrue(readFinished)
            XCTAssertEqual(versions, ["todos": 44])
            replayed.fulfill()
        }
        gate.open()
        await fulfillment(of: [replayed], timeout: 1)
        XCTAssertEqual(retryCount, 1)
        XCTAssertEqual(pushCount, 1)
    }

    @MainActor
    func testPushClaimsSlotBeforeDueTimerAndRearmsOnlyAfterRead() async {
        let timerDue = RetryActionGate()
        let pushGate = RetryActionGate()
        let entered = expectation(description: "push read started")
        let oldTimer = expectation(description: "superseded timer did not read")
        oldTimer.isInverted = true
        let nextRetry = expectation(description: "new backoff timer ran")
        let controller = ConvexSyncRetryController(now: { 100 }, sleep: { _ in await timerDue.wait() })
        var pushFinished = false
        controller.schedule(deadline: 115, member: "victor") { _, _ in oldTimer.fulfill() }
        controller.submitPush(["todos": 43], member: "victor") { _, _ in
            entered.fulfill()
            await pushGate.wait()
            pushFinished = true
            controller.schedule(deadline: 130, member: "victor") { versions, _ in
                XCTAssertTrue(pushFinished)
                XCTAssertEqual(versions, ["todos": 43])
                nextRetry.fulfill()
            }
        }
        await fulfillment(of: [entered], timeout: 1)
        XCTAssertTrue(controller.isSyncRunning)
        timerDue.open()
        await fulfillment(of: [oldTimer], timeout: 0.1)
        pushGate.open()
        await fulfillment(of: [nextRetry], timeout: 1)
    }

    @MainActor
    func testProfileSwitchCancelsOldPushAndReplaysNewProfile() async {
        let oldEntered = expectation(description: "old profile read started")
        let newEntered = expectation(description: "new profile push checked")
        let gate = RetryActionGate()
        let controller = ConvexSyncRetryController(now: { 100 }, sleep: { _ in })
        var oldWasCancelled = false
        controller.submitPush(["todos": 42], member: "victor") { _, _ in
            oldEntered.fulfill()
            await gate.wait()
            oldWasCancelled = Task.isCancelled
        }
        await fulfillment(of: [oldEntered], timeout: 1)
        controller.cancel()
        controller.submitPush(["todos": 43], member: "mason") { versions, member in
            XCTAssertEqual(member, "mason")
            XCTAssertEqual(versions, ["todos": 43])
            newEntered.fulfill()
        }
        gate.open()
        await fulfillment(of: [newEntered], timeout: 1)
        XCTAssertTrue(oldWasCancelled)
    }

    @MainActor
    func testRunningRetryCanArmNextBackoffWithoutCancellingItself() async {
        let first = expectation(description: "first retry completed")
        let second = expectation(description: "next backoff retry ran")
        let controller = ConvexSyncRetryController(now: { 100 }, sleep: { _ in })
        controller.schedule(deadline: 115, member: "victor") { _, _ in
            controller.schedule(deadline: 130, member: "victor") { _, _ in
                second.fulfill()
            }
            XCTAssertFalse(Task.isCancelled)
            first.fulfill()
        }
        await fulfillment(of: [first, second], timeout: 1)
    }

    @MainActor
    func testCancelledSyncDoesNotApplyLateFileResponse() async throws {
        let entered = expectation(description: "todo read started")
        let gate = RetryActionGate()
        let store = RecordingSyncMetadataStore()
        store.set("maddox", forKey: ConvexSyncService.selectedMemberKey)
        let client = ConvexClient(
            deploymentURL: try XCTUnwrap(URL(string: "https://example.invalid")),
            requestExecutor: { request in
                let body = try XCTUnwrap(request.httpBody)
                let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                let path = object["path"] as? String
                let value: Any
                if path == "dataFiles:getVersions" {
                    value = ["todos": 42]
                } else {
                    entered.fulfill()
                    await gate.wait() // deliberately ignores task cancellation
                    value = [Any]()
                }
                let data = try JSONSerialization.data(withJSONObject: ["status": "success", "value": value])
                let response = try XCTUnwrap(HTTPURLResponse(
                    url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil,
                ))
                return (data, response)
            },
        )
        let schema = Schema([TodoItem.self, TodoProject.self, TodoArea.self])
        let container = try ModelContainer(for: schema, configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)])
        let context = ModelContext(container)
        context.insert(TodoItem(id: "keep", title: "Keep", owner: .maddox))
        try context.save()
        let reader = ConvexDataReader(client: client, rowReadsEnabled: { false })
        let sync = ConvexSyncService(reader: reader, context: context, metadataStore: store)
        let task = Task { await sync.syncAll() }
        await fulfillment(of: [entered], timeout: 1)
        task.cancel()
        gate.open()
        await task.value
        XCTAssertEqual(try context.fetch(FetchDescriptor<TodoItem>()).map(\.id), ["keep"])
        XCTAssertNil(store.object(forKey: ConvexSyncService.dataVersionsKey))
        XCTAssertNil(store.object(forKey: ConvexSyncService.nextRetryKey))
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

@MainActor
private final class RetryActionGate {
    private var isOpen = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { continuation = $0 }
    }

    func open() {
        isOpen = true
        continuation?.resume()
        continuation = nil
    }
}

#if os(iOS)
@MainActor
private final class PartialRowsRefreshModel: ObservableObject {
    @Published var hasRows = false
    var applied: [String] = []
    var started = false
}

private struct PartialRowsRefreshHarness: View {
    @ObservedObject var model: PartialRowsRefreshModel
    let buttonGone: @MainActor () -> Void
    var invalidateAfterStart = false
    var actionSubmitted: (@MainActor () -> Void)? = nil
    @Environment(\.ledgerRetryAction) private var retryAction

    var body: some View {
        List {
            if model.hasRows {
                Text("Transaction row")
            } else {
                LedgerRefreshButton().onDisappear(perform: buttonGone)
            }
        }
        .onAppear {
            guard !model.started else { return }
            model.started = true
            retryAction?()
            if invalidateAfterStart { ConvexSyncExecutionGate.shared.invalidateSession() }
            actionSubmitted?()
        }
    }
}
#endif

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
