import Foundation
import XCTest

final class DeviceLedgerWriteTests: XCTestCase {
    func testAdultWritesUseCanonicalOwnerAndOnlyDeviceAuthentication() throws {
        let args = try AppWritebackClient.ledgerArguments(
            owner: .rachel, activeProfile: .rachel,
            arguments: ["sourceFile": "transactions", "token": "obsolete-test-token"],
            deviceID: "test-device", deviceToken: "test-device-token",
        )
        XCTAssertEqual(args["owner"] as? String, "victor")
        XCTAssertEqual(args["sourceFile"] as? String, "transactions")
        XCTAssertEqual(args["deviceId"] as? String, "test-device")
        XCTAssertEqual(args["deviceToken"] as? String, "test-device-token")
        XCTAssertNil(args["token"])
    }

    func testDeviceMoneyScopeIsNarrowerThanAdultVisibility() throws {
        for actor in FamilyMember.allCases {
            for owner in FamilyMember.allCases {
                if actor.sharesNetWorth(with: owner) {
                    let args = try AppWritebackClient.ledgerArguments(
                        owner: owner, activeProfile: actor, arguments: [:],
                        deviceID: "test-device", deviceToken: "test-device-token",
                    )
                    XCTAssertEqual(args["owner"] as? String, owner.ledgerOwner.rawValue)
                } else {
                    XCTAssertThrowsError(try AppWritebackClient.ledgerArguments(
                        owner: owner, activeProfile: actor, arguments: [:],
                        deviceID: "test-device", deviceToken: "test-device-token",
                    )) { error in
                        XCTAssertEqual(ConvexWriteResult.classify(error), .failed(.ownerMismatch(field: "entry")))
                    }
                }
            }
        }
    }

    func testAdultLedgerBindingAllowsSharedHouseholdButTasksStayPersonal() {
        XCTAssertNil(AppWritebackClient.ledgerProfileBindingError(boundProfile: .victor, activeProfile: .rachel))
        XCTAssertEqual(AppWritebackClient.taskProfileBindingError(hasStoredCredential: true, boundProfile: .victor, activeProfile: .rachel), .ownerMismatch)
        XCTAssertEqual(AppWritebackClient.ledgerProfileBindingError(boundProfile: .victor, activeProfile: .mason), .ownerMismatch)
        XCTAssertEqual(AppWritebackClient.ledgerProfileBindingError(boundProfile: .mason, activeProfile: .maddox), .ownerMismatch)
        XCTAssertEqual(AppWritebackClient.ledgerProfileBindingError(boundProfile: nil, activeProfile: .victor), .profileBindingRequired)
    }

    func testAcceptedResponseMustMatchEntityAndOperation() throws {
        for outcome in ["inserted", "updated"] {
            XCTAssertNoThrow(try AppWritebackClient.validateLedgerResponse(
                ["ok": true, "entityId": "entry-1", "outcome": outcome], entityID: "entry-1", deleting: false,
            ))
        }
        for removed in [true, false] {
            XCTAssertNoThrow(try AppWritebackClient.validateLedgerResponse(
                ["ok": true, "entityId": "entry-1", "removed": removed], entityID: "entry-1", deleting: true,
            ))
        }
        let rejectedResponses: [[String: Any]] = [
            ["ok": false, "entityId": "entry-1", "outcome": "inserted"],
            ["ok": true, "entityId": "other", "outcome": "inserted"],
            ["ok": true, "entityId": "entry-1", "outcome": "ignored"],
            ["ok": true, "entityId": "entry-1", "removed": true],
        ]
        for response in rejectedResponses {
            XCTAssertThrowsError(try AppWritebackClient.validateLedgerResponse(response, entityID: "entry-1", deleting: false))
        }
        XCTAssertThrowsError(try AppWritebackClient.validateLedgerResponse(
            ["ok": true, "entityId": "entry-1", "outcome": "updated"], entityID: "entry-1", deleting: true,
        ))
    }

