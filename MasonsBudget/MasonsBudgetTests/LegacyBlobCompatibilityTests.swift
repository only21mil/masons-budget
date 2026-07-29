// The Vogel Vault — legacy blob DTO and ledger mapper tests
// Uses embedded JSON fixtures matching the surviving `dataFiles` blob formats.
// Note: JSON→Decimal decoding goes through Double, so we use assertDecimalClose
// for fractional values. Integer Decimals (6200, 500) are exact.

import Foundation
import SwiftData
import XCTest

final class LegacyBlobCompatibilityTests: XCTestCase {
    // Helper: Decimal precision can drift through JSON→Double→Decimal path.
    // Compare to 8 decimal places which is more than enough for financial data.
    func assertDecimalClose(_ actual: Decimal?, _ expected: Decimal, tolerance: Decimal = 0.0001, file: StaticString = #file, line: UInt = #line) {
        guard let actual else {
            XCTFail("Decimal was nil, expected \(expected)", file: file, line: line)
            return
        }
        let diff = abs(actual - expected)
        XCTAssertTrue(diff < tolerance, "Decimal \(actual) not close to \(expected) (diff: \(diff))", file: file, line: line)
    }

    // MARK: - Date parsing

    func testDateParsingYMD() {
        let date = LedgerMapper.parseDate("2026-04-30")
        XCTAssertNotEqual(date, .distantPast)
    }

    func testDateParsingISO8601() {
        let date = LedgerMapper.parseDate("2026-04-30T15:09:48.945031Z")
        XCTAssertNotEqual(date, .distantPast)
    }

