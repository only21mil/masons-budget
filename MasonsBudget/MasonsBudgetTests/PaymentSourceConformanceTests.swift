// Payment-source conformance — TransactionSourceCatalog vs the closed wire contract.
//
// This suite and scripts/apple_payment_source_conformance.py guard the same
// contract from two directions, and the split is deliberate:
//
//   - This Swift test pins TransactionSourceCatalog against the contract values
//     hardcoded below (contractVersion 2 of
//     shared/domain/fixtures/payment-source-cases.json, nine ordered sources).
//     The values are inlined rather than read from the fixture JSON at runtime
//     because the unit-test bundle's fixture access is not something this test
//     should depend on.
//   - The script gate diffs the live Swift catalogue against the actual fixture
//     JSON on disk, so drift in either direction — the fixture changing under a
//     stale catalogue, or the catalogue changing under a stale fixture — is
//     caught by it, not by this test.
//
// Order is contract: every assertion below uses ordered array comparison on
// purpose. Set or sorted comparison would silently bless a reordered catalogue.

import XCTest

final class PaymentSourceConformanceTests: XCTestCase {
    // Contract values from shared/domain/fixtures/payment-source-cases.json
    // (contractVersion 2), inlined on purpose — see the header comment.

    private let contractWires = [
        "river",
        "zeus_lightning",
        "zeus_on_chain",
        "strike",
        "coinbase_card",
        "aven",
        "sofi_card",
        "capital_one_vx",
        "river_bitcoin_bill_pay",
    ]

    private let contractLabels = [
        "River",
        "Zeus Lightning",
        "Zeus On-chain",
        "Strike",
        "Coinbase Card",
        "Aven",
        "SoFi Card",
        "Capital One VX",
        "River Bitcoin Bill Pay",
    ]

    private let contractIncomeWires = [
        "river",
        "zeus_lightning",
        "zeus_on_chain",
        "strike",
    ]

    // MARK: - Catalogue order is contract

    func testCatalogueWireSequenceMatchesContract() {
        XCTAssertEqual(
            TransactionSourceCatalog.common.map(\.wire),
            contractWires,
            "Catalogue wire order must equal the fixture order position for position",
        )
    }

    func testCatalogueLabelSequenceMatchesContract() {
        XCTAssertEqual(
            TransactionSourceCatalog.common.map(\.label),
            contractLabels,
            "Catalogue labels must equal the fixture labels in fixture order",
        )
    }

    func testCatalogueCountMatchesContract() {
        XCTAssertEqual(TransactionSourceCatalog.common.count, contractWires.count)
        XCTAssertEqual(contractWires.count, contractLabels.count)
    }

    // MARK: - Per-entry classification and supported activities

    func testBitcoinNativeEntriesSupportSpendIncomeAndTransfer() {
        let bitcoinNative = TransactionSourceCatalog.common.prefix(4)
        XCTAssertEqual(bitcoinNative.count, 4)

        for (index, option) in bitcoinNative.enumerated() {
            XCTAssertEqual(
                option.supportedActivities,
                [.spend, .income, .transfer],
                "bitcoin_native entry \(index) (\(option.wire)) must support spend, income, and transfer",
            )
            XCTAssertTrue(
                option.isBitcoinNative,
                "Entry \(index) (\(option.wire)) must be classified bitcoin_native",
            )
        }
    }

    func testFiatCardEntriesSupportSpendOnly() {
        let fiatCards = TransactionSourceCatalog.common.dropFirst(4).prefix(4)
        XCTAssertEqual(fiatCards.count, 4)

        for (index, option) in fiatCards.enumerated() {
            XCTAssertEqual(
                option.supportedActivities,
                [.spend],
                "fiat_card entry \(index + 4) (\(option.wire)) must support spend only",
            )
            XCTAssertFalse(
                option.isBitcoinNative,
                "Entry \(index + 4) (\(option.wire)) must not be classified bitcoin_native",
            )
        }
    }

