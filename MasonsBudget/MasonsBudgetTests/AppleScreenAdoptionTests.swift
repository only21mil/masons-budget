import XCTest

final class AppleScreenAdoptionTests: XCTestCase {
    func testPrimaryScreenCatalogMatchesAppleNavigation() {
        XCTAssertEqual(
            ApplePrimaryScreen.allCases,
            [.bitcoin, .budget, .today, .retirement, .more],
        )
        XCTAssertEqual(AppTab.allCases, [.home, .budget, .today, .vault, .more])
    }

    func testMoreCatalogIncludesFullAdoptionRoutes() {
        XCTAssertEqual(Set(AppleMoreScreen.allCases.map(\.rawValue)).count, AppleMoreScreen.allCases.count)
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
    }

    func testMoreCountBadgesHideZeroAndCapLargeCounts() {
        XCTAssertNil(MoreCountFormatter.badge(0))
        XCTAssertEqual(MoreCountFormatter.badge(8), "8")
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
}
