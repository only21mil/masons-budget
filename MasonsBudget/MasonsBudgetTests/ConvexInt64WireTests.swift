import Foundation
import XCTest

final class ConvexInt64WireTests: XCTestCase {
    func testCanonicalConvexVectorsDecodeExactly() throws {
        let vectors: [(encoded: String, expected: Int64)] = [
            ("AAAAAAAAAAA=", 0),
            ("AQAAAAAAAAA=", 1),
            ("//////////8=", -1),
            ("/////////38=", .max),
            ("AAAAAAAAAIA=", .min),
        ]

        for vector in vectors {
            XCTAssertEqual(
                try ConvexTaggedInt64Decoder.decodePayload(vector.encoded),
                vector.expected,
                "Failed canonical Convex vector \(vector.encoded)",
            )
        }
    }

    func testCompleteSharedConvexFixture() throws {
        let bundle = Bundle(for: ConvexInt64WireTests.self)
        let url = try XCTUnwrap(
            bundle.url(forResource: "convex-int64-wire-cases", withExtension: "json")
            ?? bundle.url(
                forResource: "convex-int64-wire-cases",
                withExtension: "json",
                subdirectory: "fixtures",
            ),
            "The shared Convex int64 fixture must be bundled into the Swift test target.",
        )

        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
        )
        let valid = try XCTUnwrap(root["valid"] as? [[String: Any]])
        let invalid = try XCTUnwrap(root["invalid"] as? [[String: Any]])

        XCTAssertEqual(valid.count, 9, "The shared fixture must retain every canonical Int64 vector.")
        XCTAssertEqual(invalid.count, 15, "The shared fixture must retain every malformed Int64 vector.")

        for testCase in valid {
            let name = try XCTUnwrap(testCase["name"] as? String)
            let decimal = try XCTUnwrap(testCase["decimal"] as? String)
            let expected = try XCTUnwrap(Int64(decimal))
            let wire = try XCTUnwrap(testCase["wire"])
            XCTAssertEqual(
                try ConvexTaggedInt64Decoder.decodeTaggedValue(wire),
                expected,
                "Failed shared Convex vector: \(name)",
            )
        }