    func testTransactionDeviceRoutePreservesRevisionAndSurvivesFailedReadAfterAcceptance() async throws {
        let upsert = expectation(description: "device upsert")
        let deletion = expectation(description: "device deletion")
        let client = ConvexClient(
            deploymentURL: URL(string: "https://example.convex.cloud")!,
            requestExecutor: { _ in throw URLError(.notConnectedToInternet) },
            ledgerExecutor: { path, owner, id, args, deleting in
                XCTAssertEqual(owner, .mason)
                XCTAssertEqual(id, "device-tx")
                XCTAssertEqual(args["sourceFile"] as? String, "mason-transactions")
                XCTAssertEqual(args["baseUpdatedAtMs"] as? Double, 1234)
                XCTAssertNil(args["token"])
                if deleting {
                    XCTAssertEqual(path, "tables:deleteTransactionFromDevice")
                    XCTAssertEqual(args["entityId"] as? String, "device-tx")
                    XCTAssertNil(args["txId"])
                    deletion.fulfill()
                } else {
                    XCTAssertEqual(path, "tables:upsertTransactionFromDevice")
                    let row = try XCTUnwrap(args["transaction"] as? [String: Any])
                    XCTAssertEqual(row["owner"] as? String, "mason")
                    XCTAssertEqual(try ConvexTaggedInt64Decoder.decodeTaggedValue(row["amountCents"]!), 1234)
                    upsert.fulfill()
                }
            },
        )
        let payload = LegacyTransactionDTO(
            id: "device-tx", date: "2026-09-13", merchant: "Example", amount: Decimal(string: "12.34")!,
            category: "Food", card: nil, note: nil, owner: .mason, updatedAtMs: 1234,
        )
        let acceptedRevision = try await client.upsertTransactionRow(payload, owner: .mason, sourceFile: "mason-transactions", fromDevice: true)
        XCTAssertNil(acceptedRevision, "The accepted mutation must not fail or retry when the subsequent read is offline.")
        try await client.deleteTransactionRow(id: payload.id, owner: .mason, sourceFile: "mason-transactions", baseUpdatedAtMs: 1234, fromDevice: true)
        await fulfillment(of: [upsert, deletion], timeout: 1)
    }

    func testDeviceDeleteRefusesAnUnknownRevisionBeforeSending() async throws {
        let client = ConvexClient(
            deploymentURL: URL(string: "https://example.convex.cloud")!,
            ledgerExecutor: { _, _, _, _, _ in XCTFail("Must not send an unfenced deletion") },
        )
        do {
            try await client.deleteTransactionRow(id: "entry", owner: .victor, sourceFile: "transactions", fromDevice: true)
            XCTFail("Missing revision must fail")
        } catch {
            XCTAssertEqual(ConvexWriteResult.classify(error), .failed(.revisionRequired))
        }
    }

    func testBuyDeviceRouteSendsAdultOwnerAndExactManualFee() async throws {
        let wrote = expectation(description: "device buy")
        let client = ConvexClient(
            deploymentURL: URL(string: "https://example.convex.cloud")!,
            requestExecutor: { _ in throw URLError(.notConnectedToInternet) },
            ledgerExecutor: { path, owner, id, args, deleting in
                XCTAssertEqual(path, "tables:upsertBtcBuyFromDevice")
                XCTAssertEqual(owner, .victor)
                XCTAssertEqual(id, "buy-1")
                XCTAssertFalse(deleting)
                let row = try XCTUnwrap(args["buy"] as? [String: Any])
                XCTAssertEqual(row["owner"] as? String, "victor")
                XCTAssertEqual(try ConvexTaggedInt64Decoder.decodeTaggedValue(row["sats"]!), 1000)
                XCTAssertEqual(try ConvexTaggedInt64Decoder.decodeTaggedValue(row["feeUsdCents"]!), 125)
                wrote.fulfill()
            },
        )
        let buy = LegacyBTCBuyDTO(
            id: "buy-1", date: "2026-09-13", source: "River", amountSats: 1000,
            amountBtc: Decimal(string: "0.00001")!, priceUsd: 100000, usd: 1,
            note: nil, status: nil, costBasisStatus: nil, loggedBy: nil, archimedesRequestId: nil,
            owner: "victor", feeUsd: Decimal(string: "1.25"),
        )
        _ = try await client.upsertBTCBuyRow(buy, owner: .victor, fromDevice: true)
        await fulfillment(of: [wrote], timeout: 1)
    }

