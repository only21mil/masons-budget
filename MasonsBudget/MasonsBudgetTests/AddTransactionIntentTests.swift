import Foundation
import XCTest

final class AddTransactionIntentTests: XCTestCase {
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
