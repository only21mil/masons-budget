// Mason's Budget App — MC2 DTO & Mapper Tests
// Uses embedded JSON fixtures matching the real MC2 file format.
// Note: JSON→Decimal decoding goes through Double, so we use assertDecimalClose
// for fractional values. Integer Decimals (6200, 500) are exact.

import XCTest
import SwiftData
import Foundation

final class MC2ReaderTests: XCTestCase {

    // Helper: Decimal precision can drift through JSON→Double→Decimal path.
    // Compare to 8 decimal places which is more than enough for financial data.
    func assertDecimalClose(_ actual: Decimal?, _ expected: Decimal, tolerance: Decimal = 0.0001, file: StaticString = #file, line: UInt = #line) {
        guard let actual else {
            XCTFail("Decimal was nil, expected \(expected)", file: file, line: line)
            return
        }
        let diff = abs(actual - expected)
        XCTAssertTrue(diff < tolerance, "Decimal \(actual) not close to \(expected) (diff: \(diff))", file: file, line: line)
    }

    // MARK: - Date parsing

    func testDateParsingYMD() {
        let date = MC2Mapper.parseDate("2026-04-30")
        XCTAssertNotEqual(date, .distantPast)
    }

    func testDateParsingISO8601() {
        let date = MC2Mapper.parseDate("2026-04-30T15:09:48.945031Z")
        XCTAssertNotEqual(date, .distantPast)
    }

    // MARK: - transactions.json

    func testDecodeTransactions() throws {
        let json = """
        [
          {"id":"mortgage-2026-03-01","date":"2026-03-01","merchant":"PennyMac (Mortgage)","amount":3613.79,"category":"Bills & Utilities","card":"Strike (BTC)","note":"Monthly mortgage payment"},
          {"id":"t001","date":"2026-03-02","merchant":"Kroger","amount":76.81,"category":"Groceries","card":"Strike","note":""}
        ]
        """.data(using: .utf8)!

        let dtos = try JSONDecoder().decode([MC2Transaction].self, from: json)
        XCTAssertEqual(dtos.count, 2)
        XCTAssertEqual(dtos[0].id, "mortgage-2026-03-01")
        assertDecimalClose(dtos[0].amount, 3613.79)
        XCTAssertEqual(dtos[1].merchant, "Kroger")
    }

    func testMapTransactions() throws {
        let json = """
        [{"id":"t001","date":"2026-03-02","merchant":"Kroger","amount":76.81,"category":"Groceries","card":"Strike","note":""}]
        """.data(using: .utf8)!

        let dtos = try JSONDecoder().decode([MC2Transaction].self, from: json)
        let models = MC2Mapper.mapTransactions(dtos)

        XCTAssertEqual(models.count, 1)
        XCTAssertEqual(models[0].id, "t001")
        XCTAssertEqual(models[0].merchant, "Kroger")
        assertDecimalClose(models[0].amount, 76.81)
        XCTAssertEqual(models[0].createdBy, "mc2")
        XCTAssertEqual(models[0].sourceFile, "transactions.json")
        XCTAssertNotEqual(models[0].date, .distantPast)
    }

    func testMC2PositiveSpendingClassifiesAsSpend() throws {
        let json = """
        [{"id":"t001","date":"2026-03-02","merchant":"Kroger","amount":76.81,"category":"Groceries","card":"Aven","note":""}]
        """.data(using: .utf8)!

        let dtos = try JSONDecoder().decode([MC2Transaction].self, from: json)
        let tx = try XCTUnwrap(MC2Mapper.mapTransactions(dtos).first)

        XCTAssertTrue(tx.isSpend)
        XCTAssertFalse(tx.isIncome)
        assertDecimalClose(tx.spendAmount, 76.81)
        assertDecimalClose(tx.displayAmount, -76.81)
    }

    func testIncomeCategoryClassifiesAsIncome() {
        let tx = Transaction(
            id: "income-1",
            date: .now,
            merchant: "Paycheck",
            amount: 500,
            category: "Income",
            createdBy: "app"
        )

        XCTAssertTrue(tx.isIncome)
        XCTAssertFalse(tx.isSpend)
        assertDecimalClose(tx.displayAmount, 500)
    }

