import SwiftUI
import XCTest

final class AppleScreenAdoptionTests: XCTestCase {
    func testCachedMonthFormatterPreservesLocalizedHeadings() {
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        for locale in [Locale.current, Locale(identifier: "en_US_POSIX"), Locale(identifier: "fr_FR")] {
            let original = DateFormatter()
            original.locale = locale
            original.dateFormat = "MMMM yyyy"
            XCTAssertEqual(
                AppFormatter.monthFormatter(for: "MMMM yyyy", locale: locale).string(from: date),
                original.string(from: date),
            )
        }
    }

    func testCachedWireDayFormatterKeepsEachCallsTimeZone() throws {
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-03-01T01:00:00Z"))
        for (offset, expected) in [(-6, "2026-02-28"), (9, "2026-03-01"), (-6, "2026-02-28")] {
            let timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: offset * 3600))
            XCTAssertEqual(LegacyTransactionDTO.dateString(from: now, timeZone: timeZone), expected)
            let midnight = try XCTUnwrap(LegacyTransactionDTO.date(from: expected, timeZone: timeZone))
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            XCTAssertTrue(calendar.isDate(now, inSameDayAs: midnight))
            XCTAssertEqual(calendar.component(.hour, from: midnight), 0)
        }
    }

    func testCachedWireDayFormatterRepeatsSameZoneAfterDifferentZone() throws {
        let date = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-03-01T01:00:00Z"))
        let west = try XCTUnwrap(TimeZone(secondsFromGMT: -6 * 3600))
        let east = try XCTUnwrap(TimeZone(secondsFromGMT: 9 * 3600))
        let first = LegacyTransactionDTO.dateString(from: date, timeZone: west)
        XCTAssertEqual(first, "2026-02-28")
        XCTAssertEqual(LegacyTransactionDTO.dateString(from: date, timeZone: west), first)
        XCTAssertEqual(LegacyTransactionDTO.dateString(from: date, timeZone: east), "2026-03-01")
        XCTAssertEqual(LegacyTransactionDTO.dateString(from: date, timeZone: west), first)
    }

    func testRootAccessoryIsAvailableForEveryTabButNotPushedScreens() {
        var environment = EnvironmentValues()
        environment.ledgerRootAccessory = AnyView(EmptyView())
        for tab in AppTab.allCases {
            environment.ledgerRootTitle = tab.label
            XCTAssertNotNil(environment.ledgerRootAccessory(for: tab.label), tab.rawValue)
            XCTAssertNil(environment.ledgerRootAccessory(for: "Bill Pay"), tab.rawValue)
            XCTAssertNil(environment.ledgerRootAccessory(for: "Awards"), tab.rawValue)
            // LedgerDrilldown clears the root title even for a same-title destination.
            environment.ledgerRootTitle = ""
            XCTAssertNil(environment.ledgerRootAccessory(for: tab.label), tab.rawValue)
        }
    }

    func testPrimaryScreenCatalogMatchesAppleNavigation() {
        XCTAssertEqual(AppTab.allCases, [.home, .budget, .activity, .bitcoin, .tasks])
    }

    func testTabTitlesAreUppercaseLedgerLabels() {
        XCTAssertEqual(AppTab.allCases.map(\.tabTitle), ["HOME", "BUDGET", "ACTIVITY", "BITCOIN", "TASKS"])
    }

    func testGearMenuKeepsAccountDestinationsAccessible() {
        XCTAssertEqual(GearDestination.allCases, [.family, .settings, .export])
        XCTAssertTrue(MacNav.primaryItems.contains(.tasks))
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

    func testHomeSpentTodayConsumesSharedMoneyOutFixtureWithExplicitAppleDifferences() throws {
        let bundle = Bundle(for: AppleScreenAdoptionTests.self)
        let name = "money-out-today-cases"
        let url = bundle.url(forResource: name, withExtension: "json")
            ?? bundle.url(forResource: name, withExtension: "json", subdirectory: "fixtures")
        let fixture = try JSONDecoder().decode(
            MoneyOutTodayFixture.self, from: Data(contentsOf: try XCTUnwrap(url)),
        )
        XCTAssertEqual(fixture.contractVersion, 1)
        XCTAssertEqual(Set(fixture.cases.map(\.activeProfile)), Set(FamilyMember.allCases.map(\.rawValue)))

        let dtos = try fixture.transactions.map { row in
            LegacyTransactionDTO(
                id: row.id, date: row.date, merchant: row.id,
                amount: try fixtureDollars(row.amountCents), category: row.category,
                card: nil, note: nil, owner: try XCTUnwrap(FamilyMember(rawValue: row.owner)),
            )
        }
        let transactions = LedgerMapper.mapTransactions(dtos)
        // The production mapper interprets wire days in the current time zone.
        let calendar = Calendar.current
        let now = try XCTUnwrap(LegacyTransactionDTO.date(from: fixture.date, timeZone: calendar.timeZone))
        let expectedHomeCents = ["victor": "3800", "rachel": "3800", "mason": "600", "maddox": "0"]

        for testCase in fixture.cases {
            let viewer = try XCTUnwrap(FamilyMember(rawValue: testCase.activeProfile))
            XCTAssertEqual(viewer.ledgerOwner.rawValue, testCase.expectedOwner)
            let sharedSourceIds = Set(testCase.expectedSourceIds)
            let sharedTransactions = transactions.filter { sharedSourceIds.contains($0.id) }
            let sharedBills = fixture.billPays.filter { sharedSourceIds.contains($0.id) }
            XCTAssertEqual(
                sharedSourceIds, Set(sharedTransactions.map(\.id) + sharedBills.map(\.id)),
                testCase.activeProfile,
            )
            let excludedBills = try sharedBills.reduce(Decimal(0)) { total, bill in
                try total + fixtureDollars(bill.principalCents) + fixtureDollars(bill.feeUsdCents)
            }
            let sharedTotal = try fixtureDollars(testCase.expectedTotalCents)
            // The 2026-09-17 audit records Home's transaction-only total:
            // bill principal AND fees stay out, unlike shared Money Out Today.
            XCTAssertEqual(
                HomeDashboardData.spentToday(sharedTransactions, viewer: viewer, now: now, calendar: calendar),
                sharedTotal - excludedBills, testCase.activeProfile,
            )
            XCTAssertEqual(excludedBills, viewer.isAdult ? Decimal(1025) / 100 : (viewer == .mason ? Decimal(205) / 100 : 0))

            // Apple also counts legacy Credit Card Payment transactions as spend,
            // and canSee gives adults child spending oversight on Home.
            // Pin both differences explicitly instead of dropping fixture rows.
            let cardPayment = try XCTUnwrap(transactions.first { $0.id == "adult-card-transfer" })
            XCTAssertEqual(
                HomeDashboardData.spentToday([cardPayment], viewer: viewer, now: now, calendar: calendar),
                viewer.isAdult ? 30 : 0, testCase.activeProfile,
            )
            let childSpend = try XCTUnwrap(transactions.first { $0.id == "mason-spend" })
            XCTAssertEqual(
                HomeDashboardData.spentToday([childSpend], viewer: viewer, now: now, calendar: calendar),
                viewer == .maddox ? 0 : 6, testCase.activeProfile,
            )
            let actual = HomeDashboardData.spentToday(transactions, viewer: viewer, now: now, calendar: calendar)
            XCTAssertEqual(actual, sharedTotal - excludedBills + (viewer.isAdult ? 36 : 0), testCase.activeProfile)
            XCTAssertEqual(actual, try fixtureDollars(XCTUnwrap(expectedHomeCents[testCase.activeProfile])), testCase.activeProfile)
        }
    }

    private func fixtureDollars(_ cents: String) throws -> Decimal {
        try XCTUnwrap(Decimal(string: cents, locale: Locale(identifier: "en_US_POSIX"))) / 100
    }

    private struct MoneyOutTodayFixture: Decodable {
        let contractVersion: Int
        let date: String
        let transactions: [TransactionRow]
        let billPays: [BillPayRow]
        let cases: [ProfileCase]

        struct TransactionRow: Decodable {
            let id: String
            let date: String
            let amountCents: String
            let category: String
            let owner: String
        }

        struct BillPayRow: Decodable {
            let id: String
            let principalCents: String
            let feeUsdCents: String
        }

        struct ProfileCase: Decodable {
            let activeProfile: String
            let expectedOwner: String
            let expectedTotalCents: String
            let expectedSourceIds: [String]
        }
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

    func testHomeUnavailableHintMatchesReadConnectionRecovery() {
        // A missing read credential still needs setup after a previous sync error.
        for lastError in ["", "Offline"] {
            XCTAssertEqual(
                ContentView.readSyncMessage(hasReadToken: false, lastError: lastError),
                "Connect this device to load your household data.",
            )
            XCTAssertEqual(
                HomeDashboardData.netWorthUnavailableHint(hasReadToken: false),
                "Unavailable until this device is connected.",
            )
        }
        // Once reads are configured, absent balances or prices can request refresh.
        XCTAssertNil(ContentView.readSyncMessage(hasReadToken: true, lastError: ""))
        XCTAssertEqual(
            HomeDashboardData.netWorthUnavailableHint(hasReadToken: true),
            "Refresh balances and prices to calculate your total.",
        )
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
        XCTAssertEqual(OnboardingStep.all[1].title, "One household, separate profiles")
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

        XCTAssertTrue(SmartListFilter.wasCompletedToday(todo, now: now, calendar: calendar))
        XCTAssertEqual(todo.ownerMember, .mason)
        XCTAssertEqual(todo.updatedAtMs, 42)
    }

    func testCompletedTodayFilterPreservesVisibilityAndSupportsReopening() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: -6 * 3600))
        let now = Date(timeIntervalSince1970: 1_767_268_800)
        let yesterday = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: now))
        let adult = TodoItem(id: "adult", title: "Adult task", isDone: true, owner: .victor, completedAt: now)
        let child = TodoItem(id: "child", title: "Child task", isDone: true, owner: .mason, completedAt: now)
        let old = TodoItem(id: "old", title: "Old task", dueDate: now, isDone: true, completedAt: yesterday)
        let legacy = TodoItem(id: "legacy", title: "Legacy task", dueDate: now, isDone: true)
        let open = TodoItem(id: "open", title: "Open task", completedAt: now)
        let undated = TodoItem(id: "undated", title: "Undated task", isDone: true)
        let todos = [adult, child, old, legacy, open, undated]

        XCTAssertEqual(SmartListFilter.today.completedTodayItems(
            todos, viewer: .victor, now: now, calendar: calendar
        ).map(\.id), ["adult", "legacy"])
        XCTAssertEqual(SmartListFilter.today.completedTodayItems(
            todos, viewer: .mason, now: now, calendar: calendar
        ).map(\.id), ["child"])
        for filter in [SmartListFilter.inbox, .upcoming, .flagged] {
            XCTAssertTrue(filter.completedTodayItems(todos, viewer: .victor, now: now, calendar: calendar).isEmpty)
        }
        adult.isDone = false
        XCTAssertTrue(SmartListFilter.today.completedTodayItems(
            [adult], viewer: .victor, now: now, calendar: calendar
        ).isEmpty)
    }

    func testCategoryDeletionMonthKeyUsesInjectedCalendar() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let date = Date(timeIntervalSince1970: 1_767_268_800)
        XCTAssertEqual(CategoryDetailView.monthKey(for: date, calendar: calendar), "2026-01")
    }
}

