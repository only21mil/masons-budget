import Foundation
import SwiftData
import XCTest

final class ConvexRowsTests: XCTestCase {
    func testProductionWireGoldensUseRequestSelectedFormatAndDecodeExactly() async throws {
        let deploymentURL = try XCTUnwrap(URL(string: "https://golden.invalid"))
        let client = ConvexClient(
            deploymentURL: deploymentURL,
            requestExecutor: { request in
                try ConvexWireGoldenReplay.response(for: request)
            },
        )

        let transactions: ConvexRowEnvelope<ConvexTransactionRow> = try await client.fetchRows(
            .transactions(viewer: .victor),
            as: ConvexRowEnvelope<ConvexTransactionRow>.self,
        )
        XCTAssertFalse(transactions.complete)
        XCTAssertEqual(transactions.rows.count, 3)
        XCTAssertEqual(transactions.rows[0].txId, "aven-20260801-ef20d6dc6ad5bce1e3569287")
        XCTAssertEqual(transactions.rows[0].amountCents, 2_366)

        let todos: ConvexRowEnvelope<ConvexTodoRow> = try await client.fetchRows(
            .todos(viewer: .victor),
            as: ConvexRowEnvelope<ConvexTodoRow>.self,
        )
        XCTAssertFalse(todos.complete)
        XCTAssertEqual(todos.rows.count, 3)
        XCTAssertEqual(todos.rows[0].todoId, "8A56A12C-DB12-4766-96BF-6E3AE7D1EFC9")
        XCTAssertEqual(todos.rows[0].priority, 0)

        let buys: ConvexRowEnvelope<ConvexBTCBuyRow> = try await client.fetchRows(
            .btcBuys(viewer: .victor, scope: .visible),
            as: ConvexRowEnvelope<ConvexBTCBuyRow>.self,
        )
        XCTAssertFalse(buys.complete)
        XCTAssertEqual(buys.rows.count, 3)
        XCTAssertEqual(buys.rows[0].buyId, "river-buy-by5ekey7i4")
        XCTAssertEqual(buys.rows[0].sats, 6_572_537)
        XCTAssertEqual(buys.rows[0].priceUsdCents, 6_414_981)
        XCTAssertEqual(buys.rows[0].usdCents, 425_843)
        XCTAssertNil(buys.rows[0].feeUsdCents)

        let billPays: ConvexRowEnvelope<ConvexBTCBillPayRow> = try await client.fetchRows(
            .btcBillPays(viewer: .victor, scope: .visible),
            as: ConvexRowEnvelope<ConvexBTCBillPayRow>.self,
        )
        XCTAssertFalse(billPays.complete)
        XCTAssertEqual(billPays.rows.count, 3)
        XCTAssertEqual(billPays.rows[0].billPayId, "river-billpay-qe3kbvq5qy")
        XCTAssertEqual(billPays.rows[0].amountUsdCents, 179_200)
        XCTAssertEqual(billPays.rows[0].btcSpentSats, 2_802_143)
        XCTAssertEqual(billPays.rows[0].btcPriceCents, 6_395_105)
        XCTAssertEqual(billPays.rows[0].feeUsdCents, 0)

        let accounts: ConvexRowEnvelope<ConvexBTCAccountRow> = try await client.fetchRows(
            .btcAccounts(viewer: .victor, scope: .visible),
            as: ConvexRowEnvelope<ConvexBTCAccountRow>.self,
        )
        XCTAssertFalse(accounts.complete)
        XCTAssertEqual(accounts.rows.count, 3)
        XCTAssertEqual(accounts.rows[0].key, "son-coldcard-mason")
        XCTAssertEqual(accounts.rows[0].owner, .mason)
        XCTAssertEqual(accounts.rows[0].sats, 76_406_392)

        let budget: ConvexBudgetDocumentEnvelope = try await client.fetchRows(
            .budget(viewer: .victor),
            as: ConvexBudgetDocumentEnvelope.self,
        )
        XCTAssertTrue(budget.complete)
        let budgetDocument = try XCTUnwrap(budget.document)
        XCTAssertEqual(budgetDocument.owner, .victor)
        XCTAssertEqual(budgetDocument.month, "August 2026")
        XCTAssertEqual(budgetDocument.coinbaseOneBalanceCents, 2_642)
        XCTAssertEqual(budgetDocument.categories.first?.name, "Bills & Utilities")
        XCTAssertEqual(budgetDocument.categories.first?.budgetCents, 620_000)
        XCTAssertEqual(budgetDocument.monthlyHistory.first?.month, "January 2026")
        XCTAssertEqual(budgetDocument.monthlyHistory.first?.savingsBps, 5_410)

        let counts = try await client.fetchRows(.rowCounts, as: ConvexRowCounts.self)
        XCTAssertEqual(
            counts,
            ConvexRowCounts(
                transactions: 993,
                todos: 9,
                btcBuys: 35,
                btcBillPays: 37,
                btcAccounts: 8,
            ),
        )
    }