    func testBillPayEntrySupportsBtcBillPayOnly() {
        let billPay = TransactionSourceCatalog.common.last
        XCTAssertEqual(billPay?.wire, "river_bitcoin_bill_pay")
        XCTAssertEqual(billPay?.supportedActivities, [.btcBillPay])
        XCTAssertFalse(billPay?.isBitcoinNative ?? true)
    }

    // MARK: - Retired wires are gone from the catalogue

    func testRetiredWiresAreNotSelectable() {
        let wires = Set(TransactionSourceCatalog.common.map(\.wire))
        XCTAssertFalse(
            wires.contains("lightning"),
            "Retired wire \"lightning\" must not appear as a catalogue option",
        )
        XCTAssertFalse(
            wires.contains("on_chain"),
            "Retired wire \"on_chain\" must not appear as a catalogue option",
        )
    }

    // MARK: - Activity-filtered wire sequences

    func testIncomeWiresMatchContract() {
        XCTAssertEqual(TransactionSourceCatalog.wires(for: .income), contractIncomeWires)
    }

    func testBillPayWiresMatchContract() {
        XCTAssertEqual(
            TransactionSourceCatalog.wires(for: .btcBillPay),
            ["river_bitcoin_bill_pay"],
        )
    }

    // MARK: - Legacy escape hatch
    //
    // Catalogue order is the contract, and the ordered assertions above run
    // against the base catalogue (`common`, starting with "river"). The picker-
    // rendered list is a different object: sources(for:including:) in a legacy
    // context PREPENDS a synthetic entry for the unknown stored wire at index 0
    // by design, so a rendered list whose first entry is not "river" is not an
    // order violation. The synthetic and canonical sequences are asserted
    // separately below precisely so neither masks drift in the other.

    func testOptionForWireReturnsCatalogueEntry() {
        XCTAssertEqual(TransactionSourceCatalog.option(forWire: "river")?.label, "River")
        XCTAssertEqual(TransactionSourceCatalog.option(forWire: "strike")?.classification, .bitcoinNative)
        // Retired and unknown wires have no catalogue entry.
        XCTAssertNil(TransactionSourceCatalog.option(forWire: "lightning"))
        XCTAssertNil(TransactionSourceCatalog.option(forWire: "not-a-wire"))
    }

    func testEditableSourcesFenceOffBitcoinNativeForRowsWithoutPosting() {
        // A fiat row (and by the same code path a legacy or untagged one)
        // must not offer any Bitcoin-native wire: the edit surface has no
        // sats entry, so it cannot collect the posting the backend demands.
        let fiat = TransactionSourceCatalog.editableSources(
            for: .spend, storedCard: "sofi_card", selected: nil)
        XCTAssertFalse(fiat.contains { $0.classification.isBitcoinNative })
        XCTAssertEqual(
            fiat.map(\.wire),
            contractWires.filter { wire in
                wire != "river_bitcoin_bill_pay" && wire != "river"
                    && wire != "zeus_lightning" && wire != "zeus_on_chain"
                    && wire != "strike"
            },
            "Only the fiat cards remain for a fiat row",
        )

        // Untagged and unknown-wire rows are fenced identically.
        XCTAssertFalse(
            TransactionSourceCatalog
                .editableSources(for: .spend, storedCard: nil, selected: nil)
                .contains { $0.classification.isBitcoinNative })
        XCTAssertFalse(
            TransactionSourceCatalog
                .editableSources(for: .spend, storedCard: "lightning", selected: nil)
                .contains { $0.classification.isBitcoinNative })
    }

    func testEditableSourcesKeepStoredBitcoinNativeWireSelectable() {
        // A row that already carries a Bitcoin-native wire keeps it — the
        // stored posting round-trips unchanged, and the wire stays offered
        // alongside the other Bitcoin-native options for that row.
        let options = TransactionSourceCatalog.editableSources(
            for: .spend, storedCard: "zeus_lightning", selected: nil)
        XCTAssertEqual(
            options.filter { $0.classification.isBitcoinNative }.map(\.wire),
            ["river", "zeus_lightning", "zeus_on_chain", "strike"])
        XCTAssertTrue(options.contains { $0.wire == "sofi_card" })
    }

