import XCTest

final class FamilyVisibilityTests: XCTestCase {
    func testLedgerOwnerKeepsActorSeparateFromFinancialOwner() {
        XCTAssertEqual(FamilyMember.victor.ledgerOwner, .victor)
        XCTAssertEqual(FamilyMember.rachel.ledgerOwner, .victor)
        XCTAssertEqual(FamilyMember.mason.ledgerOwner, .mason)
        XCTAssertEqual(FamilyMember.maddox.ledgerOwner, .maddox)
    }

    // MARK: - Core canSee Logic

    func testAdultSeesAllMembers() {
        for adult in [FamilyMember.victor, .rachel] {
            for member in FamilyMember.allCases {
                XCTAssertTrue(
                    adult.canSee(dataOwnedBy: member),
                    "\(adult) should see \(member)'s data",
                )
            }
        }
    }

    func testChildSeesOnlySelf() {
        for child in [FamilyMember.mason, .maddox] {
            for member in FamilyMember.allCases {
                if member == child {
                    XCTAssertTrue(child.canSee(dataOwnedBy: member))
                } else {
                    XCTAssertFalse(
                        child.canSee(dataOwnedBy: member),
                        "\(child) should NOT see \(member)'s data",
                    )
                }
            }
        }
    }

    func testRachelSeesVictorData_CriticalRegression() {
        XCTAssertTrue(
            FamilyMember.rachel.canSee(dataOwnedBy: .victor),
            "CRITICAL: Rachel must see Victor's data (shared household). This bug shipped in v0.3.",
        )
    }

    func testMasonCannotSeeAdultData() {
        XCTAssertFalse(FamilyMember.mason.canSee(dataOwnedBy: .victor))
        XCTAssertFalse(FamilyMember.mason.canSee(dataOwnedBy: .rachel))
    }

    func testMasonCannotSeeSiblingData() {
        XCTAssertFalse(FamilyMember.mason.canSee(dataOwnedBy: .maddox))
        XCTAssertFalse(FamilyMember.maddox.canSee(dataOwnedBy: .mason))
    }

    // MARK: - Transaction Filtering (ActivityView, BudgetView, DashboardView)

    func testTransactionFilteringForAdult() {
        let transactions = sampleTransactions()
        let victorVisible = transactions.filter { FamilyMember.victor.canSee(dataOwnedBy: $0.ownerMember) }
        XCTAssertEqual(victorVisible.count, transactions.count, "Victor sees all transactions")

        let rachelVisible = transactions.filter { FamilyMember.rachel.canSee(dataOwnedBy: $0.ownerMember) }
        XCTAssertEqual(rachelVisible.count, transactions.count, "Rachel sees all transactions")
    }

    func testTransactionFilteringForChild() {
        let transactions = sampleTransactions()
        let masonVisible = transactions.filter { FamilyMember.mason.canSee(dataOwnedBy: $0.ownerMember) }
        XCTAssertEqual(masonVisible.count, 1)
        XCTAssertEqual(masonVisible.first?.merchant, "Game Store")
    }

    func testMaddoxSeesOnlyOwnTransactions() {
        let transactions = sampleTransactions()
        let visible = transactions.filter { FamilyMember.maddox.canSee(dataOwnedBy: $0.ownerMember) }
        XCTAssertEqual(visible.count, 1)
        XCTAssertEqual(visible.first?.merchant, "Roblox")
    }

    // MARK: - BTC Account Filtering (RetirementView, NetWorthView, DashboardView)

    func testAccountFilteringForAdult() {
        let accounts = sampleAccounts()
        let victorVisible = accounts.filter { FamilyMember.victor.canSee(dataOwnedBy: $0.ownerMember) }
        XCTAssertEqual(victorVisible.count, accounts.count, "Victor sees all accounts")

        let rachelVisible = accounts.filter { FamilyMember.rachel.canSee(dataOwnedBy: $0.ownerMember) }
        XCTAssertEqual(rachelVisible.count, accounts.count, "Rachel sees all accounts")
    }

    func testAccountFilteringForChild() {
        let accounts = sampleAccounts()
        let masonVisible = accounts.filter { FamilyMember.mason.canSee(dataOwnedBy: $0.ownerMember) }
        XCTAssertEqual(masonVisible.count, 1)
        XCTAssertEqual(masonVisible.first?.label, "Mason Strike")
    }

    func testNetWorthScopeKeepsAdultHouseholdButExcludesKids() {
        let accounts = sampleAccounts()

        let victorNetWorth = accounts.filter { FamilyMember.victor.sharesNetWorth(with: $0.ownerMember) }
        XCTAssertEqual(victorNetWorth.map(\.label), ["Multisig", "Phoenix LN"])

        let rachelNetWorth = accounts.filter { FamilyMember.rachel.sharesNetWorth(with: $0.ownerMember) }
        XCTAssertEqual(rachelNetWorth.map(\.label), ["Multisig", "Phoenix LN"])

        let masonNetWorth = accounts.filter { FamilyMember.mason.sharesNetWorth(with: $0.ownerMember) }
        XCTAssertEqual(masonNetWorth.map(\.label), ["Mason Strike"])
    }

    // MARK: - Todo Filtering (TodayView, ProjectsView)

    func testTodoFilteringUsesExactOwnerForAdults() {
        let todos = sampleTodos()
        let victorVisible = todos.filter { FamilyMember.victor.canAccessTodo(ownedBy: $0.ownerMember) }
        XCTAssertEqual(victorVisible.map(\.ownerMember), [.victor])

        let rachelVisible = todos.filter { FamilyMember.rachel.canAccessTodo(ownedBy: $0.ownerMember) }
        XCTAssertEqual(rachelVisible.map(\.ownerMember), [.rachel])
    }

    func testRachelDoesNotAggregateVictorTodo() {
        let todos = sampleTodos()
        let rachelVisible = todos.filter { FamilyMember.rachel.canAccessTodo(ownedBy: $0.ownerMember) }

        XCTAssertFalse(rachelVisible.contains { $0.ownerMember == .victor })
    }

    func testTodoFilteringForChild() {
        let todos = sampleTodos()
        let masonVisible = todos.filter { FamilyMember.mason.canAccessTodo(ownedBy: $0.ownerMember) }
        XCTAssertEqual(masonVisible.count, 1)
        XCTAssertEqual(masonVisible.first?.title, "Finish homework")
    }

    // MARK: - Profile Switch Targets

    func testAdultCanSwitchToAll() {
        XCTAssertEqual(FamilyMember.victor.allowedSwitchTargets, FamilyMember.allCases)
        XCTAssertEqual(FamilyMember.rachel.allowedSwitchTargets, FamilyMember.allCases)
    }

