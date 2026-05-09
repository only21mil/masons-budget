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
        XCTAssertEqual(tabs.count, 6)
        for tab in tabs {
            XCTAssertFalse(tab.title.isEmpty, "\(tab) should have a title")
            XCTAssertFalse(tab.icon.isEmpty, "\(tab) should have an icon")
        }
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

    func testBTCCustodyRawValues() {
        XCTAssertEqual(BTCCustody.exchange.rawValue, "exchange")
        XCTAssertEqual(BTCCustody.selfCustody.rawValue, "self_custody")
    }

    func testSyncOperationCases() {
        XCTAssertEqual(SyncOperation.create.rawValue, "create")
        XCTAssertEqual(SyncOperation.update.rawValue, "update")
        XCTAssertEqual(SyncOperation.delete.rawValue, "delete")
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
        XCTAssertNil(tx.card)
        XCTAssertNil(tx.note)
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