    func testAppTransactionPayloadMatchesMC2Shape() throws {
        var components = DateComponents()
        components.calendar = Calendar(identifier: .gregorian)
        components.timeZone = TimeZone(secondsFromGMT: 0)
        components.year = 2026
        components.month = 5
        components.day = 1
        components.hour = 12

        let transaction = Transaction(
            id: "manual-1-abcdef",
            date: try XCTUnwrap(components.date),
            merchant: "Starbucks",
            amount: 25.00,
            category: "Dining & Drinks",
            card: "Strike",
            note: "Coffee",
            owner: .victor,
            createdBy: "manual"
        )

        let dto = MC2Transaction(appTransaction: transaction)
        XCTAssertEqual(dto.id, "manual-1-abcdef")
        XCTAssertEqual(dto.date, "2026-05-01")
        XCTAssertEqual(dto.merchant, "Starbucks")
        XCTAssertEqual(dto.category, "Dining & Drinks")
        XCTAssertEqual(dto.card, "Strike")
        XCTAssertEqual(dto.note, "Coffee")

        let payload = try dto.convexJSONObject()
        XCTAssertEqual(payload["id"] as? String, "manual-1-abcdef")
        XCTAssertEqual(payload["date"] as? String, "2026-05-01")
        XCTAssertEqual(payload["merchant"] as? String, "Starbucks")
        XCTAssertEqual(payload["category"] as? String, "Dining & Drinks")
        XCTAssertEqual(payload["card"] as? String, "Strike")
        XCTAssertEqual(payload["note"] as? String, "Coffee")
        XCTAssertEqual(payload["amount"] as? Double, 25.0)
    }

    func testAppSpendPayloadUsesPositiveMC2Amount() throws {
        let transaction = Transaction(
            id: "manual-spend",
            date: .now,
            merchant: "Dominos",
            amount: -32.45,
            category: "Dining & Drinks",
            card: "Aven",
            owner: .victor,
            createdBy: "app"
        )

        let dto = MC2Transaction(appTransaction: transaction)
        assertDecimalClose(dto.amount, 32.45)

        let payload = try dto.convexJSONObject()
        XCTAssertEqual(payload["amount"] as? Double, 32.45)
    }

    // MARK: - budget.json

    func testDecodeBudget() throws {
        let json = """
        {
          "coinbase_one_balance": 26.42,
          "month": "April 2026",
          "categories": [
            {"name":"Bills & Utilities","icon":"house","budget":6200,"spent":5943.57},
            {"name":"Groceries","icon":"cart","budget":1500,"spent":1527.27}
          ],
          "strategy": {
            "effective_apr": 5.99,
            "strategy_note": "BTC-first cashflow plan."
          },
          "income": {
            "weekly_gross": 3941.53,
            "weekly_strike": 500,
            "weekly_river": 3441.53,
            "pay_frequency": "weekly",
            "monthly_gross": 17079.96,
            "mtd_income": 3941.53,
            "paychecks": [
              {"date":"2026-04-01","platform":"Strike","amount":500,"net":500},
              {"date":"2026-04-03","platform":"River","amount":3441.53,"net":3441.53}
            ]
          }
        }
        """.data(using: .utf8)!

        let budget = try JSONDecoder().decode(MC2Budget.self, from: json)
        XCTAssertEqual(budget.month, "April 2026")
        XCTAssertEqual(budget.categories.count, 2)
        assertDecimalClose(budget.income?.weeklyGross, 3941.53)
        assertDecimalClose(budget.income?.mtdIncome, 3941.53)
        XCTAssertEqual(budget.income?.paychecks?.count, 2)
        XCTAssertEqual(budget.strategy?.strategyNote, "BTC-first cashflow plan.")
    }

    func testMapBudgetSnapshot() throws {
        let json = """
        {
          "month": "April 2026",
          "categories": [],
          "income": {
            "weekly_gross": 3941.53,
            "weekly_strike": 500,
            "weekly_river": 3441.53,
            "pay_frequency": "weekly",
            "monthly_gross": 17079.96,
            "paychecks": [
              {"date":"2026-01-03","platform":"River","amount":3000,"net":3000},
              {"date":"2026-04-01","platform":"Strike","amount":500,"net":500},
              {"date":"2026-04-03","platform":"River","amount":3441.53,"net":3441.53}
            ]
          }
        }
        """.data(using: .utf8)!

        let dto = try JSONDecoder().decode(MC2Budget.self, from: json)
        let snapshot = MC2Mapper.mapBudgetSnapshot(dto)

        XCTAssertEqual(snapshot.monthKey, "April 2026")
        assertDecimalClose(snapshot.weeklyGross, 3941.53)
        assertDecimalClose(snapshot.monthlyGross, 17079.96)
        assertDecimalClose(snapshot.mtdIncome, 3941.53)
        assertDecimalClose(snapshot.ytdIncome, 6941.53)
        XCTAssertEqual(snapshot.payFrequency, "weekly")
    }