    func testActivityRailsCoverActiveAndRetiredBitcoinWires() {
        // The Lightning rail takes zeus_lightning plus the retired
        // "lightning"; On-chain takes zeus_on_chain, retired "on-chain",
        // and nil-card rows. Fiat cards and River/Strike live in no rail.
        XCTAssertEqual(TransactionSourceCatalog.activityRail(forCard: "zeus_lightning"), .lightning)
        XCTAssertEqual(TransactionSourceCatalog.activityRail(forCard: "lightning"), .lightning)
        XCTAssertEqual(TransactionSourceCatalog.activityRail(forCard: "zeus_on_chain"), .onChain)
        XCTAssertEqual(TransactionSourceCatalog.activityRail(forCard: "on-chain"), .onChain)
        XCTAssertEqual(TransactionSourceCatalog.activityRail(forCard: nil), .onChain)
        XCTAssertNil(TransactionSourceCatalog.activityRail(forCard: "sofi_card"))
        XCTAssertNil(TransactionSourceCatalog.activityRail(forCard: "river"))
        XCTAssertNil(TransactionSourceCatalog.activityRail(forCard: "strike"))
    }

    func testSearchMatchesDisplayLabelOfCatalogueWires() {
        // Search runs on the display label: a user typing "Zeus" finds a
        // zeus_lightning row without knowing the wire value.
        let tx = Transaction(
            id: "search-1", date: Date(), merchant: "Test", amount: 10,
            category: "Other", card: "zeus_lightning", owner: .victor, createdBy: "app",
        )
        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "Zeus"))
        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "lightning"))
        XCTAssertFalse(SearchMatcher.matches(transaction: tx, query: "Coinbase"))
    }

    func testSearchMatchesLegacyCardByItsOwnStoredText() {
        // An unrecognised card still matches by its verbatim stored value —
        // label(forWire:) falls back to the wire itself.
        let legacy = Transaction(
            id: "search-2", date: Date(), merchant: "Test", amount: 10,
            category: "Other", card: "SoFi old card", owner: .victor, createdBy: "app",
        )
        XCTAssertTrue(SearchMatcher.matches(transaction: legacy, query: "sofi old"))
        XCTAssertFalse(SearchMatcher.matches(transaction: legacy, query: "Zeus"))
    }

    func testExportCardColumnRendersLabelAndLegacyVerbatim() {
        // Catalogue wires export their display label; an unrecognised card
        // exports byte-for-byte verbatim via the label fallback.
        XCTAssertEqual(ExportView.cardColumn(for: "coinbase_card"), "Coinbase Card")
        XCTAssertEqual(ExportView.cardColumn(for: "zeus_on_chain"), "Zeus On-chain")
        XCTAssertEqual(ExportView.cardColumn(for: "SoFi old card"), "SoFi old card")
        XCTAssertEqual(ExportView.cardColumn(for: nil), "On-chain")
    }

    func testUnknownWireIsReinsertedAsSyntheticOption() {
        // A stored wire that no longer exists in the catalogue (e.g. a retired
        // value on an existing row) must round-trip: sources(for:including:)
        // re-inserts it as a synthetic option instead of dropping it.
        let sources = TransactionSourceCatalog.sources(for: .spend, including: "lightning")

        XCTAssertEqual(sources.first?.wire, "lightning")
        XCTAssertEqual(sources.first?.label, "lightning")
        XCTAssertEqual(
            sources.map(\.wire),
            ["lightning"] + contractWires.filter { $0 != "river_bitcoin_bill_pay" },
            "The synthetic option leads, followed by every catalogue source that supports spend in order",
        )
    }
}
