import Foundation

struct MC2Transaction: Codable {
    let id: String
    let date: String
    let merchant: String
    let amount: Decimal
    let category: String
    let card: String?
    let note: String?
}

extension MC2Transaction {
    init(appTransaction transaction: Transaction) {
        self.init(
            id: transaction.id,
            date: Self.dateString(from: transaction.date),
            merchant: transaction.merchant,
            amount: transaction.amount,
            category: transaction.category,
            card: transaction.card,
            note: transaction.note
        )
    }

    static func dateString(from date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    func convexJSONObject() throws -> [String: Any] {
        let data = try JSONEncoder().encode(self)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ConvexError.decodeFailed("transaction", NSError(domain: "MC2Transaction", code: -1))
        }
        return object
    }
}

struct MC2BudgetCategory: Codable {
    let name: String
    let icon: String?
    let budget: Decimal
    let spent: Decimal?
}

struct MC2BudgetStrategy: Codable {
    let effectiveApr: Decimal?
    let strategyNote: String?

    enum CodingKeys: String, CodingKey {
        case effectiveApr = "effective_apr"
        case strategyNote = "strategy_note"
    }
}

struct MC2Paycheck: Codable {
    let date: String
    let platform: String?
    let source: String?
    let amount: Decimal?
    let net: Decimal?
    let note: String?
}

struct MC2BudgetIncome: Codable {
    let weeklyGross: Decimal?
    let weeklyStrike: Decimal?
    let weeklyRiver: Decimal?
    let payFrequency: String?
    let monthlyGross: Decimal?
    let mtdIncome: Decimal?
    let ytdIncome: Decimal?
    let paychecks: [MC2Paycheck]?

    enum CodingKeys: String, CodingKey {
        case weeklyGross = "weekly_gross"
        case weeklyStrike = "weekly_strike"
        case weeklyRiver = "weekly_river"
        case payFrequency = "pay_frequency"
        case monthlyGross = "monthly_gross"
        case mtdIncome = "mtd_income"
        case ytdIncome = "ytd_income"
        case paychecks
    }
}

struct MC2Budget: Codable {
    let month: String
    let coinbaseOneBalance: Decimal?
    let categories: [MC2BudgetCategory]
    let strategy: MC2BudgetStrategy?
    let income: MC2BudgetIncome?
    let mtdIncome: Decimal?
    let ytdIncome: Decimal?

    enum CodingKeys: String, CodingKey {
        case month
        case coinbaseOneBalance = "coinbase_one_balance"
        case categories
        case strategy
        case income
        case mtdIncome = "mtd_income"
        case ytdIncome = "ytd_income"
    }
}

struct MC2BTCBuy: Codable {
    let id: String
    let date: String
    let source: String
    let amountSats: Int64
    let amountBtc: Decimal
    let priceUsd: Decimal
    let usd: Decimal
    let note: String?
    let status: String?
    let costBasisStatus: String?
    let loggedBy: String?
    let archimedesRequestId: String?

    enum CodingKeys: String, CodingKey {
        case id, date, source, usd, note, status
        case amountSats = "amount_sats"
        case amountBtc = "amount_btc"
        case priceUsd = "price_usd"
        case costBasisStatus = "cost_basis_status"
        case loggedBy = "logged_by"
        case archimedesRequestId = "archimedes_request_id"
    }
}

struct MC2BTCAccountEntry: Codable {
    let btc: Decimal
    let fiat: Decimal
    let label: String
    let custody: String
}

struct MC2BTCTotals: Codable {
    let btc: Decimal
    let fiat: Decimal
    let exchangeBtc: Decimal
    let selfCustodyBtc: Decimal

    enum CodingKeys: String, CodingKey {
        case btc, fiat
        case exchangeBtc = "exchange_btc"
        case selfCustodyBtc = "self_custody_btc"
    }
}

struct MC2BTCSnapshot: Codable {
    let schemaVersion: Int
    let asOf: String
    let accounts: [String: MC2BTCAccountEntry]
    let totals: MC2BTCTotals
    let metadata: MC2BTCMetadata?
    let totalSats: Int64?
    let totalBtc: Decimal?
    let totalUsdInvested: Decimal?

    enum CodingKeys: String, CodingKey {
        case schemaVersion, asOf, accounts, totals, metadata
        case totalSats, totalBtc, totalUsdInvested
    }
}

struct MC2BTCMetadata: Codable {
    let source: String?
    let basis: String?
    let confidence: String?
}

struct MC2BTCBillPay: Codable {
    let id: String
    let date: String
    let merchant: String
    let category: String
    let amountUsd: Decimal
    let btcSpent: Decimal
    let btcPrice: Decimal?
    let platform: String?
    let note: String?
    let feeUsd: Decimal?
    let reference: String?

    /// BTC price at time of bill pay — computed from amount/btc when missing.
    var effectiveBtcPrice: Decimal {
        if let price = btcPrice { return price }
        guard btcSpent > 0 else { return 0 }
        return amountUsd / btcSpent
    }

    enum CodingKeys: String, CodingKey {
        case id, date, merchant, category, platform, note, reference
        case amountUsd = "amount_usd"
        case btcSpent = "btc_spent"
        case btcPrice = "btc_price"
        case feeUsd = "fee_usd"
    }
}