    func testMapBudgetCategories() throws {
        let json = """
        [
          {"name":"Bills & Utilities","icon":"house","budget":6200,"spent":5943.57},
          {"name":"Groceries","icon":"cart","budget":1500,"spent":1527.27}
        ]
        """.data(using: .utf8)!

        let dtos = try JSONDecoder().decode([MC2BudgetCategory].self, from: json)
        let models = MC2Mapper.mapBudgetCategories(dtos)

        XCTAssertEqual(models.count, 2)
        XCTAssertEqual(models[0].name, "Bills & Utilities")
        XCTAssertEqual(models[0].monthlyBudget, 6200)  // Integer — exact
        XCTAssertEqual(models[0].sortOrder, 0)
        XCTAssertEqual(models[1].sortOrder, 1)
        XCTAssertFalse(models[0].isIncome)
    }

    // MARK: - btc-balance-snapshot.json

    func testDecodeBTCSnapshot() throws {
        let json = """
        {
          "schemaVersion": 1,
          "asOf": "2026-04-30T15:09:48.945031Z",
          "accounts": {
            "strike": {"btc":0.00874765,"fiat":0,"label":"Strike","custody":"exchange"},
            "coldcard": {"btc":4.51718914,"fiat":0,"label":"Coldcard","custody":"self_custody"}
          },
          "totals": {"btc":4.58478055,"fiat":0,"exchange_btc":0.06408003,"self_custody_btc":4.52070052},
          "metadata": {"source":"snapshot","basis":"authoritative","confidence":"high"}
        }
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(MC2BTCSnapshot.self, from: json)
        XCTAssertEqual(snapshot.schemaVersion, 1)
        XCTAssertEqual(snapshot.accounts.count, 2)
        assertDecimalClose(snapshot.accounts["strike"]?.btc, 0.00874765)
        XCTAssertEqual(snapshot.accounts["coldcard"]?.custody, "self_custody")
        assertDecimalClose(snapshot.totals.btc, 4.58478055)
    }

    func testMapBTCAccounts() throws {
        let json = """
        {
          "schemaVersion": 1,
          "asOf": "2026-04-30",
          "accounts": {
            "strike": {"btc":0.00874765,"fiat":0,"label":"Strike","custody":"exchange"},
            "coldcard": {"btc":4.51718914,"fiat":0,"label":"Coldcard","custody":"self_custody"}
          },
          "totals": {"btc":4.52593679,"fiat":0,"exchange_btc":0.00874765,"self_custody_btc":4.51718914}
        }
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(MC2BTCSnapshot.self, from: json)
        let accounts = MC2Mapper.mapBTCAccounts(snapshot, owner: .victor)

        XCTAssertEqual(accounts.count, 2)
        for acct in accounts {
            XCTAssertEqual(acct.ownerMember, .victor)
            XCTAssertTrue(acct.key.hasSuffix("-victor"))
        }

        let coldcard = accounts.first(where: { $0.label == "Coldcard" })
        XCTAssertNotNil(coldcard)
        XCTAssertEqual(coldcard?.custody, .selfCustody)
        assertDecimalClose(coldcard?.btc, 4.51718914)
    }

    // MARK: - bitcoin-buys.json

    func testDecodeBTCBuys() throws {
        let json = """
        [
          {
            "id": "b-strike-2026-04-01",
            "date": "2026-04-01",
            "source": "Strike",
            "amount_sats": 732371,
            "amount_btc": 0.00732371,
            "price_usd": 68271.41,
            "usd": 500.0,
            "note": "Direct deposit auto-buy",
            "status": "complete",
            "cost_basis_status": "complete",
            "logged_by": "user-screenshot",
            "archimedes_request_id": "arch-2026-04-01-strike"
          }
        ]
        """.data(using: .utf8)!

        let buys = try JSONDecoder().decode([MC2BTCBuy].self, from: json)
        XCTAssertEqual(buys.count, 1)
        XCTAssertEqual(buys[0].id, "b-strike-2026-04-01")
        XCTAssertEqual(buys[0].amountSats, 732371)
        assertDecimalClose(buys[0].amountBtc, 0.00732371)
        assertDecimalClose(buys[0].priceUsd, 68271.41)
    }

