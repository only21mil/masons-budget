// Mason's Budget App — Unit Tests

import SwiftData
import SwiftUI
import XCTest

final class MasonsBudgetTests: XCTestCase {
    // MARK: - Theme & UI

    func testAppThemeColorsExist() {
        XCTAssertEqual(ColorTokens.dark.accent, Color(hex: 0xF7931A))
        XCTAssertEqual(ColorTokens.dark.bg, Color(hex: 0x0B0907))
        XCTAssertEqual(ColorTokens.dark.surface, Color(hex: 0x15120E))
        XCTAssertEqual(ColorTokens.dark.text, Color(hex: 0xF4ECD8))

        XCTAssertEqual(ColorTokens.light.accent, Color(hex: 0xF7931A))
        XCTAssertEqual(ColorTokens.light.bg, Color(hex: 0xFAF8F4))
        XCTAssertEqual(ColorTokens.light.surface, .white)
        XCTAssertEqual(ColorTokens.light.text, Color(hex: 0x15110A))
    }

    func testAppTabCases() {
        let tabs = AppTab.allCases
        XCTAssertEqual(tabs, [.home, .budget, .tasks, .vault, .more])
        for tab in tabs {
            XCTAssertFalse(tab.label.isEmpty, "\(tab) should have a label")
            XCTAssertFalse(tab.icon.isEmpty, "\(tab) should have an icon")
        }

        XCTAssertTrue(MacNav.moneyItems.contains(.activity))
        XCTAssertTrue(MacNav.moneyItems.contains(.netWorth))
        XCTAssertTrue(MacNav.taskItems.contains(.projects))
    }

    func testColorHexInit() {
        let btcOrange = Color(hex: 0xF7931A)
        XCTAssertEqual(
            btcOrange,
            Color(
                red: 247.0 / 255.0,
                green: 147.0 / 255.0,
                blue: 26.0 / 255.0,
            ),
        )
    }

    // MARK: - Enums

    func testFamilyMemberCases() {
        let members = FamilyMember.allCases
        XCTAssertEqual(members.count, 4)
        XCTAssertEqual(FamilyMember.victor.displayName, "Victor")
        XCTAssertEqual(FamilyMember.mason.displayName, "Mason")
    }

    func testFamilyMemberVisibilityRules() {
        XCTAssertTrue(FamilyMember.victor.isAdult)
        XCTAssertTrue(FamilyMember.rachel.isAdult)
        XCTAssertFalse(FamilyMember.mason.isAdult)
        XCTAssertFalse(FamilyMember.maddox.isAdult)

        XCTAssertTrue(FamilyMember.victor.canSee(dataOwnedBy: .mason))
        XCTAssertTrue(FamilyMember.rachel.canSee(dataOwnedBy: .victor))
        XCTAssertFalse(FamilyMember.mason.canSee(dataOwnedBy: .victor))
        XCTAssertEqual(FamilyMember.mason.allowedSwitchTargets, [.mason])
    }

    func testBTCCustodyRawValues() {
        XCTAssertEqual(BTCCustody.exchange.rawValue, "exchange")
        XCTAssertEqual(BTCCustody.selfCustody.rawValue, "self_custody")
    }

    func testSyncOperationCases() {
        XCTAssertEqual(SyncOperation.create.rawValue, "create")
        XCTAssertEqual(SyncOperation.update.rawValue, "update")
        XCTAssertEqual(SyncOperation.delete.rawValue, "delete")
    }

    func testTransactionSourceCatalogIncludesRequestedCards() {
        let spendSources = TransactionSourceCatalog.sources(for: .spend)
        XCTAssertTrue(spendSources.contains("Aven Card"))
        XCTAssertTrue(spendSources.contains("Coinbase One Card"))
        XCTAssertTrue(spendSources.contains("Gemini Card"))
        XCTAssertTrue(spendSources.contains("SoFi Card"))
    }

    func testTransactionSourceCatalogFiltersByActivity() {
        let billPaySources = TransactionSourceCatalog.sources(for: .btcBillPay)
        XCTAssertTrue(billPaySources.contains("River Bill Pay"))
        XCTAssertTrue(billPaySources.contains("Strike Bill Pay"))
        XCTAssertFalse(billPaySources.contains("SoFi Card"))
    }

