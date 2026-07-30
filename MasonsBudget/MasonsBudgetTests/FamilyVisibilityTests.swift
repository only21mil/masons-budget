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
        XCTAssertEqual(victorNetWorth.map(\.label), ["Coldcard", "Phoenix LN"])

        let rachelNetWorth = accounts.filter { FamilyMember.rachel.sharesNetWorth(with: $0.ownerMember) }
        XCTAssertEqual(rachelNetWorth.map(\.label), ["Coldcard", "Phoenix LN"])

        let masonNetWorth = accounts.filter { FamilyMember.mason.sharesNetWorth(with: $0.ownerMember) }
        XCTAssertEqual(masonNetWorth.map(\.label), ["Mason Strike"])
    }

    // MARK: - Todo Filtering (TodayView, ProjectsView)

    func testTodoFilteringForAdult() {
        let todos = sampleTodos()
        let victorVisible = todos.filter { FamilyMember.victor.canSee(dataOwnedBy: $0.ownerMember) }
        XCTAssertEqual(victorVisible.count, todos.count, "Victor sees all todos")

        let rachelVisible = todos.filter { FamilyMember.rachel.canSee(dataOwnedBy: $0.ownerMember) }
        XCTAssertEqual(rachelVisible.count, todos.count, "Rachel sees all todos")
    }

    func testRachelSeesVictorTodo_CriticalRegression() {
        let todos = sampleTodos()
        let rachelVisible = todos.filter { FamilyMember.rachel.canSee(dataOwnedBy: $0.ownerMember) }

        XCTAssertTrue(
            rachelVisible.contains { $0.title == "Pay mortgage" && $0.ownerMember == .victor },
            "CRITICAL: Rachel must see Victor-owned todos in shared household views.",
        )
    }

    func testTodoFilteringForChild() {
        let todos = sampleTodos()
        let masonVisible = todos.filter { FamilyMember.mason.canSee(dataOwnedBy: $0.ownerMember) }
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
        XCTAssertEqual(Set(fixture.expectations.visibleTodoCount.keys), expectedMembers)
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

        for (viewerName, expectedCount) in fixture.expectations.visibleTodoCount {
            let viewer = try familyMember(viewerName)
            XCTAssertEqual(
                todos.filter { viewer.canSee(dataOwnedBy: $0.ownerMember) }.count,
                expectedCount,
            )
        }

        for (viewerName, expectedTitles) in fixture.expectations.visibleTodoTitles {
            let viewer = try familyMember(viewerName)
            XCTAssertEqual(
                todos
                    .filter { viewer.canSee(dataOwnedBy: $0.ownerMember) }
                    .map(\.title),
                expectedTitles,
            )
        }

        let rachelVisibleTodos = todos.filter { FamilyMember.rachel.canSee(dataOwnedBy: $0.ownerMember) }
        XCTAssertTrue(rachelVisibleTodos.contains {
            $0.title == fixture.expectations.rachelSeesVictorTodo && $0.ownerMember == .victor
        })

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
            BTCAccount(key: "coldcard-victor", label: "Coldcard", custody: .selfCustody, btc: Decimal(string: "3.5")!, owner: .victor),
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
    let visibleTodoCount: [String: Int]
    let visibleTodoTitles: [String: [String]]
    let rachelSeesVictorTodo: String
    let visibleSpend: [String: String]
    let budgetSpend: [String: String]
}