    func testMapBTCBuy() throws {
        let dto = MC2BTCBuy(
            id: "b-strike-2026-04-01",
            date: "2026-04-01",
            source: "Strike",
            amountSats: 732371,
            amountBtc: 0.00732371,
            priceUsd: 68271.41,
            usd: 500.0,
            note: "Auto-buy",
            status: "complete",
            costBasisStatus: "complete",
            loggedBy: "user-screenshot",
            archimedesRequestId: "arch-001"
        )

        let model = MC2Mapper.mapBTCBuy(dto)
        XCTAssertEqual(model.id, "b-strike-2026-04-01")
        XCTAssertEqual(model.amountSats, 732371)
        XCTAssertEqual(model.source, "Strike")
        XCTAssertEqual(model.archimedesRequestId, "arch-001")
        XCTAssertNotEqual(model.date, .distantPast)
    }

    // MARK: - bitcoin-bill-pays.json

    func testDecodeBTCBillPays() throws {
        let json = """
        {
          "bill_pays": [
            {
              "id": "bp005",
              "date": "2026-03-01",
              "merchant": "PENNYMAC",
              "category": "Mortgage",
              "amount_usd": 3613.79,
              "btc_spent": 0.05425107,
              "btc_price": 66612.33,
              "platform": "Strike",
              "fee_usd": 28.55,
              "note": "Mortgage via Strike"
            }
          ]
        }
        """.data(using: .utf8)!

        let wrapper = try JSONDecoder().decode(MC2BillPaysWrapper.self, from: json)
        XCTAssertEqual(wrapper.billPays.count, 1)
        XCTAssertEqual(wrapper.billPays[0].id, "bp005")
        assertDecimalClose(wrapper.billPays[0].amountUsd, 3613.79)
        assertDecimalClose(wrapper.billPays[0].feeUsd, 28.55)
    }

    func testMapBTCBillPay() throws {
        let dto = MC2BTCBillPay(
            id: "bp005",
            date: "2026-03-01",
            merchant: "PENNYMAC",
            category: "Mortgage",
            amountUsd: 3613.79,
            btcSpent: 0.05425107,
            btcPrice: 66612.33,
            platform: "Strike",
            note: "Mortgage",
            feeUsd: 28.55,
            reference: nil,
            owner: nil
        )

        let model = MC2Mapper.mapBTCBillPay(dto)
        XCTAssertEqual(model.platform, "Strike")
        XCTAssertEqual(model.feeUSD, 28.55)
        XCTAssertEqual(model.btcSpent, 0.05425107)
        XCTAssertEqual(model.ownerMember, .victor)
    }

    func testMapBTCBillPayMasonOwner() throws {
        let dto = MC2BTCBillPay(
            id: "bp-mason-allowance",
            date: "2026-04-15",
            merchant: "Mason allowance",
            category: "Allowance",
            amountUsd: 25,
            btcSpent: 0.0003,
            btcPrice: 83333,
            platform: "Strike",
            note: nil,
            feeUsd: nil,
            reference: nil,
            owner: "mason"
        )

        let model = MC2Mapper.mapBTCBillPay(dto)
        XCTAssertEqual(model.ownerMember, .mason)
    }

    // MARK: - finances.json

    func testDecodeFinances() throws {
        let json = """
        {
          "lastUpdated": "2026-04-29",
          "retirement": {
            "401k": {
              "provider": "Discount Tire 401(k)",
              "total": 773307.46,
              "holdings": [
                {
                  "name": "VOO",
                  "category": "Large Cap",
                  "value": 601281.38,
                  "costBasis": 213109.93,
                  "gainPct": 182.15,
                  "shares": 932.42,
                  "avgCost": 228.56,
                  "currentPricePerShare": 644.86,
                  "ticker": "VOO",
                  "lots": [
                    {"date":"2026-03-07","type":"conversion_baseline","pricePerShare":619.85,"shares":929.097,"amountInvested":211068.73}
                  ]
                }
              ]
            }
          }
        }
        """.data(using: .utf8)!

        let finances = try JSONDecoder().decode(MC2Finances.self, from: json)
        XCTAssertNotNil(finances.retirement.accounts["401k"])
        assertDecimalClose(finances.retirement.accounts["401k"]?.total, 773307.46)
        XCTAssertEqual(finances.retirement.accounts["401k"]?.holdings.count, 1)
    }

