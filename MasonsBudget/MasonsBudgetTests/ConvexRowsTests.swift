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
        XCTAssertEqual(transactions.rows[0].txId, "t1784233824245")
        XCTAssertEqual(transactions.rows[0].amountCents, 27_918)

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
        XCTAssertEqual(buys.rows[0].buyId, "b1784166358832")
        XCTAssertEqual(buys.rows[0].sats, 148_033)
        XCTAssertEqual(buys.rows[0].priceUsdCents, 6_563_401)
        XCTAssertEqual(buys.rows[0].usdCents, 9_813)

        let billPays: ConvexRowEnvelope<ConvexBTCBillPayRow> = try await client.fetchRows(
            .btcBillPays(viewer: .victor, scope: .visible),
            as: ConvexRowEnvelope<ConvexBTCBillPayRow>.self,
        )
        XCTAssertFalse(billPays.complete)
        XCTAssertEqual(billPays.rows.count, 3)
        XCTAssertEqual(billPays.rows[0].billPayId, "bp030")
        XCTAssertEqual(billPays.rows[0].amountUsdCents, 30_673)
        XCTAssertEqual(billPays.rows[0].btcSpentSats, 481_122)
        XCTAssertEqual(billPays.rows[0].btcPriceCents, 6_375_306)
        XCTAssertEqual(billPays.rows[0].feeUsdCents, 0)

        let accounts: ConvexRowEnvelope<ConvexBTCAccountRow> = try await client.fetchRows(
            .btcAccounts(viewer: .victor, scope: .visible),
            as: ConvexRowEnvelope<ConvexBTCAccountRow>.self,
        )
        XCTAssertFalse(accounts.complete)
        XCTAssertTrue(accounts.rows.isEmpty)

        let budget: ConvexBudgetDocumentEnvelope = try await client.fetchRows(
            .budget(viewer: .victor),
            as: ConvexBudgetDocumentEnvelope.self,
        )
        XCTAssertTrue(budget.complete)
        XCTAssertNil(budget.document)

        let counts = try await client.fetchRows(.rowCounts, as: ConvexRowCounts.self)
        XCTAssertEqual(
            counts,
            ConvexRowCounts(
                transactions: 911,
                todos: 25,
                btcBuys: 33,
                btcBillPays: 31,
                btcAccounts: 0,
            ),
        )
    }

    func testClosedCatalogueRequiresScopeAndReadTokenIsAttached() throws {
        let request = ConvexRowQuery.btcAccounts(viewer: .rachel, scope: .netWorth)
        XCTAssertEqual(request.path, "tables:listBtcAccounts")
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
            ],
        ])

        let budget = try envelope.completeDocument().adultBudgetDTO()
        XCTAssertEqual(
            budget.categories[0].budget,
            Decimal(string: "90071992547409.93")!,
        )
        XCTAssertNil(budget.categories[0].spent, "Row budget spend must remain transaction-derived.")
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

    @MainActor
    func testCompleteRowOwnerScopeReconcilesAnOwnerWithZeroTodos() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: TodoItem.self, configurations: configuration)
        let context = ModelContext(container)
        let service = MC2SyncService(context: context)
        context.insert(TodoItem(
            id: "stale-rachel",
            title: "Stale",
            owner: .rachel,
            createdBy: "mc2",
        ))
        try context.save()

        service.replaceTodos(
            visibleTo: .victor,
            with: [],
            replacementOwners: Set(FamilyMember.allCases),
        )
        try context.save()

        XCTAssertTrue(try context.fetch(FetchDescriptor<TodoItem>()).isEmpty)
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

    private func int64(_ payload: String) -> [String: String] {
        ["$integer": payload]
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