    func testChildCanOnlySwitchToSelf() {
        XCTAssertEqual(FamilyMember.mason.allowedSwitchTargets, [.mason])
        XCTAssertEqual(FamilyMember.maddox.allowedSwitchTargets, [.maddox])
    }

    // MARK: - Budget Category Visibility

    func testBudgetSpendingFilteredByMember() {
        let transactions = sampleTransactions()
        let masonSpending = transactions
            .filter { FamilyMember.mason.canSee(dataOwnedBy: $0.ownerMember) }
            .reduce(Decimal(0)) { $0 + $1.spendAmount }

        XCTAssertEqual(masonSpending, 60, "Mason only sees his own spending")
    }

    func testAdultSeesAllSpending() {
        let transactions = sampleTransactions()
        let victorSpending = transactions
            .filter { FamilyMember.victor.canSee(dataOwnedBy: $0.ownerMember) }
            .reduce(Decimal(0)) { $0 + $1.spendAmount }

        XCTAssertEqual(victorSpending, 315, "Victor sees all household spending")
    }

    // MARK: - Canonical Owner Tag Defaults

    func testDefaultOwnerIsVictor() {
        let tx = Transaction(
            id: "no-owner",
            date: .now,
            merchant: "Test",
            amount: -10,
            category: "Other",
            createdBy: "mc2",
        )
        XCTAssertEqual(tx.ownerMember, .victor, "Untagged records default to Victor")
    }

    func testExplicitOwnerPreserved() {
        let tx = Transaction(
            id: "mason-owned",
            date: .now,
            merchant: "Test",
            amount: -10,
            category: "Other",
            owner: .mason,
            createdBy: "mc2",
        )
        XCTAssertEqual(tx.ownerMember, .mason)
    }

    // MARK: - Edge Cases

    func testEmptyDataSetDoesNotCrash() {
        let empty: [Transaction] = []
        let visible = empty.filter { FamilyMember.mason.canSee(dataOwnedBy: $0.ownerMember) }
        XCTAssertTrue(visible.isEmpty)
    }

    func testShowsFullBudgetFlag() {
        XCTAssertTrue(FamilyMember.victor.showsFullBudget)
        XCTAssertTrue(FamilyMember.rachel.showsFullBudget)
        XCTAssertFalse(FamilyMember.mason.showsFullBudget)
        XCTAssertFalse(FamilyMember.maddox.showsFullBudget)
    }

    // MARK: - Shared Cross-Client Fixture

    func testCompleteSharedVisibilityFixture() throws {
        let fixture = try loadVisibilityFixture()
        let members = FamilyMember.allCases.map(\.rawValue)

        XCTAssertEqual(fixture.members, members)
        XCTAssertEqual(fixture.adults, FamilyMember.allCases.filter(\.isAdult).map(\.rawValue))
        XCTAssertEqual(fixture.defaultOwner, FamilyMember.victor.rawValue)

        let expectedMembers = Set(members)
        let expectedViewerOwnerPairs = Set(members.flatMap { viewer in
            members.map { owner in "\(viewer):\(owner)" }
        })
        XCTAssertEqual(fixture.canSee.count, expectedViewerOwnerPairs.count)
        XCTAssertEqual(
            Set(fixture.canSee.map { "\($0.viewer):\($0.owner)" }),
            expectedViewerOwnerPairs,
        )
        XCTAssertEqual(fixture.sharesNetWorth.count, expectedViewerOwnerPairs.count)
        XCTAssertEqual(
            Set(fixture.sharesNetWorth.map { "\($0.viewer):\($0.owner)" }),
            expectedViewerOwnerPairs,
        )

        XCTAssertEqual(Set(fixture.allowedSwitchTargets.map(\.member)), expectedMembers)
        XCTAssertEqual(Set(fixture.showsFullBudget.map(\.member)), expectedMembers)
        XCTAssertEqual(Set(fixture.transactionsDataFileName.map(\.member)), expectedMembers)
        XCTAssertEqual(Set(fixture.btcBuysDataFileName.map(\.member)), expectedMembers)
        XCTAssertEqual(Set(fixture.hasDedicatedChildFinanceFiles.map(\.member)), expectedMembers)

        XCTAssertEqual(fixture.sampleTransactions.count, 9)
        XCTAssertEqual(fixture.sampleAccounts.count, 3)
        XCTAssertEqual(fixture.sampleTodos.count, 4)

        XCTAssertEqual(Set(fixture.expectations.visibleTransactionCount.keys), expectedMembers)
        XCTAssertEqual(Set(fixture.expectations.visibleAccountCount.keys), expectedMembers)
        XCTAssertEqual(Set(fixture.expectations.netWorthAccountLabels.keys), expectedMembers)
        XCTAssertEqual(Set(fixture.expectations.visibleSpend.keys), expectedMembers)
        XCTAssertEqual(Set(fixture.expectations.budgetSpend.keys), expectedMembers)

        for testCase in fixture.canSee {
            let viewer = try familyMember(testCase.viewer)
            let owner = try familyMember(testCase.owner)
            XCTAssertEqual(
                viewer.canSee(dataOwnedBy: owner),
                testCase.expected,
                "Fixture mismatch for \(viewer).canSee(dataOwnedBy: \(owner))",
            )
        }

        for testCase in fixture.sharesNetWorth {
            let viewer = try familyMember(testCase.viewer)
            let owner = try familyMember(testCase.owner)
            XCTAssertEqual(
                viewer.sharesNetWorth(with: owner),
                testCase.expected,
                "Fixture mismatch for \(viewer).sharesNetWorth(with: \(owner))",
            )
        }

        for testCase in fixture.allowedSwitchTargets {
            XCTAssertEqual(
                try familyMember(testCase.member).allowedSwitchTargets.map(\.rawValue),
                testCase.expected,
            )
        }

        for testCase in fixture.showsFullBudget {
            XCTAssertEqual(try familyMember(testCase.member).showsFullBudget, testCase.expected)
        }

        for testCase in fixture.transactionsDataFileName {
            XCTAssertEqual(try familyMember(testCase.member).transactionsDataFileName, testCase.expected)
        }

        for testCase in fixture.btcBuysDataFileName {
            XCTAssertEqual(try familyMember(testCase.member).btcBuysDataFileName, testCase.expected)
        }

        for testCase in fixture.hasDedicatedChildFinanceFiles {
            XCTAssertEqual(
                try familyMember(testCase.member).hasDedicatedChildFinanceFiles,
                testCase.expected,
            )
        }

        let transactions = try fixture.sampleTransactions.map { sample -> Transaction in
            let amount = try decimal(sample.amount)
            let transaction = Transaction(
                id: sample.id,
                date: .now,
                merchant: sample.merchant,
                amount: amount,
                category: sample.category,
                owner: try familyMember(sample.owner),
                createdBy: "fixture",
            )
            XCTAssertEqual(transaction.spendAmount, try decimal(sample.spendAmount))
            return transaction
        }

        let accounts = try fixture.sampleAccounts.map { sample -> BTCAccount in
            let custody = try XCTUnwrap(BTCCustody(rawValue: sample.custody))
            return BTCAccount(
                key: sample.key,
                label: sample.label,
                custody: custody,
                btc: try decimal(sample.btc),
                owner: try familyMember(sample.owner),
            )
        }

        let todos = try fixture.sampleTodos.map { sample in
            TodoItem(
                id: sample.id,
                title: sample.title,
                owner: try familyMember(sample.owner),
                createdBy: "fixture",
            )
        }

        for (viewerName, expectedCount) in fixture.expectations.visibleTransactionCount {
            let viewer = try familyMember(viewerName)
            XCTAssertEqual(
                transactions.filter { viewer.canSee(dataOwnedBy: $0.ownerMember) }.count,
                expectedCount,
            )
        }

        for (viewerName, expectedMerchants) in fixture.expectations.visibleTransactionMerchants {
            let viewer = try familyMember(viewerName)
            XCTAssertEqual(
                transactions
                    .filter { viewer.canSee(dataOwnedBy: $0.ownerMember) }
                    .map(\.merchant),
                expectedMerchants,
            )
        }

        for (viewerName, expectedCount) in fixture.expectations.visibleAccountCount {
            let viewer = try familyMember(viewerName)
            XCTAssertEqual(
                accounts.filter { viewer.canSee(dataOwnedBy: $0.ownerMember) }.count,
                expectedCount,
            )
        }

        for (viewerName, expectedLabels) in fixture.expectations.visibleAccountLabels {
            let viewer = try familyMember(viewerName)
            XCTAssertEqual(
                accounts
                    .filter { viewer.canSee(dataOwnedBy: $0.ownerMember) }
                    .map(\.label),
                expectedLabels,
            )
        }

        for (viewerName, expectedLabels) in fixture.expectations.netWorthAccountLabels {
            let viewer = try familyMember(viewerName)
            XCTAssertEqual(
                accounts
                    .filter { viewer.sharesNetWorth(with: $0.ownerMember) }
                    .map(\.label),
                expectedLabels,
            )
        }

        for (viewerName, expectedSpend) in fixture.expectations.visibleSpend {
            let viewer = try familyMember(viewerName)
            let spend = transactions
                .filter { viewer.canSee(dataOwnedBy: $0.ownerMember) }
                .reduce(Decimal(0)) { $0 + $1.spendAmount }
            XCTAssertEqual(spend, try decimal(expectedSpend))
        }

        for (viewerName, expectedSpend) in fixture.expectations.budgetSpend {
            let viewer = try familyMember(viewerName)
            let spend = transactions
                .filter { viewer.sharesNetWorth(with: $0.ownerMember) }
                .reduce(Decimal(0)) { $0 + $1.spendAmount }
            XCTAssertEqual(spend, try decimal(expectedSpend))
        }
    }

