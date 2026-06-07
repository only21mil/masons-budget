import XCTest

final class FamilyVisibilityTests: XCTestCase {
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

    // MARK: - MC2 Owner Tag Defaults

    func testDefaultOwnerIsVictor() {
        let tx = Transaction(
            id: "no-owner",
            date: .now,
            merchant: "Test",
            amount: -10,
            category: "Other",
            createdBy: "mc2",
        )
        XCTAssertEqual(tx.ownerMember, .victor, "Untagged records default to Victor (MC2 convention)")
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

    // MARK: - Helpers

    private func sampleTransactions() -> [Transaction] {
        [
            Transaction(id: "tx-1", date: .now, merchant: "Costco", amount: -150, category: "Groceries", owner: .victor, createdBy: "mc2"),
            Transaction(id: "tx-2", date: .now, merchant: "Salary", amount: 5000, category: "Income", owner: .victor, createdBy: "mc2"),
            Transaction(id: "tx-3", date: .now, merchant: "Target", amount: -95, category: "Shopping", owner: .rachel, createdBy: "mc2"),
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
