import XCTest

final class AppleScreenAdoptionTests: XCTestCase {
    func testPrimaryScreenCatalogMatchesAppleNavigation() {
        XCTAssertEqual(
            ApplePrimaryScreen.allCases,
            [.home, .activity, .budget, .tasks],
        )
        XCTAssertEqual(AppTab.allCases, [.home, .activity, .budget, .tasks])
    }

    func testTabTitlesAreUppercaseLedgerLabels() {
        XCTAssertEqual(AppTab.allCases.map(\.tabTitle), ["HOME", "ACTIVITY", "BUDGET", "TASKS"])
    }

    func testAvatarCatalogKeepsAccountDestinationsAccessible() {
        XCTAssertEqual(AppleAccountScreen.allCases, [.profile, .settings, .family, .awards, .sync, .export])
        XCTAssertTrue(MacNav.taskItems.contains(.tasks))
    }

    func testHomeTodayMatchesActivityVisibilityAndLocalDay() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: -6 * 3600))
        let today = Date(timeIntervalSince1970: 1_800_000_000)
        let yesterday = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: today))
        let rows = [
            Transaction(id: "adult", date: today, merchant: "Grocer", amount: 20, category: "Food", owner: .victor, createdBy: "victor"),
            Transaction(id: "refund", date: today, merchant: "Return", amount: -5, category: "Food", owner: .victor, createdBy: "victor"),
            Transaction(id: "child", date: today, merchant: "Lunch", amount: 3, category: "Food", owner: .mason, createdBy: "mason"),
            Transaction(id: "old", date: yesterday, merchant: "Old", amount: 99, category: "Food", owner: .victor, createdBy: "victor"),
            Transaction(id: "income", date: today, merchant: "Legacy pay", amount: 100, category: "Income", owner: .victor, createdBy: "victor"),
        ]
        XCTAssertEqual(HomeDashboardData.spentToday(rows, viewer: .rachel, now: today, calendar: calendar), 18)
        XCTAssertEqual(HomeDashboardData.spentToday(rows, viewer: .mason, now: today, calendar: calendar), 3)
        XCTAssertEqual(HomeDashboardData.spentToday(rows, viewer: .maddox, now: today, calendar: calendar), 0)
    }

    func testHomeBudgetExcludesIncomeCategoriesRegardlessOfCase() {
        let expenses: [ConvexBudgetDocumentRow.Category] = [
            .init(name: "Housing", icon: nil, budgetCents: 200_000),
            .init(name: "Food", icon: nil, budgetCents: 100_025),
        ]
        for incomeName in ["Income", "income", "INCOME", "iNcOmE"] {
            let income = ConvexBudgetDocumentRow.Category(name: incomeName, icon: nil, budgetCents: 500_000)
            XCTAssertEqual(HomeDashboardData.plannedExpenseTotal(expenses + [income]), Decimal(300025) / 100)
            XCTAssertEqual(HomeDashboardData.plannedExpenseTotal([income]), 0)
        }
        XCTAssertEqual(HomeDashboardData.plannedExpenseTotal([]), 0)
    }

    func testHomeBudgetRequiresCanonicalCurrentMonth() {
        XCTAssertTrue(HomeDashboardData.isCurrentBudgetMonth("2026-09", currentMonth: "2026-09"))
        XCTAssertTrue(HomeDashboardData.isCurrentBudgetMonth("September 2026", currentMonth: "2026-09"))
        XCTAssertFalse(HomeDashboardData.isCurrentBudgetMonth("August 2026", currentMonth: "2026-09"))
        XCTAssertFalse(HomeDashboardData.isCurrentBudgetMonth("2026-10", currentMonth: "2026-09"))
        XCTAssertFalse(HomeDashboardData.isCurrentBudgetMonth("", currentMonth: "2026-09"))
    }

    func testTodayIncomeUsesLocalDayAndRootRetainsHistory() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: -6 * 3600))
        // September 14 at 01:00 UTC is still September 13 locally.
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-09-14T01:00:00Z"))
        XCTAssertTrue(ActivityDateScope.includesIncomeDate("2026-09-13", todayOnly: true, now: now, calendar: calendar))
        XCTAssertFalse(ActivityDateScope.includesIncomeDate("2026-09-14", todayOnly: true, now: now, calendar: calendar))
        XCTAssertFalse(ActivityDateScope.includesIncomeDate("2026-09-12", todayOnly: true, now: now, calendar: calendar))
        XCTAssertTrue(ActivityDateScope.includesIncomeDate("2026-09-12", todayOnly: false, now: now, calendar: calendar))
    }

    func testPaymentRailsUseBoltAndChainPresentation() {
        XCTAssertEqual(PaymentRailPresentation.allCases.map(\.rawValue), ["Bolt", "Chain"])
        XCTAssertEqual(ActivityView.TxFilter.lightning.rail, .bolt)
        XCTAssertEqual(ActivityView.TxFilter.onChain.rail, .chain)
        XCTAssertEqual(TransactionSourceCatalog.activityRail(forCard: "lightning"), .lightning)
        XCTAssertEqual(TransactionSourceCatalog.activityRail(forCard: "on-chain"), .onChain)
        XCTAssertEqual(PaymentRailPresentation.forCard("zeus_lightning"), .bolt)
        XCTAssertEqual(PaymentRailPresentation.forCard("zeus_on_chain"), .chain)
        XCTAssertEqual(PaymentRailPresentation.forCard(nil), .chain)
        XCTAssertNil(PaymentRailPresentation.forCard("coinbase_card"))
    }

    func testFamilyScopeKeepsTasksPrivateAndAdultNetWorthHouseholdOnly() {
        XCTAssertEqual(
            FamilyScopePresentation.forMember(.rachel),
            FamilyScopePresentation(
                finance: "Adult household + child oversight",
                tasks: "Rachel only",
                netWorth: "Adult household only",
            ),
        )
        XCTAssertEqual(
            FamilyScopePresentation.forMember(.mason),
            FamilyScopePresentation(
                finance: "Mason only",
                tasks: "Mason only",
                netWorth: "Mason only",
            ),
        )
    }

    func testRiverBillPayFeeAlwaysRequiresManualValue() {
        XCTAssertNil(RiverBillPayFeePolicy.fee(forAmount: 29999, manualFee: nil))
        XCTAssertNil(RiverBillPayFeePolicy.fee(forAmount: 30000, manualFee: nil))
        XCTAssertNil(RiverBillPayFeePolicy.fee(forAmount: 30001, manualFee: nil))
        XCTAssertEqual(
            RiverBillPayFeePolicy.fee(forAmount: 30000, manualFee: Decimal(string: "28.55")),
            Decimal(string: "28.55"),
        )
    }

    func testOnboardingEndsWithSyncSetup() {
        XCTAssertEqual(OnboardingStep.all.count, 4)
        XCTAssertEqual(OnboardingStep.all.map(\.eyebrow), ["01 · LEDGER", "02 · FAMILY", "03 · READY", "04 · CONNECT"])
        XCTAssertEqual(OnboardingStep.progressLabel(for: 0), "Step 1 of 4")
        XCTAssertEqual(OnboardingStep.progressLabel(for: 2), "Step 3 of 4")
        XCTAssertEqual(OnboardingStep.all.last?.title, "Connect your household")
    }

    func testCompletedTodayIncludesSecureTaskRowsWithoutChangingOwnership() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let now = Date(timeIntervalSince1970: 1_767_268_800)
        let todo = TodoItem(
            id: "completed-today",
            title: "Reconcile ledger",
            dueDate: now,
            isDone: true,
            owner: .mason,
            completedAt: now,
            updatedAtMs: 42,
        )

        XCTAssertTrue(TodayView.wasCompletedToday(todo, now: now, calendar: calendar))
        XCTAssertEqual(todo.ownerMember, .mason)
        XCTAssertEqual(todo.updatedAtMs, 42)
    }

    func testCategoryDeletionMonthKeyUsesInjectedCalendar() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let date = Date(timeIntervalSince1970: 1_767_268_800)
        XCTAssertEqual(CategoryDetailView.monthKey(for: date, calendar: calendar), "2026-01")
    }
}
