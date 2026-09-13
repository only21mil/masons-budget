import Foundation
import XCTest

final class CanonicalFinancialSourceStoreTests: XCTestCase {
    @MainActor
    func testLateAdultResponseCannotReplaceAnyCompletedChildSource() async throws {
        for path in FinancialResponseGate.paths {
            for failsWhenReleased in [false, true] {
                let gate = FinancialResponseGate(heldPath: path, failsWhenReleased: failsWhenReleased)
                let store = makeStore(gate: gate)
                let adult = Task { await store.load(viewer: .victor) }
                await gate.waitUntilHeld()

                await store.load(viewer: .mason)
                assertMasonSources(store)
                await gate.release()
                await adult.value
                assertMasonSources(store)
            }
        }
    }

    @MainActor
    func testCancelledLoadCannotPublishEvenWhenTransportReturnsSuccessfully() async {
        let gate = FinancialResponseGate(heldPath: FinancialResponseGate.paths[0])
        let store = makeStore(gate: gate)
        let adult = Task { await store.load(viewer: .victor) }
        await gate.waitUntilHeld()
        adult.cancel()
        await gate.release()
        await adult.value

        XCTAssertNil(store.btcBalance.value)
        XCTAssertNil(store.income.value)
        XCTAssertNil(store.btcBillPays.value)
    }

    @MainActor
    func testOlderSameProfileRequestCannotOverwriteNewerLoad() async {
        let gate = FinancialResponseGate(heldPath: FinancialResponseGate.paths[0])
        let store = makeStore(gate: gate)
        let older = Task { await store.load(viewer: .victor) }
        await gate.waitUntilHeld()
        await gate.setValue(900)
        await store.load(viewer: .victor)
        XCTAssertEqual(store.btcBalance.value?.totalSats, 900)
        await gate.release()
        await older.value
        XCTAssertEqual(store.btcBalance.value?.totalSats, 900)
        XCTAssertEqual(store.income.value?.cents(forMonth: "2099-01"), 900)
        XCTAssertEqual(store.btcBillPays.value?.totalUSDCents, 900)
    }

    @MainActor
    func testSetupAndSuccessfulSyncReloadSameProfileAndRecoverBanner() async throws {
        let gate = FinancialResponseGate()
        let store = makeStore(gate: gate)
        let suiteName = "CanonicalFinancialSourceStoreTests.\(UUID().uuidString)"
        let metadata = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { metadata.removePersistentDomain(forName: suiteName) }

        await gate.setAvailable(false)
        ConvexSyncService.recordFailure("Read failed", at: 1, to: metadata)
        let failedID = store.loadID(viewer: .mason, lastReadSuccess: 0)
        await store.load(viewer: failedID.viewer)
        XCTAssertNil(store.btcBalance.value)
        XCTAssertNotNil(ContentView.readSyncMessage(
            hasReadToken: false,
            lastError: metadata.string(forKey: ConvexSyncService.lastSyncErrorKey) ?? "",
        ))

        // Model a successful setup without writing any real credential. Both
        // recovery sheets send this signal to ContentView's task identity.
        await gate.setAvailable(true)
        store.requestReload()
        let setupID = store.loadID(viewer: .mason, lastReadSuccess: 0)
        XCTAssertNotEqual(setupID, failedID)
        await store.load(viewer: setupID.viewer)
        assertMasonSources(store)

        // Automatic sync clears the banner and changes the root task identity,
        // including when Setup was opened through Settings instead of a sheet.
        await gate.setValue(300)
        ConvexSyncService.publishSuccessfulSync(versions: [:], totalEntities: 1, timestamp: 2, to: metadata)
        let syncedID = store.loadID(
            viewer: .mason,
            lastReadSuccess: metadata.double(forKey: ConvexSyncService.lastSyncKey),
        )
        XCTAssertNotEqual(syncedID, setupID)
        await store.load(viewer: syncedID.viewer)
        XCTAssertEqual(store.btcBalance.value?.owner, .mason)
        XCTAssertEqual(store.btcBalance.value?.totalSats, 300)
        XCTAssertEqual(store.income.value?.cents(forMonth: "2099-01"), 300)
        XCTAssertEqual(store.btcBillPays.value?.totalUSDCents, 300)
        XCTAssertNil(ContentView.readSyncMessage(
            hasReadToken: true,
            lastError: metadata.string(forKey: ConvexSyncService.lastSyncErrorKey) ?? "",
        ))
    }