    func testBudgetEnvelopeRetainsSyntheticNullDocumentHandling() throws {
        let envelope: ConvexBudgetDocumentEnvelope = try decodeTaggedJSON([
            "complete": true,
            "document": NSNull(),
        ])

        XCTAssertNil(envelope.document)
        XCTAssertThrowsError(try envelope.completeDocument()) { error in
            XCTAssertEqual(error as? ConvexRowDecodeError, .missingDocument)
        }
    }

    func testClosedCatalogueRequiresScopeAndReadTokenIsAttached() throws {
        let request = ConvexRowQuery.btcBalanceDocuments(viewer: .rachel, scope: .netWorth)
        XCTAssertEqual(request.path, "tables:listBtcBalanceDocuments")
        XCTAssertEqual(request.arguments["viewer"] as? String, "rachel")
        XCTAssertEqual(request.arguments["scope"] as? String, "netWorth")

        let authenticated = ConvexClient.authenticatedArguments(
            endpoint: "api/query",
            args: request.arguments,
            syncToken: "unused-write-token",
            readToken: "test-read-token",
        )
        XCTAssertEqual(authenticated["token"] as? String, "test-read-token")
        XCTAssertNil(
            ConvexClient.authenticatedArguments(
                endpoint: "api/query",
                args: request.arguments,
                syncToken: "",
                readToken: "",
            )["token"],
        )
    }

    func testIncomeQueryUsesDedicatedCanonicalLedgerPath() {
        let allIncome = ConvexRowQuery.income(viewer: .rachel, month: nil)
        XCTAssertEqual(allIncome.path, "tables:listIncome")
        XCTAssertEqual(allIncome.arguments["viewer"] as? String, "rachel")
        XCTAssertNil(allIncome.arguments["month"])

        let july = ConvexRowQuery.income(viewer: .rachel, month: "2026-07")
        XCTAssertEqual(july.arguments["month"] as? String, "2026-07")
    }

    func testSignedTransactionMoneyAndOwnersArePreservedWithoutDouble() throws {
        let envelope: ConvexRowEnvelope<ConvexTransactionRow> = try decodeTaggedJSON([
            "complete": true,
            "rows": [
                transactionRow(owner: "victor", amount: "x8////////8="),
                transactionRow(owner: "mason", amount: "OTAAAAAAAAA="),
            ],
        ])
        let rows = try envelope.completeRows()
        let adult = try rows[0].legacyDTO()
        let child = try rows[1].legacyDTO()

        XCTAssertEqual(adult.amount, Decimal(string: "-123.45")!)
        XCTAssertEqual(adult.owner, .victor)
        XCTAssertEqual(child.amount, Decimal(string: "123.45")!)
        XCTAssertEqual(child.owner, .mason)
    }

    func testBitcoinAccountKeySurvivesTransactionProjection() throws {
        var row = transactionRow(owner: "victor", amount: "OTAAAAAAAAA=")
        row["card"] = "zeus_lightning"
        row["amountSats"] = int64("QOIBAAAAAAA=")
        row["bitcoinAccountKey"] = "zeus-mobile"

        let envelope: ConvexRowEnvelope<ConvexTransactionRow> = try decodeTaggedJSON([
            "complete": true,
            "rows": [row],
        ])
        let transaction = try XCTUnwrap(envelope.completeRows().first?.legacyDTO())

        XCTAssertEqual(transaction.card, "zeus_lightning")
        XCTAssertEqual(transaction.bitcoinAccountKey, "zeus-mobile")
        XCTAssertEqual(transaction.amountSats, 123_456)
    }

