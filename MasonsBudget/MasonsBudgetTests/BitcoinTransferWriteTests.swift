import Foundation
import XCTest

final class BitcoinTransferWriteTests: XCTestCase {
    private func balance(owner: FamilyMember = .victor, sats: Int64 = 1_000) -> CanonicalBTCBalance {
        CanonicalBTCBalance(
            owner: owner, asOf: "2026-09-07", totalSats: sats, totalFiatCents: nil,
            exchangeSats: sats, selfCustodySats: 0,
            accounts: [
                .init(key: "river", label: "River", custody: .exchange, sats: sats, fiatCents: nil),
                .init(key: "coldcard", label: "Coldcard", custody: .selfCustody, sats: 0, fiatCents: nil),
            ],
        )
    }

    private func intent(sats: String = "500", viewer: FamilyMember = .rachel) throws -> BitcoinTransferIntent {
        try .make(
            viewer: viewer, balance: balance(), from: "river", to: "coldcard",
            satsText: sats, date: Date(timeIntervalSince1970: 1_788_782_400),
        )
    }

    func testHouseholdOwnerAndExactZeroFeeWire() throws {
        let transfer = try intent()
        XCTAssertEqual(transfer.owner, .victor)
        let args = transfer.arguments(deviceID: "synthetic-device", deviceToken: "synthetic-token")
        XCTAssertEqual(args["owner"] as? String, "victor")
        XCTAssertEqual(args["sourceFile"] as? String, "btc-transfers")
        let row = try XCTUnwrap(args["transfer"] as? [String: Any])
        XCTAssertEqual(try ConvexTaggedInt64Decoder.decodeTaggedValue(XCTUnwrap(row["sats"])), 500)
        XCTAssertEqual(try ConvexTaggedInt64Decoder.decodeTaggedValue(XCTUnwrap(row["feeSats"])), 0)
        XCTAssertNil(args["baseUpdatedAtMs"])
        XCTAssertThrowsError(try intent(viewer: .mason))
        XCTAssertThrowsError(try intent(viewer: .maddox))
    }

    func testRejectsPrecisionOverflowInsufficientFundsAndWrongAccounts() throws {
        for sats in ["0", "-1", "0.5", "1e2", "9223372036854775808", "1001", "1,000"] {
            XCTAssertThrowsError(try intent(sats: sats), sats)
        }
        for (from, to) in [("river", "river"), ("missing", "coldcard"), ("river", "missing"), (" river", "coldcard")] {
            XCTAssertThrowsError(try BitcoinTransferIntent.make(
                viewer: .victor, balance: balance(), from: from, to: to, satsText: "1", date: Date(),
            ))
        }
        XCTAssertThrowsError(try BitcoinTransferIntent.make(
            viewer: .victor, balance: balance(owner: .mason), from: "river", to: "coldcard", satsText: "1", date: Date(),
        ))
    }

    func testOnlyMatchingExplicitReceiptsAreAccepted() throws {
        let transfer = try intent()
        for outcome in ["inserted", "updated"] {
            XCTAssertNoThrow(try transfer.validateReceipt(["ok": true, "entityId": transfer.id, "outcome": outcome]))
        }
        let invalid: [Any] = [
            [:] as [String: Any], NSNull(),
            ["ok": false, "entityId": transfer.id, "outcome": "inserted"],
            ["ok": 1, "entityId": transfer.id, "outcome": "inserted"],
            ["ok": true, "entityId": "other", "outcome": "inserted"],
            ["ok": true, "entityId": transfer.id, "outcome": "unknown"],
        ]
        for value in invalid { XCTAssertThrowsError(try transfer.validateReceipt(value)) }
    }

    @MainActor
    func testRestartRetainsTheExactRequestAndBlocksReplacementUntilReceipt() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("draft.json")
        let transfer = try intent()
        let store = try BitcoinTransferDraftStore(fileURL: url)
        try store.reserve(transfer)
        let restarted = try BitcoinTransferDraftStore(fileURL: url)
        XCTAssertEqual(try restarted.load()?.intent, transfer)
        XCTAssertEqual(try restarted.load()?.accepted, false)
        // Recovery uses the saved request, even when the first debit exhausted the source.
        XCTAssertThrowsError(try BitcoinTransferIntent.make(
            viewer: .victor, balance: balance(sats: 0), from: "river", to: "coldcard", satsText: "500", date: Date(),
        ))
        XCTAssertNoThrow(try restarted.reserve(transfer))
        XCTAssertThrowsError(try restarted.reserve(intent(sats: "200")))
        XCTAssertThrowsError(try restarted.retire(transfer))
        try restarted.accept(transfer)
        XCTAssertEqual(try BitcoinTransferDraftStore(fileURL: url).load()?.accepted, true)
        XCTAssertThrowsError(try restarted.reserve(transfer))
        try restarted.retire(transfer)
        XCTAssertNil(try restarted.load())
        XCTAssertNoThrow(try restarted.reserve(intent(sats: "200")))
        // A stale receipt must never remove a newer transfer.
        XCTAssertThrowsError(try restarted.accept(transfer))
        XCTAssertThrowsError(try restarted.retire(transfer))
    }

    @MainActor
    func testCorruptOrUnwritableDraftStorageFailsClosed() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("draft.json")
        try Data("broken".utf8).write(to: url)
        let store = try BitcoinTransferDraftStore(fileURL: url)
        XCTAssertThrowsError(try store.load())
        XCTAssertThrowsError(try store.reserve(intent()))
        let impossible = try BitcoinTransferDraftStore(fileURL: url.appendingPathComponent("draft.json"))
        XCTAssertThrowsError(try impossible.reserve(intent()))
    }
}