    @MainActor
    func testIncomeBillPayTransferAndAccountUseExactDeviceRequests() async {
        let previousEnabled = ConvexConfig.writesEnabled
        ConvexConfig.setWritesEnabled(true)
        defer { ConvexConfig.setWritesEnabled(previousEnabled) }
        let done = expectation(description: "all mutations accepted")
        done.expectedFulfillmentCount = 4
        let writer: AppWriteSyncService.LedgerWriter = { path, owner, id, args, deleting in
            XCTAssertFalse(deleting)
            XCTAssertEqual(id, "new-entry")
            XCTAssertNil(args["token"])
            switch path {
            case "tables:upsertIncomeFromDevice":
                XCTAssertEqual(owner, .mason)
                let row = try XCTUnwrap(args["income"] as? [String: Any])
                XCTAssertEqual(row["owner"] as? String, "mason")
                XCTAssertEqual(args["sourceFile"] as? String, "income")
                XCTAssertEqual(try ConvexTaggedInt64Decoder.decodeTaggedValue(row["amountCents"]!), 1234)
            case "tables:upsertBtcBillPayFromDevice":
                XCTAssertEqual(owner, .rachel)
                let row = try XCTUnwrap(args["billPay"] as? [String: Any])
                XCTAssertEqual(row["owner"] as? String, "victor")
                XCTAssertEqual(row["category"] as? String, "Credit Card Payment")
                XCTAssertEqual(row["budgetEffect"] as? String, "credit_card_payment")
                XCTAssertEqual(try ConvexTaggedInt64Decoder.decodeTaggedValue(row["btcSpentSats"]!), 12345)
                XCTAssertEqual(try ConvexTaggedInt64Decoder.decodeTaggedValue(row["feeUsdCents"]!), 0)
            case "tables:upsertBtcTransferFromDevice":
                let row = try XCTUnwrap(args["transfer"] as? [String: Any])
                XCTAssertEqual(row["fromAccountKey"] as? String, "river")
                XCTAssertEqual(row["toAccountKey"] as? String, "cold")
                XCTAssertEqual(try ConvexTaggedInt64Decoder.decodeTaggedValue(row["feeSats"]!), 42)
            case "tables:upsertBtcAccountFromDevice":
                let row = try XCTUnwrap(args["account"] as? [String: Any])
                XCTAssertEqual(args["sourceFile"] as? String, "btc-balance-snapshot")
                XCTAssertEqual(row["owner"] as? String, "victor")
                XCTAssertEqual(row["custody"] as? String, "self_custody")
                XCTAssertEqual(row["asOf"] as? String, "2026-09-13T00:00:00.000Z")
                XCTAssertEqual(args["baseUpdatedAtMs"] as? Double, 987)
                XCTAssertEqual(try ConvexTaggedInt64Decoder.decodeTaggedValue(row["sats"]!), 0)
            default: XCTFail("Unexpected device mutation")
            }
        }
        let complete: @MainActor @Sendable (ConvexWriteResult) -> Void = { result in
            XCTAssertEqual(result, .ok)
            done.fulfill()
        }
        AppWriteSyncService.pushIncome(id: "new-entry", date: .now, amount: Decimal(string: "12.34")!, source: "Job", note: nil, member: .mason, writer: writer, onResult: complete)
        AppWriteSyncService.pushBillPay(id: "new-entry", date: .now, merchant: "Card", category: "ignored", effect: .creditCardPayment, amount: 12, sats: 12345, price: 100000, fee: 0, member: .rachel, writer: writer, onResult: complete)
        AppWriteSyncService.pushTransfer(id: "new-entry", date: .now, from: "river", to: "cold", sats: 5000, feeSats: 42, member: .victor, writer: writer, onResult: complete)
        AppWriteSyncService.pushAccount(key: "new-entry", label: "Savings", custody: .selfCustody, sats: 0, asOf: "2026-09-13T00:00:00.000Z", member: .victor, baseUpdatedAtMs: 987, writer: writer, onResult: complete)
        await fulfillment(of: [done], timeout: 2)
    }

    @MainActor
    func testEveryBitcoinDeleteSendsItsRevisionAndDeviceRoute() async {
        let previousEnabled = ConvexConfig.writesEnabled
        ConvexConfig.setWritesEnabled(true)
        defer { ConvexConfig.setWritesEnabled(previousEnabled) }
        let done = expectation(description: "four deletes accepted")
        done.expectedFulfillmentCount = 4
        let entities: [AppWriteSyncService.BitcoinEntity] = [.buy, .billPay, .transfer, .account]
        for entity in entities {
            AppWriteSyncService.deleteBitcoinEntry(entity, id: "entry", owner: .victor, baseUpdatedAtMs: 1234, writer: { path, _, id, args, deleting in
                XCTAssertEqual(path, "tables:delete\(entity.rawValue)FromDevice")
                XCTAssertTrue(deleting)
                XCTAssertEqual(id, "entry")
                XCTAssertEqual(args["baseUpdatedAtMs"] as? Double, 1234)
                XCTAssertEqual(args["entityId"] as? String, "entry")
            }) { result in
                XCTAssertEqual(result, .ok)
                done.fulfill()
            }
        }
        await fulfillment(of: [done], timeout: 2)
    }