    func testFiatRowDecodesWithNilBitcoinAccountKey() throws {
        var row = transactionRow(owner: "victor", amount: "OTAAAAAAAAA=")
        row["card"] = "sofi_card"

        let envelope: ConvexRowEnvelope<ConvexTransactionRow> = try decodeTaggedJSON([
            "complete": true,
            "rows": [row],
        ])
        let transaction = try XCTUnwrap(envelope.completeRows().first?.legacyDTO())

        XCTAssertEqual(transaction.card, "sofi_card")
        XCTAssertNil(transaction.bitcoinAccountKey)
    }

    func testSatIncomeAndRevisionArePreservedThroughTransactionProjection() throws {
        var row = transactionRow(owner: "victor", amount: "KCMAAAAAAAA=")
        row["category"] = "Income"
        row["amountSats"] = int64("QOIBAAAAAAA=")
        row["updatedAtMs"] = 1_777_777_777_777

        let envelope: ConvexRowEnvelope<ConvexTransactionRow> = try decodeTaggedJSON([
            "complete": true,
            "rows": [row],
        ])
        let transaction = try XCTUnwrap(envelope.completeRows().first?.legacyDTO())

        XCTAssertEqual(transaction.amountSats, 123_456)
        XCTAssertEqual(transaction.updatedAtMs, 1_777_777_777_777)
    }

    func testUnexpectedResponseFieldsAreIgnoredButKnownFieldsStayValidated() throws {
        var row = transactionRow(owner: "victor", amount: "OTAAAAAAAAA=")
        row["spendAmount"] = int64("x8////////8=")
        row["displaySpendAmount"] = int64("OTAAAAAAAAA=")
        row["hasOppositeSpendSign"] = true
        row["futureTransactionField"] = ["nested": true]

        let envelope: ConvexRowEnvelope<ConvexTransactionRow> = try decodeTaggedJSON([
            "complete": true,
            "rows": [row],
            "futureEnvelopeField": "ignored",
        ])

        // The server's rendering projection must not replace the signed source
        // amount used by Transaction's spend semantics.
        let transaction = try XCTUnwrap(envelope.completeRows().first?.legacyDTO())
        XCTAssertEqual(transaction.amount, Decimal(string: "123.45")!)

        row["amountCents"] = "not-an-int64"
        XCTAssertThrowsError(
            try decodeTaggedJSON([
                "complete": true,
                "rows": [row],
            ]) as ConvexRowEnvelope<ConvexTransactionRow>,
        )
    }

    func testBothInt64LimitsRemainExactThroughTypedMoneyRows() throws {
        let maximum: ConvexRowEnvelope<ConvexTransactionRow> = try decodeTaggedJSON([
            "complete": true,
            "rows": [transactionRow(owner: "victor", amount: "/////////38=")],
        ])
        let minimum: ConvexRowEnvelope<ConvexTransactionRow> = try decodeTaggedJSON([
            "complete": true,
            "rows": [transactionRow(owner: "mason", amount: "AAAAAAAAAIA=")],
        ])

        let maxAmount = try maximum.completeRows()[0].legacyDTO().amount
        let minAmount = try minimum.completeRows()[0].legacyDTO().amount
        XCTAssertEqual(maxAmount, Decimal(string: "92233720368547758.07")!)
        XCTAssertEqual(minAmount, Decimal(string: "-92233720368547758.08")!)
    }