#if os(macOS) && MAC_DESIGN_PACKET
    import AppKit
    import CoreText
    import SwiftData

    enum MacPacketDestination: Hashable {
        case billPay, awards
    }

    /// Installed on the packet target's Convex sessions, including tokenless reads.
    final class MacPacketNoNetwork: URLProtocol {
        override class func canInit(with _: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        }
        override func stopLoading() {}

        /// The same transport seam used by CanonicalFinancialSourceStoreTests.
        /// Known reads receive fixture rows; every other request fails offline.
        static func response(to request: URLRequest) throws -> (Data, URLResponse) {
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
            let path = try XCTUnwrap(body["path"] as? String)
            let day = LegacyTransactionDTO.dateString(from: LedgerClock.now, timeZone: TimeZone(secondsFromGMT: 0)!)
            let month = String(day.prefix(7))
            let integer = ConvexTaggedInt64Encoder.encode
            let row: [String: Any]
            switch path {
            case "tables:listBtcBalanceDocuments":
                let fixture = try MacPacketFixture.load(bundle: Bundle(for: AppleScreenAdoptionTests.self))
                let household = try fixture.sampleAccounts.filter {
                    try FamilyMember.victor.sharesNetWorth(with: XCTUnwrap(FamilyMember(rawValue: $0.owner)))
                }
                let accounts: [[String: Any]] = try household.map { account in
                    let btc = try XCTUnwrap(Decimal(string: account.btc))
                    return ["key": account.key, "label": account.label, "custody": account.custody,
                            "sats": integer(NSDecimalNumber(decimal: btc * 100_000_000).int64Value)]
                }
                row = ["owner": "victor", "schemaVersion": integer(1), "asOf": day, "accounts": accounts,
                       "totals": ["sats": integer(355_000_000), "exchangeSats": integer(0), "selfCustodySats": integer(355_000_000)]]
            case "tables:listIncome":
                row = ["incomeId": "packet-income", "owner": "victor", "date": day, "month": month,
                       "amountCents": integer(500_000), "source": "Fixture paycheck", "updatedAtMs": 1]
            case "tables:listBtcBillPays":
                row = ["billPayId": "packet-bill", "owner": "victor", "date": day, "month": month,
                       "amountUsdCents": integer(10_000), "btcSpentSats": integer(100_000), "btcPriceCents": integer(10_000_000),
                       "feeUsdCents": integer(100), "budgetEffect": "budget_category", "merchant": "Electric company", "category": "Housing"]
            case "tables:getBudgetDocument":
                row = ["owner": "victor", "month": month, "coinbaseOneBalanceCents": integer(0),
                       "categories": ["Food", "Housing", "Transport"].map { name -> [String: Any] in
                           ["name": name, "budgetCents": integer(50_000)]
                       },
                       "mtdIncomeCents": integer(500_000), "ytdIncomeCents": integer(500_000), "monthlyHistory": [], "updatedAtMs": 1]
            default:
                throw URLError(.notConnectedToInternet)
            }
            let value: [String: Any] = path == "tables:getBudgetDocument"
                ? ["complete": true, "document": row] : ["complete": true, "rows": [row]]
            let data = try JSONSerialization.data(withJSONObject: ["status": "success", "value": value])
            return (data, try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: 200,
                                                      httpVersion: nil, headerFields: nil)))
        }
    }

    extension AppleScreenAdoptionTests {
        /// Review artifacts, not pixel baselines. Runs without MasonsBudgetApp or its lock/sync tasks.
        @MainActor
        func testMacDesignPacket() async throws {
            guard let path = ProcessInfo.processInfo.environment["MAC_DESIGN_PACKET_DIR"],
                  !path.isEmpty, !path.contains("$(")
            else { throw XCTSkip("Set MAC_DESIGN_PACKET_DIR to capture macOS fixture screens") }
            let directory = URL(fileURLWithPath: path, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

            // Override only this test process's preference search domain. Never migrate,
            // clear, or read host credentials; the packet target compiles those getters empty.
            let defaults = UserDefaults.standard
            let previousArguments = defaults.volatileDomain(forName: UserDefaults.argumentDomain)
            var arguments = previousArguments
            arguments.merge([
                "selected_family_member": FamilyMember.victor.rawValue,
                "display_unit": DisplayUnit.btc.rawValue,
                "appearance_mode": AppearanceMode.dark.rawValue,
                "app_lock_enabled": false,
                "AppleLanguages": ["en"],
                "AppleLocale": "en_US_POSIX",
                ConvexSyncService.versionsMemberKey: "victor",
                ConvexSyncService.lastSyncKey: 0.0,
                ConvexSyncService.lastSyncErrorKey: "",
                ConvexSyncService.dataVersionsKey: [String: Double](),
                MarketQuoteService.cacheKey: Data(),
                BTCPriceService.updatedAtKey: 0.0,
                LedgerPreference.reduceMotionKey: true,
                LedgerPreference.scanlinesKey: false,
                LedgerPreference.phosphorGlowKey: false,
            ]) { _, fixture in fixture }
            defaults.setVolatileDomain(arguments, forName: UserDefaults.argumentDomain)
            let previousTimeZone = NSTimeZone.default
            NSTimeZone.default = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
            let application = NSApplication.shared
            let previousAppearance = application.appearance
            application.appearance = NSAppearance(named: .darkAqua)
            defer {
                application.appearance = previousAppearance
                NSTimeZone.default = previousTimeZone
                defaults.setVolatileDomain(previousArguments, forName: UserDefaults.argumentDomain)
            }
            XCTAssertFalse(ConvexConfig.hasReadToken)
            XCTAssertFalse(ConvexConfig.hasSyncToken)
            XCTAssertFalse(AppWritebackConfig.isConfigured)

            let bundle = Bundle(for: AppleScreenAdoptionTests.self)
            let fonts = (bundle.urls(forResourcesWithExtension: "ttf", subdirectory: nil) ?? [])
                + (bundle.urls(forResourcesWithExtension: "ttf", subdirectory: "Fonts") ?? [])
            let registeredFonts = Set(fonts).filter { CTFontManagerRegisterFontsForURL($0 as CFURL, .process, nil) }
            defer {
                for font in registeredFonts { CTFontManagerUnregisterFontsForURL(font as CFURL, .process, nil) }
            }

            let schema = Schema([
                Transaction.self, BudgetCategory.self, MonthlyBudgetSnapshot.self,
                BTCAccount.self, BTCBuy.self, BTCBillPay.self, HoldingAccount.self,
                Holding.self, HoldingLot.self, SyncEvent.self, FamilyProfile.self,
                NetWorthSnapshot.self, TodoItem.self, TodoProject.self, TodoArea.self, CostBasisLot.self,
            ])
            let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
            let container = try ModelContainer(for: schema, configurations: [configuration])
            try seedMacPacket(container.mainContext, bundle: bundle)
            let authentication = AppAuthenticationSession(defaults: defaults)
            authentication.transition(to: .active)
            XCTAssertTrue(authentication.isUnlocked)
            let financials = CanonicalFinancialSourceStore()
            await financials.load(viewer: .victor)
            XCTAssertEqual(financials.btcBalance.value?.totalSats, 355_000_000)
            XCTAssertNotNil(financials.income.value)
            XCTAssertEqual(financials.btcBillPays.value?.totalUSDCents, 10_000)

            for tab in AppTab.allCases {
                try await captureMacPacket(ContentView(packetTab: tab), name: tab.rawValue,
                                     directory: directory, container: container, authentication: authentication)
            }
            try await captureMacPacket(ContentView(packetTab: .home, destination: .billPay), name: "bill-pay",
                                 directory: directory, container: container, authentication: authentication)
            try await captureMacPacket(ContentView(packetTab: .home, destination: .awards), name: "awards",
                                 directory: directory, container: container, authentication: authentication)
            // A sheet is a separate AppKit window, outside ContentView's cached bitmap.
            // Capture its actual view separately; bill-pay.png retains the COMPOSE header.
            try await captureMacPacket(BTCBillPayComposeView(), name: "bill-pay-compose",
                                 directory: directory, container: container, authentication: authentication)
        }

        @MainActor
        private func captureMacPacket(
            _ content: some View, name: String, directory: URL,
            container: ModelContainer, authentication: AppAuthenticationSession,
        ) async throws {
            let size = NSSize(width: 1000, height: 700)
            let root = content
                .modelContainer(container)
                .environmentObject(authentication)
                .environmentObject(SyncStatusStore.shared)
                .environmentObject(TaskUndoStore.shared)
                .themed()
                .preferredColorScheme(.dark)
                .environment(\.colorScheme, .dark)
                .environment(\.locale, Locale(identifier: "en_US_POSIX"))
                .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
                .environment(\._accessibilityReduceMotion, true)
                .transaction { $0.disablesAnimations = true }
                .frame(width: size.width, height: size.height)
            let hosting = NSHostingView(rootView: root)
            let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: .darkAqua)
            window.contentView = hosting
            window.orderFront(nil)
            defer {
                window.orderOut(nil)
                window.contentView = nil
                window.close()
            }
            // Release MainActor so the root's asynchronous fixture reads can finish.
            try await Task.sleep(nanoseconds: 500_000_000)
            settleMacPacket(hosting)
            hosting.displayIfNeeded()
            XCTAssertEqual(hosting.bounds.size, size, name)
            let bitmap: NSBitmapImageRep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds), name)
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            let png: Data = try XCTUnwrap(bitmap.representation(using: NSBitmapImageRep.FileType.png, properties: [:]), name)
            XCTAssertGreaterThan(png.count, 1000, "Empty capture: \(name)")
            try png.write(to: directory.appendingPathComponent("\(name).png"), options: Data.WritingOptions.atomic)
        }

        @MainActor
        private func settleMacPacket(_ hosting: NSView) {
            // Drain navigation pushes, @Query delivery and row onAppear.
            let deadline = Date().addingTimeInterval(0.5)
            while Date() < deadline {
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
                hosting.layoutSubtreeIfNeeded()
            }
        }

        @MainActor
        private func seedMacPacket(_ context: ModelContext, bundle: Bundle) throws {
            let fixture = try MacPacketFixture.load(bundle: bundle)
            let now = LedgerClock.now
            for (index, row) in fixture.sampleTransactions.enumerated() {
                context.insert(Transaction(
                    id: row.id, date: now.addingTimeInterval(-Double(index)), merchant: row.merchant,
                    amount: try XCTUnwrap(Decimal(string: row.amount)), category: row.category,
                    owner: try XCTUnwrap(FamilyMember(rawValue: row.owner)), createdBy: "fixture",
                ))
            }
            for row in fixture.sampleAccounts {
                context.insert(BTCAccount(
                    key: row.key, label: row.label, custody: try XCTUnwrap(BTCCustody(rawValue: row.custody)),
                    btc: try XCTUnwrap(Decimal(string: row.btc)),
                    owner: try XCTUnwrap(FamilyMember(rawValue: row.owner)), lastUpdated: now,
                ))
            }
            for (index, name) in ["Food", "Housing", "Transport"].enumerated() {
                context.insert(BudgetCategory(name: name, icon: "creditcard", monthlyBudget: 500,
                                              sortOrder: index, owner: .victor))
            }
            context.insert(TodoItem(id: "packet-today", title: "Review household budget", dueDate: now,
                                    priority: 2, owner: .victor, createdBy: "fixture", updatedAt: now))
            context.insert(TodoItem(id: "packet-done", title: "Reconcile receipts", isDone: true,
                                    owner: .victor, createdBy: "fixture", updatedAt: now, completedAt: now))
            context.insert(BTCBuy(id: "packet-buy", date: now, source: "River", amountBTC: Decimal(1) / 100,
                                  amountSats: 1_000_000, priceUSD: 100_000, usd: 1000, owner: .victor))
            context.insert(BTCBillPay(id: "packet-bill", date: now, merchant: "Electric company", category: "Housing",
                                      amountUSD: 100, btcSpent: Decimal(1) / 1000, btcPrice: 100_000,
                                      feeUSD: 1, budgetEffect: .budgetCategory, platform: "River", owner: .victor))
            try context.save()
        }
    }

    /// Same shared fixture consumed by FamilyVisibilityTests; unrelated fields are ignored.
    private struct MacPacketFixture: Decodable {
        struct TransactionRow: Decodable {
            let id, merchant, amount, category, owner: String
        }
        struct AccountRow: Decodable {
            let key, label, custody, btc, owner: String
        }
        let sampleTransactions: [TransactionRow]
        let sampleAccounts: [AccountRow]

        static func load(bundle: Bundle) throws -> Self {
            let url = bundle.url(forResource: "visibility-cases", withExtension: "json")
                ?? bundle.url(forResource: "visibility-cases", withExtension: "json", subdirectory: "fixtures")
            return try JSONDecoder().decode(Self.self, from: Data(contentsOf: XCTUnwrap(url)))
        }
    }
#endif
