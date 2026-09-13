import Foundation
import XCTest

final class AddTransactionIntentTests: XCTestCase {
    func testDefaultsShareAdultsButIsolateChildrenAndPaymentMethods() throws {
        let suite = "entry-default-tests.\(UUID().uuidString)"
        let store = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { store.removePersistentDomain(forName: suite) }
        let adult = EntryFormDefaults(category: "Groceries", merchant: "Market")
        adult.save(owner: .rachel, method: "sofi_card", store: store)
        XCTAssertEqual(EntryFormDefaults.load(owner: .victor, method: "sofi_card", store: store), adult)
        XCTAssertEqual(EntryFormDefaults.load(owner: .mason, method: "sofi_card", store: store), EntryFormDefaults())
        XCTAssertEqual(EntryFormDefaults.load(owner: .rachel, method: "river", store: store), EntryFormDefaults())
        let child = EntryFormDefaults(category: "Lunch", merchant: "Cafeteria")
        child.save(owner: .mason, method: "sofi_card", store: store)
        XCTAssertEqual(EntryFormDefaults.load(owner: .mason, method: "sofi_card", store: store), child)
        XCTAssertEqual(EntryFormDefaults.load(owner: .maddox, method: "sofi_card", store: store), EntryFormDefaults())
        XCTAssertEqual(EntryFormDefaults.load(owner: .victor, method: "sofi_card", store: store), adult)
    }

    func testInvalidSavedDefaultsDoNotPopulateEntry() throws {
        let suite = "entry-default-invalid-tests.\(UUID().uuidString)"
        let store = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { store.removePersistentDomain(forName: suite) }
        store.set(Data("invalid".utf8), forKey: EntryFormDefaults.key(owner: .mason, method: "sofi_card"))
        XCTAssertEqual(EntryFormDefaults.load(owner: .mason, method: "sofi_card", store: store), EntryFormDefaults())
    }

    func testUSDIncomeOmitsBitcoinMarkerAndSats() {
        let intent = AddTransactionAmountIntent.make(
            isIncome: true,
            inputUnit: .usd,
            typedAmount: 1_234.56,
            computedSats: 1_543_200,
            btcPrice: 80_000,
        )

        XCTAssertEqual(intent.amountUSD, 1_234.56)
        XCTAssertNil(intent.amountSats)
        XCTAssertNil(intent.enteredInBitcoin)
    }

    func testBTCAndSatsIncomePreserveBitcoinMarkerAndSats() {
        for unit in [DisplayUnit.btc, .sats] {
            let intent = AddTransactionAmountIntent.make(
                isIncome: true,
                inputUnit: unit,
                typedAmount: 0.01,
                computedSats: 1_000_000,
                btcPrice: 80_000,
            )

            XCTAssertEqual(intent.amountUSD, 800)
            XCTAssertEqual(intent.amountSats, 1_000_000)
            XCTAssertEqual(intent.enteredInBitcoin, true)
        }
    }

    /// A Bitcoin-native spend carries its typed sats exactly like a typed
    /// Bitcoin income — the encoder's three-condition rule depends on this:
    /// derived sats (USD entry) must stay nil for spends of fiat sources, but
    /// a Bitcoin-native source requires positive sats the user typed.
    func testSpendCarriesTypedSatsForBitcoinEntry() {
        for unit in [DisplayUnit.btc, DisplayUnit.sats] {
            let intent = AddTransactionAmountIntent.make(
                isIncome: false,
                inputUnit: unit,
                typedAmount: 0.01,
                computedSats: 1_000_000,
                btcPrice: 80_000,
            )

            XCTAssertEqual(intent.amountSats, 1_000_000)
            XCTAssertEqual(intent.enteredInBitcoin, true)
        }
    }

    func testUSDSpendCarriesDerivedSatsAndNoBitcoinMarker() {
        let intent = AddTransactionAmountIntent.make(
            isIncome: false,
            inputUnit: .usd,
            typedAmount: 100,
            computedSats: 125_000,
            btcPrice: 80_000,
        )

        // The derived value exists on the intent, but the marker is absent —
        // the form's Bitcoin-native guard rejects a USD entry before it can
        // reach the encoder, and the encoder refuses it independently.
        XCTAssertEqual(intent.amountSats, 125_000)
        XCTAssertNil(intent.enteredInBitcoin)
    }

    @MainActor
    func testTransactionCreateIDSurvivesTwoFailuresAndRotatesAfterAcceptedReceipt() {
        let store = makeCreateIDStore()
        let originalID = store.transactionID

        XCTAssertFalse(store.recordServerResult(.failed(.transport), for: .transaction))
        XCTAssertEqual(store.transactionID, originalID)
        XCTAssertFalse(store.recordServerResult(.missing, for: .transaction))
        XCTAssertEqual(store.transactionID, originalID)

        XCTAssertTrue(store.recordServerResult(.ok, for: .transaction))
        XCTAssertNotEqual(store.transactionID, originalID)
    }

    @MainActor
    func testBitcoinBuyCreateIDSurvivesTwoFailuresAndRotatesAfterAcceptedReceipt() {
        let store = makeCreateIDStore()
        let originalID = store.bitcoinBuyID

        XCTAssertFalse(store.recordServerResult(.failed(.transport), for: .bitcoinBuy))
        XCTAssertEqual(store.bitcoinBuyID, originalID)
        XCTAssertFalse(store.recordServerResult(.missing, for: .bitcoinBuy))
        XCTAssertEqual(store.bitcoinBuyID, originalID)

        XCTAssertTrue(store.recordServerResult(.ok, for: .bitcoinBuy))
        XCTAssertNotEqual(store.bitcoinBuyID, originalID)
    }

    @MainActor
    private func makeCreateIDStore() -> AddTransactionCreateIDStore {
        var uuids = [
            UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
            UUID(uuidString: "00000000-0000-0000-0000-000000000002")!,
            UUID(uuidString: "00000000-0000-0000-0000-000000000003")!,
        ]
        return AddTransactionCreateIDStore { uuids.removeFirst() }
    }
}
