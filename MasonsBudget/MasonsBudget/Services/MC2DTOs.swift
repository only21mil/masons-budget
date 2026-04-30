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

struct MC2BudgetCategory: Codable {
    let name: String
    let icon: String?
    let budget: Decimal
    let spent: Decimal?
}

struct MC2BudgetStrategy: Codable {
    let avenApr: Decimal?
    let avenCashbackPct: Decimal?
    let effectiveApr: Decimal?
    let strategyNote: String?

    enum CodingKeys: String, CodingKey {
        case avenApr = "aven_apr"
        case avenCashbackPct = "aven_cashback_pct"
        case effectiveApr = "effective_apr"
        case strategyNote = "strategy_note"
    }
}

struct MC2BudgetIncome: Codable {
    let weeklyGross: Decimal?
    let weeklyStrike: Decimal?
    let weeklyRiver: Decimal?
    let payFrequency: String?
    let monthlyGross: Decimal?

    enum CodingKeys: String, CodingKey {
        case weeklyGross = "weekly_gross"
        case weeklyStrike = "weekly_strike"
        case weeklyRiver = "weekly_river"
        case payFrequency = "pay_frequency"
        case monthlyGross = "monthly_gross"
    }
}

struct MC2Budget: Codable {
    let month: String
    let avenBalance: Decimal
    let coinbaseOneBalance: Decimal?
    let categories: [MC2BudgetCategory]
    let strategy: MC2BudgetStrategy?
    let income: MC2BudgetIncome?

    enum CodingKeys: String, CodingKey {
        case month
        case avenBalance = "aven_balance"
        case coinbaseOneBalance = "coinbase_one_balance"
        case categories
        case strategy
        case income
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
    let btcPrice: Decimal
    let platform: String?
    let note: String?
    let feeUsd: Decimal?
    let reference: String?

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

struct MC2FinancesRetirement: Codable {
    let accounts: [String: MC2FinanceAccount]

    enum CodingKeys: String, CodingKey {
        case accounts
    }

    init(from decoder: Decoder) throws {
        if let container = try? decoder.container(keyedBy: CodingKeys.self),
           let acc = try? container.decode([String: MC2FinanceAccount].self, forKey: .accounts) {
            self.accounts = acc
        } else {
            self.accounts = try decoder.singleValueContainer().decode([String: MC2FinanceAccount].self)
        }
    }
}

struct MC2FinanceAccount: Codable {
    let provider: String?
    let total: Decimal?
    let weeklyContribution: Decimal?
    let holdings: [MC2FinanceHolding]

    enum CodingKeys: String, CodingKey {
        case provider, total, weeklyContribution, holdings
    }
}

struct MC2FinanceHolding: Codable {
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
}

struct MC2FinanceLot: Codable {
    let date: String
    let type: String
    let pricePerShare: Decimal?
    let shares: Decimal?
    let amountInvested: Decimal?
    let note: String?
}

struct MC2Finances: Codable {
    let retirement: MC2FinancesRetirement
    let lastUpdated: String?

    enum CodingKeys: String, CodingKey {
        case retirement
        case lastUpdated = "last_updated"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        retirement = try container.decode(MC2FinancesRetirement.self, forKey: .retirement)
        lastUpdated = try container.decodeIfPresent(String.self, forKey: .lastUpdated)
    }
}

struct MC2SonBalances: Codable {
    let strike: Decimal
    let river: Decimal
    let coldcard: Decimal
    let total: Decimal
    let lastUpdated: String
}