struct MC2BillPaysWrapper: Codable {
    let billPays: [MC2BTCBillPay]

    enum CodingKeys: String, CodingKey {
        case billPays = "bill_pays"
    }
}

struct MC2FinancesRetirement: Decodable {
    let accounts: [String: MC2FinanceAccount]

    enum CodingKeys: String, CodingKey {
        case accounts
    }

    private struct DynamicKey: CodingKey {
        let stringValue: String
        let intValue: Int? = nil

        init?(stringValue: String) {
            self.stringValue = stringValue
        }

        init?(intValue: Int) {
            return nil
        }
    }

    init(from decoder: Decoder) throws {
        if let container = try? decoder.container(keyedBy: CodingKeys.self),
           let acc = try? container.decode([String: MC2FinanceAccount].self, forKey: .accounts) {
            self.accounts = acc
        } else {
            let container = try decoder.container(keyedBy: DynamicKey.self)
            var decoded: [String: MC2FinanceAccount] = [:]
            for key in container.allKeys {
                if let account = try? container.decode(MC2FinanceAccount.self, forKey: key) {
                    decoded[key.stringValue] = account
                }
            }
            self.accounts = decoded
        }
    }
}

struct MC2FinanceAccount: Decodable {
    let provider: String?
    let total: Decimal?
    let weeklyContribution: Decimal?
    let holdings: [MC2FinanceHolding]
    /// Per-account owner from MC2 finances.json. Missing → treated as "victor"
    /// for backwards compatibility with adult-only accounts.
    let owner: String?

    enum CodingKeys: String, CodingKey {
        case provider, total, weeklyContribution, holdings, owner
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decodeIfPresent(String.self, forKey: .provider)
        total = try container.decodeIfPresent(Decimal.self, forKey: .total)
        weeklyContribution = try container.decodeIfPresent(Decimal.self, forKey: .weeklyContribution)
        holdings = try container.decodeIfPresent([MC2FinanceHolding].self, forKey: .holdings) ?? []
        owner = try container.decodeIfPresent(String.self, forKey: .owner)
    }
}

struct MC2FinanceHolding: Decodable {
    let name: String
    let category: String
    let ticker: String?
    let value: Decimal
    let costBasis: Decimal
    let gainPct: Decimal
    let shares: Decimal
    let avgCost: Decimal
    let currentPricePerShare: Decimal
    let proxy: Bool?
    let proxyNote: String?
    let lots: [MC2FinanceLot]?

    enum CodingKeys: String, CodingKey {
        case name, category, ticker, value, shares, lots
        case costBasis, gainPct, avgCost, currentPricePerShare
        case proxy, proxyNote
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        category = try container.decodeIfPresent(String.self, forKey: .category) ?? "Uncategorized"
        ticker = try container.decodeIfPresent(String.self, forKey: .ticker)
        value = try container.decodeIfPresent(Decimal.self, forKey: .value) ?? 0
        costBasis = try container.decodeIfPresent(Decimal.self, forKey: .costBasis) ?? value
        gainPct = try container.decodeIfPresent(Decimal.self, forKey: .gainPct) ?? 0
        shares = try container.decodeIfPresent(Decimal.self, forKey: .shares) ?? 0
        avgCost = try container.decodeIfPresent(Decimal.self, forKey: .avgCost) ?? 0
        currentPricePerShare = try container.decodeIfPresent(Decimal.self, forKey: .currentPricePerShare) ?? 0
        proxy = try container.decodeIfPresent(Bool.self, forKey: .proxy)
        proxyNote = try container.decodeIfPresent(String.self, forKey: .proxyNote)
        lots = try container.decodeIfPresent([MC2FinanceLot].self, forKey: .lots)
    }
}

struct MC2FinanceLot: Decodable {
    let date: String
    let type: String
    let pricePerShare: Decimal?
    let shares: Decimal?
    let amountInvested: Decimal?
    let note: String?
}

struct MC2Finances: Decodable {
    let retirement: MC2FinancesRetirement
    let mason401k: MC2FinanceAccount?
    let lastUpdated: String?

    enum CodingKeys: String, CodingKey {
        case retirement
        case mason401k = "mason_401k"
        case lastUpdated = "last_updated"
        case camelLastUpdated = "lastUpdated"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        retirement = try container.decode(MC2FinancesRetirement.self, forKey: .retirement)
        mason401k = try container.decodeIfPresent(MC2FinanceAccount.self, forKey: .mason401k)
        lastUpdated = try container.decodeIfPresent(String.self, forKey: .lastUpdated)
            ?? container.decodeIfPresent(String.self, forKey: .camelLastUpdated)
    }
}

struct MC2SonBalances: Codable {
    let strike: Decimal
    let river: Decimal
    let coldcard: Decimal
    let total: Decimal
    let lastUpdated: String
}

struct MC2MasonAllowance: Codable {
    let weekly: Decimal
    let source: String
}

struct MC2MasonBudget: Codable {
    let month: String
    let owner: String
    let categories: [MC2BudgetCategory]
    let allowance: MC2MasonAllowance?
    let income: MC2BudgetIncome?
}