    // MARK: - Helpers

    private func loadVisibilityFixture() throws -> VisibilityFixture {
        let bundle = Bundle(for: FamilyVisibilityTests.self)
        let url = bundle.url(forResource: "visibility-cases", withExtension: "json")
            ?? bundle.url(forResource: "visibility-cases", withExtension: "json", subdirectory: "fixtures")
        return try JSONDecoder().decode(VisibilityFixture.self, from: Data(contentsOf: try XCTUnwrap(url)))
    }

    private func familyMember(_ rawValue: String) throws -> FamilyMember {
        try XCTUnwrap(FamilyMember(rawValue: rawValue), "Unknown fixture family member: \(rawValue)")
    }

    private func decimal(_ rawValue: String) throws -> Decimal {
        try XCTUnwrap(Decimal(string: rawValue, locale: Locale(identifier: "en_US_POSIX")))
    }

    private func sampleTransactions() -> [Transaction] {
        [
            Transaction(id: "tx-1", date: .now, merchant: "Costco", amount: 150, category: "Groceries", owner: .victor, createdBy: "mc2"),
            Transaction(id: "tx-2", date: .now, merchant: "Salary", amount: 5000, category: "Income", owner: .victor, createdBy: "mc2"),
            Transaction(id: "tx-3", date: .now, merchant: "Target", amount: 95, category: "Shopping", owner: .rachel, createdBy: "mc2"),
            Transaction(id: "tx-4", date: .now, merchant: "Game Store", amount: 60, category: "Entertainment", owner: .mason, createdBy: "mc2"),
            Transaction(id: "tx-5", date: .now, merchant: "Roblox", amount: 10, category: "Entertainment", owner: .maddox, createdBy: "mc2"),
        ]
    }

    private func sampleAccounts() -> [BTCAccount] {
        [
            BTCAccount(key: "coldcard-victor", label: "Multisig", custody: .selfCustody, btc: Decimal(string: "3.5")!, owner: .victor),
            BTCAccount(key: "phoenix-victor", label: "Phoenix LN", custody: .selfCustody, btc: Decimal(string: "0.05")!, owner: .victor),
            BTCAccount(key: "strike-mason", label: "Mason Strike", custody: .exchange, btc: Decimal(string: "0.01")!, owner: .mason),
        ]
    }

    private func sampleTodos() -> [TodoItem] {
        [
            TodoItem(id: "todo-1", title: "Pay mortgage", owner: .victor, createdBy: "mc2"),
            TodoItem(id: "todo-2", title: "Schedule dentist", owner: .rachel, createdBy: "mc2"),
            TodoItem(id: "todo-3", title: "Finish homework", owner: .mason, createdBy: "mc2"),
            TodoItem(id: "todo-4", title: "Pack lunch", owner: .maddox, createdBy: "mc2"),
        ]
    }
}

private struct VisibilityFixture: Decodable {
    let members: [String]
    let adults: [String]
    let defaultOwner: String
    let canSee: [ViewerOwnerExpectation]
    let sharesNetWorth: [ViewerOwnerExpectation]
    let allowedSwitchTargets: [MemberListExpectation]
    let showsFullBudget: [MemberBoolExpectation]
    let transactionsDataFileName: [MemberStringExpectation]
    let btcBuysDataFileName: [MemberStringExpectation]
    let hasDedicatedChildFinanceFiles: [MemberBoolExpectation]
    let sampleTransactions: [FixtureTransaction]
    let sampleAccounts: [FixtureAccount]
    let sampleTodos: [FixtureTodo]
    let expectations: FixtureExpectations