        for testCase in invalid {
            let name = try XCTUnwrap(testCase["name"] as? String)
            let wire = try XCTUnwrap(testCase["wire"])
            XCTAssertThrowsError(
                try ConvexTaggedInt64Decoder.decodeTaggedValue(wire),
                "Accepted malformed shared Convex vector: \(name)",
            )
        }
    }

    func testExactCentsAndSatoshisNeverPassThroughDouble() throws {
        let wire: [String: Any] = [
            "amountCents": ["$integer": "AQAAAAAAIAA="],
            "sats": ["$integer": "AEAHWvB1BwA="],
        ]

        let decoded = try XCTUnwrap(try ConvexTaggedInt64Decoder.decode(wire) as? [String: Any])
        let cents = try XCTUnwrap(decoded["amountCents"] as? Int64)
        let sats = try XCTUnwrap(decoded["sats"] as? Int64)

        XCTAssertEqual(cents, 9_007_199_254_740_993)
        XCTAssertEqual(sats, 2_100_000_000_000_000)
        XCTAssertFalse(decoded["amountCents"] is Double)
        XCTAssertFalse(decoded["sats"] is Double)
    }

    func testDecodedValuesRoundTripIntoTypedRowsWithoutLosingPrecision() throws {
        let wire: [String: Any] = [
            "amountCents": ["$integer": "AQAAAAAAIAA="],
            "sats": ["$integer": "AEAHWvB1BwA="],
        ]

        let decoded = try ConvexTaggedInt64Decoder.decode(wire)
        let data = try JSONSerialization.data(withJSONObject: decoded)
        let row = try JSONDecoder().decode(Int64Row.self, from: data)

        XCTAssertEqual(row.amountCents, 9_007_199_254_740_993)
        XCTAssertEqual(row.sats, 2_100_000_000_000_000)
    }

    func testJSONFormatDecimalStringsFailTypedInt64Decoding() throws {
        let jsonFormatWire: [String: Any] = [
            "amountCents": "2500",
            "sats": "100000",
        ]

        let passedThrough = try ConvexTaggedInt64Decoder.decode(jsonFormatWire)
        let data = try JSONSerialization.data(withJSONObject: passedThrough)

        XCTAssertThrowsError(try JSONDecoder().decode(Int64Row.self, from: data)) { error in
            guard let decodingError = error as? DecodingError else {
                return XCTFail("Expected an Int64 type mismatch, received \(error)")
            }
            guard case .typeMismatch = decodingError else {
                return XCTFail("Expected an Int64 type mismatch, received \(error)")
            }
        }
    }

    func testDecoderRecursesWithoutChangingOrdinaryBlobValues() throws {
        let wire: [String: Any] = [
            "rows": [
                ["amountCents": ["$integer": "QOIBAAAAAAA="], "merchant": "Test"],
            ],
            "legacy": ["amount": 12.5, "enabled": true],
        ]

        let decoded = try XCTUnwrap(try ConvexTaggedInt64Decoder.decode(wire) as? [String: Any])
        let rows = try XCTUnwrap(decoded["rows"] as? [[String: Any]])
        XCTAssertEqual(rows.first?["amountCents"] as? Int64, 123_456)
        XCTAssertEqual(rows.first?["merchant"] as? String, "Test")

        let legacy = try XCTUnwrap(decoded["legacy"] as? [String: Any])
        XCTAssertEqual(legacy["amount"] as? Double, 12.5)
        XCTAssertEqual(legacy["enabled"] as? Bool, true)
    }

    func testStrictTaggedDecoderRejectsNonTagsAndMalformedShapes() {
        let malformed: [Any] = [
            NSNull(),
            1,
            "1",
            [Any](),
            [String: Any](),
            ["$int64": "AQAAAAAAAAA="],
            ["$integer": "AAAAAAAAAAA=", "extra": true],
            ["$integer": 0],
            ["$integer": NSNull()],
        ]

        for value in malformed {
            XCTAssertThrowsError(try ConvexTaggedInt64Decoder.decodeTaggedValue(value)) { error in
                XCTAssertEqual(error as? ConvexTaggedInt64Decoder.DecodeError, .malformedTag)
            }
        }
    }

    func testMalformedPayloadsAreRejected() {
        let malformed = [
            "",
            "not-base64",
            "__________8=",
            "AAAAAAAAAA!=",
            "AAAA",
            "AAAAAAAAAAA",
            "AAAAAAAAAAA==",
            "AAAAAAAAAAB=",
            "AAAAAAAAAA==",
            "AAAAAAAAAAAA",
        ]

        for payload in malformed {
            XCTAssertThrowsError(try ConvexTaggedInt64Decoder.decodePayload(payload)) { error in
                XCTAssertEqual(error as? ConvexTaggedInt64Decoder.DecodeError, .malformedPayload)
            }
        }
    }
}

private struct Int64Row: Decodable {
    let amountCents: Int64
    let sats: Int64
}

final class ConvexRowMutationTests: XCTestCase {
    func testInt64EncoderAndMoneyConversionFailClosed() throws {
        let vectors: [(Int64, String)] = [
            (0, "AAAAAAAAAAA="),
            (1, "AQAAAAAAAAA="),
            (-1, "//////////8="),
            (.max, "/////////38="),
            (.min, "AAAAAAAAAIA="),
            (9_007_199_254_740_993, "AQAAAAAAIAA="),
        ]
        for (value, expected) in vectors {
            XCTAssertEqual(ConvexTaggedInt64Encoder.encode(value), ["$integer": expected])
        }

        XCTAssertEqual(
            try ConvexClient.exactMinorUnits(Decimal(string: "1234.69")!, field: "amount"),
            123_469,
        )
        XCTAssertThrowsError(
            try ConvexClient.exactMinorUnits(Decimal(string: "0.001")!, field: "amount"),
        ) { error in
            XCTAssertEqual(
                error as? ConvexRowMutationError,
                .fractionalMinorUnit(field: "amount"),
            )
        }
        XCTAssertThrowsError(
            try ConvexClient.exactMinorUnits(
                Decimal(string: "92233720368547758.08")!,
                field: "amount",
            ),
        ) { error in
            XCTAssertEqual(
                error as? ConvexRowMutationError,
                .minorUnitOverflow(field: "amount"),
            )
        }
    }