    @MainActor
    private func makeStore(gate: FinancialResponseGate) -> CanonicalFinancialSourceStore {
        CanonicalFinancialSourceStore(client: ConvexClient(
            deploymentURL: URL(string: "https://financial-store.invalid")!,
            requestExecutor: { try await gate.response(to: $0) },
        ))
    }

    @MainActor
    private func assertMasonSources(
        _ store: CanonicalFinancialSourceStore,
        file: StaticString = #filePath,
        line: UInt = #line,
    ) {
        XCTAssertEqual(store.btcBalance.value?.owner, .mason, file: file, line: line)
        XCTAssertEqual(store.btcBalance.value?.totalSats, 100, file: file, line: line)
        XCTAssertEqual(store.income.value?.cents(forMonth: "2099-01"), 100, file: file, line: line)
        XCTAssertEqual(store.btcBillPays.value?.totalUSDCents, 100, file: file, line: line)
    }
}

/// Holds one request even after cancellation, as a transport that has already
/// received its response may do. The request's value is captured before waiting.
private actor FinancialResponseGate {
    static let paths = ["tables:listBtcBalanceDocuments", "tables:listIncome", "tables:listBtcBillPays"]

    private let heldPath: String?
    private let failsWhenReleased: Bool
    private var didHold = false
    private var available = true
    private var value: Int64?
    private var held: CheckedContinuation<Void, Never>?
    private var started: CheckedContinuation<Void, Never>?

    init(heldPath: String? = nil, failsWhenReleased: Bool = false) {
        self.heldPath = heldPath
        self.failsWhenReleased = failsWhenReleased
    }

    func waitUntilHeld() async {
        if didHold { return }
        await withCheckedContinuation { started = $0 }
    }

    func release() {
        held?.resume()
        held = nil
    }

    func setAvailable(_ available: Bool) { self.available = available }
    func setValue(_ value: Int64) { self.value = value }

    func response(to request: URLRequest) async throws -> (Data, URLResponse) {
        let body = try XCTUnwrap(request.httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let path = try XCTUnwrap(object["path"] as? String)
        let args = try XCTUnwrap(object["args"] as? [String: Any])
        let viewer = try XCTUnwrap(args["viewer"] as? String)
        let amount = value ?? (viewer == "mason" ? 100 : 700)
        guard available else { throw URLError(.userAuthenticationRequired) }
        if !didHold, viewer == "victor", path == heldPath {
            didHold = true
            started?.resume()
            started = nil
            await withCheckedContinuation { held = $0 }
            if failsWhenReleased { throw URLError(.timedOut) }
        }

        let money = ConvexTaggedInt64Encoder.encode(amount)
        let zero = ConvexTaggedInt64Encoder.encode(0)
        let row: [String: Any]
        switch path {
        case Self.paths[0]:
            row = [
                "owner": viewer, "schemaVersion": ConvexTaggedInt64Encoder.encode(1),
                "asOf": "2099-01-01T00:00:00Z", "accounts": [],
                "totals": ["sats": money, "exchangeSats": money, "selfCustodySats": zero],
            ]
        case Self.paths[1]:
            row = [
                "incomeId": "test-income", "owner": viewer, "date": "2099-01-01",
                "month": "2099-01", "amountCents": money, "source": "Test", "updatedAtMs": 1,
            ]
        case Self.paths[2]:
            row = [
                "billPayId": "test-bill", "owner": viewer, "date": "2099-01-01",
                "month": "2099-01", "amountUsdCents": money, "btcSpentSats": money,
                "btcPriceCents": money, "merchant": "Test", "category": "Utilities",
            ]
        default:
            throw URLError(.unsupportedURL)
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "status": "success", "value": ["complete": true, "rows": [row]],
        ])
        let response = try XCTUnwrap(HTTPURLResponse(
            url: XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil,
        ))
        return (data, response)
    }
}
