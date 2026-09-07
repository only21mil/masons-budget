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
            now: Date(timeIntervalSince1970: 1_788_782_400),
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

    private func instant(_ value: String) throws -> Date {
        try XCTUnwrap(ISO8601DateFormatter().date(from: value))
    }

    @MainActor
    func testDateWindowRejectsBeforeReservationAndAcceptsBothBoundaries() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try BitcoinTransferDraftStore(fileURL: directory.appendingPathComponent("draft.json"))
        let now = try instant("2026-09-07T12:00:00Z")
        let utc = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        for invalid in ["1999-12-31T12:00:00Z", "2026-10-08T00:00:00Z"] {
            XCTAssertThrowsError(try store.reserve(BitcoinTransferIntent.make(
                viewer: .victor, balance: balance(), from: "river", to: "coldcard", satsText: "1",
                date: instant(invalid), now: now, timeZone: utc,
            ))) { error in
                XCTAssertEqual(error as? BitcoinTransferError, .invalidDate)
            }
            XCTAssertNil(try store.load(), "Invalid dates must not freeze a saved request")
        }
        for valid in ["2000-01-01T00:00:00Z", "2026-10-07T23:59:59Z"] {
            let transfer = try BitcoinTransferIntent.make(
                viewer: .victor, balance: balance(), from: "river", to: "coldcard", satsText: "1",
                date: instant(valid), now: now, timeZone: utc,
            )
            XCTAssertEqual(transfer.date, String(valid.prefix(10)))
            try store.reserve(transfer)
            try store.accept(transfer)
            try store.retire(transfer)
        }
    }

    func testPickerBoundsMatchUTCLimitAcrossLocalDateAndDaylightSavingChanges() throws {
        for timestamp in ["2026-09-07T00:30:00Z", "2026-09-07T23:30:00Z", "2026-10-15T23:30:00Z"] {
            let now = try instant(timestamp)
            let utc = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
            let expected = try BitcoinTransferDateWindow.validatedISODate(
                now.addingTimeInterval(30 * 86_400), now: now, timeZone: utc,
            )
            for zone in ["Pacific/Kiritimati", "America/Los_Angeles", "America/Chicago"] {
                let timeZone = try XCTUnwrap(TimeZone(identifier: zone))
                let range = BitcoinTransferDateWindow.allowedDates(now: now, timeZone: timeZone)
                XCTAssertEqual(try BitcoinTransferDateWindow.validatedISODate(
                    range.lowerBound, now: now, timeZone: timeZone,
                ), "2000-01-01")
                XCTAssertEqual(try BitcoinTransferDateWindow.validatedISODate(
                    range.upperBound, now: now, timeZone: timeZone,
                ), expected)
                for outside in [range.lowerBound.addingTimeInterval(-1), range.upperBound.addingTimeInterval(1)] {
                    XCTAssertThrowsError(try BitcoinTransferDateWindow.validatedISODate(outside, now: now, timeZone: timeZone))
                }
            }
        }
    }

    func testDeletionRequiresMatchingStructuredTransferIdentity() throws {
        let transfer = try intent()
        let matching: [String: Any] = [
            "code": "ENTITY_DELETED", "entityType": "btcTransfer", "entityId": transfer.id,
        ]
        XCTAssertEqual(BitcoinTransferDeletionReceipt(intent: transfer, errorData: matching)?.intent, transfer)
        let encoded = try JSONSerialization.data(withJSONObject: matching)
        XCTAssertNotNil(BitcoinTransferDeletionReceipt(intent: transfer, errorData: String(data: encoded, encoding: .utf8)))
        let invalid: [Any] = [
            ["code": "ENTITY_DELETED"],
            ["code": "ENTITY_DELETED", "entityType": "btcTransfer", "entityId": "another"],
            ["code": "ENTITY_DELETED", "entityType": "btcBuy", "entityId": transfer.id],
            ["code": "ENTITY_NOT_FOUND", "entityType": "btcTransfer", "entityId": transfer.id],
            ["code": "DEVICE_UNAUTHORIZED", "entityType": "btcTransfer", "entityId": transfer.id],
            "ENTITY_DELETED", NSNull(),
        ]
        for value in invalid {
            XCTAssertNil(BitcoinTransferDeletionReceipt(intent: transfer, errorData: value))
        }
    }

    @MainActor
    func testDeletionSurvivesRestartAndStaleResultCannotRetireReplacement() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("draft.json")
        let store = try BitcoinTransferDraftStore(fileURL: url)
        let transfer = try intent()
        try store.reserve(transfer)
        // Old drafts had only accepted. Decoding them must retain pending recovery.
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        legacy.removeValue(forKey: "deleted")
        try JSONSerialization.data(withJSONObject: legacy).write(to: url)
        XCTAssertEqual(try store.load()?.terminal, false)
        let receipt = try XCTUnwrap(BitcoinTransferDeletionReceipt(intent: transfer, errorData: [
            "code": "ENTITY_DELETED", "entityType": "btcTransfer", "entityId": transfer.id,
        ]))
        try store.recordDeletion(receipt)
        // Simulate interruption between recording the deletion and removing the file.
        let restarted = try BitcoinTransferDraftStore(fileURL: url)
        XCTAssertEqual(try restarted.load()?.intent, transfer)
        XCTAssertEqual(try restarted.load()?.deleted, true)
        XCTAssertEqual(try restarted.load()?.terminal, true)
        XCTAssertThrowsError(try restarted.reserve(transfer))
        XCTAssertThrowsError(try restarted.accept(transfer))
        try restarted.retire(transfer)
        XCTAssertNil(try restarted.load())
        let replacement = try intent(sats: "200")
        try restarted.reserve(replacement)
        XCTAssertThrowsError(try restarted.recordDeletion(receipt))
        XCTAssertThrowsError(try restarted.retire(transfer))
        XCTAssertEqual(try restarted.load()?.intent, replacement)
        XCTAssertEqual(try restarted.load()?.terminal, false)
    }

    func testMutationResponseRecognizesDeletionOnlyFromExpectedHTTPStatuses() throws {
        let transfer = try intent()
        let body = try JSONSerialization.data(withJSONObject: [
            "status": "error",
            "errorData": ["code": "ENTITY_DELETED", "entityType": "btcTransfer", "entityId": transfer.id],
        ])
        for status in [200, 560] {
            XCTAssertThrowsError(try AppWritebackClient.mutationValue(
                data: body, statusCode: status, bitcoinTransfer: transfer,
            )) { error in
                XCTAssertEqual((error as? BitcoinTransferDeletionReceipt)?.intent, transfer)
            }
        }
        for status in [401, 403, 500, 502] {
            XCTAssertThrowsError(try AppWritebackClient.mutationValue(
                data: body, statusCode: status, bitcoinTransfer: transfer,
            )) { error in
                guard case AppWritebackError.httpError(let actual) = error else {
                    return XCTFail("An unrelated HTTP failure must not become a deletion receipt")
                }
                XCTAssertEqual(actual, status)
            }
        }
        XCTAssertThrowsError(try AppWritebackClient.mutationValue(data: body, statusCode: 560)) { error in
            guard case AppWritebackError.httpError(560) = error else {
                return XCTFail("Other mutation routes must keep their existing HTTP error behavior")
            }
        }
        let success = try JSONSerialization.data(withJSONObject: [
            "status": "success", "value": ["ok": true, "entityId": transfer.id, "outcome": "inserted"],
        ])
        try transfer.validateReceipt(AppWritebackClient.mutationValue(
            data: success, statusCode: 200, bitcoinTransfer: transfer,
        ))
        XCTAssertThrowsError(try AppWritebackClient.mutationValue(
            data: success, statusCode: 560, bitcoinTransfer: transfer,
        ))
        let mismatched = try intent()
        XCTAssertThrowsError(try AppWritebackClient.mutationValue(
            data: body, statusCode: 560, bitcoinTransfer: mismatched,
        )) { error in
            XCTAssertFalse(error is BitcoinTransferDeletionReceipt, "A stale response must remain unresolved")
        }
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