    func testValueBeyondJavaScriptSafeIntegerRemainsExactInBudgetCategory() throws {
        let envelope: ConvexBudgetDocumentEnvelope = try decodeTaggedJSON([
            "complete": true,
            "document": [
                "owner": "victor",
                "month": "2026-07",
                "coinbaseOneBalanceCents": int64("AAAAAAAAAAA="),
                "categories": [[
                    "name": "Precision",
                    "budgetCents": int64("AQAAAAAAIAA="),
                ]],
                "mtdIncomeCents": int64("AAAAAAAAAAA="),
                "ytdIncomeCents": int64("AAAAAAAAAAA="),
                "monthlyHistory": [],
                "updatedAtMs": 1_777_777_777_777,
            ],
        ])

        let document = try envelope.completeDocument()
        let budget = document.adultBudgetDTO()
        XCTAssertEqual(
            budget.categories[0].budget,
            Decimal(string: "90071992547409.93")!,
        )
        XCTAssertNil(budget.categories[0].spent, "Row budget spend must remain transaction-derived.")
        let intent = try document.categoryDeletionIntent(
            viewer: .rachel,
            trustedCurrentMonth: "2026-07",
            categoryName: "Precision",
        )
        XCTAssertEqual(intent.owner, .victor)
        XCTAssertEqual(intent.source, "budget")
        XCTAssertEqual(intent.baseUpdatedAtMs, 1_777_777_777_777)
    }

    func testUnknownOwnerAndIncompleteSnapshotAreRejected() throws {
        XCTAssertThrowsError(
            try decodeTaggedJSON([
                "complete": true,
                "rows": [transactionRow(owner: "unknown", amount: "AAAAAAAAAAA=")],
            ]) as ConvexRowEnvelope<ConvexTransactionRow>,
        )

        let incomplete: ConvexRowEnvelope<ConvexTransactionRow> = try decodeTaggedJSON([
            "complete": false,
            "rows": [],
        ])
        XCTAssertThrowsError(try incomplete.completeRows()) { error in
            XCTAssertEqual(error as? ConvexRowDecodeError, .incompleteSnapshot)
        }
    }

    func testOnlyAbsentRowAPIErrorsPermitBlobFallback() {
        XCTAssertTrue(
            ConvexError.rowAPIUnavailable(path: "tables:listTransactions").isRowAPIUnavailable,
        )
        XCTAssertTrue(
            ConvexClient.isMissingRowAPIDiagnostic(
                "Could not find public function for 'tables:listTransactions'",
            ),
        )
        XCTAssertTrue(
            ConvexClient.isMissingRowAPIDiagnostic("Table todos does not exist"),
        )
        XCTAssertFalse(
            ConvexError.unauthorized(path: "tables:listTransactions").isRowAPIUnavailable,
        )
        XCTAssertFalse(
            ConvexError.decodeFailed(
                "tables:listTransactions",
                ConvexTaggedInt64Decoder.DecodeError.malformedPayload,
            ).isRowAPIUnavailable,
        )
    }

    func testDateMonthMismatchIsRejectedRatherThanCorrected() throws {
        let envelope: ConvexRowEnvelope<ConvexTransactionRow> = try decodeTaggedJSON([
            "complete": true,
            "rows": [[
                "txId": "bad-month",
                "owner": "victor",
                "date": "2026-07-01",
                "month": "2026-06",
                "merchant": "Test",
                "amountCents": int64("AQAAAAAAAAA="),
                "category": "Other",
                "updatedAtMs": 1,
            ]],
        ])
        XCTAssertThrowsError(try envelope.completeRows()[0].legacyDTO()) { error in
            XCTAssertEqual(error as? ConvexRowDecodeError, .inconsistentMonth)
        }
    }

    func testPreFeeBillPayRowDecodesWithLegacyCreditCardPaymentDefaults() throws {
        let envelope: ConvexRowEnvelope<ConvexBTCBillPayRow> = try decodeTaggedJSON([
            "complete": true,
            "rows": [[
                "billPayId": "legacy-bill-pay",
                "owner": "victor",
                "date": "2026-08-25",
                "month": "2026-08",
                "merchant": "Card",
                "category": "Legacy category",
                "amountUsdCents": int64(value: 10_000),
                "btcSpentSats": int64(value: 100_000),
                "btcPriceCents": int64(value: 10_000_000),
                "updatedAtMs": 1_777_777_777_777,
            ]],
        ])
        let dto = try XCTUnwrap(envelope.completeRows().first).legacyDTO()
        let model = try LedgerMapper.mapBTCBillPay(dto)

        XCTAssertNil(dto.feeUsd)
        XCTAssertNil(dto.budgetEffect)
        XCTAssertEqual(model.effectiveFeeUSD, 0)
        XCTAssertEqual(try model.validatedBudgetEffect(), .creditCardPayment)
        XCTAssertEqual(model.updatedAtMs, 1_777_777_777_777)
    }

