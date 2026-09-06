// Mason's Budget App — Budget month-scoping regression tests
//
// A budget is for one month. Its spend must come from that month's transactions
// and no others — "July should only show July transactions, June should only
// show June" (Victor, 2026-07-26).
//
// iOS has always derived budget spend this way, which is why the Linux and
// Android clients were changed to match it. Nothing pinned it here, so the
// behaviour the other two clients now copy was itself unguarded. These are the
// Swift mirror of shared/domain/test/month.test.ts.
//
// BudgetView's month logic lives in private computed properties on the view and
// SwiftUI offers no way to read them from a test, so the predicates are
// duplicated below. They are copied verbatim from BudgetView; if you change one
// you must change the other, and these tests are what tells you that you did not.

import Foundation
import XCTest

final class BudgetMonthScopingTests: XCTestCase {
    // A fixed UTC calendar so the assertions do not depend on the machine's
    // locale or zone. BudgetView uses Calendar.current; the rule under test —
    // isDate(_:equalTo:toGranularity: .month) — is the same either way.
    private let calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .gmt
        return cal
    }()

    // MARK: - Mirrors of BudgetView

    /// Mirrors `BudgetView.monthTransactions`.
    private func monthTransactions(
        _ transactions: [Transaction],
        member: FamilyMember,
        month: Date,
    ) -> [Transaction] {
        transactions.filter { tx in
            member.sharesNetWorth(with: tx.ownerMember) &&
                calendar.isDate(tx.date, equalTo: month, toGranularity: .month)
        }
    }

    /// Mirrors `BudgetView.monthSpent`.
    private func monthSpent(_ transactions: [Transaction], member: FamilyMember, month: Date) -> Decimal {
        monthTransactions(transactions, member: member, month: month)
            .reduce(Decimal(0)) { $0 + $1.spendAmount }
    }

    /// Mirrors `BudgetView.spentInCategory(_:)`.
    private func spentInCategory(
        _ name: String,
        in transactions: [Transaction],
        member: FamilyMember,
        month: Date,
    ) -> Decimal {
        monthTransactions(transactions, member: member, month: month)
            .filter { $0.category == name && $0.isSpend }
            .reduce(Decimal(0)) { $0 + $1.spendAmount }
    }

    /// Mirrors `BudgetView.spentForOffset(_:)`, with `now` injected because the
    /// view reads `Date()` directly and a test cannot pin that.
    private func spentForOffset(
        _ offset: Int,
        in transactions: [Transaction],
        member: FamilyMember,
        now: Date,
    ) throws -> Decimal {
        let date = try XCTUnwrap(calendar.date(byAdding: .month, value: -offset, to: now))
        return transactions.filter { tx in
            member.sharesNetWorth(with: tx.ownerMember) &&
                calendar.isDate(tx.date, equalTo: date, toGranularity: .month) &&
                tx.isSpend
        }.reduce(Decimal(0)) { $0 + $1.spendAmount }
    }

    // MARK: - Filtering

    func testJulyKeepsOnlyJuly() throws {
        let july = monthTransactions(try sampleTransactions(), member: .victor, month: try monthAnchor(2026, 7))
        XCTAssertEqual(july.map(\.id), ["jul-26-groceries", "jul-02-groceries"])
    }

    func testJuneKeepsOnlyJune() throws {
        let june = monthTransactions(try sampleTransactions(), member: .victor, month: try monthAnchor(2026, 6))
        XCTAssertEqual(june.map(\.id), ["jun-30-groceries", "jun-01-dining"])
    }

    func testAdjacentDaysDoNotBleedAcrossTheBoundary() throws {
        // 2026-06-30 and 2026-08-01 are one day either side of July.
        let july = monthTransactions(try sampleTransactions(), member: .victor, month: try monthAnchor(2026, 7))

        XCTAssertFalse(july.contains { $0.id == "jun-30-groceries" }, "June 30 leaked into July")
        XCTAssertFalse(july.contains { $0.id == "aug-01-groceries" }, "August 1 leaked into July")
    }

    func testCategoryDetailShowsOnlySelectedMonthTransactions() throws {
        let juneGroceries = CategoryDetailView.transactions(
            try sampleTransactions(),
            visibleTo: .victor,
            category: "Groceries",
            selectedMonth: try monthAnchor(2026, 6),
            calendar: calendar,
        )

        XCTAssertEqual(juneGroceries.map(\.id), ["jun-30-groceries"])
    }

    func testFirstAndLastInstantOfTheMonthBelongToIt() throws {
        let firstMoment = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 7, day: 1, hour: 0, minute: 0, second: 0)),
        )
        let lastMoment = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 7, day: 31, hour: 23, minute: 59, second: 59)),
        )
        let edges = [
            transaction(id: "jul-first", date: firstMoment, amount: 1, category: "Groceries"),
            transaction(id: "jul-last", date: lastMoment, amount: 2, category: "Groceries"),
        ]

        let july = monthTransactions(edges, member: .victor, month: try monthAnchor(2026, 7))
        XCTAssertEqual(july.count, 2, "A budget month must include its own first and last day")
        XCTAssertEqual(monthSpent(edges, member: .victor, month: try monthAnchor(2026, 7)), 3)
    }

    func testMonthWithNoTransactionsIsEmptyNotEverything() throws {
        let transactions = try sampleTransactions()
        XCTAssertTrue(monthTransactions(transactions, member: .victor, month: try monthAnchor(2026, 3)).isEmpty)
        XCTAssertTrue(monthTransactions([], member: .victor, month: try monthAnchor(2026, 7)).isEmpty)
    }

    // MARK: - Totals

    func testJulyTotalCountsOnlyJuly() throws {
        let transactions = try sampleTransactions()
        let july = try monthAnchor(2026, 7)

        XCTAssertEqual(monthSpent(transactions, member: .victor, month: july), 150, "100 + 50 from July only")
        XCTAssertEqual(spentInCategory("Groceries", in: transactions, member: .victor, month: july), 150)
        XCTAssertEqual(
            spentInCategory("Dining", in: transactions, member: .victor, month: july),
            0,
            "the only Dining row is June's",
        )
    }

    func testJuneTotalCountsOnlyJune() throws {
        let transactions = try sampleTransactions()
        let june = try monthAnchor(2026, 6)

        XCTAssertEqual(monthSpent(transactions, member: .victor, month: june), 1039)
        XCTAssertEqual(spentInCategory("Groceries", in: transactions, member: .victor, month: june), 999)
        XCTAssertEqual(spentInCategory("Dining", in: transactions, member: .victor, month: june), 40)
    }

    func testSameTransactionsGiveDifferentAnswersPerMonth() throws {
        // The regression this whole file exists for.
        let transactions = try sampleTransactions()
        let july = monthSpent(transactions, member: .victor, month: try monthAnchor(2026, 7))
        let june = monthSpent(transactions, member: .victor, month: try monthAnchor(2026, 6))

        XCTAssertNotEqual(july, june)
        XCTAssertEqual(july, 150)
        XCTAssertEqual(june, 999 + 40)
    }

    func testMonthStripOffsetsSelectDistinctMonths() throws {
        // The strip drives the same scoping by offset from today, so an offset
        // that resolves to the wrong month is the same bug wearing a hat.
        let transactions = try sampleTransactions()
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 7, day: 26, hour: 12)))

        XCTAssertEqual(try spentForOffset(0, in: transactions, member: .victor, now: now), 150)
        XCTAssertEqual(try spentForOffset(1, in: transactions, member: .victor, now: now), 1039)
        XCTAssertEqual(try spentForOffset(2, in: transactions, member: .victor, now: now), 777)
        XCTAssertEqual(try spentForOffset(4, in: transactions, member: .victor, now: now), 0, "March has nothing")
    }

    func testEmptyTransactionSetIsZeroNotACrash() throws {
        XCTAssertEqual(monthSpent([], member: .victor, month: try monthAnchor(2026, 7)), 0)
        XCTAssertEqual(spentInCategory("Groceries", in: [], member: .victor, month: try monthAnchor(2026, 7)), 0)
    }

    // MARK: - Sign handling

    func testIncomeIsNotSpend() throws {
        let salary = transaction(
            id: "jul-15-salary",
            date: try makeDate(2026, 7, 15),
            amount: 5000,
            category: "Income",
        )
        let transactions = try sampleTransactions() + [salary]
        let july = try monthAnchor(2026, 7)

        XCTAssertEqual(monthSpent(transactions, member: .victor, month: july), 150, "a paycheck is not spending")
        XCTAssertEqual(spentInCategory("Income", in: transactions, member: .victor, month: july), 0)
    }

    func testChildPositiveMagnitudeRowsStillCountAsSpend() throws {
        // Adult and child purchases are both positive; category distinguishes
        // Income from spending.
        let masonSpend = transaction(
            id: "jul-10-game",
            date: try makeDate(2026, 7, 10),
            amount: 24,
            category: "Entertainment",
            owner: .mason,
        )

        XCTAssertTrue(masonSpend.isSpend, "A positive child row is spending, not income")
        XCTAssertEqual(masonSpend.spendAmount, 24)
        XCTAssertEqual(
            spentInCategory("Entertainment", in: [masonSpend], member: .mason, month: try monthAnchor(2026, 7)),
            24,
        )
    }

    func testChildSpendIsStillMonthScoped() throws {
        let rows = [
            transaction(id: "jul-10-game", date: try makeDate(2026, 7, 10), amount: 24, category: "Entertainment", owner: .mason),
            transaction(id: "jun-10-game", date: try makeDate(2026, 6, 10), amount: 11, category: "Entertainment", owner: .mason),
        ]

        XCTAssertEqual(monthSpent(rows, member: .mason, month: try monthAnchor(2026, 7)), 24)
        XCTAssertEqual(monthSpent(rows, member: .mason, month: try monthAnchor(2026, 6)), 11)
    }

    // MARK: - Month scoping does not weaken household scoping

    func testRachelSeesTheSameJulyTotalAsVictor() throws {
        // Canonical adult records default to owner "victor". Month scoping must not be
        // the thing that empties Rachel's budget screen. That bug shipped in v0.3.
        let transactions = try sampleTransactions()
        let july = try monthAnchor(2026, 7)

        XCTAssertEqual(
            monthSpent(transactions, member: .rachel, month: july),
            monthSpent(transactions, member: .victor, month: july),
        )
        XCTAssertEqual(monthSpent(transactions, member: .rachel, month: july), 150)
    }

    func testChildStacksStayOutOfTheAdultMonthTotal() throws {
        let transactions = try sampleTransactions() + [
            transaction(id: "jul-10-game", date: try makeDate(2026, 7, 10), amount: 24, category: "Entertainment", owner: .mason),
        ]

        XCTAssertEqual(
            monthSpent(transactions, member: .victor, month: try monthAnchor(2026, 7)),
            150,
            "Mason's spending is visible to adults elsewhere but never rolls into the household budget",
        )
    }

    // MARK: - Helpers

    /// Noon avoids any ambiguity about which day a fixture lands on.
    private func makeDate(_ year: Int, _ month: Int, _ day: Int) throws -> Date {
        try XCTUnwrap(calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12)))
    }

    /// An anchor inside the month — BudgetView compares to month granularity, so
    /// any instant in the month identifies it.
    private func monthAnchor(_ year: Int, _ month: Int) throws -> Date {
        try makeDate(year, month, 15)
    }

    private func transaction(
        id: String,
        date: Date,
        amount: Decimal,
        category: String,
        owner: FamilyMember = .victor,
    ) -> Transaction {
        Transaction(
            id: id,
            date: date,
            merchant: "Sample",
            amount: amount,
            category: category,
            owner: owner,
            createdBy: "mc2",
        )
    }

    /// The same spread as MIXED in shared/domain/test/month.test.ts.
    private func sampleTransactions() throws -> [Transaction] {
        [
            transaction(id: "jul-26-groceries", date: try makeDate(2026, 7, 26), amount: 100, category: "Groceries"),
            transaction(id: "jul-02-groceries", date: try makeDate(2026, 7, 2), amount: 50, category: "Groceries"),
            transaction(id: "jun-30-groceries", date: try makeDate(2026, 6, 30), amount: 999, category: "Groceries"),
            transaction(id: "jun-01-dining", date: try makeDate(2026, 6, 1), amount: 40, category: "Dining"),
            transaction(id: "may-15-groceries", date: try makeDate(2026, 5, 15), amount: 777, category: "Groceries"),
            transaction(id: "aug-01-groceries", date: try makeDate(2026, 8, 1), amount: 888, category: "Groceries"),
        ]
    }
}