    func testFinancialWritesUseRowsTaggedMoneyAndChildOwnership() async throws {
        let capture = RowMutationRequestCapture()
        let client = makeClient(capture: capture)
        let transaction = LegacyTransactionDTO(
            id: "tx-1",
            date: "2026-07-29",
            merchant: "Refund",
            amount: Decimal(string: "-8.00")!,
            category: "Shopping",
            card: "Aven",
            note: nil,
            owner: .mason,
        )
        try await client.upsertTransactionRow(
            transaction,
            owner: .mason,
            sourceFile: "mason-transactions",
        )
        try await client.deleteTransactionRow(
            id: transaction.id,
            owner: .mason,
            sourceFile: "mason-transactions",
        )

        let buy = LegacyBTCBuyDTO(
            id: "buy-1",
            date: "2026-07-29",
            source: "River",
            amountSats: 123_456,
            amountBtc: Decimal(string: "0.00123456")!,
            priceUsd: Decimal(string: "65634.01")!,
            usd: Decimal(string: "81.03")!,
            note: nil,
            status: nil,
            costBasisStatus: nil,
            loggedBy: nil,
            archimedesRequestId: nil,
            owner: FamilyMember.maddox.rawValue,
            feeUsd: Decimal(string: "1.23"),
            updatedAtMs: 1_777_777_777_777,
        )
        let acceptedBuyRevision = try await client.upsertBTCBuyRow(
            buy,
            owner: .maddox,
            sourceFile: "bitcoin-buys",
        )
        // tables:upsertBtcBuy returns identity/outcome, but not a revision.
        XCTAssertNil(acceptedBuyRevision)

        let requests = capture.values()
        XCTAssertEqual(
            requests.compactMap { $0["path"] as? String },
            [
                "tables:upsertTransaction",
                "tables:deleteTransaction",
                "tables:upsertBtcBuy",
            ],
        )
        XCTAssertFalse(
            requests.contains {
                (($0["path"] as? String) ?? "").hasPrefix("dataFiles:")
            },
        )

        let transactionArgs = try XCTUnwrap(requests[0]["args"] as? [String: Any])
        XCTAssertEqual(transactionArgs["sourceFile"] as? String, "mason-transactions")
        let transactionRow = try XCTUnwrap(transactionArgs["transaction"] as? [String: Any])
        XCTAssertEqual(transactionRow["kind"] as? String, "credit")
        XCTAssertEqual(
            transactionRow["amountCents"] as? [String: String],
            ["$integer": "4Pz///////8="],
        )
        XCTAssertEqual(transactionRow["owner"] as? String, "mason")

        let buyArgs = try XCTUnwrap(requests[2]["args"] as? [String: Any])
        XCTAssertEqual(buyArgs["sourceFile"] as? String, "bitcoin-buys")
        let buyRow = try XCTUnwrap(buyArgs["buy"] as? [String: Any])
        XCTAssertEqual(buyRow["sats"] as? [String: String], ["$integer": "QOIBAAAAAAA="])
        XCTAssertEqual(
            buyRow["priceUsdCents"] as? [String: String],
            ["$integer": "SSZkAAAAAAA="],
        )
        XCTAssertEqual(buyRow["usdCents"] as? [String: String], ["$integer": "px8AAAAAAAA="])
        XCTAssertEqual(buyRow["feeUsdCents"] as? [String: String], ["$integer": "ewAAAAAAAAA="])
        XCTAssertEqual(buyRow["owner"] as? String, "maddox")
        XCTAssertEqual(buyArgs["baseUpdatedAtMs"] as? Double, 1_777_777_777_777)
    }

    func testBTCBuyWriteEmitsExplicitZeroFeeWhenManualFeeIsMissing() async throws {
        let capture = RowMutationRequestCapture()
        let client = makeClient(capture: capture)
        let buy = LegacyBTCBuyDTO(
            id: "buy-1",
            date: "2026-07-29",
            source: "River",
            amountSats: 1,
            amountBtc: Decimal(string: "0.00000001")!,
            priceUsd: 100_000,
            usd: 1,
            note: nil,
            status: nil,
            costBasisStatus: nil,
            loggedBy: nil,
            archimedesRequestId: nil,
            owner: FamilyMember.victor.rawValue,
        )

        let acceptedBuyRevision = try await client.upsertBTCBuyRow(buy, owner: .victor)
        XCTAssertNil(acceptedBuyRevision)
        let request = try XCTUnwrap(capture.values().first)
        let arguments = try XCTUnwrap(request["args"] as? [String: Any])
        let row = try XCTUnwrap(arguments["buy"] as? [String: Any])
        XCTAssertEqual(
            row["feeUsdCents"] as? [String: String],
            ["$integer": "AAAAAAAAAAA="],
        )
    }