    func testTodoRowReaderRejectsCrossProfileRowsFromTheServer() async throws {
        let victorReader = try todoReader(serverRows: [[
            "todoId": "victor-private",
            "owner": "victor",
            "title": "Victor private",
            "done": false,
            "flagged": false,
            "updatedAtMs": 1_777_777_777_777,
        ]])
        let victorTodos = try await victorReader.todos(viewer: .victor)
        XCTAssertEqual(victorTodos.map(\.id), ["victor-private"])
        XCTAssertEqual(victorTodos.first?.updatedAtMs, 1_777_777_777_777)
        let cached = LedgerMapper.mapTodos(victorTodos, viewer: .victor)
        XCTAssertEqual(cached.first?.updatedAtMs, 1_777_777_777_777)
        XCTAssertTrue(cached.first?.hasServerAuthority == true)

        let crossProfileReader = try todoReader(serverRows: [[
            "todoId": "rachel-private",
            "owner": "rachel",
            "title": "Rachel private",
            "done": false,
            "flagged": false,
            "updatedAtMs": 1_777_777_777_778,
        ]])
        do {
            _ = try await crossProfileReader.todos(viewer: .victor)
            XCTFail("Cross-profile server todo was accepted")
        } catch {
            XCTAssertEqual(error as? ConvexRowDecodeError, .ownerOutOfScope)
        }
    }

