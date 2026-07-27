import Foundation
import SwiftData
import XCTest

final class ConvexRowsTests: XCTestCase {
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