    func testTodayTodoPredicateIncludesOverdueAndTodayOnly() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))

        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 6, hour: 12)))
        let overdue = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 4, hour: 9)))
        let today = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 6, hour: 23)))
        let tomorrow = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 7, hour: 8)))

        XCTAssertTrue(TodayView.isDueTodayOrOverdue(overdue, now: now, calendar: calendar))
        XCTAssertTrue(TodayView.isDueTodayOrOverdue(today, now: now, calendar: calendar))
        XCTAssertFalse(TodayView.isDueTodayOrOverdue(tomorrow, now: now, calendar: calendar))
        XCTAssertFalse(TodayView.isDueTodayOrOverdue(nil, now: now, calendar: calendar))
    }

    @MainActor
    func testReplaceTodosUpdatesExistingImportedUniqueIDWithoutDuplicate() throws {
        let context = try makeInMemoryTodoContext()
        let service = ConvexSyncService(context: context)

        context.insert(TodoItem(
            id: "t1",
            title: "Original title",
            owner: .victor,
            createdBy: "mc2",
            updatedAt: Date(timeIntervalSince1970: 10),
        ))
        try context.save()

        service.replaceTodos(visibleTo: .victor, with: [
            TodoItem(
                id: "t1",
                title: "Remote newer title",
                owner: .victor,
                createdBy: "mc2",
                updatedAt: Date(timeIntervalSince1970: 20),
            ),
        ])
        try context.save()

        let todos = try context.fetch(FetchDescriptor<TodoItem>())
        XCTAssertEqual(todos.count, 1)
        XCTAssertEqual(todos.first?.id, "t1")
        XCTAssertEqual(todos.first?.title, "Remote newer title")
        XCTAssertEqual(todos.first?.createdBy, "mc2")
    }

    @MainActor
    func testReplaceTodosPreservesAppCreatedRowOnRemoteIDCollision() throws {
        let context = try makeInMemoryTodoContext()
        let service = ConvexSyncService(context: context)

        context.insert(TodoItem(
            id: "t1",
            title: "User-entered task",
            owner: .victor,
            createdBy: "app",
            updatedAt: Date(timeIntervalSince1970: 10),
        ))
        try context.save()

        service.replaceTodos(visibleTo: .victor, with: [
            TodoItem(
                id: "t1",
                title: "Remote mc2 task",
                owner: .victor,
                createdBy: "mc2",
                updatedAt: Date(timeIntervalSince1970: 20),
            ),
        ])
        try context.save()

        let todos = try context.fetch(FetchDescriptor<TodoItem>())
        XCTAssertEqual(todos.count, 1)
        XCTAssertEqual(todos.first?.id, "t1")
        XCTAssertEqual(todos.first?.title, "User-entered task")
        XCTAssertEqual(todos.first?.createdBy, "app")
    }

    /// B1 regression: a single-owner payload must delete missing rows for the owners
    /// present in that payload, but must NEVER touch rows belonging to other owners.
    @MainActor
    func testReplaceTodosMultiOwnerPayloadScopesDeletionToPresentOwners() throws {
        let context = try makeInMemoryTodoContext()
        let service = ConvexSyncService(context: context)

        // Seed two Victor-owned mc2 rows and two Rachel-owned mc2 rows.
        context.insert(TodoItem(
            id: "v1",
            title: "Victor todo 1",
            owner: .victor,
            createdBy: "mc2",
            updatedAt: Date(timeIntervalSince1970: 10),
        ))
        context.insert(TodoItem(
            id: "v2",
            title: "Victor todo 2",
            owner: .victor,
            createdBy: "mc2",
            updatedAt: Date(timeIntervalSince1970: 10),
        ))
        context.insert(TodoItem(
            id: "r1",
            title: "Rachel todo 1 (original)",
            owner: .rachel,
            createdBy: "mc2",
            updatedAt: Date(timeIntervalSince1970: 10),
        ))
        context.insert(TodoItem(
            id: "r2",
            title: "Rachel todo 2 (will be removed)",
            owner: .rachel,
            createdBy: "mc2",
            updatedAt: Date(timeIntervalSince1970: 10),
        ))
        try context.save()

        // Rachel-only payload: r1 is updated, r2 is absent (should be deleted).
        // Victor rows are entirely absent from this payload (must be untouched).
        service.replaceTodos(visibleTo: .rachel, with: [
            TodoItem(
                id: "r1",
                title: "Rachel todo 1 (updated)",
                owner: .rachel,
                createdBy: "mc2",
                updatedAt: Date(timeIntervalSince1970: 20),
            ),
        ])
        try context.save()

        let todos = try context.fetch(FetchDescriptor<TodoItem>())

        // Total rows: v1 + v2 (untouched) + r1 (updated) = 3; r2 deleted.
        XCTAssertEqual(todos.count, 3)

        // r2 must be gone — it belonged to Rachel (present owner) but was absent from payload.
        XCTAssertNil(todos.first(where: { $0.id == "r2" }), "r2 should have been reconciled away")

        // r1 must survive and carry the updated title.
        let r1 = todos.first(where: { $0.id == "r1" })
        XCTAssertNotNil(r1, "r1 should survive")
        XCTAssertEqual(r1?.title, "Rachel todo 1 (updated)")
        XCTAssertEqual(r1?.createdBy, "mc2")

        // Victor rows must be completely untouched.
        XCTAssertNotNil(todos.first(where: { $0.id == "v1" }), "v1 must survive (owner absent from payload)")
        XCTAssertNotNil(todos.first(where: { $0.id == "v2" }), "v2 must survive (owner absent from payload)")

        let v1 = todos.first(where: { $0.id == "v1" })
        XCTAssertEqual(v1?.title, "Victor todo 1")
        XCTAssertEqual(v1?.createdBy, "mc2")
    }

    @MainActor
    private func makeInMemoryTodoContext() throws -> ModelContext {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: TodoItem.self, configurations: configuration)
        return ModelContext(container)
    }

    // MARK: - transactions.json

    func testDecodeTransactions() throws {
        let json = """
        [
          {"id":"mortgage-2026-03-01","date":"2026-03-01","merchant":"PennyMac (Mortgage)","amount":3613.79,"category":"Bills & Utilities","card":"Strike (BTC)","note":"Monthly mortgage payment"},
          {"id":"t001","date":"2026-03-02","merchant":"Kroger","amount":76.81,"category":"Groceries","card":"Strike","note":""}
        ]
        """.data(using: .utf8)!

        let dtos = try JSONDecoder().decode([LegacyTransactionDTO].self, from: json)
        XCTAssertEqual(dtos.count, 2)
        XCTAssertEqual(dtos[0].id, "mortgage-2026-03-01")
        assertDecimalClose(dtos[0].amount, 3613.79)
        XCTAssertEqual(dtos[1].merchant, "Kroger")
    }

    func testMapTransactions() throws {
        let json = """
        [{"id":"t001","date":"2026-03-02","merchant":"Kroger","amount":76.81,"category":"Groceries","card":"Strike","note":""}]
        """.data(using: .utf8)!

        let dtos = try JSONDecoder().decode([LegacyTransactionDTO].self, from: json)
        let models = LedgerMapper.mapTransactions(dtos)

        XCTAssertEqual(models.count, 1)
        XCTAssertEqual(models[0].id, "t001")
        XCTAssertEqual(models[0].merchant, "Kroger")
        assertDecimalClose(models[0].amount, 76.81)
        XCTAssertEqual(models[0].createdBy, "mc2")
        XCTAssertEqual(models[0].sourceFile, "transactions.json")
        XCTAssertNotEqual(models[0].date, .distantPast)
    }

    func testPositiveAdultSpendingContributesPositiveBudgetSpend() throws {
        let json = """
        [{"id":"t001","date":"2026-03-02","merchant":"Kroger","amount":76.81,"category":"Groceries","card":"Aven","note":""}]
        """.data(using: .utf8)!

        let dtos = try JSONDecoder().decode([LegacyTransactionDTO].self, from: json)
        let tx = try XCTUnwrap(LedgerMapper.mapTransactions(dtos).first)

        // The mapper defaults this adult file to Victor. Production purchases
        // are positive for every owner.
        XCTAssertTrue(tx.isSpend)
        XCTAssertFalse(tx.isIncome)
        assertDecimalClose(tx.spendAmount, 76.81)
        assertDecimalClose(tx.displaySpendAmount, 76.81)
        XCTAssertFalse(tx.hasOppositeSpendSign)
        assertDecimalClose(tx.displayAmount, -76.81)
    }

    func testProductionSignsKeepPurchasesPositiveAndRefundsNegativeInBudgetActuals() {
        func row(_ id: String, owner: FamilyMember, amount: Decimal) -> Transaction {
            Transaction(
                id: id,
                date: .now,
                merchant: id,
                amount: amount,
                category: "Shopping",
                owner: owner,
                createdBy: "test",
            )
        }

        let adultPurchase = row("Etsy", owner: .victor, amount: 37.62)
        let adultRefund = row("Paypal *ebay", owner: .victor, amount: -1234.69)
        let childPurchase = row("Mason purchase", owner: .mason, amount: 37.62)
        let monthRows = [
            adultPurchase,
            row("Production-sized purchase", owner: .victor, amount: 1234.69),
            adultRefund,
        ]

        XCTAssertEqual(adultPurchase.spendAmount, 37.62)
        XCTAssertFalse(adultPurchase.hasOppositeSpendSign)
        XCTAssertEqual(adultRefund.spendAmount, -1234.69)
        XCTAssertTrue(adultRefund.hasOppositeSpendSign)
        XCTAssertEqual(childPurchase.spendAmount, 37.62)
        XCTAssertFalse(childPurchase.hasOppositeSpendSign)
        XCTAssertEqual(
            monthRows.reduce(Decimal(0)) { $0 + $1.spendAmount },
            37.62,
            "monthly actual is purchases minus refunds",
        )
    }

    func testIncomeCategoryClassifiesAsIncome() {
        let tx = Transaction(
            id: "income-1",
            date: .now,
            merchant: "Paycheck",
            amount: 500,
            category: "Income",
            createdBy: "app",
        )

        XCTAssertTrue(tx.isIncome)
        XCTAssertFalse(tx.isSpend)
        assertDecimalClose(tx.displayAmount, 500)
    }

    func testAppTransactionPayloadMatchesLegacyBlobShape() throws {
        var components = DateComponents()
        components.calendar = Calendar(identifier: .gregorian)
        components.timeZone = TimeZone(secondsFromGMT: 0)
        components.year = 2026
        components.month = 5
        components.day = 1
        components.hour = 12

        let transaction = try Transaction(
            id: "manual-1-abcdef",
            date: XCTUnwrap(components.date),
            merchant: "Starbucks",
            amount: 25.00,
            category: "Dining & Drinks",
            card: "Strike",
            note: "Coffee",
            owner: .victor,
            createdBy: "manual",
        )

        let dto = try LegacyTransactionDTO(appTransaction: transaction, owner: .victor)
        XCTAssertEqual(dto.id, "manual-1-abcdef")
        XCTAssertEqual(dto.date, "2026-05-01")
        XCTAssertEqual(dto.merchant, "Starbucks")
        XCTAssertEqual(dto.category, "Dining & Drinks")
        XCTAssertEqual(dto.card, "Strike")
        XCTAssertEqual(dto.note, "Coffee")

        let payload = try dto.convexJSONObject()
        XCTAssertEqual(payload["id"] as? String, "manual-1-abcdef")
        XCTAssertEqual(payload["date"] as? String, "2026-05-01")
        XCTAssertEqual(payload["merchant"] as? String, "Starbucks")
        XCTAssertEqual(payload["category"] as? String, "Dining & Drinks")
        XCTAssertEqual(payload["card"] as? String, "Strike")
        XCTAssertEqual(payload["note"] as? String, "Coffee")
        assertDecimalClose(try XCTUnwrap(payload["amount"] as? NSNumber).decimalValue, 25)
    }

    func testAppAdultRefundPayloadPreservesNegativeAmount() throws {
        let transaction = Transaction(
            id: "manual-refund",
            date: .now,
            merchant: "Dominos Refund",
            amount: -32.45,
            category: "Dining & Drinks",
            card: "Aven",
            owner: .victor,
            createdBy: "app",
        )

        let dto = try LegacyTransactionDTO(appTransaction: transaction, owner: .victor)
        assertDecimalClose(dto.amount, -32.45)

        let payload = try dto.convexJSONObject()
        assertDecimalClose(try XCTUnwrap(payload["amount"] as? NSNumber).decimalValue, -32.45)
    }

    func testAppChildSpendPayloadPreservesPositiveMagnitude() throws {
        let transaction = Transaction(
            id: "mason-spend",
            date: .now,
            merchant: "Game Store",
            amount: 24,
            category: "Entertainment",
            owner: .mason,
            createdBy: "app",
        )

        let dto = try LegacyTransactionDTO(appTransaction: transaction, owner: .mason)
        assertDecimalClose(dto.amount, 24)

        let payload = try dto.convexJSONObject()
        assertDecimalClose(try XCTUnwrap(payload["amount"] as? NSNumber).decimalValue, 24)
    }

    func testAppIncomePayloadPreservesPositiveAmount() throws {
        let transaction = Transaction(
            id: "income",
            date: .now,
            merchant: "Paycheck",
            amount: 500,
            category: "Income",
            owner: .victor,
            createdBy: "app",
        )

        let dto = try LegacyTransactionDTO(appTransaction: transaction, owner: .victor)
        assertDecimalClose(dto.amount, 500)

        let payload = try dto.convexJSONObject()
        assertDecimalClose(try XCTUnwrap(payload["amount"] as? NSNumber).decimalValue, 500)
    }

    func testAppSpendPayloadAcceptsPositivePurchasesAndNegativeRefunds() throws {
        let adultSpend = Transaction(
            id: "adult-spend",
            date: .now,
            merchant: "Grocer",
            amount: 25,
            category: "Groceries",
            owner: .victor,
            createdBy: "app",
        )
        let childSpend = Transaction(
            id: "child-spend",
            date: .now,
            merchant: "Game Store",
            amount: 24,
            category: "Entertainment",
            owner: .mason,
            createdBy: "app",
        )
        let refund = Transaction(
            id: "adult-refund",
            date: .now,
            merchant: "Refund",
            amount: -12,
            category: "Shopping",
            owner: .victor,
            createdBy: "app",
        )

        XCTAssertEqual(try LegacyTransactionDTO(appTransaction: adultSpend, owner: .victor).amount, 25)
        XCTAssertEqual(try LegacyTransactionDTO(appTransaction: childSpend, owner: .mason).amount, 24)
        XCTAssertEqual(try LegacyTransactionDTO(appTransaction: refund, owner: .victor).amount, -12)
    }

    // MARK: - budget.json

    func testDecodeBudget() throws {
        let json = """
        {
          "coinbase_one_balance": 26.42,
          "month": "April 2026",
          "categories": [
            {"name":"Bills & Utilities","icon":"house","budget":6200,"spent":5943.57},
            {"name":"Groceries","icon":"cart","budget":1500,"spent":1527.27}
          ],
          "strategy": {
            "effective_apr": 5.99,
            "strategy_note": "BTC-first cashflow plan."
          },
          "income": {
            "weekly_gross": 3941.53,
            "weekly_strike": 500,
            "weekly_river": 3441.53,
            "pay_frequency": "weekly",
            "monthly_gross": 17079.96,
            "mtd_income": 3941.53,
            "paychecks": [
              {"date":"2026-04-01","platform":"Strike","amount":500,"net":500},
              {"date":"2026-04-03","platform":"River","amount":3441.53,"net":3441.53}
            ]
          }
        }
        """.data(using: .utf8)!

        let budget = try JSONDecoder().decode(LegacyBudgetDTO.self, from: json)
        XCTAssertEqual(budget.month, "April 2026")
        XCTAssertEqual(budget.categories.count, 2)
        assertDecimalClose(budget.income?.weeklyGross, 3941.53)
        assertDecimalClose(budget.income?.mtdIncome, 3941.53)
        XCTAssertEqual(budget.income?.paychecks?.count, 2)
        XCTAssertEqual(budget.strategy?.strategyNote, "BTC-first cashflow plan.")
    }

    func testMapBudgetSnapshot() throws {
        let json = """
        {
          "month": "April 2026",
          "categories": [],
          "income": {
            "weekly_gross": 3941.53,
            "weekly_strike": 500,
            "weekly_river": 3441.53,
            "pay_frequency": "weekly",
            "monthly_gross": 17079.96,
            "paychecks": [
              {"date":"2026-01-03","platform":"River","amount":3000,"net":3000},
              {"date":"2026-04-01","platform":"Strike","amount":500,"net":500},
              {"date":"2026-04-03","platform":"River","amount":3441.53,"net":3441.53}
            ]
          }
        }
        """.data(using: .utf8)!

        let dto = try JSONDecoder().decode(LegacyBudgetDTO.self, from: json)
        let snapshot = LedgerMapper.mapBudgetSnapshot(dto)

        XCTAssertEqual(snapshot.monthKey, "April 2026")
        assertDecimalClose(snapshot.weeklyGross, 3941.53)
        assertDecimalClose(snapshot.monthlyGross, 17079.96)
        assertDecimalClose(snapshot.mtdIncome, 3941.53)
        assertDecimalClose(snapshot.ytdIncome, 6941.53)
        XCTAssertEqual(snapshot.payFrequency, "weekly")
    }

    func testMapBudgetCategories() throws {
        let json = """
        [
          {"name":"Bills & Utilities","icon":"house","budget":6200,"spent":5943.57},
          {"name":"Groceries","icon":"cart","budget":1500,"spent":1527.27}
        ]
        """.data(using: .utf8)!

        let dtos = try JSONDecoder().decode([LegacyBudgetCategoryDTO].self, from: json)
        let models = LedgerMapper.mapBudgetCategories(dtos)

        XCTAssertEqual(models.count, 2)
        XCTAssertEqual(models[0].name, "Bills & Utilities")
        XCTAssertEqual(models[0].monthlyBudget, 6200) // Integer — exact
        XCTAssertEqual(models[0].sortOrder, 0)
        XCTAssertEqual(models[1].sortOrder, 1)
        XCTAssertFalse(models[0].isIncome)
    }

    // MARK: - btc-balance-snapshot.json

    func testDecodeBTCSnapshot() throws {
        let json = """
        {
          "schemaVersion": 1,
          "asOf": "2026-04-30T15:09:48.945031Z",
          "accounts": {
            "strike": {"btc":0.00874765,"fiat":0,"label":"Strike","custody":"exchange"},
            "coldcard": {"btc":4.51718914,"fiat":0,"label":"Coldcard","custody":"self_custody"}
          },
          "totals": {"btc":4.58478055,"fiat":0,"exchange_btc":0.06408003,"self_custody_btc":4.52070052},
          "metadata": {"source":"snapshot","basis":"authoritative","confidence":"high"}
        }
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(LegacyBTCSnapshotDTO.self, from: json)
        XCTAssertEqual(snapshot.schemaVersion, 1)
        XCTAssertEqual(snapshot.accounts.count, 2)
        assertDecimalClose(snapshot.accounts["strike"]?.btc, 0.00874765)
        XCTAssertEqual(snapshot.accounts["coldcard"]?.custody, "self_custody")
        assertDecimalClose(snapshot.totals.btc, 4.58478055)
    }

    func testMapBTCAccounts() throws {
        let json = """
        {
          "schemaVersion": 1,
          "asOf": "2026-04-30",
          "accounts": {
            "strike": {"btc":0.00874765,"fiat":0,"label":"Strike","custody":"exchange"},
            "coldcard": {"btc":4.51718914,"fiat":0,"label":"Coldcard","custody":"self_custody"}
          },
          "totals": {"btc":4.52593679,"fiat":0,"exchange_btc":0.00874765,"self_custody_btc":4.51718914}
        }
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(LegacyBTCSnapshotDTO.self, from: json)
        let accounts = LedgerMapper.mapBTCAccounts(snapshot, owner: .victor)

        XCTAssertEqual(accounts.count, 2)
        for acct in accounts {
            XCTAssertEqual(acct.ownerMember, .victor)
            XCTAssertTrue(acct.key.hasSuffix("-victor"))
        }

        let coldcard = accounts.first(where: { $0.label == "Coldcard" })
        XCTAssertNotNil(coldcard)
        XCTAssertEqual(coldcard?.custody, .selfCustody)
        assertDecimalClose(coldcard?.btc, 4.51718914)
    }

    // MARK: - bitcoin-buys.json

    func testDecodeBTCBuys() throws {
        let json = """
        [
          {
            "id": "b-strike-2026-04-01",
            "date": "2026-04-01",
            "source": "Strike",
            "amount_sats": 732371,
            "amount_btc": 0.00732371,
            "price_usd": 68271.41,
            "usd": 500.0,
            "note": "Direct deposit auto-buy",
            "status": "complete",
            "cost_basis_status": "complete",
            "logged_by": "user-screenshot",
            "archimedes_request_id": "arch-2026-04-01-strike"
          }
        ]
        """.data(using: .utf8)!

        let buys = try JSONDecoder().decode([LegacyBTCBuyDTO].self, from: json)
        XCTAssertEqual(buys.count, 1)
        XCTAssertEqual(buys[0].id, "b-strike-2026-04-01")
        XCTAssertEqual(buys[0].amountSats, 732_371)
        assertDecimalClose(buys[0].amountBtc, 0.00732371)
        assertDecimalClose(buys[0].priceUsd, 68271.41)
    }

    func testMapBTCBuy() {
        let dto = LegacyBTCBuyDTO(
            id: "b-strike-2026-04-01",
            date: "2026-04-01",
            source: "Strike",
            amountSats: 732_371,
            amountBtc: 0.00732371,
            priceUsd: 68271.41,
            usd: 500.0,
            note: "Auto-buy",
            status: "complete",
            costBasisStatus: "complete",
            loggedBy: "user-screenshot",
            archimedesRequestId: "arch-001",
        )

        let model = LedgerMapper.mapBTCBuy(dto)
        XCTAssertEqual(model.id, "b-strike-2026-04-01")
        XCTAssertEqual(model.amountSats, 732_371)
        XCTAssertEqual(model.source, "Strike")
        XCTAssertEqual(model.archimedesRequestId, "arch-001")
        XCTAssertNotEqual(model.date, .distantPast)
    }

    func testMapBTCBuyPreservesExplicitOwner() {
        let dto = LegacyBTCBuyDTO(
            id: "b-app-rachel",
            date: "2026-04-01",
            source: "River",
            amountSats: 100_000,
            amountBtc: 0.001,
            priceUsd: 100_000,
            usd: 100,
            note: "App buy",
            status: "complete",
            costBasisStatus: "complete",
            loggedBy: "app",
            archimedesRequestId: nil,
            owner: "rachel",
        )

        let model = LedgerMapper.mapBTCBuy(dto)

        XCTAssertEqual(model.ownerMember, .rachel)
        XCTAssertEqual(model.amountSats, 100_000)
    }

    // MARK: - bitcoin-bill-pays.json

    func testDecodeBTCBillPays() throws {
        let json = """
        {
          "bill_pays": [
            {
              "id": "bp005",
              "date": "2026-03-01",
              "merchant": "PENNYMAC",
              "category": "Mortgage",
              "amount_usd": 3613.79,
              "btc_spent": 0.05425107,
              "btc_price": 66612.33,
              "platform": "Strike",
              "fee_usd": 28.55,
              "note": "Mortgage via Strike"
            }
          ]
        }
        """.data(using: .utf8)!

        let wrapper = try JSONDecoder().decode(LegacyBillPaysWrapperDTO.self, from: json)
        XCTAssertEqual(wrapper.billPays.count, 1)
        XCTAssertEqual(wrapper.billPays[0].id, "bp005")
        assertDecimalClose(wrapper.billPays[0].amountUsd, 3613.79)
        assertDecimalClose(wrapper.billPays[0].feeUsd, 28.55)
    }

    func testMapBTCBillPay() {
        let dto = LegacyBTCBillPayDTO(
            id: "bp005",
            date: "2026-03-01",
            merchant: "PENNYMAC",
            category: "Mortgage",
            amountUsd: 3613.79,
            btcSpent: 0.05425107,
            btcPrice: 66612.33,
            platform: "Strike",
            note: "Mortgage",
            feeUsd: 28.55,
            reference: nil,
            owner: nil,
        )

        let model = LedgerMapper.mapBTCBillPay(dto)
        XCTAssertEqual(model.platform, "Strike")
        XCTAssertEqual(model.feeUSD, 28.55)
        XCTAssertEqual(model.btcSpent, 0.05425107)
        XCTAssertEqual(model.ownerMember, .victor)
    }

    func testMapBTCBillPayMasonOwner() {
        let dto = LegacyBTCBillPayDTO(
            id: "bp-mason-allowance",
            date: "2026-04-15",
            merchant: "Mason allowance",
            category: "Allowance",
            amountUsd: 25,
            btcSpent: 0.0003,
            btcPrice: 83333,
            platform: "Strike",
            note: nil,
            feeUsd: nil,
            reference: nil,
            owner: "mason",
        )

        let model = LedgerMapper.mapBTCBillPay(dto)
        XCTAssertEqual(model.ownerMember, .mason)
    }

    // MARK: - finances.json

    func testDecodeFinances() throws {
        let json = """
        {
          "lastUpdated": "2026-04-29",
          "retirement": {
            "401k": {
              "provider": "Discount Tire 401(k)",
              "total": 773307.46,
              "holdings": [
                {
                  "name": "VOO",
                  "category": "Large Cap",
                  "value": 601281.38,
                  "costBasis": 213109.93,
                  "gainPct": 182.15,
                  "shares": 932.42,
                  "avgCost": 228.56,
                  "currentPricePerShare": 644.86,
                  "ticker": "VOO",
                  "lots": [
                    {"date":"2026-03-07","type":"conversion_baseline","pricePerShare":619.85,"shares":929.097,"amountInvested":211068.73}
                  ]
                }
              ]
            }
          }
        }
        """.data(using: .utf8)!

        let finances = try JSONDecoder().decode(LegacyFinancesDTO.self, from: json)
        XCTAssertNotNil(finances.retirement.accounts["401k"])
        assertDecimalClose(finances.retirement.accounts["401k"]?.total, 773_307.46)
        XCTAssertEqual(finances.retirement.accounts["401k"]?.holdings.count, 1)
    }

    func testDecodeLiveFinancesShape() throws {
        let json = """
        {
          "lastUpdated": "2026-04-29",
          "retirement": {
            "401k": {
              "provider": "Discount Tire 401(k)",
              "total": 773307.46,
              "holdings": [
                {
                  "name": "Cash & Money Market",
                  "category": "Cash",
                  "value": 37.83,
                  "costBasis": 37.83,
                  "gainPct": 0
                }
              ],
              "weeklyContribution": 291.6,
              "weeklyContributionDay": "Friday"
            },
            "wap": {
              "provider": "Discount Tire WAP",
              "total": 911987.42,
              "holdings": [
                {
                  "name": "VOO - Vanguard S&P 500 ETF",
                  "ticker": "VOO",
                  "value": 911987.42,
                  "costBasis": 356459.07,
                  "gainPct": 155.85,
                  "shares": 1393.9646307166,
                  "avgCost": 255.72,
                  "currentPricePerShare": 654.24
                }
              ]
            },
            "total": 1685294.88
          }
        }
        """.data(using: .utf8)!

        let finances = try JSONDecoder().decode(LegacyFinancesDTO.self, from: json)

        XCTAssertEqual(finances.lastUpdated, "2026-04-29")
        XCTAssertEqual(Set(finances.retirement.accounts.keys), ["401k", "wap"])
        XCTAssertNil(finances.retirement.accounts["total"])
        assertDecimalClose(finances.retirement.accounts["401k"]?.weeklyContribution, 291.6)
        XCTAssertEqual(finances.retirement.accounts["401k"]?.holdings[0].shares, 0)
        XCTAssertEqual(finances.retirement.accounts["wap"]?.holdings[0].category, "Uncategorized")
    }

    func testMapFinancesCreatesHoldingTree() throws {
        let json = """
        {
          "lastUpdated": "2026-04-29",
          "retirement": {
            "401k": {
              "provider": "Discount Tire 401(k)",
              "weeklyContribution": 291.6,
              "total": 773307.46,
              "holdings": [
                {
                  "name": "VOO",
                  "category": "Large Cap",
                  "value": 601281.38,
                  "costBasis": 213109.93,
                  "gainPct": 182.15,
                  "shares": 932.42,
                  "avgCost": 228.56,
                  "currentPricePerShare": 644.86,
                  "ticker": "VOO",
                  "lots": [
                    {"date":"2026-03-07","type":"conversion_baseline","pricePerShare":619.85,"shares":929.097,"amountInvested":211068.73}
                  ]
                }
              ]
            }
          }
        }
        """.data(using: .utf8)!

        let finances = try JSONDecoder().decode(LegacyFinancesDTO.self, from: json)
        let accounts = LedgerMapper.mapFinances(finances, owner: .victor)

        let k401 = try XCTUnwrap(accounts.first(where: { $0.name == "401k" }))
        XCTAssertEqual(k401.provider, "Discount Tire 401(k)")
        XCTAssertEqual(k401.ownerMember, .victor)
        assertDecimalClose(k401.totalValue, 773_307.46)
        assertDecimalClose(k401.weeklyContribution, 291.6)
        XCTAssertEqual(k401.holdings.count, 1)
        XCTAssertEqual(k401.holdings[0].ticker, "VOO")
        XCTAssertEqual(k401.holdings[0].lots.count, 1)
        XCTAssertEqual(k401.holdings[0].lots[0].type, "conversion_baseline")
    }

    // MARK: - son-balances.json

    func testDecodeSonBalances() throws {
        let json = """
        {"strike":0.00667448,"river":0.02497671,"coldcard":0.75072814,"total":0.78237933,"lastUpdated":"2026-04-24"}
        """.data(using: .utf8)!

        let son = try JSONDecoder().decode(LegacySonBalancesDTO.self, from: json)
        assertDecimalClose(son.total, 0.78237933)
        assertDecimalClose(son.coldcard, 0.75072814)
    }

    func testMapSonBalancesCreatesMasonAccounts() {
        let son = LegacySonBalancesDTO(strike: 0.00667, river: 0.02497, coldcard: 0.75072, total: 0.78236, lastUpdated: "2026-04-24")
        let accounts = LedgerMapper.mapSonBalances(son)

        XCTAssertEqual(accounts.count, 3)
        for acct in accounts {
            XCTAssertEqual(acct.ownerMember, .mason)
            XCTAssertTrue(acct.key.hasSuffix("-mason"))
        }

        let coldcard = accounts.first(where: { $0.label == "Coldcard" })
        XCTAssertEqual(coldcard?.custody, .selfCustody)
        XCTAssertEqual(coldcard?.btc, 0.75072) // Exact — created from Decimal literal
    }
}