    func testDecodeLiveFinancesShape() throws {
        let json = """
        {
          "lastUpdated": "2026-04-29",
          "retirement": {
            "401k": {
              "provider": "Discount Tire 401(k)",
              "total": 773307.46,
              "holdings": [
                {
                  "name": "Cash & Money Market",
                  "category": "Cash",
                  "value": 37.83,
                  "costBasis": 37.83,
                  "gainPct": 0
                }
              ],
              "weeklyContribution": 291.6,
              "weeklyContributionDay": "Friday"
            },
            "wap": {
              "provider": "Discount Tire WAP",
              "total": 911987.42,
              "holdings": [
                {
                  "name": "VOO - Vanguard S&P 500 ETF",
                  "ticker": "VOO",
                  "value": 911987.42,
                  "costBasis": 356459.07,
                  "gainPct": 155.85,
                  "shares": 1393.9646307166,
                  "avgCost": 255.72,
                  "currentPricePerShare": 654.24
                }
              ]
            },
            "total": 1685294.88
          }
        }
        """.data(using: .utf8)!

        let finances = try JSONDecoder().decode(MC2Finances.self, from: json)

        XCTAssertEqual(finances.lastUpdated, "2026-04-29")
        XCTAssertEqual(Set(finances.retirement.accounts.keys), ["401k", "wap"])
        XCTAssertNil(finances.retirement.accounts["total"])
        XCTAssertEqual(finances.retirement.accounts["401k"]?.holdings[0].shares, 0)
        XCTAssertEqual(finances.retirement.accounts["wap"]?.holdings[0].category, "Uncategorized")
    }

    func testMapFinancesCreatesHoldingTree() throws {
        let json = """
        {
          "lastUpdated": "2026-04-29",
          "retirement": {
            "401k": {
              "provider": "Discount Tire 401(k)",
              "total": 773307.46,
              "holdings": [
                {
                  "name": "VOO",
                  "category": "Large Cap",
                  "value": 601281.38,
                  "costBasis": 213109.93,
                  "gainPct": 182.15,
                  "shares": 932.42,
                  "avgCost": 228.56,
                  "currentPricePerShare": 644.86,
                  "ticker": "VOO",
                  "lots": [
                    {"date":"2026-03-07","type":"conversion_baseline","pricePerShare":619.85,"shares":929.097,"amountInvested":211068.73}
                  ]
                }
              ]
            }
          }
        }
        """.data(using: .utf8)!

        let finances = try JSONDecoder().decode(MC2Finances.self, from: json)
        let accounts = MC2Mapper.mapFinances(finances, owner: .victor)

        let k401 = accounts.first(where: { $0.name == "401k" })!
        XCTAssertEqual(k401.provider, "Discount Tire 401(k)")
        XCTAssertEqual(k401.ownerMember, .victor)
        assertDecimalClose(k401.totalValue, 773307.46)
        XCTAssertEqual(k401.holdings.count, 1)
        XCTAssertEqual(k401.holdings[0].ticker, "VOO")
        XCTAssertEqual(k401.holdings[0].lots.count, 1)
        XCTAssertEqual(k401.holdings[0].lots[0].type, "conversion_baseline")
    }

    // MARK: - son-balances.json

    func testDecodeSonBalances() throws {
        let json = """
        {"strike":0.00667448,"river":0.02497671,"coldcard":0.75072814,"total":0.78237933,"lastUpdated":"2026-04-24"}
        """.data(using: .utf8)!

        let son = try JSONDecoder().decode(MC2SonBalances.self, from: json)
        assertDecimalClose(son.total, 0.78237933)
        assertDecimalClose(son.coldcard, 0.75072814)
    }

    func testMapSonBalancesCreatesMasonAccounts() throws {
        let son = MC2SonBalances(strike: 0.00667, river: 0.02497, coldcard: 0.75072, total: 0.78236, lastUpdated: "2026-04-24")
        let accounts = MC2Mapper.mapSonBalances(son)

        XCTAssertEqual(accounts.count, 3)
        for acct in accounts {
            XCTAssertEqual(acct.ownerMember, .mason)
            XCTAssertTrue(acct.key.hasSuffix("-mason"))
        }

        let coldcard = accounts.first(where: { $0.label == "Coldcard" })
        XCTAssertEqual(coldcard?.custody, .selfCustody)
        XCTAssertEqual(coldcard?.btc, 0.75072) // Exact — created from Decimal literal
    }
}