    private enum CodingKeys: String, CodingKey {
        case members
        case adults
        case defaultOwner
        case canSee
        case sharesNetWorth
        case allowedSwitchTargets
        case showsFullBudget
        case transactionsDataFileName
        case legacyTransactionsDataFileName = "mc2TransactionsFileName"
        case btcBuysDataFileName
        case legacyBTCBuysDataFileName = "mc2BTCBuysFileName"
        case hasDedicatedChildFinanceFiles
        case legacyDedicatedChildFinanceFiles = "hasDedicatedMC2ChildFinanceFiles"
        case sampleTransactions
        case sampleAccounts
        case sampleTodos
        case expectations
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        members = try container.decode([String].self, forKey: .members)
        adults = try container.decode([String].self, forKey: .adults)
        defaultOwner = try container.decode(String.self, forKey: .defaultOwner)
        canSee = try container.decode([ViewerOwnerExpectation].self, forKey: .canSee)
        sharesNetWorth = try container.decode([ViewerOwnerExpectation].self, forKey: .sharesNetWorth)
        allowedSwitchTargets = try container.decode([MemberListExpectation].self, forKey: .allowedSwitchTargets)
        showsFullBudget = try container.decode([MemberBoolExpectation].self, forKey: .showsFullBudget)
        transactionsDataFileName = try container.decodeIfPresent(
            [MemberStringExpectation].self,
            forKey: .transactionsDataFileName,
        ) ?? container.decode([MemberStringExpectation].self, forKey: .legacyTransactionsDataFileName)
        btcBuysDataFileName = try container.decodeIfPresent(
            [MemberStringExpectation].self,
            forKey: .btcBuysDataFileName,
        ) ?? container.decode([MemberStringExpectation].self, forKey: .legacyBTCBuysDataFileName)
        hasDedicatedChildFinanceFiles = try container.decodeIfPresent(
            [MemberBoolExpectation].self,
            forKey: .hasDedicatedChildFinanceFiles,
        ) ?? container.decode([MemberBoolExpectation].self, forKey: .legacyDedicatedChildFinanceFiles)
        sampleTransactions = try container.decode([FixtureTransaction].self, forKey: .sampleTransactions)
        sampleAccounts = try container.decode([FixtureAccount].self, forKey: .sampleAccounts)
        sampleTodos = try container.decode([FixtureTodo].self, forKey: .sampleTodos)
        expectations = try container.decode(FixtureExpectations.self, forKey: .expectations)
    }
}

private struct ViewerOwnerExpectation: Decodable {
    let viewer: String
    let owner: String
    let expected: Bool
}

private struct MemberListExpectation: Decodable {
    let member: String
    let expected: [String]
}

private struct MemberBoolExpectation: Decodable {
    let member: String
    let expected: Bool
}

private struct MemberStringExpectation: Decodable {
    let member: String
    let expected: String
}

private struct FixtureTransaction: Decodable {
    let id: String
    let merchant: String
    let amount: String
    let category: String
    let owner: String
    let spendAmount: String
}

private struct FixtureAccount: Decodable {
    let key: String
    let label: String
    let custody: String
    let btc: String
    let owner: String
}

private struct FixtureTodo: Decodable {
    let id: String
    let title: String
    let owner: String
}

private struct FixtureExpectations: Decodable {
    let visibleTransactionCount: [String: Int]
    let visibleTransactionMerchants: [String: [String]]
    let visibleAccountCount: [String: Int]
    let visibleAccountLabels: [String: [String]]
    let netWorthAccountLabels: [String: [String]]
    let visibleSpend: [String: String]
    let budgetSpend: [String: String]
}

private struct MoneyOutTodayFixture: Decodable {
    let contractVersion: Int
    let date: String
    let transactions: [MoneyOutTodayFixtureTransaction]
    let billPays: [MoneyOutTodayFixtureBillPay]
    let cases: [MoneyOutTodayFixtureCase]
}

private struct MoneyOutTodayFixtureTransaction: Decodable {
    let id: String
    let date: String
    let amountCents: String
    let category: String
    let owner: String
}

private struct MoneyOutTodayFixtureBillPay: Decodable {
    let id: String
    let date: String
    let principalCents: String
    let feeUsdCents: String
    let owner: String
    let budgetEffect: BTCBillPayBudgetEffect?
}

private struct MoneyOutTodayFixtureCase: Decodable {
    let activeProfile: String
    let expectedOwner: String
    let expectedTotalCents: String
    let expectedSourceIds: [String]
}

private struct BudgetCategoryDeletionFixture: Decodable {
    let contractVersion: Int
    let accepted: [BudgetCategoryDeletionAcceptedFixture]
    let rejected: [BudgetCategoryDeletionRejectedFixture]
}

private struct BudgetCategoryDeletionAcceptedFixture: Decodable {
    let name: String
    let activeProfile: String
    let budgetOwner: String
    let currentMonth: String
    let sourceFile: String
    let categoryName: String
    let baseUpdatedAtMs: Double
    let expectedOwner: String
}

private struct BudgetCategoryDeletionRejectedFixture: Decodable {
    let name: String
    let replace: BudgetCategoryDeletionReplacementFixture?
    let budgetOwner: String?
    let budgetMonth: String?
    let reason: String
}

private struct BudgetCategoryDeletionReplacementFixture: Decodable {
    let activeProfile: String?
    let currentMonth: String?
    let sourceFile: String?
    let categoryName: String?
    let baseUpdatedAtMs: Double?
}

final class Phase1ContractsTests: XCTestCase {
    func testTodoAccessIsExactOwnerWithoutChangingFinancialVisibility() {
        for viewer in FamilyMember.allCases {
            for owner in FamilyMember.allCases {
                XCTAssertEqual(viewer.canAccessTodo(ownedBy: owner), viewer == owner)
            }
        }

        XCTAssertTrue(FamilyMember.rachel.canSee(dataOwnedBy: .victor))
        XCTAssertTrue(FamilyMember.rachel.sharesNetWorth(with: .victor))
        XCTAssertFalse(FamilyMember.rachel.canAccessTodo(ownedBy: .victor))
    }