    @MainActor
    func testCompleteRowOwnerScopeReconcilesOnlyTheExactTodoOwner() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: TodoItem.self, configurations: configuration)
        let context = ModelContext(container)
        let service = ConvexSyncService(context: context)
        context.insert(TodoItem(
            id: "stale-victor",
            title: "Stale Victor",
            owner: .victor,
            createdBy: "mc2",
        ))
        context.insert(TodoItem(
            id: "stale-rachel",
            title: "Stale Rachel",
            owner: .rachel,
            createdBy: "app",
        ))
        try context.save()

        try service.replaceTodos(
            visibleTo: .victor,
            with: [],
            replacementOwners: Set(FamilyMember.allCases),
        )
        try context.save()

        let remaining = try context.fetch(FetchDescriptor<TodoItem>())
        XCTAssertEqual(remaining.map(\.id), ["stale-rachel"])
        XCTAssertEqual(remaining.first?.createdBy, "app")
    }

    @MainActor
    func testTodoRefreshInstallsAuthorityOnAnOfflineAppCreateWithoutReplacingItsContent() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: TodoItem.self, configurations: configuration)
        let context = ModelContext(container)
        let service = ConvexSyncService(context: context)
        let local = TodoItem(
            id: "offline-create",
            title: "Local optimistic title",
            owner: .mason,
            createdBy: "app",
            hasServerAuthority: false,
        )
        context.insert(local)
        try context.save()

        let remote = TodoItem(
            id: local.id,
            title: "Server projection",
            owner: .mason,
            createdBy: "mc2",
            updatedAtMs: 1_888_888_888_888,
            hasServerAuthority: true,
        )
        try service.replaceTodos(
            visibleTo: .mason,
            with: [remote],
            replacementOwners: [.mason],
        )

        XCTAssertEqual(local.title, "Local optimistic title")
        XCTAssertEqual(local.updatedAtMs, 1_888_888_888_888)
        XCTAssertTrue(local.hasServerAuthority)
        XCTAssertEqual(local.createdBy, "app")
    }

    @MainActor
    func testTodoReplacementRejectsCrossOwnerRows() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: TodoItem.self, configurations: configuration)
        let service = ConvexSyncService(context: ModelContext(container))
        let rachelTodo = TodoItem(id: "rachel", title: "Private", owner: .rachel)

        XCTAssertThrowsError(
            try service.replaceTodos(visibleTo: .victor, with: [rachelTodo]),
        ) { error in
            XCTAssertEqual(error as? ConvexRowDecodeError, .ownerOutOfScope)
        }
    }

    func testCanonicalBTCUsesOneDocumentTotalWithoutSummingAccounts() throws {
        let document = ConvexBTCBalanceDocumentRow(
            owner: .victor,
            schemaVersion: 1,
            asOf: "2026-07-16T00:00:00Z",
            accounts: [
                .init(
                    key: "coldcard",
                    label: "Multisig",
                    custody: .selfCustody,
                    sats: 100_000_000,
                    fiatCents: 1,
                ),
                .init(
                    key: "river",
                    label: "River",
                    custody: .exchange,
                    sats: 200_000_000,
                    fiatCents: 2,
                ),
            ],
            totals: .init(
                sats: 541_782_856,
                fiatCents: 35_000_000,
                exchangeSats: 141_782_856,
                selfCustodySats: 400_000_000,
            ),
            source: "btc-balance-snapshot",
            basis: "authoritative",
            confidence: "verified",
        )

        let balance = try XCTUnwrap(
            CanonicalFinancialProjection.btcBalance(documents: [document]).value,
        )
        XCTAssertEqual(balance.totalSats, 541_782_856)
        XCTAssertEqual(balance.exchangeSats, 141_782_856)
        XCTAssertEqual(balance.selfCustodySats, 400_000_000)
        XCTAssertNotEqual(
            balance.totalSats,
            document.accounts.reduce(Int64(0)) { $0 + $1.sats },
            "The authoritative document total must not be recomputed from another projection.",
        )
    }

    func testCanonicalBTCDecodesUnavailableFiatWithoutFabricatingZero() throws {
        let document: ConvexBTCBalanceDocumentRow = try decodeTaggedJSON([
            "owner": "victor",
            "schemaVersion": int64(value: 2),
            "asOf": "2026-08-01T00:00:00Z",
            "accounts": [[
                "key": "river",
                "label": "River",
                "custody": "exchange",
                "sats": int64(value: 7_426_251),
            ]],
            "totals": [
                "sats": int64(value: 7_426_251),
                "exchangeSats": int64(value: 7_426_251),
                "selfCustodySats": int64(value: 0),
            ],
        ])

        let balance = try XCTUnwrap(
            CanonicalFinancialProjection.btcBalance(documents: [document]).value,
        )
        XCTAssertEqual(balance.totalSats, 7_426_251)
        XCTAssertNil(balance.totalFiatCents)
        XCTAssertNil(balance.accounts.first?.fiatCents)
    }

    func testEmptyAndAmbiguousRequiredBTCSourceNeverBecomeZero() throws {
        XCTAssertNil(try CanonicalFinancialProjection.btcBalance(documents: []).value)

        let document = ConvexBTCBalanceDocumentRow(
            owner: .victor,
            schemaVersion: 1,
            asOf: "2026-07-16",
            accounts: [],
            totals: .init(
                sats: 0,
                fiatCents: 0,
                exchangeSats: 0,
                selfCustodySats: 0,
            ),
            source: nil,
            basis: nil,
            confidence: nil,
        )
        XCTAssertThrowsError(
            try CanonicalFinancialProjection.btcBalance(documents: [document, document]),
        ) { error in
            XCTAssertEqual(error as? ConvexRowDecodeError, .ambiguousDocument)
        }
    }

    func testServerShapedIncomeRowDecodesThroughTheRealEnvelope() throws {
        // The wire shape from tables:projectIncome exactly: ten keys, no
        // sourceKey (the server strips it and pins the absence in its own
        // tests). Decoding through the real ConvexRowEnvelope path is what
        // catches a required field the server never sends — the in-memory
        // constructor tests cannot see that class of bug.
        let envelope: ConvexRowEnvelope<ConvexIncomeRow> = try decodeTaggedJSON([
            "complete": true,
            "rows": [[
                "incomeId": "income-1",
                "owner": "victor",
                "date": "2026-07-01",
                "month": "2026-07",
                "amountCents": int64("QOIBAAAAAAA="),
                "source": "River",
                "loggedBy": nil,
                "note": nil,
                "archimedesRequestId": nil,
                "updatedAtMs": 1_777_777_777_777,
            ]],
        ])
        let row = try XCTUnwrap(envelope.completeRows().first)

        XCTAssertEqual(row.incomeId, "income-1")
        XCTAssertEqual(row.amountCents, 123_456)
        XCTAssertEqual(row.source, "River")
    }

    func testDedicatedIncomeRowsAreTheOnlyIncomeProjection() throws {
        let rows = [
            ConvexIncomeRow(
                incomeId: "income-1",
                owner: .victor,
                date: "2026-07-01",
                month: "2026-07",
                amountCents: 2_500_550,
                source: "River",
                loggedBy: nil,
                note: nil,
                archimedesRequestId: nil,
            ),
            ConvexIncomeRow(
                incomeId: "income-2",
                owner: .victor,
                date: "2026-07-15",
                month: "2026-07",
                amountCents: 988_797,
                source: "Strike",
                loggedBy: nil,
                note: nil,
                archimedesRequestId: nil,
            ),
        ]

        let summary = try XCTUnwrap(
            CanonicalFinancialProjection.income(rows: rows, complete: true).value,
        )
        XCTAssertEqual(summary.cents(forMonth: "2026-07"), 3_489_347)
        XCTAssertEqual(summary.cents(forYear: 2026), 3_489_347)
        XCTAssertNil(
            try CanonicalFinancialProjection.income(rows: [], complete: true).value,
            "An empty required income source is unavailable, not a zero-dollar month.",
        )
    }

    func testBTCBillPaysStayASeparateRequiredLedger() throws {
        let rows = (0 ..< 31).map { index in
            ConvexBTCBillPayRow(
                billPayId: "bp-\(index)",
                owner: .victor,
                date: "2026-07-01",
                month: "2026-07",
                merchant: "Mortgage",
                category: "Housing",
                amountUsdCents: index == 0 ? 2_563_375 : 1,
                btcSpentSats: 1,
                btcPriceCents: 6_578_947,
                platform: "River",
                note: nil,
                feeUsdCents: 0,
                budgetEffect: .budgetCategory,
                reference: nil,
                updatedAtMs: 1,
            )
        }
        let ledger = try XCTUnwrap(CanonicalFinancialProjection.btcBillPays(rows: rows).value)
        XCTAssertEqual(ledger.count, 31)
        XCTAssertEqual(ledger.totalUSDCents, 2_563_405)
        XCTAssertEqual(ledger.totalSpentSats, 31)
        XCTAssertNil(CanonicalFinancialProjection.btcBillPays(rows: []).value)
    }

    private func transactionRow(owner: String, amount: String) -> [String: Any] {
        [
            "txId": "\(owner)-tx",
            "owner": owner,
            "date": "2026-07-01",
            "month": "2026-07",
            "merchant": "Test",
            "amountCents": int64(amount),
            "category": "Other",
            "updatedAtMs": 1,
        ]
    }

    private func todoReader(serverRows: [[String: Any]]) throws -> ConvexRowReader {
        let envelope: [String: Any] = [
            "status": "success",
            "value": [
                "complete": true,
                "rows": serverRows,
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: envelope)
        let client = ConvexClient(
            deploymentURL: URL(string: "https://todo-privacy.invalid")!,
            requestExecutor: { request in
                guard let url = request.url,
                      let response = HTTPURLResponse(
                          url: url,
                          statusCode: 200,
                          httpVersion: "HTTP/1.1",
                          headerFields: ["Content-Type": "application/json"],
                      )
                else { throw URLError(.badServerResponse) }
                return (data, response)
            },
        )
        return ConvexRowReader(client: client)
    }

    /// Takes an already-encoded Convex payload: base64 of eight little-endian
    /// bytes. Most fixtures are written that way deliberately, to pin the exact
    /// wire bytes rather than trusting the encoder.
    private func int64(_ payload: String) -> [String: String] {
        ["$integer": payload]
    }

    /// Encodes a numeric value into the same tagged form. Use this when the test
    /// cares about the quantity rather than the exact bytes — writing a decimal
    /// string into `int64(_:)` produces a payload the real decoder rejects.
    private func int64(value: Int64) -> [String: String] {
        ConvexTaggedInt64Encoder.encode(value)
    }

    private func decodeTaggedJSON<T: Decodable>(_ object: Any) throws -> T {
        let decoded = try ConvexTaggedInt64Decoder.decode(object)
        let data = try JSONSerialization.data(withJSONObject: decoded)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

/// Credential-free transport replay for the shipped request and decode boundary.
///
/// The response filename is chosen from the request's actual `format` value. A
/// production change from `convex_encoded_json` to `json` therefore replays the
/// real decimal-string capture and fails typed `Int64` decoding.
private enum ConvexWireGoldenReplay {
    private static let queryNames = [
        "tables:rowCounts": "rowCounts",
        "tables:listTransactions": "listTransactions",
        "tables:listTodos": "listTodos",
        "tables:listBtcBuys": "listBtcBuys",
        "tables:listBtcAccounts": "listBtcAccounts",
        "tables:listBtcBillPays": "listBtcBillPays",
        "tables:getBudgetDocument": "getBudgetDocument",
    ]

    static func response(for request: URLRequest) throws -> (Data, URLResponse) {
        let bundle = Bundle(for: ConvexRowsTests.self)
        let jsonResources = jsonResources(in: bundle)
        var context = ReplayContext(
            requestURL: request.url?.absoluteString ?? "<missing>",
            bodyByteCount: request.httpBody?.count,
            hasBodyStream: request.httpBodyStream != nil,
            path: nil,
            format: nil,
            queryName: nil,
            filename: nil,
            bundlePath: bundle.bundleURL.path,
            jsonResourceNames: jsonResources.map(\.lastPathComponent),
        )

        guard let body = request.httpBody else {
            try fail("Golden request has no readable JSON body.", context: context)
        }

        let object: [String: Any]
        do {
            guard let decoded = try JSONSerialization.jsonObject(with: body) as? [String: Any] else {
                try fail("Golden request body is not a JSON object.", context: context)
            }
            object = decoded
        } catch let error as ReplayError {
            throw error
        } catch {
            try fail("Golden request body is invalid JSON: \(error).", context: context)
        }

        context.path = object["path"] as? String
        context.format = object["format"] as? String
        guard let path = context.path, let format = context.format else {
            try fail("Golden request body must contain string path and format values.", context: context)
        }

        context.queryName = queryNames[path]
        guard let queryName = context.queryName else {
            try fail("No golden capture is mapped for the request path.", context: context)
        }

        context.filename = "\(queryName).\(format).json"
        guard let filename = context.filename,
              let fixtureURL = jsonResources.first(where: { $0.lastPathComponent == filename })
        else {
            try fail("The request-selected golden fixture is absent from the test bundle.", context: context)
        }

        let data: Data
        do {
            data = try Data(contentsOf: fixtureURL)
        } catch {
            try fail("The request-selected golden fixture could not be read: \(error).", context: context)
        }

        guard let requestURL = request.url,
              let response = HTTPURLResponse(
                  url: requestURL,
                  statusCode: 200,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json"],
              )
        else {
            try fail("Golden request has no valid URL.", context: context)
        }
        return (data, response)
    }

    private static func jsonResources(in bundle: Bundle) -> [URL] {
        guard let enumerator = FileManager.default.enumerator(
            at: bundle.bundleURL,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles],
        ) else {
            return []
        }
        return enumerator.compactMap { $0 as? URL }
            .filter { $0.pathExtension == "json" }
            .sorted { $0.path < $1.path }
    }

    private static func fail(_ reason: String, context: ReplayContext) throws -> Never {
        let message = """
        Convex wire-golden replay failed: \(reason)
        requestURL=\(context.requestURL)
        httpBodyBytes=\(context.bodyByteCount.map { String($0) } ?? "<missing>")
        httpBodyStreamPresent=\(context.hasBodyStream)
        path=\(context.path ?? "<missing>")
        format=\(context.format ?? "<missing>")
        queryName=\(context.queryName ?? "<unresolved>")
        filename=\(context.filename ?? "<unresolved>")
        bundle=\(context.bundlePath)
        jsonResources=\(context.jsonResourceNames)
        """
        print(message)
        XCTFail(message)
        throw ReplayError.invalidRequest(message)
    }

    private struct ReplayContext {
        let requestURL: String
        let bodyByteCount: Int?
        let hasBodyStream: Bool
        var path: String?
        var format: String?
        var queryName: String?
        var filename: String?
        let bundlePath: String
        let jsonResourceNames: [String]
    }

    private enum ReplayError: LocalizedError {
        case invalidRequest(String)

        var errorDescription: String? {
            switch self {
            case let .invalidRequest(message): message
            }
        }
    }
}
