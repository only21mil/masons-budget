import Foundation
import XCTest

final class ConvexRowMutationTests: XCTestCase {
    func testInt64EncoderUsesCanonicalLittleEndianConvexTags() {
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
    }

    func testMoneyConversionIsExactAndFailsClosed() throws {
        XCTAssertEqual(
            try ConvexClient.exactMinorUnits(Decimal(string: "1234.69")!, field: "amount"),
            123_469,
        )
        XCTAssertEqual(
            try ConvexClient.exactMinorUnits(Decimal(string: "-8.00")!, field: "amount"),
            -800,
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

    func testFinancialWritesUsePerRowMutationPathsAndTaggedMinorUnits() async throws {
        let capture = MutationRequestCapture()
        let client = ConvexClient(
            deploymentURL: URL(string: "https://example.test")!,
            requestExecutor: { request in
                let body = try XCTUnwrap(request.httpBody)
                let object = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: body) as? [String: Any],
                )
                let path = try XCTUnwrap(object["path"] as? String)
                capture.append(object)

                let value: [String: Any]
                switch path {
                case "tables:upsertTransaction":
                    value = ["txId": "tx-1", "owner": "mason", "month": "2026-07", "outcome": "inserted"]
                case "tables:deleteTransaction":
                    value = ["txId": "tx-1", "owner": "mason", "removed": true]
                case "tables:upsertBtcBuy":
                    value = ["buyId": "buy-1", "owner": "maddox", "month": "2026-07", "outcome": "inserted"]
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

        let transaction = LegacyTransactionDTO(
            id: "tx-1",
            date: "2026-07-29",
            merchant: "Refund",
            amount: Decimal(string: "-8.00")!,
            category: "Shopping",
            card: "Aven",
            note: nil,
            owner: nil,
        )
        try await client.upsertTransactionRow(
            transaction,
            sourceFile: "mason-transactions",
        )
        try await client.deleteTransactionRow(
            id: transaction.id,
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
        )
        try await client.upsertBTCBuyRow(
            buy,
            owner: .maddox,
            sourceFile: "bitcoin-buys",
        )

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
        XCTAssertNil(transactionRow["owner"])

        let buyArgs = try XCTUnwrap(requests[2]["args"] as? [String: Any])
        XCTAssertEqual(buyArgs["sourceFile"] as? String, "bitcoin-buys")
        let buyRow = try XCTUnwrap(buyArgs["buy"] as? [String: Any])
        XCTAssertEqual(buyRow["sats"] as? [String: String], ["$integer": "QOIBAAAAAAA="])
        XCTAssertEqual(
            buyRow["priceUsdCents"] as? [String: String],
            ["$integer": "SSZkAAAAAAA="],
        )
        XCTAssertEqual(buyRow["usdCents"] as? [String: String], ["$integer": "px8AAAAAAAA="])
        XCTAssertEqual(buyRow["owner"] as? String, "maddox")
    }

    func testTodoAndBudgetWritesUseRowsAndServerSelectedBudgetMonth() async throws {
        let capture = MutationRequestCapture()
        let client = ConvexClient(
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
                case "tables:upsertTodo":
                    value = ["todoId": "todo-1", "owner": "mason", "done": false, "outcome": "inserted"]
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
                        ],
                    ]
                case "tables:upsertBudgetCategory":
                    value = [
                        "owner": "mason",
                        "month": "July 2026",
                        "name": "Fun",
                        "outcome": "updated",
                    ]
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
        XCTAssertEqual(category["budgetCents"] as? [String: String], ["$integer": "sAkAAAAAAAA="])
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

private final class MutationRequestCapture: @unchecked Sendable {
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