    func testTodoMapperReturnsOnlyRequestedOwner() {
        let rows = [
            LegacyTodoDTO(id: "victor-todo", title: "Victor", owner: "victor"),
            LegacyTodoDTO(id: "rachel-todo", title: "Rachel", owner: "rachel"),
            LegacyTodoDTO(id: "mason-todo", title: "Mason", owner: "mason"),
        ]

        XCTAssertEqual(LedgerMapper.mapTodos(rows, viewer: .victor).map(\.id), ["victor-todo"])
        XCTAssertEqual(LedgerMapper.mapTodos(rows, viewer: .rachel).map(\.id), ["rachel-todo"])
        XCTAssertEqual(LedgerMapper.mapTodos(rows, viewer: .mason).map(\.id), ["mason-todo"])
    }

    func testCachedTodosChangeImmediatelyWithTheAuthenticatedActiveProfile() {
        let cached = [
            TodoItem(id: "victor", title: "Victor private", owner: .victor),
            TodoItem(id: "rachel", title: "Rachel private", owner: .rachel),
            TodoItem(id: "mason", title: "Mason private", owner: .mason),
        ]

        XCTAssertEqual(
            cached.filter { FamilyMember.victor.canAccessTodo(ownedBy: $0.ownerMember) }.map(\.id),
            ["victor"],
        )
        XCTAssertEqual(
            cached.filter { FamilyMember.rachel.canAccessTodo(ownedBy: $0.ownerMember) }.map(\.id),
            ["rachel"],
        )
        XCTAssertEqual(
            cached.filter { FamilyMember.mason.canAccessTodo(ownedBy: $0.ownerMember) }.map(\.id),
            ["mason"],
        )
    }

    func testMoneyOutTodayUsesCanonicalAdultLedgerAndExcludesCreditCardBillPayRow() throws {
        let transactions = try [
            MoneyOutTodayTransaction(owner: .victor, day: "2026-08-25", amountCents: 1_000, category: "Groceries"),
            MoneyOutTodayTransaction(owner: .victor, day: "2026-08-25", amountCents: -250, category: "Refund"),
            MoneyOutTodayTransaction(owner: .victor, day: "2026-08-25", amountCents: 50_000, category: "Income"),
            MoneyOutTodayTransaction(owner: .rachel, day: "2026-08-25", amountCents: 9_999, category: "Other"),
            MoneyOutTodayTransaction(
                owner: .victor,
                day: "2026-08-25",
                amountCents: 3_000,
                category: BTCBillPayBudgetEffect.creditCardPaymentCategory,
            ),
            MoneyOutTodayTransaction(owner: .mason, day: "2026-08-25", amountCents: 8_888, category: "Other"),
            MoneyOutTodayTransaction(owner: .victor, day: "2026-08-24", amountCents: 7_777, category: "Other"),
        ]
        let billPays = try [
            MoneyOutTodayBillPay(
                owner: .victor,
                day: "2026-08-25",
                principalUsdCents: 2_000,
                feeUsdCents: 33,
                budgetEffect: .budgetCategory,
            ),
            MoneyOutTodayBillPay(
                owner: .rachel,
                day: "2026-08-25",
                principalUsdCents: 6_666,
                feeUsdCents: 44,
                budgetEffect: .creditCardPayment,
            ),
        ]

        let victor = try MoneyOutTodayContract.deriveCents(
            viewer: .victor,
            day: "2026-08-25",
            transactions: transactions,
            billPays: billPays,
        )
        let rachel = try MoneyOutTodayContract.deriveCents(
            viewer: .rachel,
            day: "2026-08-25",
            transactions: transactions,
            billPays: billPays,
        )

        XCTAssertEqual(victor, 12_782)
        XCTAssertEqual(rachel, victor)
    }

    func testMoneyOutTodayChildUsesOnlyOwnRowsAndMissingFeeDefaultsAtBoundary() throws {
        let transactions = try [
            MoneyOutTodayTransaction(owner: .victor, day: "2026-08-25", amountCents: 100, category: "Other"),
            MoneyOutTodayTransaction(owner: .mason, day: "2026-08-25", amountCents: 250, category: "Other"),
            MoneyOutTodayTransaction(owner: .maddox, day: "2026-08-25", amountCents: 400, category: "Other"),
        ]
        let billPay = try MoneyOutTodayBillPay(
            owner: .mason,
            day: "2026-08-25",
            principalUsdCents: 1_000,
            budgetEffect: .budgetCategory,
        )

        XCTAssertEqual(billPay.feeUsdCents, 0)
        XCTAssertEqual(
            try MoneyOutTodayContract.deriveCents(
                viewer: .mason,
                day: "2026-08-25",
                transactions: transactions,
                billPays: [billPay],
            ),
            1_250,
        )
    }