    @MainActor
    func testTransactionDraftFailureLeavesOriginalRowAndDraftIntact() {
        let original = Transaction(id: "tx", date: .now, merchant: "Before", amount: 10, category: "Food", createdBy: "app", updatedAtMs: 1234)
        let draft = Transaction(id: "tx", date: original.date, merchant: "After", amount: 20, category: "Travel", createdBy: "app", updatedAtMs: 1234)
        var delivered: ConvexWriteResult?
        TransactionDetailWriteFlow.save(original, candidate: draft, writer: { _, complete in
            XCTAssertEqual(original.merchant, "Before")
            XCTAssertEqual(original.amount, 10)
            complete(.unauthorized)
        }) { delivered = $0 }
        XCTAssertEqual(delivered, .unauthorized)
        XCTAssertEqual(original.merchant, "Before")
        XCTAssertEqual(original.amount, 10)
        XCTAssertEqual(original.updatedAtMs, 1234)
        XCTAssertEqual(draft.merchant, "After")
        XCTAssertEqual(draft.amount, 20)
    }

    @MainActor
    func testTransactionDraftAppliesOnlyAfterAcceptedResult() {
        let original = Transaction(id: "tx", date: .now, merchant: "Before", amount: 10, category: "Food", createdBy: "app", updatedAtMs: 1234)
        let draft = Transaction(id: "tx", date: original.date, merchant: "After", amount: 20, category: "Travel", createdBy: "app", updatedAtMs: 1234)
        TransactionDetailWriteFlow.save(original, candidate: draft, writer: { candidate, complete in
            XCTAssertEqual(original.amount, 10)
            candidate.updatedAtMs = 5678
            complete(.ok)
        }) { XCTAssertEqual($0, .ok) }
        XCTAssertEqual(original.merchant, "After")
        XCTAssertEqual(original.amount, 20)
        XCTAssertEqual(original.updatedAtMs, 5678)
    }

    func testKnownCapabilityReceiptRefusesMissingGrantWithoutTreatingLegacyAsGranted() {
        XCTAssertFalse(AppWritebackConfig.allows("bitcoin:write", granted: ["todos:write"]))
        XCTAssertFalse(AppWritebackConfig.allows("transactions:write", granted: []))
        XCTAssertTrue(AppWritebackConfig.allows("bitcoin:write", granted: ["bitcoin:write"]))
        XCTAssertTrue(AppWritebackConfig.allows("bitcoin:write", granted: nil), "A legacy device must reach server authorization when its old receipt is unknown.")
    }

    @MainActor
    func testAccountKeyIsCanonicalAndGeneratedWithoutAVisibleIdentifierField() {
        let key = AddBitcoinAccountView.makeKey(label: "Cold Storage", owner: .rachel)
        XCTAssertTrue(key.hasPrefix("cold-storage-victor-"))
        XCTAssertEqual(key.suffix(6).count, 6)
        let asOf = AddBitcoinAccountView.defaultAsOf()
        XCTAssertTrue(asOf.hasSuffix("T00:00:00.000Z"))
    }

    func testMissingPairingOffersSetupInsteadOfUnauthorized() {
        XCTAssertEqual(ConvexWriteResult.classify(AppWritebackError.notConfigured), .notConfigured)
        XCTAssertEqual(ConvexWriteResult.notConfigured.userMessage(operation: "Task"), "Pair this device in Sync Setup before saving.")
    }

    @MainActor
    func testEveryBitcoinDeletionSelectsDeviceSourceForItsOwner() {
        XCTAssertEqual(AppWriteSyncService.BitcoinEntity.buy.sourceFile(owner: .rachel), "bitcoin-buys")
        XCTAssertEqual(AppWriteSyncService.BitcoinEntity.buy.sourceFile(owner: .mason), "mason-bitcoin-buys")
        XCTAssertEqual(AppWriteSyncService.BitcoinEntity.billPay.sourceFile(owner: .victor), "bitcoin-bill-pays")
        XCTAssertEqual(AppWriteSyncService.BitcoinEntity.transfer.sourceFile(owner: .mason), "btc-transfers")
        XCTAssertEqual(AppWriteSyncService.BitcoinEntity.account.sourceFile(owner: .rachel), "btc-balance-snapshot")
        XCTAssertEqual(AppWriteSyncService.BitcoinEntity.account.sourceFile(owner: .maddox), "son-balances")
    }
}