/// Copy-forward tests exercise the production decision and wire helpers.
extension BudgetMonthScopingTests {
    func testCopyPlanSharedFixtures() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/domain/fixtures/budget-plan-carry-cases.json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let accepted = try XCTUnwrap(fixture["accepted"] as? [[String: Any]])
        for row in accepted {
            let intent = try XCTUnwrap(carryEligibility(row).intent, row["name"] as? String ?? "")
            XCTAssertEqual(intent.owner.rawValue, row["expectedOwner"] as? String)
            XCTAssertEqual(intent.sourceFile, row["expectedSourceFile"] as? String)
            XCTAssertEqual(intent.fromMonth, row["expectedFromMonth"] as? String)
            XCTAssertEqual(intent.toMonth, row["expectedToMonth"] as? String)
        }
        for row in try XCTUnwrap(fixture["rejected"] as? [[String: Any]]) {
            var input = try XCTUnwrap(accepted.first)
            input.merge(row) { _, value in value }
            input.merge(row["replace"] as? [String: Any] ?? [:]) { _, value in value }
            XCTAssertEqual(carryEligibility(input).rejection?.rawValue, row["reason"] as? String)
        }
    }

    private func carryEligibility(_ row: [String: Any]) -> BudgetPlanCarryEligibility {
        BudgetPlanCarry.eligibility(
            activeProfile: FamilyMember(rawValue: row["activeProfile"] as? String ?? "") ?? .maddox,
            currentMonth: row["currentMonth"] as? String ?? "",
            selectedMonth: row["selectedMonth"] as? String,
            budgetOwner: FamilyMember(rawValue: row["budgetOwner"] as? String ?? "") ?? .maddox,
            budgetMonth: row["budgetMonth"] as? String ?? "",
            budgetUpdatedAtMs: 1_787_654_321_000,
            baseUpdatedAtMs: row["baseUpdatedAtMs"] as? Double ?? 0,
        )
    }

    func testCopyPlanNormalizesOnlySupportedStoredMonthLabels() {
        XCTAssertEqual(BudgetPlanCarry.canonicalStoredMonth("August 2026"), "2026-08")
        XCTAssertEqual(BudgetPlanCarry.canonicalStoredMonth("December 2026"), "2026-12")
        XCTAssertEqual(BudgetPlanCarry.canonicalStoredMonth("2026-09"), "2026-09")
        for invalid in ["Sep 2026", "September 26", "September  2026", "2026-9", "2026-13"] {
            XCTAssertNil(BudgetPlanCarry.canonicalStoredMonth(invalid))
        }
    }

    func testCopyPlanWireIsPlanOnlyAndRevisionFenced() throws {
        let intent = BudgetPlanCarryIntent(owner: .victor, sourceFile: "budget", fromMonth: "2026-08", toMonth: "2026-09", baseUpdatedAtMs: 100)
        let args = AppWritebackClient.budgetPlanCarryArguments(intent, deviceID: "test-device", deviceToken: "test-token")
        XCTAssertEqual(Set(args.keys), Set(["deviceId", "deviceToken", "owner", "sourceFile", "fromMonth", "toMonth", "baseUpdatedAtMs"]))
        XCTAssertEqual(args["baseUpdatedAtMs"] as? Int64, 100)
        XCTAssertEqual(args["owner"] as? String, "victor")
        XCTAssertEqual(args["sourceFile"] as? String, "budget")
        XCTAssertEqual(BudgetPlanCarry.mutationPath, "tables:copyBudgetPlanForwardFromDevice")
        var response: [String: Any] = [
            "ok": true, "outcome": "copied", "sourceFile": "budget", "fromMonth": "2026-08", "toMonth": "2026-09",
            "categoryCount": 4.0, "updatedAtMs": 101.0,
        ]
        XCTAssertNoThrow(try AppWritebackClient.validateBudgetPlanCarryResponse(response, intent: intent))
        response["outcome"] = "already-copied"
        XCTAssertNoThrow(try AppWritebackClient.validateBudgetPlanCarryResponse(response, intent: intent))
        response["toMonth"] = "2026-10"
        XCTAssertThrowsError(try AppWritebackClient.validateBudgetPlanCarryResponse(response, intent: intent))
        response["toMonth"] = "2026-09"
        response["updatedAtMs"] = 100.0
        XCTAssertThrowsError(try AppWritebackClient.validateBudgetPlanCarryResponse(response, intent: intent))
        response["updatedAtMs"] = 101.0
        response["categoryCount"] = -1.0
        XCTAssertThrowsError(try AppWritebackClient.validateBudgetPlanCarryResponse(response, intent: intent))
    }
}
