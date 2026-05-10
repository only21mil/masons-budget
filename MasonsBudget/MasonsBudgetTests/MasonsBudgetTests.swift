// Mason's Budget App — Unit Tests

import XCTest
import SwiftUI
import SwiftData

final class MasonsBudgetTests: XCTestCase {

    // MARK: - Theme & UI

    func testAppThemeColorsExist() {
        _ = AppTheme.accentColor
        _ = AppTheme.background
        _ = AppTheme.cardBackground
        _ = AppTheme.primaryText
    }

    func testAppTabCases() {
        let tabs = AppTab.allCases
        XCTAssertEqual(tabs, [.home, .budget, .today, .stack, .more])
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
        XCTAssertNotNil(btcOrange)
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
            createdBy: "mason"
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
            createdBy: "test"
        )

        XCTAssertEqual(tx.amount, 90)
        XCTAssertEqual(tx.amountSats, 125_000)
        XCTAssertEqual(tx.satsValue(btcPrice: 90_000), 125_000)
    }

    func testTransactionDerivesSatsFromFiatWhenExplicitSatsMissing() {
        let tx = Transaction(
            id: "t-usd-001",
            date: .now,
            merchant: "Coffee",
            amount: 90,
            category: "Dining",
            createdBy: "test"
        )

        XCTAssertNil(tx.amountSats)
        XCTAssertEqual(tx.satsValue(btcPrice: 90_000), 100_000)
    }

    func testBudgetCategoryInit() {
        let cat = BudgetCategory(
            name: "Groceries",
            icon: "cart.fill",
            monthlyBudget: 800
        )
        XCTAssertEqual(cat.name, "Groceries")
        XCTAssertEqual(cat.sortOrder, 0)
        XCTAssertFalse(cat.isIncome)
    }

    func testBudgetNotificationsFilterTransactionsByFamilyMember() {
        let category = BudgetCategory(
            name: "Gaming",
            icon: "gamecontroller.fill",
            monthlyBudget: 100
        )
        let masonTransaction = Transaction(
            id: "tx-mason-gaming",
            date: Date(),
            merchant: "Game Store",
            amount: 90,
            category: "Gaming",
            owner: .mason,
            createdBy: "mason"
        )
        let victorTransaction = Transaction(
            id: "tx-victor-gaming",
            date: Date(),
            merchant: "Console Store",
            amount: 90,
            category: "Gaming",
            owner: .victor,
            createdBy: "victor"
        )

        let alerts = BudgetNotificationManager.shared.budgetAlerts(
            categories: [category],
            transactions: [masonTransaction, victorTransaction],
            member: .mason
        )

        XCTAssertEqual(alerts.count, 1)
        XCTAssertEqual(alerts.first?.title, "Gaming Almost at Limit")
    }

    func testBTCAccountInit() {
        let acct = BTCAccount(
            key: "strike-victor",
            label: "Strike",
            custody: .exchange,
            btc: Decimal(string: "0.01001648")!,
            owner: .victor
        )
        XCTAssertEqual(acct.key, "strike-victor")
        XCTAssertEqual(acct.custody, .exchange)
        XCTAssertEqual(acct.fiat, 0)
    }

    func testBTCAccountUsesSyncedFiatValue() {
        UserDefaults.standard.removeObject(forKey: BTCPriceService.priceKey)
        let acct = BTCAccount(
            key: "river-victor",
            label: "River",
            custody: .exchange,
            btc: Decimal(string: "0.5")!,
            fiat: 50000,
            owner: .victor
        )

        XCTAssertEqual(acct.usdValue(), 50000)
    }

    func testBTCAccountUsesLivePriceOverSnapshotFiat() {
        let acct = BTCAccount(
            key: "river-victor-live",
            label: "River",
            custody: .exchange,
            btc: Decimal(string: "0.5")!,
            fiat: 50000,
            owner: .victor
        )

        XCTAssertEqual(acct.usdValue(liveBTCPrice: 100000), 50000)
    }

    func testBTCBuyInit() {
        let buy = BTCBuy(
            id: "b-strike-2026-04-30",
            date: .now,
            source: "Strike",
            amountBTC: Decimal(string: "0.00052")!,
            amountSats: 52000,
            priceUSD: 95000,
            usd: 49.40
        )
        XCTAssertEqual(buy.status, "complete")
        XCTAssertEqual(buy.costBasisStatus, "complete")
        XCTAssertNil(buy.archimedesRequestId)
    }

    func testBTCBillPayInit() {
        let pay = BTCBillPay(
            id: "bp-mortgage-2026-04",
            date: .now,
            merchant: "Mortgage",
            category: "Housing",
            amountUSD: 2800,
            btcSpent: Decimal(string: "0.029")!,
            btcPrice: 96551
        )
        XCTAssertEqual(pay.platform, "Strike")
        XCTAssertNil(pay.feeUSD)
        XCTAssertEqual(pay.ownerMember, .victor)
    }

    func testBTCBillPayHiddenFromKidProfiles() {
        let pay = BTCBillPay(
            id: "bp-victor",
            date: .now,
            merchant: "PENNYMAC",
            category: "Mortgage",
            amountUSD: 3613.79,
            btcSpent: Decimal(string: "0.054")!,
            btcPrice: 66612.33
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
            createdBy: "vogel-vault"
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

    func testHoldingAccountRelationship() {
        let acct = HoldingAccount(
            name: "401k",
            provider: "Fidelity",
            owner: .victor,
            totalValue: 773307.46
        )
        XCTAssertTrue(acct.holdings.isEmpty)
        XCTAssertEqual(acct.weeklyContribution, 0)
    }
}