    func testMoneyOutTodayLegacyBillPayDefaultsToExcludedCreditCardPayment() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let now = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 8,
            day: 25,
            hour: 12,
        )))
        let legacy = BTCBillPay(
            id: "legacy-bill-pay",
            date: now,
            merchant: "Legacy bill",
            category: "Legacy category",
            amountUSD: 100,
            btcSpent: Decimal(string: "0.001")!,
            btcPrice: 100_000,
            feeUSD: Decimal(string: "0.25"),
            owner: .victor,
        )

        XCTAssertNil(legacy.budgetEffect)
        XCTAssertEqual(try legacy.validatedBudgetEffect(), .creditCardPayment)
        XCTAssertEqual(
            try MoneyOutTodayService.deriveCents(
                viewer: .rachel,
                now: now,
                calendar: calendar,
                transactions: [],
                billPays: [legacy],
            ),
            0,
        )
    }

    func testMoneyOutTodayDoesNotClampNegativeRefundTotal() throws {
        let refund = try MoneyOutTodayTransaction(
            owner: .victor,
            day: "2026-08-25",
            amountCents: -500,
            category: "Refund",
        )

        XCTAssertEqual(
            try MoneyOutTodayContract.deriveCents(
                viewer: .victor,
                day: "2026-08-25",
                transactions: [refund],
                billPays: [],
            ),
            -500,
        )
    }

    func testMoneyOutTodayRejectsInvalidDayAndOverflow() throws {
        XCTAssertThrowsError(
            try MoneyOutTodayTransaction(
                owner: .victor,
                day: "2026-02-30",
                amountCents: 1,
                category: "Other",
            ),
        ) { error in
            XCTAssertEqual(error as? MoneyOutTodayError, .invalidDay("2026-02-30"))
        }

        let rows = try [
            MoneyOutTodayTransaction(
                owner: .victor,
                day: "2026-08-25",
                amountCents: Int64.max,
                category: "Other",
            ),
            MoneyOutTodayTransaction(
                owner: .victor,
                day: "2026-08-25",
                amountCents: 1,
                category: "Other",
            ),
        ]
        XCTAssertThrowsError(
            try MoneyOutTodayContract.deriveCents(
                viewer: .victor,
                day: "2026-08-25",
                transactions: rows,
                billPays: [],
            ),
        ) { error in
            XCTAssertEqual(error as? MoneyOutTodayError, .overflow)
        }

        let overflowingBillPay = try MoneyOutTodayBillPay(
            owner: .victor,
            day: "2026-08-25",
            principalUsdCents: Int64.max,
            feeUsdCents: 1,
            budgetEffect: .budgetCategory,
        )
        XCTAssertThrowsError(
            try MoneyOutTodayContract.deriveCents(
                viewer: .victor,
                day: "2026-08-25",
                transactions: [],
                billPays: [overflowingBillPay],
            ),
        ) { error in
            XCTAssertEqual(error as? MoneyOutTodayError, .overflow)
        }

        XCTAssertThrowsError(
            try MoneyOutTodayBillPay(
                owner: .victor,
                day: "2026-08-25",
                principalUsdCents: 1,
                feeUsdCents: -1,
                budgetEffect: .budgetCategory,
            ),
        ) { error in
            XCTAssertEqual(
                error as? ExactMoneyError,
                .negative(field: "moneyOutToday.billPay.feeUsdCents"),
            )
        }
    }

    func testMoneyOutTodayProductionAdapterChecksExactCentsAndBillPayTreatment() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let now = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 8,
            day: 25,
            hour: 12,
        )))
        let rows = [
            Transaction(
                id: "spend",
                date: now,
                merchant: "Grocer",
                amount: Decimal(string: "12.34")!,
                category: "Groceries",
                owner: .rachel,
                createdBy: "test",
            ),
            Transaction(
                id: "transfer",
                date: now,
                merchant: "Card",
                amount: 50,
                category: BTCBillPayBudgetEffect.creditCardPaymentCategory,
                owner: .victor,
                createdBy: "test",
            ),
        ]
        let billPay = BTCBillPay(
            id: "bill-pay",
            date: now,
            merchant: "Utility",
            category: "Bills & Utilities",
            amountUSD: 20,
            btcSpent: Decimal(string: "0.0002")!,
            btcPrice: 100_000,
            feeUSD: Decimal(string: "0.25"),
            budgetEffect: .budgetCategory,
            owner: .victor,
        )

        XCTAssertEqual(
            try MoneyOutTodayService.deriveCents(
                viewer: .rachel,
                now: now,
                calendar: calendar,
                transactions: rows,
                billPays: [billPay],
            ),
            8_259,
        )
    }

    func testSharedMoneyOutTodayFixtureThroughLegacyMapperAndProductionAdapter() throws {
        let fixture: MoneyOutTodayFixture = try loadSharedFixture("money-out-today-cases")
        XCTAssertEqual(fixture.contractVersion, 1)

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let now = LedgerMapper.parseDate(fixture.date)
        let transactions = try fixture.transactions.map { row in
            Transaction(
                id: row.id,
                date: LedgerMapper.parseDate(row.date),
                merchant: row.id,
                amount: Decimal(try fixtureInt64(row.amountCents)) / 100,
                category: row.category,
                owner: try fixtureFamilyMember(row.owner),
                createdBy: "shared-fixture",
            )
        }
        let billPays = try fixture.billPays.map { row in
            // The shared fixture's omitted value means an eligible budget posting.
            // Resolve it before entering the legacy-compatible persisted model.
            let budgetEffect = row.budgetEffect ?? .budgetCategory
            let dto = LegacyBTCBillPayDTO(
                id: row.id,
                date: row.date,
                merchant: row.id,
                category: budgetEffect == .creditCardPayment
                    ? BTCBillPayBudgetEffect.creditCardPaymentCategory
                    : "Bills",
                amountUsd: Decimal(try fixtureInt64(row.principalCents)) / 100,
                btcSpent: Decimal(string: "0.00000001")!,
                btcPrice: 100_000,
                platform: "River",
                note: nil,
                feeUsd: Decimal(try fixtureInt64(row.feeUsdCents)) / 100,
                reference: nil,
                owner: row.owner,
                budgetEffect: budgetEffect,
            )
            let model = try LedgerMapper.mapBTCBillPay(dto)
            XCTAssertEqual(try model.validatedBudgetEffect(), budgetEffect, row.id)
            return model
        }

        for row in fixture.cases {
            let viewer = try fixtureFamilyMember(row.activeProfile)
            XCTAssertEqual(viewer.ledgerOwner, try fixtureFamilyMember(row.expectedOwner), row.activeProfile)
            XCTAssertEqual(
                try MoneyOutTodayService.deriveCents(
                    viewer: viewer,
                    now: now,
                    calendar: calendar,
                    transactions: transactions,
                    billPays: billPays,
                ),
                try fixtureInt64(row.expectedTotalCents),
                "\(row.activeProfile): \(row.expectedSourceIds.joined(separator: ", "))",
            )
        }
    }

    func testLegacyRiverBuyFeeDecodesAndEncodesExactly() throws {
        let data = Data("""
        {
          "id": "river-buy-1",
          "date": "2026-08-25",
          "source": "River",
          "amount_sats": 125000,
          "amount_btc": 0.00125000,
          "price_usd": 100000,
          "usd": 125,
          "fee_usd": 1.23
        }
        """.utf8)

        let dto = try JSONDecoder().decode(LegacyBTCBuyDTO.self, from: data)
        let model = try LedgerMapper.mapBTCBuy(dto)
        let mutationObject = try dto.convexJSONObject()

        XCTAssertEqual(dto.feeUsd, Decimal(string: "1.23"))
        XCTAssertEqual(model.feeUsdCents, 123)
        XCTAssertEqual(model.effectiveFeeUsdCents, 123)
        XCTAssertEqual(mutationObject["fee_usd"] as? Double, 1.23)
        XCTAssertNil(mutationObject["feeUsdCents"])
    }

    func testMissingLegacyBuyAndBillPayFeesDefaultOnlyAtModelBoundary() throws {
        let buyData = Data("""
        {
          "id": "legacy-buy",
          "date": "2026-08-25",
          "source": "River",
          "amount_sats": 100000,
          "amount_btc": 0.001,
          "price_usd": 100000,
          "usd": 100
        }
        """.utf8)
        let dto = try JSONDecoder().decode(LegacyBTCBuyDTO.self, from: buyData)
        let buy = try LedgerMapper.mapBTCBuy(dto)
        let billPay = BTCBillPay(
            id: "legacy-bill-pay",
            date: .now,
            merchant: "Bill",
            category: "Bills",
            amountUSD: 10,
            btcSpent: Decimal(string: "0.0001")!,
            btcPrice: 100_000,
        )

        XCTAssertNil(dto.feeUsd)
        XCTAssertEqual(buy.feeUsdCents, 0)
        XCTAssertEqual(buy.effectiveFeeUsdCents, 0)
        XCTAssertNil(billPay.feeUSD)
        XCTAssertEqual(billPay.effectiveFeeUSD, 0)
    }

    func testManualFeesRejectFractionalNegativeAndOverflowValues() throws {
        let fractional = LegacyBTCBuyDTO(
            id: "fractional",
            date: "2026-08-25",
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
            feeUsd: Decimal(string: "0.001"),
        )
        XCTAssertThrowsError(try LedgerMapper.mapBTCBuy(fractional)) { error in
            XCTAssertEqual(error as? ExactMoneyError, .fractionalCent(field: "btcBuy.feeUsd"))
        }

        let negative = LegacyBTCBuyDTO(
            id: "negative",
            date: "2026-08-25",
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
            feeUsd: Decimal(string: "-0.01"),
        )
        XCTAssertThrowsError(try LedgerMapper.mapBTCBuy(negative)) { error in
            XCTAssertEqual(error as? ExactMoneyError, .negative(field: "btcBuy.feeUsd"))
        }

        let negativeBillPay = LegacyBTCBillPayDTO(
            id: "negative-bill-pay",
            date: "2026-08-25",
            merchant: "Bill",
            category: "Bills",
            amountUsd: 1,
            btcSpent: Decimal(string: "0.00001")!,
            btcPrice: 100_000,
            platform: "River",
            note: nil,
            feeUsd: Decimal(string: "-0.01"),
            reference: nil,
            owner: "victor",
        )
        XCTAssertThrowsError(try LedgerMapper.mapBTCBillPay(negativeBillPay)) { error in
            XCTAssertEqual(error as? ExactMoneyError, .negative(field: "btcBillPay.feeUsd"))
        }

        XCTAssertThrowsError(
            try ExactMoney.cents(
                from: Decimal(Int64.max),
                field: "overflow",
            ),
        ) { error in
            XCTAssertEqual(error as? ExactMoneyError, .overflow(field: "overflow"))
        }
    }

    func testCurrentMonthCategoryDeletionIntentCarriesExactIdentityAndRevision() throws {
        let intent = try BudgetCategoryDeletionIntent.make(
            viewer: .rachel,
            currentMonth: "2026-08",
            budgetMonth: "2026-08",
            budgetOwner: .victor,
            budgetSource: "budget",
            existingCategoryNames: ["Groceries", "Dining & Drinks"],
            categoryName: "groceries",
            budgetUpdatedAtMs: 1_777_777_777_777,
            baseUpdatedAtMs: 1_777_777_777_777,
        )

        XCTAssertEqual(intent.month, "2026-08")
        XCTAssertEqual(intent.owner, .victor)
        XCTAssertEqual(intent.source, BudgetCategoryDeletionIntent.canonicalSource)
        XCTAssertEqual(intent.categoryName, "Groceries")
        XCTAssertEqual(intent.baseUpdatedAtMs, 1_777_777_777_777)

        let arguments = AppWritebackClient.budgetCategoryDeletionArguments(
            intent,
            deviceID: "device-id",
            deviceToken: "device-token",
        )
        XCTAssertEqual(arguments["owner"] as? String, "victor")
        XCTAssertEqual(arguments["sourceFile"] as? String, "budget")
        XCTAssertEqual(arguments["month"] as? String, "2026-08")
        XCTAssertEqual(arguments["entityId"] as? String, "Groceries")
        XCTAssertEqual(arguments["baseUpdatedAtMs"] as? Int64, 1_777_777_777_777)
        XCTAssertEqual(Set(arguments.keys), Set([
            "deviceId",
            "deviceToken",
            "owner",
            "sourceFile",
            "month",
            "entityId",
            "baseUpdatedAtMs",
        ]))

        let masonIntent = try BudgetCategoryDeletionIntent.make(
            viewer: .mason,
            currentMonth: "2026-08",
            budgetMonth: "2026-08",
            budgetOwner: .mason,
            budgetSource: "mason-budget",
            existingCategoryNames: ["Fun"],
            categoryName: "Fun",
            budgetUpdatedAtMs: 2,
            baseUpdatedAtMs: 2,
        )
        XCTAssertEqual(masonIntent.owner, .mason)
        XCTAssertEqual(masonIntent.source, "mason-budget")
    }

    func testCategoryDeletionRejectsNonCurrentMonthOwnerSourceCategoryRevisionAndChild() {
        assertDeletionError(
            expected: .invalidCurrentMonth("August 2026"),
            currentMonth: "August 2026",
        )
        assertDeletionError(
            expected: .invalidCurrentMonth("0000-08"),
            currentMonth: "0000-08",
        )
        assertDeletionError(
            expected: .invalidBudgetMonth("2026-8"),
            budgetMonth: "2026-8",
        )
        assertDeletionError(
            expected: .monthMismatch(currentMonth: "2026-08", budgetMonth: "2026-07"),
            budgetMonth: "2026-07",
        )
        assertDeletionError(
            expected: .monthMismatch(currentMonth: "2026-08", budgetMonth: "2026-09"),
            budgetMonth: "2026-09",
        )
        assertDeletionError(
            expected: .ownerMismatch(expected: .victor, actual: .rachel),
            budgetOwner: .rachel,
        )
        assertDeletionError(
            expected: .sourceMismatch(expected: "budget", actual: "mason-budget"),
            budgetSource: "mason-budget",
        )
        assertDeletionError(
            expected: .nonCanonicalCategory(expected: "Groceries", actual: " Groceries "),
            categoryName: " Groceries ",
        )
        assertDeletionError(
            expected: .foldedCategoryCollision("Groceries"),
            existingCategoryNames: ["Groceries", " groceries "],
        )
        assertDeletionError(expected: .invalidRevision(0), baseUpdatedAtMs: 0)
        assertDeletionError(expected: .invalidRevision(-1), baseUpdatedAtMs: -1)
        assertDeletionError(
            expected: .invalidRevision(BudgetCategoryDeletionIntent.maximumExactJSONRevision + 1),
            baseUpdatedAtMs: BudgetCategoryDeletionIntent.maximumExactJSONRevision + 1,
        )
        assertDeletionError(
            expected: .revisionMismatch(expected: 2, actual: 1),
            budgetUpdatedAtMs: 2,
        )
        assertDeletionError(
            expected: .unsupportedChildBudget(.maddox),
            viewer: .maddox,
            budgetOwner: .maddox,
        )
    }

    func testSharedBudgetCategoryDeletionFixture() throws {
        let fixture: BudgetCategoryDeletionFixture = try loadSharedFixture("budget-category-deletion-cases")
        XCTAssertEqual(fixture.contractVersion, 2)

        for row in fixture.accepted {
            let revision = try exactFixtureRevision(row.baseUpdatedAtMs)
            let intent = try BudgetCategoryDeletionIntent.make(
                viewer: fixtureFamilyMember(row.activeProfile),
                currentMonth: row.currentMonth,
                budgetMonth: row.currentMonth,
                budgetOwner: fixtureFamilyMember(row.budgetOwner),
                budgetSource: row.sourceFile,
                existingCategoryNames: ["Groceries", "School"],
                categoryName: row.categoryName,
                budgetUpdatedAtMs: revision,
                baseUpdatedAtMs: revision,
            )

            XCTAssertEqual(intent.month, row.currentMonth, row.name)
            XCTAssertEqual(intent.owner, try fixtureFamilyMember(row.expectedOwner), row.name)
            XCTAssertEqual(intent.source, row.sourceFile, row.name)
            XCTAssertEqual(intent.categoryName, row.categoryName, row.name)
            XCTAssertEqual(intent.baseUpdatedAtMs, revision, row.name)
        }

        let baseline = try XCTUnwrap(fixture.accepted.first)
        let currentRevision = try exactFixtureRevision(baseline.baseUpdatedAtMs)
        for row in fixture.rejected {
            let replacement = row.replace
            XCTAssertThrowsError(
                try BudgetCategoryDeletionIntent.make(
                    viewer: fixtureFamilyMember(replacement?.activeProfile ?? baseline.activeProfile),
                    currentMonth: replacement?.currentMonth ?? baseline.currentMonth,
                    budgetMonth: row.budgetMonth ?? baseline.currentMonth,
                    budgetOwner: fixtureFamilyMember(row.budgetOwner ?? baseline.budgetOwner),
                    budgetSource: replacement?.sourceFile ?? baseline.sourceFile,
                    existingCategoryNames: ["Groceries", "School"],
                    categoryName: replacement?.categoryName ?? baseline.categoryName,
                    budgetUpdatedAtMs: currentRevision,
                    baseUpdatedAtMs: try exactFixtureRevision(
                        replacement?.baseUpdatedAtMs ?? baseline.baseUpdatedAtMs,
                    ),
                ),
                row.name,
            ) { error in
                XCTAssertEqual(sharedDeletionReason(error), row.reason, row.name)
            }
        }

        XCTAssertThrowsError(
            try BudgetCategoryDeletionIntent.make(
                viewer: fixtureFamilyMember(baseline.activeProfile),
                currentMonth: baseline.currentMonth,
                budgetMonth: baseline.currentMonth,
                budgetOwner: fixtureFamilyMember(baseline.budgetOwner),
                budgetSource: baseline.sourceFile,
                existingCategoryNames: [baseline.categoryName, baseline.categoryName.lowercased()],
                categoryName: baseline.categoryName,
                budgetUpdatedAtMs: currentRevision,
                baseUpdatedAtMs: currentRevision,
            ),
        ) { error in
            XCTAssertEqual(
                error as? BudgetCategoryDeletionEligibilityError,
                .foldedCategoryCollision(baseline.categoryName),
            )
        }
    }

    private func assertDeletionError(
        expected: BudgetCategoryDeletionEligibilityError,
        viewer: FamilyMember = .victor,
        currentMonth: String = "2026-08",
        budgetMonth: String = "2026-08",
        budgetOwner: FamilyMember = .victor,
        budgetSource: String = "budget",
        existingCategoryNames: [String] = ["Groceries"],
        categoryName: String = "Groceries",
        budgetUpdatedAtMs: Int64 = 1,
        baseUpdatedAtMs: Int64 = 1,
    ) {
        XCTAssertThrowsError(
            try BudgetCategoryDeletionIntent.make(
                viewer: viewer,
                currentMonth: currentMonth,
                budgetMonth: budgetMonth,
                budgetOwner: budgetOwner,
                budgetSource: budgetSource,
                existingCategoryNames: existingCategoryNames,
                categoryName: categoryName,
                budgetUpdatedAtMs: budgetUpdatedAtMs,
                baseUpdatedAtMs: baseUpdatedAtMs,
            ),
        ) { error in
            XCTAssertEqual(error as? BudgetCategoryDeletionEligibilityError, expected)
        }
    }

    private func loadSharedFixture<Fixture: Decodable>(_ name: String) throws -> Fixture {
        let bundle = Bundle(for: Phase1ContractsTests.self)
        let url = bundle.url(forResource: name, withExtension: "json")
            ?? bundle.url(forResource: name, withExtension: "json", subdirectory: "fixtures")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: try XCTUnwrap(url)))
    }

    private func fixtureFamilyMember(_ rawValue: String) throws -> FamilyMember {
        try XCTUnwrap(FamilyMember(rawValue: rawValue), "Unknown fixture family member: \(rawValue)")
    }

    private func fixtureInt64(_ rawValue: String) throws -> Int64 {
        try XCTUnwrap(Int64(rawValue), "Invalid fixture Int64: \(rawValue)")
    }

    private func exactFixtureRevision(_ value: Double) throws -> Int64 {
        guard value.isFinite, let revision = Int64(exactly: value) else {
            throw BudgetCategoryDeletionEligibilityError.invalidRevisionNumber(value)
        }
        return revision
    }

    private func sharedDeletionReason(_ error: Error) -> String? {
        guard let error = error as? BudgetCategoryDeletionEligibilityError else { return nil }
        switch error {
        case .invalidCurrentMonth, .invalidBudgetMonth:
            "invalid-current-month"
        case .unsupportedChildBudget:
            "unsupported-profile"
        case .monthMismatch:
            "month-mismatch"
        case .ownerMismatch:
            "owner-mismatch"
        case .sourceMismatch:
            "source-mismatch"
        case .missingCategory:
            "missing-category"
        case .nonCanonicalCategory:
            "invalid-category"
        case .foldedCategoryCollision:
            "ambiguous-category"
        case .missingRevision, .invalidRevision, .invalidRevisionNumber:
            "invalid-revision"
        case .revisionMismatch:
            "revision-mismatch"
        }
    }
}