    func testBTCBuyWriteRejectsInvalidManualFeesBeforeNetworkIO() async throws {
        for invalidFee in [
            Decimal(string: "-0.01")!,
            Decimal(string: "0.001")!,
            Decimal(string: "92233720368547758.08")!,
        ] {
            let capture = RowMutationRequestCapture()
            let client = makeClient(capture: capture)
            let buy = LegacyBTCBuyDTO(
                id: "buy-1",
                date: "2026-07-29",
                source: "River",
                amountSats: 1,
                amountBtc: Decimal(string: "0.00000001")!,
                priceUsd: 100_000,
                usd: 1,
                note: nil,
                status: nil,
                costBasisStatus: nil,
                loggedBy: nil,
                archimedesRequestId: nil,
                owner: FamilyMember.victor.rawValue,
                feeUsd: invalidFee,
            )

            do {
                _ = try await client.upsertBTCBuyRow(buy, owner: .victor)
                XCTFail("Invalid manual fee was accepted")
            } catch {
                XCTAssertTrue(error is ExactMoneyError)
            }
            XCTAssertTrue(capture.values().isEmpty)
        }
    }

    func testSatIncomeWritePreservesSatsAndRevisionFence() async throws {
        let capture = RowMutationRequestCapture()
        let client = makeClient(capture: capture)
        let transaction = LegacyTransactionDTO(
            id: "tx-1",
            date: "2026-08-01",
            merchant: "Bitcoin income",
            amount: Decimal(string: "80.00")!,
            category: "Income",
            card: nil,
            note: "Paid in sats",
            owner: .victor,
            amountSats: 123_456,
            enteredInBitcoin: true,
            updatedAtMs: 1_777_777_777_777,
        )

        let accepted = try await client.upsertTransactionRow(
            transaction,
            owner: .victor,
            sourceFile: "transactions",
        )
        // Without this the client cannot fence its own next edit or delete.
        XCTAssertEqual(accepted, 1_888_888_888_888)
        try await client.deleteTransactionRow(
            id: transaction.id,
            owner: .victor,
            sourceFile: "transactions",
            baseUpdatedAtMs: transaction.updatedAtMs,
        )

        let requests = capture.values()
        let upsertArgs = try XCTUnwrap(requests[0]["args"] as? [String: Any])
        let row = try XCTUnwrap(upsertArgs["transaction"] as? [String: Any])
        XCTAssertEqual(row["amountSats"] as? [String: String], ["$integer": "QOIBAAAAAAA="])
        XCTAssertEqual(upsertArgs["baseUpdatedAtMs"] as? Double, 1_777_777_777_777)

        let deleteArgs = try XCTUnwrap(requests[1]["args"] as? [String: Any])
        XCTAssertEqual(deleteArgs["baseUpdatedAtMs"] as? Double, 1_777_777_777_777)
    }

    // A USD Income row carries a sats figure derived from a spot price. Sending
    // it would post that estimate to the ledger as if the user had received an
    // exact amount of Bitcoin, so only an explicitly Bitcoin-entered row may
    // carry sats onto the wire.
    func testUsdDerivedIncomeDoesNotSendSats() async throws {
        let capture = RowMutationRequestCapture()
        let client = makeClient(capture: capture)
        let transaction = LegacyTransactionDTO(
            id: "tx-1",
            date: "2026-08-01",
            merchant: "Payroll",
            amount: Decimal(string: "80.00")!,
            category: "Income",
            card: nil,
            note: nil,
            owner: .victor,
            amountSats: 123_456,
            enteredInBitcoin: false,
        )

        try await client.upsertTransactionRow(
            transaction,
            owner: .victor,
            sourceFile: "transactions",
        )

        let upsertArgs = try XCTUnwrap(capture.values()[0]["args"] as? [String: Any])
        let row = try XCTUnwrap(upsertArgs["transaction"] as? [String: Any])
        XCTAssertNil(row["amountSats"])
    }