    // MARK: - Model init (verify defaults)

    func testTransactionInit() {
        let tx = Transaction(
            id: "t-test-001",
            date: .now,
            merchant: "Costco",
            amount: 45.99,
            category: "Groceries",
            createdBy: "mason",
        )
        XCTAssertEqual(tx.id, "t-test-001")
        XCTAssertEqual(tx.merchant, "Costco")
        XCTAssertEqual(tx.amount, 45.99)
        XCTAssertNil(tx.amountSats)
        XCTAssertNil(tx.card)
        XCTAssertNil(tx.note)
    }

    func testTransactionKeepsFiatAmountSeparateFromSats() {
        let tx = Transaction(
            id: "t-sats-001",
            date: .now,
            merchant: "Strike DCA",
            amount: 90,
            category: "Bitcoin",
            amountSats: 125_000,
            createdBy: "test",
        )

        XCTAssertEqual(tx.amount, 90)
        XCTAssertEqual(tx.amountSats, 125_000)
        XCTAssertEqual(tx.satsValue(btcPrice: 90000), 125_000)
    }

    func testTransactionDerivesSatsFromFiatWhenExplicitSatsMissing() {
        let tx = Transaction(
            id: "t-usd-001",
            date: .now,
            merchant: "Coffee",
            amount: 90,
            category: "Dining",
            createdBy: "test",
        )

        XCTAssertNil(tx.amountSats)
        XCTAssertEqual(tx.satsValue(btcPrice: 90000), 100_000)
    }

    // MARK: - Search

