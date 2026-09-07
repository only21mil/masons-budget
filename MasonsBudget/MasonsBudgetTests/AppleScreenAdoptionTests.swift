import XCTest

final class AppleScreenAdoptionTests: XCTestCase {
    func testPrimaryScreenCatalogMatchesAppleNavigation() {
        XCTAssertEqual(
            ApplePrimaryScreen.allCases,
            [.bitcoin, .budget, .today, .retirement, .more],
        )
        XCTAssertEqual(AppTab.allCases, [.home, .budget, .today, .vault, .more])
    }

    func testTabTitlesAreUppercaseLedgerLabels() {
        XCTAssertEqual(AppTab.allCases.map(\.tabTitle), ["BITCOIN", "BUDGET", "TODAY", "VAULT", "MORE"])
    }

    func testMoreCatalogIncludesFullAdoptionRoutes() {
        XCTAssertEqual(Set(AppleMoreScreen.allCases.map(\.rawValue)).count, AppleMoreScreen.allCases.count)
        XCTAssertEqual(AppleMoreScreen.allCases.count, 12)
        XCTAssertTrue(AppleMoreScreen.allCases.contains(.price))
        XCTAssertTrue(AppleMoreScreen.allCases.contains(.transfer))
        XCTAssertTrue(AppleMoreScreen.allCases.contains(.billPay))
        XCTAssertTrue(AppleMoreScreen.allCases.contains(.family))
        XCTAssertTrue(AppleMoreScreen.allCases.contains(.settings))
        XCTAssertTrue(AppleMoreScreen.allCases.contains(.awards))
        XCTAssertTrue(AppleMoreScreen.allCases.contains(.export))
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

    func testOnboardingHasThreeAuthoredSteps() {
        XCTAssertEqual(OnboardingStep.all.count, 3)
        XCTAssertEqual(OnboardingStep.all.map(\.eyebrow), ["01 · LEDGER", "02 · FAMILY", "03 · READY"])
        XCTAssertEqual(OnboardingStep.progressLabel(for: 0), "Step 1 of 3")
        XCTAssertEqual(OnboardingStep.progressLabel(for: 2), "Step 3 of 3")
    }

    func testMoreCountBadgesHideZeroAndCapLargeCounts() {
        XCTAssertNil(MoreCountFormatter.badge(0))
        XCTAssertEqual(MoreCountFormatter.badge(8), "8")
        XCTAssertEqual(MoreCountFormatter.badge(AppleMoreScreen.allCases.count), "12")
        XCTAssertEqual(MoreCountFormatter.badge(1000), "999+")
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

    func testCategoryDeletionMonthKeyDefaultsToUTC() throws {
        // 2026-01-31 23:30 UTC is still January UTC; local Americas zones are
        // already February. Eligibility must follow server trustedCurrentMonth.
        let nearUtcMonthEdge = Date(timeIntervalSince1970: 1_769_902_200)
        XCTAssertEqual(CategoryDetailView.monthKey(for: nearUtcMonthEdge), "2026-01")
        XCTAssertEqual(
            CategoryDetailView.monthKey(for: nearUtcMonthEdge, calendar: CategoryDetailView.utcMonthCalendar),
            "2026-01",
        )
    }

    func testCategoryDeletionIntentAcceptsLegacyEnglishBudgetMonth() throws {
        let document = ConvexBudgetDocumentRow(
            owner: .victor,
            month: "July 2026",
            coinbaseOneBalanceCents: 0,
            categories: [
                .init(name: "Groceries", icon: nil, budgetCents: 10_000),
            ],
            effectiveApr: nil,
            strategyNote: nil,
            income: nil,
            mtdIncomeCents: 0,
            ytdIncomeCents: 0,
            monthlyHistory: [],
            updatedAtMs: 42,
        )
        let intent = try document.categoryDeletionIntent(
            viewer: .victor,
            trustedCurrentMonth: "2026-07",
            categoryName: "Groceries",
        )
        XCTAssertEqual(intent.month, "2026-07")
        XCTAssertEqual(intent.categoryName, "Groceries")
    }
}