    // A row written before the input-origin marker existed has no answer. It
    // must read as "not explicitly Bitcoin" so a legacy USD estimate is never
    // promoted into an exact sat posting by the migration alone.
    func testLegacyIncomeWithoutInputOriginDoesNotSendSats() async throws {
        let capture = RowMutationRequestCapture()
        let client = makeClient(capture: capture)
        let transaction = LegacyTransactionDTO(
            id: "tx-1",
            date: "2026-08-01",
            merchant: "Payroll",
            amount: Decimal(string: "80.00")!,
            category: "Income",
            card: nil,
            note: nil,
            owner: .victor,
            amountSats: 123_456,
        )

        try await client.upsertTransactionRow(
            transaction,
            owner: .victor,
            sourceFile: "transactions",
        )

        let upsertArgs = try XCTUnwrap(capture.values()[0]["args"] as? [String: Any])
        let row = try XCTUnwrap(upsertArgs["transaction"] as? [String: Any])
        XCTAssertNil(row["amountSats"])
    }

    func testTodoAndBudgetWritesUseRowsAndServerSelectedMonth() async throws {
        let capture = RowMutationRequestCapture()
        let client = makeClient(capture: capture)
        let todo = LegacyTodoDTO(
            id: "todo-1",
            title: "Pack lunch",
            owner: FamilyMember.mason.rawValue,
        )
        try await client.upsertTodoRow(todo)
        try await client.deleteTodoRow(id: todo.id)
        try await client.upsertBudgetCategoryRow(
            name: "Fun",
            icon: "🎮",
            budget: Decimal(string: "24.80")!,
            viewer: .mason,
        )

        let requests = capture.values()
        XCTAssertEqual(
            requests.compactMap { $0["path"] as? String },
            [
                "tables:upsertTodo",
                "tables:deleteTodo",
                "tables:getBudgetDocument",
                "tables:upsertBudgetCategory",
            ],
        )
        let budgetArgs = try XCTUnwrap(requests[3]["args"] as? [String: Any])
        XCTAssertEqual(budgetArgs["viewer"] as? String, "mason")
        XCTAssertEqual(budgetArgs["month"] as? String, "July 2026")
        let category = try XCTUnwrap(budgetArgs["category"] as? [String: Any])
        XCTAssertEqual(
            category["budgetCents"] as? [String: String],
            ["$integer": "sAkAAAAAAAA="],
        )
    }

    private func makeClient(capture: RowMutationRequestCapture) -> ConvexClient {
        ConvexClient(
            deploymentURL: URL(string: "https://example.test")!,
            requestExecutor: { request in
                let body = try XCTUnwrap(request.httpBody)
                let object = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: body) as? [String: Any],
                )
                let path = try XCTUnwrap(object["path"] as? String)
                capture.append(object)
                let value: Any
                switch path {
                case "tables:upsertTransaction":
                    value = ["txId": "tx-1", "updatedAtMs": 1_888_888_888_888]
                case "tables:deleteTransaction":
                    value = ["txId": "tx-1", "removed": true]
                case "tables:upsertBtcBuy":
                    value = ["buyId": "buy-1", "owner": "victor", "month": "2026-07", "outcome": "inserted"]
                case "tables:upsertTodo":
                    value = ["todoId": "todo-1"]
                case "tables:deleteTodo":
                    value = ["todoId": "todo-1", "removed": true]
                case "tables:getBudgetDocument":
                    value = [
                        "complete": true,
                        "document": [
                            "owner": "mason",
                            "month": "July 2026",
                            "coinbaseOneBalanceCents": ConvexTaggedInt64Encoder.encode(0),
                            "categories": [],
                            "mtdIncomeCents": ConvexTaggedInt64Encoder.encode(0),
                            "ytdIncomeCents": ConvexTaggedInt64Encoder.encode(0),
                            "monthlyHistory": [],
                            "updatedAtMs": 1_777_777_777_777,
                        ],
                    ]
                case "tables:upsertBudgetCategory":
                    value = ["month": "July 2026", "name": "Fun"]
                default:
                    return try ConvexRowMutationTests.response(
                        for: request,
                        statusCode: 500,
                        envelope: ["status": "error", "errorMessage": "unexpected path"],
                    )
                }
                return try ConvexRowMutationTests.response(
                    for: request,
                    envelope: ["status": "success", "value": value],
                )
            },
        )
    }

    private static func response(
        for request: URLRequest,
        statusCode: Int = 200,
        envelope: [String: Any],
    ) throws -> (Data, URLResponse) {
        guard let url = request.url else { throw URLError(.badURL) }
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"],
        ) else {
            throw URLError(.badServerResponse)
        }
        return (try JSONSerialization.data(withJSONObject: envelope), response)
    }
}

private final class RowMutationRequestCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [[String: Any]] = []

    func append(_ request: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        requests.append(request)
    }

    func values() -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }
}