    func testSearchMatcherFindsTransactionAcrossMerchantNoteAmountCategoryAndCard() {
        let tx = Transaction(
            id: "t-search-001",
            date: .now,
            merchant: "Café São Paulo",
            amount: -42.75,
            category: "Dining",
            amountSats: 45000,
            card: "lightning",
            note: "Family dinner",
            createdBy: "test",
        )

        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "cafe sao"))
        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "family"))
        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "42.75"))
        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "dining"))
        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "45000"))
        XCTAssertTrue(SearchMatcher.matches(transaction: tx, query: "LIGHTNING"))
        XCTAssertFalse(SearchMatcher.matches(transaction: tx, query: "groceries"))
    }

    func testSearchMatcherFindsTodoAcrossTitleProjectAndArea() {
        let todo = TodoItem(
            id: "todo-search-001",
            title: "Call orthodontist",
            project: "Health Admin",
            area: "Family",
            owner: .rachel,
            createdBy: "mc2",
        )

        XCTAssertTrue(SearchMatcher.matches(todo: todo, query: "ORTHODONTIST"))
        XCTAssertTrue(SearchMatcher.matches(todo: todo, query: "health"))
        XCTAssertTrue(SearchMatcher.matches(todo: todo, query: "family"))
        XCTAssertFalse(SearchMatcher.matches(todo: todo, query: "mortgage"))
    }

    @MainActor
    func testSyncStatusStoreTracksFailureAndRetry() {
        let store = SyncStatusStore()
        var didRetry = false

        store.begin("Save transaction")
        store.complete("Save transaction", success: false, retry: {
            didRetry = true
        })

        XCTAssertEqual(store.phase, .failed)
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertEqual(store.lastError, "Save transaction did not sync")

        store.retry()

        XCTAssertTrue(didRetry)
        XCTAssertEqual(store.phase, .idle)
        XCTAssertNil(store.lastError)
    }

    @MainActor
    func testSyncStatusStoreClearsAfterFinalSuccess() {
        let store = SyncStatusStore()

        store.begin("Save todo")
        store.begin("Save transaction")
        store.complete("Save todo", success: true)

        XCTAssertEqual(store.phase, .syncing)
        XCTAssertEqual(store.pendingCount, 1)

        store.complete("Save transaction", success: true)

        XCTAssertEqual(store.phase, .idle)
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertNil(store.lastError)
    }

    func testBudgetCategoryInit() {
        let cat = BudgetCategory(
            name: "Groceries",
            icon: "cart.fill",
            monthlyBudget: 800,
        )
        XCTAssertEqual(cat.name, "Groceries")
        XCTAssertEqual(cat.sortOrder, 0)
        XCTAssertFalse(cat.isIncome)
    }

    func testBudgetNotificationsFilterTransactionsByFamilyMember() {
        let category = BudgetCategory(
            name: "Gaming",
            icon: "gamecontroller.fill",
            monthlyBudget: 100,
            owner: .mason,
        )
        let masonTransaction = Transaction(
            id: "tx-mason-gaming",
            date: Date(),
            merchant: "Game Store",
            amount: 90,
            category: "Gaming",
            owner: .mason,
            createdBy: "mason",
        )
        let victorTransaction = Transaction(
            id: "tx-victor-gaming",
            date: Date(),
            merchant: "Console Store",
            amount: 90,
            category: "Gaming",
            owner: .victor,
            createdBy: "victor",
        )

        let alerts = BudgetNotificationManager.shared.budgetAlerts(
            categories: [category],
            transactions: [masonTransaction, victorTransaction],
            member: .mason,
        )

        XCTAssertEqual(alerts.count, 1)
        XCTAssertEqual(alerts.first?.title, "Gaming Almost at Limit")
    }

    func testBudgetNotificationsUseNarrowScopeAndCanonicalSpend() {
        let adultCategory = BudgetCategory(
            name: "Gaming",
            icon: "gamecontroller.fill",
            monthlyBudget: 100,
            owner: .victor,
        )
        let childCategory = BudgetCategory(
            name: "Mason:Gaming",
            icon: "gamecontroller.fill",
            monthlyBudget: 50,
            owner: .mason,
        )
        let adultSpend = Transaction(
            id: "tx-victor-positive-spend",
            date: Date(),
            merchant: "Console Store",
            amount: 90,
            category: "Gaming",
            owner: .victor,
            createdBy: "victor",
        )
        let childSpend = Transaction(
            id: "tx-mason-positive-spend",
            date: Date(),
            merchant: "Game Store",
            amount: 60,
            category: "Gaming",
            owner: .mason,
            createdBy: "mason",
        )

        let alerts = BudgetNotificationManager.shared.budgetAlerts(
            categories: [adultCategory, childCategory],
            transactions: [adultSpend, childSpend],
            member: .victor,
        )

        XCTAssertEqual(alerts.count, 1)
        XCTAssertEqual(alerts.first?.title, "Gaming Almost at Limit")
    }

    func testTransactionsExportUsesWideRecordVisibility() {
        let adult = Transaction(
            id: "tx-export-adult",
            date: Date(),
            merchant: "Grocer",
            amount: -10,
            category: "Groceries",
            owner: .victor,
            createdBy: "victor",
        )
        let child = Transaction(
            id: "tx-export-child",
            date: Date(),
            merchant: "Game Store",
            amount: 10,
            category: "Gaming",
            owner: .mason,
            createdBy: "mason",
        )

        let adultExport = ExportView.transactionsVisible(to: .victor, in: [adult, child])
        let childExport = ExportView.transactionsVisible(to: .mason, in: [adult, child])

        XCTAssertEqual(adultExport.map(\.id), [adult.id, child.id])
        XCTAssertEqual(childExport.map(\.id), [child.id])
    }

    @MainActor
    func testTransactionDetailCategoryQueryUsesTransactionBudgetScope() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: BudgetCategory.self, configurations: configuration)
        let context = container.mainContext
        context.insert(BudgetCategory(name: "Adult", icon: "house", monthlyBudget: 100, owner: .victor))
        context.insert(BudgetCategory(name: "Spouse", icon: "house", monthlyBudget: 100, owner: .rachel))
        context.insert(BudgetCategory(name: "Child", icon: "gamecontroller", monthlyBudget: 100, owner: .mason))
        try context.save()

        let adultCategories = try context.fetch(FetchDescriptor(
            predicate: TransactionDetailView.categoryPredicate(for: .victor),
        ))
        let childCategories = try context.fetch(FetchDescriptor(
            predicate: TransactionDetailView.categoryPredicate(for: .mason),
        ))

        XCTAssertEqual(Set(adultCategories.map(\.ownerMember)), Set([.victor, .rachel]))
        XCTAssertEqual(childCategories.map(\.ownerMember), [.mason])
    }

    func testBTCAccountInit() throws {
        let acct = try BTCAccount(
            key: "strike-victor",
            label: "Strike",
            custody: .exchange,
            btc: XCTUnwrap(Decimal(string: "0.01001648")),
            owner: .victor,
        )
        XCTAssertEqual(acct.key, "strike-victor")
        XCTAssertEqual(acct.custody, .exchange)
        XCTAssertEqual(acct.fiat, 0)
    }

    func testBTCAccountUsesSyncedFiatValue() throws {
        UserDefaults.standard.removeObject(forKey: BTCPriceService.priceKey)
        let acct = try BTCAccount(
            key: "river-victor",
            label: "River",
            custody: .exchange,
            btc: XCTUnwrap(Decimal(string: "0.5")),
            fiat: 50000,
            owner: .victor,
        )

        XCTAssertEqual(acct.usdValue(), 50000)
    }

    func testBTCAccountUsesLivePriceOverSnapshotFiat() throws {
        let acct = try BTCAccount(
            key: "river-victor-live",
            label: "River",
            custody: .exchange,
            btc: XCTUnwrap(Decimal(string: "0.5")),
            fiat: 50000,
            owner: .victor,
        )

        XCTAssertEqual(acct.usdValue(liveBTCPrice: 100_000), 50000)
    }

    func testBTCBuyInit() throws {
        let buy = try BTCBuy(
            id: "b-strike-2026-04-30",
            date: .now,
            source: "Strike",
            amountBTC: XCTUnwrap(Decimal(string: "0.00052")),
            amountSats: 52000,
            priceUSD: 95000,
            usd: 49.40,
        )
        XCTAssertEqual(buy.status, "complete")
        XCTAssertEqual(buy.costBasisStatus, "complete")
        XCTAssertNil(buy.archimedesRequestId)
    }

    func testBTCBuyPayloadPreservesDecimalAndOwnerShape() throws {
        let buy = try BTCBuy(
            id: "b-app-test",
            date: Date(timeIntervalSince1970: 1_777_000_000),
            source: "River",
            amountBTC: XCTUnwrap(Decimal(string: "0.00123456")),
            amountSats: 123_456,
            priceUSD: XCTUnwrap(Decimal(string: "100000")),
            usd: XCTUnwrap(Decimal(string: "123.456")),
            note: "Logged in app",
            loggedBy: "app",
            owner: .rachel,
        )

        let dto = MC2BTCBuy(appBuy: buy)
        let object = try dto.convexJSONObject()

        XCTAssertEqual(dto.amountBtc, Decimal(string: "0.00123456"))
        XCTAssertEqual(dto.amountSats, 123_456)
        XCTAssertEqual(dto.owner, FamilyMember.rachel.rawValue)
        XCTAssertEqual(object["owner"] as? String, FamilyMember.rachel.rawValue)
        XCTAssertEqual((object["amount_sats"] as? NSNumber)?.int64Value, 123_456)
    }

    func testBTCBuyFileRoutingUsesDedicatedMasonFileOnly() {
        XCTAssertEqual(FamilyMember.victor.mc2BTCBuysFileName, "bitcoin-buys")
        XCTAssertEqual(FamilyMember.rachel.mc2BTCBuysFileName, "bitcoin-buys")
        XCTAssertEqual(FamilyMember.mason.mc2BTCBuysFileName, "mason-bitcoin-buys")
        XCTAssertEqual(FamilyMember.maddox.mc2BTCBuysFileName, "bitcoin-buys")
    }

    func testBTCBillPayInit() throws {
        let pay = try BTCBillPay(
            id: "bp-mortgage-2026-04",
            date: .now,
            merchant: "Mortgage",
            category: "Housing",
            amountUSD: 2800,
            btcSpent: XCTUnwrap(Decimal(string: "0.029")),
            btcPrice: 96551,
        )
        XCTAssertEqual(pay.platform, "Strike")
        XCTAssertNil(pay.feeUSD)
        XCTAssertEqual(pay.ownerMember, .victor)
    }

    func testBTCBillPayHiddenFromKidProfiles() throws {
        let pay = try BTCBillPay(
            id: "bp-victor",
            date: .now,
            merchant: "PENNYMAC",
            category: "Mortgage",
            amountUSD: 3613.79,
            btcSpent: XCTUnwrap(Decimal(string: "0.054")),
            btcPrice: 66612.33,
        )
        XCTAssertTrue(FamilyMember.victor.canSee(dataOwnedBy: pay.ownerMember))
        XCTAssertTrue(FamilyMember.rachel.canSee(dataOwnedBy: pay.ownerMember))
        XCTAssertFalse(FamilyMember.mason.canSee(dataOwnedBy: pay.ownerMember))
    }

    func testTodoItemInit() {
        let todo = TodoItem(
            id: "vv-test-task",
            title: "Verify MC2 todo sync",
            project: "Inbox",
            dueDate: Date(),
            isFlagged: true,
            owner: .victor,
            createdBy: "vogel-vault",
        )

        XCTAssertEqual(todo.id, "vv-test-task")
        XCTAssertEqual(todo.title, "Verify MC2 todo sync")
        XCTAssertEqual(todo.project, "Inbox")
        XCTAssertTrue(todo.isFlagged)
        XCTAssertFalse(todo.isDone)
        XCTAssertEqual(todo.ownerMember, .victor)
    }

    func testTodoMapperSkipsNonFamilyAssignee() throws {
        let json = """
        [
          {
            "id": "sats-agent-task",
            "text": "Operational task that should stay out of Vogel Vault",
            "category": "sats",
            "assignee": "sats",
            "done": false
          },
          {
            "id": "family-task",
            "text": "Call Ann about hiring",
            "category": "work",
            "status": "pending"
          }
        ]
        """.data(using: .utf8)!
        let dtos = try JSONDecoder().decode([MC2TodoItem].self, from: json)
        let todos = MC2Mapper.mapTodos(dtos, viewer: .victor)

        XCTAssertEqual(todos.map(\.id), ["family-task"])
        XCTAssertEqual(todos.first?.ownerMember, .victor)
        XCTAssertEqual(todos.first?.project, "work")
    }

    func testTodoDecoderAcceptsNumericTimestamps() throws {
        let json = """
        [
          {
            "id": 1774806795347,
            "text": "Sync task with legacy numeric timestamps",
            "category": "family",
            "createdAt": 1774914863033,
            "updated_at": 1774914863034,
            "completedAt": 1774914863035
          }
        ]
        """.data(using: .utf8)!

        let dtos = try JSONDecoder().decode([MC2TodoItem].self, from: json)

        XCTAssertEqual(dtos.first?.id, "1774806795347")
        XCTAssertEqual(dtos.first?.createdAt, "1774914863033")
        XCTAssertEqual(dtos.first?.updatedAt, "1774914863034")
        XCTAssertEqual(dtos.first?.completedAt, "1774914863035")
    }

    func testTodoMapperKeepsRecognizedNonVictorOwnersAndDropsUnknownOwners() throws {
        let json = """
        [
          {
            "id": "rachel-task",
            "text": "Rachel task",
            "owner": "rachel"
          },
          {
            "id": "mason-task",
            "text": "Mason task",
            "owner": "mason"
          },
          {
            "id": "unknown-owner-task",
            "text": "Unknown owner task",
            "owner": "sats"
          }
        ]
        """.data(using: .utf8)!

        let dtos = try JSONDecoder().decode([MC2TodoItem].self, from: json)
        let todos = MC2Mapper.mapTodos(dtos, viewer: .victor)

        XCTAssertEqual(todos.map(\.id), ["rachel-task", "mason-task"])
        XCTAssertEqual(todos.map(\.ownerMember), [.rachel, .mason])
    }

    func testAppTodoPayloadPreservesTodoOwner() {
        let todo = TodoItem(
            id: "mason-app-task",
            title: "Mason app task",
            owner: .mason,
            createdBy: "app",
        )

        let dto = MC2TodoItem(appTodo: todo)

        XCTAssertEqual(dto.owner, FamilyMember.mason.rawValue)
    }

    func testHoldingAccountRelationship() {
        let acct = HoldingAccount(
            name: "401k",
            provider: "Fidelity",
            owner: .victor,
            totalValue: 773_307.46,
        )
        XCTAssertTrue(acct.holdings.isEmpty)
        XCTAssertEqual(acct.weeklyContribution, 0)
    }
}
