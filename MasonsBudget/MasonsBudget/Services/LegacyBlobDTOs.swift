import Foundation
import os

// These DTOs decode the surviving legacy JSON blobs. They describe a wire
// schema, not a live service or upstream system.

struct LegacyTransactionDTO: Codable {
    let id: String
    let date: String
    let merchant: String
    let amount: Decimal
    let category: String
    let card: String?
    let note: String?
    let owner: FamilyMember?
    let amountSats: Int64?
    /// Bitcoin account the row posts to when its payment source is
    /// Bitcoin-native. Absent on legacy blobs, which must round-trip as nil.
    let bitcoinAccountKey: String?
    /// True only when the amount was typed in BTC/sats. Absent on legacy rows,
    /// which must be read as "not explicitly Bitcoin".
    let enteredInBitcoin: Bool?
    let updatedAtMs: Double?

    init(
        id: String,
        date: String,
        merchant: String,
        amount: Decimal,
        category: String,
        card: String?,
        note: String?,
        owner: FamilyMember?,
        amountSats: Int64? = nil,
        enteredInBitcoin: Bool? = nil,
        bitcoinAccountKey: String? = nil,
        updatedAtMs: Double? = nil,
    ) {
        self.id = id
        self.date = date
        self.merchant = merchant
        self.amount = amount
        self.category = category
        self.card = card
        self.note = note
        self.owner = owner
        self.amountSats = amountSats
        self.enteredInBitcoin = enteredInBitcoin
        self.bitcoinAccountKey = bitcoinAccountKey
        self.updatedAtMs = updatedAtMs
    }
}

enum TransactionWriteValidationError: LocalizedError, Equatable {
    case ownerMismatch(transactionOwner: String, targetOwner: FamilyMember)
    case transactionMustBeNonZero(owner: FamilyMember)
    case incomeMustBePositive(owner: FamilyMember)

    var errorDescription: String? {
        switch self {
        case let .ownerMismatch(transactionOwner, targetOwner):
            "Rejected transaction write: owner '\(transactionOwner)' does not match target owner '\(targetOwner.rawValue)'."
        case let .transactionMustBeNonZero(owner):
            "Rejected transaction write for \(owner.rawValue): transaction amount must be non-zero."
        case let .incomeMustBePositive(owner):
            "Rejected transaction write for \(owner.rawValue): income must be positive."
        }
    }
}

extension LegacyTransactionDTO {
    init(appTransaction transaction: Transaction, owner: FamilyMember) throws {
        let canonicalOwner = owner.ledgerOwner
        let transactionOwner = FamilyMember(rawValue: transaction.owner)?.ledgerOwner
        guard transactionOwner == canonicalOwner else {
            throw TransactionWriteValidationError.ownerMismatch(
                transactionOwner: transaction.owner,
                targetOwner: canonicalOwner,
            )
        }

        if transaction.isIncome {
            guard transaction.amount > 0 else {
                throw TransactionWriteValidationError.incomeMustBePositive(owner: canonicalOwner)
            }
        } else {
            guard transaction.amount != 0 else {
                throw TransactionWriteValidationError.transactionMustBeNonZero(owner: canonicalOwner)
            }
        }

        self.init(
            id: transaction.id,
            date: Self.dateString(from: transaction.date),
            merchant: transaction.merchant,
            amount: transaction.amount,
            category: transaction.category,
            card: transaction.card,
            note: transaction.note,
            owner: canonicalOwner,
            amountSats: transaction.amountSats,
            enteredInBitcoin: transaction.enteredInBitcoin,
            // The stored key carries the local composite identity
            // "asOf-key-owner"; the server posts against the bare account key.
            bitcoinAccountKey: transaction.bitcoinAccountKey.map {
                LedgerMapper.wireAccountKey(from: $0, owner: canonicalOwner)
            },
            updatedAtMs: transaction.updatedAtMs,
        )
    }

    // Shared date-only wire formatter. The transaction and todo DTOs must
    // produce byte-identical yyyy-MM-dd strings, so this is the single copy.
    private static let wireDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func dateString(from date: Date) -> String {
        wireDateFormatter.string(from: date)
    }

    func convexJSONObject() throws -> [String: Any] {
        let data = try JSONEncoder().encode(self)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ConvexError.decodeFailed("transaction", NSError(domain: "LegacyBlobTransaction", code: -1))
        }
        return object
    }
}

struct LegacyBudgetCategoryDTO: Codable {
    let name: String
    let icon: String?
    let budget: Decimal
    let spent: Decimal?
}

struct LegacyBudgetStrategyDTO: Codable {
    let effectiveApr: Decimal?
    let strategyNote: String?

    enum CodingKeys: String, CodingKey {
        case effectiveApr = "effective_apr"
        case strategyNote = "strategy_note"
    }
}

struct LegacyPaycheckDTO: Codable {
    let date: String
    let platform: String?
    let source: String?
    let amount: Decimal?
    let net: Decimal?
    let note: String?
}

struct LegacyBudgetIncomeDTO: Codable {
    let weeklyGross: Decimal?
    let weeklyStrike: Decimal?
    let weeklyRiver: Decimal?
    let payFrequency: String?
    let monthlyGross: Decimal?
    let mtdIncome: Decimal?
    let ytdIncome: Decimal?
    let paychecks: [LegacyPaycheckDTO]?

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

struct LegacyMonthlyHistoryEntryDTO: Codable {
    let month: String
    let income: Decimal?
    let expenses: Decimal?
    let savingsPct: Decimal?

    enum CodingKeys: String, CodingKey {
        case month, income, expenses
        case savingsPct = "savings_pct"
    }
}

struct LegacyBudgetDTO: Codable {
    let month: String
    let coinbaseOneBalance: Decimal?
    let categories: [LegacyBudgetCategoryDTO]
    let strategy: LegacyBudgetStrategyDTO?
    let income: LegacyBudgetIncomeDTO?
    let mtdIncome: Decimal?
    let ytdIncome: Decimal?
    let monthlyHistory: [LegacyMonthlyHistoryEntryDTO]?

    enum CodingKeys: String, CodingKey {
        case month
        case coinbaseOneBalance = "coinbase_one_balance"
        case categories
        case strategy
        case income
        case mtdIncome = "mtd_income"
        case ytdIncome = "ytd_income"
        case monthlyHistory = "monthly_history"
    }
}

struct LegacyBTCBuyDTO: Codable {
    let id: String
    let date: String
    let source: String
    let amountSats: Int64
    let amountBtc: Decimal
    let priceUsd: Decimal
    let usd: Decimal
    /// Optional manual fee. Missing pre-fee rows decode as zero at the model boundary.
    let feeUsd: Decimal?
    let note: String?
    let status: String?
    let costBasisStatus: String?
    let loggedBy: String?
    let archimedesRequestId: String?
    let owner: String?
    let updatedAtMs: Double?

    init(
        id: String,
        date: String,
        source: String,
        amountSats: Int64,
        amountBtc: Decimal,
        priceUsd: Decimal,
        usd: Decimal,
        note: String?,
        status: String?,
        costBasisStatus: String?,
        loggedBy: String?,
        archimedesRequestId: String?,
        owner: String? = nil,
        feeUsd: Decimal? = nil,
        updatedAtMs: Double? = nil,
    ) {
        self.id = id
        self.date = date
        self.source = source
        self.amountSats = amountSats
        self.amountBtc = amountBtc
        self.priceUsd = priceUsd
        self.usd = usd
        self.feeUsd = feeUsd
        self.note = note
        self.status = status
        self.costBasisStatus = costBasisStatus
        self.loggedBy = loggedBy
        self.archimedesRequestId = archimedesRequestId
        self.owner = owner
        self.updatedAtMs = updatedAtMs
    }

    enum CodingKeys: String, CodingKey {
        case id, date, source, usd, note, status, owner
        case amountSats = "amount_sats"
        case amountBtc = "amount_btc"
        case priceUsd = "price_usd"
        case feeUsd = "fee_usd"
        case costBasisStatus = "cost_basis_status"
        case loggedBy = "logged_by"
        case archimedesRequestId = "archimedes_request_id"
        case updatedAtMs = "updated_at_ms"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        date = try container.decode(String.self, forKey: .date)
        source = try container.decode(String.self, forKey: .source)
        amountSats = try container.decode(Int64.self, forKey: .amountSats)
        amountBtc = try container.decode(Decimal.self, forKey: .amountBtc)
        priceUsd = try container.decode(Decimal.self, forKey: .priceUsd)
        usd = try container.decode(Decimal.self, forKey: .usd)
        feeUsd = try container.decodeIfPresent(Decimal.self, forKey: .feeUsd)
        note = try container.decodeIfPresent(String.self, forKey: .note)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        costBasisStatus = try container.decodeIfPresent(String.self, forKey: .costBasisStatus)
        loggedBy = try container.decodeIfPresent(String.self, forKey: .loggedBy)
        archimedesRequestId = try container.decodeIfPresent(String.self, forKey: .archimedesRequestId)
        owner = try container.decodeIfPresent(String.self, forKey: .owner)
        updatedAtMs = try container.decodeIfPresent(Double.self, forKey: .updatedAtMs)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(date, forKey: .date)
        try container.encode(source, forKey: .source)
        try container.encode(amountSats, forKey: .amountSats)
        try container.encode(amountBtc, forKey: .amountBtc)
        try container.encode(priceUsd, forKey: .priceUsd)
        try container.encode(usd, forKey: .usd)
        try container.encodeIfPresent(feeUsd, forKey: .feeUsd)
        try container.encodeIfPresent(note, forKey: .note)
        try container.encodeIfPresent(status, forKey: .status)
        try container.encodeIfPresent(costBasisStatus, forKey: .costBasisStatus)
        try container.encodeIfPresent(loggedBy, forKey: .loggedBy)
        try container.encodeIfPresent(archimedesRequestId, forKey: .archimedesRequestId)
        try container.encodeIfPresent(owner, forKey: .owner)
        try container.encodeIfPresent(updatedAtMs, forKey: .updatedAtMs)
    }
}

extension LegacyBTCBuyDTO {
    init(appBuy buy: BTCBuy, owner: FamilyMember) throws {
        let canonicalOwner = owner.ledgerOwner
        let feeUsd = try ExactMoney.optionalDollars(
            from: buy.feeUsdCents,
            field: "btcBuy.feeUsdCents",
        )
        self.init(
            id: buy.id,
            date: LegacyTransactionDTO.dateString(from: buy.date),
            source: buy.source,
            amountSats: buy.amountSats,
            amountBtc: buy.amountBTC,
            priceUsd: buy.priceUSD,
            usd: buy.usd,
            note: buy.note,
            status: buy.status,
            costBasisStatus: buy.costBasisStatus,
            loggedBy: buy.loggedBy,
            archimedesRequestId: buy.archimedesRequestId,
            owner: canonicalOwner.rawValue,
            feeUsd: feeUsd,
            updatedAtMs: buy.updatedAtMs,
        )
    }

    func convexJSONObject() throws -> [String: Any] {
        let data = try JSONEncoder().encode(self)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ConvexError.decodeFailed("btcBuy", NSError(domain: "LegacyBlobBTCBuy", code: -1))
        }
        return object
    }
}

struct LegacyBTCAccountEntryDTO: Codable {
    let btc: Decimal
    let fiat: Decimal
    let label: String
    let custody: String
}

struct LegacyBTCTotalsDTO: Codable {
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

struct LegacyBTCSnapshotDTO: Codable {
    let schemaVersion: Int
    let asOf: String
    let accounts: [String: LegacyBTCAccountEntryDTO]
    let totals: LegacyBTCTotalsDTO
    let metadata: LegacyBTCMetadataDTO?
    let totalSats: Int64?
    let totalBtc: Decimal?
    let totalUsdInvested: Decimal?

    enum CodingKeys: String, CodingKey {
        case schemaVersion, asOf, accounts, totals, metadata
        case totalSats, totalBtc, totalUsdInvested
    }
}

struct LegacyBTCMetadataDTO: Codable {
    let source: String?
    let basis: String?
    let confidence: String?
}

struct LegacyBTCBillPayDTO: Codable {
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
    let owner: String?
    let budgetEffect: BTCBillPayBudgetEffect?
    let updatedAtMs: Double?

    init(
        id: String,
        date: String,
        merchant: String,
        category: String,
        amountUsd: Decimal,
        btcSpent: Decimal,
        btcPrice: Decimal?,
        platform: String?,
        note: String?,
        feeUsd: Decimal?,
        reference: String?,
        owner: String?,
        budgetEffect: BTCBillPayBudgetEffect? = nil,
        updatedAtMs: Double? = nil,
    ) {
        self.id = id
        self.date = date
        self.merchant = merchant
        self.category = category
        self.amountUsd = amountUsd
        self.btcSpent = btcSpent
        self.btcPrice = btcPrice
        self.platform = platform
        self.note = note
        self.feeUsd = feeUsd
        self.reference = reference
        self.owner = owner
        self.budgetEffect = budgetEffect
        self.updatedAtMs = updatedAtMs
    }

    /// BTC price at time of bill pay — computed from amount/btc when missing.
    var effectiveBtcPrice: Decimal {
        if let price = btcPrice { return price }
        guard btcSpent > 0 else { return 0 }
        return amountUsd / btcSpent
    }

    enum CodingKeys: String, CodingKey {
        case id, date, merchant, category, platform, note, reference, owner
        case amountUsd = "amount_usd"
        case btcSpent = "btc_spent"
        case btcPrice = "btc_price"
        case feeUsd = "fee_usd"
        case budgetEffect = "budget_effect"
        case updatedAtMs = "updated_at_ms"
    }
}

struct LegacyBillPaysWrapperDTO: Codable {
    let billPays: [LegacyBTCBillPayDTO]

    enum CodingKeys: String, CodingKey {
        case billPays = "bill_pays"
    }
}

struct LegacyFinancesRetirementDTO: Decodable {
    private static let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "LegacyBlob")

    let accounts: [String: LegacyFinanceAccountDTO]

    enum CodingKeys: String, CodingKey {
        case accounts
    }

    private struct DynamicKey: CodingKey {
        let stringValue: String
        let intValue: Int? = nil

        init?(stringValue: String) {
            self.stringValue = stringValue
        }

        init?(intValue _: Int) {
            nil
        }
    }

    init(from decoder: Decoder) throws {
        if let container = try? decoder.container(keyedBy: CodingKeys.self),
           let acc = try? container.decode([String: LegacyFinanceAccountDTO].self, forKey: .accounts)
        {
            accounts = acc
        } else {
            let container = try decoder.container(keyedBy: DynamicKey.self)
            var decoded: [String: LegacyFinanceAccountDTO] = [:]
            for key in container.allKeys {
                do {
                    let account = try container.decode(LegacyFinanceAccountDTO.self, forKey: key)
                    decoded[key.stringValue] = account
                } catch {
                    // Value-free diagnostic: the key is a real account name and
                    // must never reach stdout or the unified log.
                    Self.log.error("Failed to decode one retirement account row")
                }
            }
            accounts = decoded
        }
    }
}

struct LegacyFinanceAccountDTO: Decodable {
    let provider: String?
    let total: Decimal?
    let weeklyContribution: Decimal?
    let holdings: [LegacyFinanceHoldingDTO]
    /// Per-account owner from the surviving finances blob. Missing → treated as "victor"
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
        holdings = try container.decodeIfPresent([LegacyFinanceHoldingDTO].self, forKey: .holdings) ?? []
        owner = try container.decodeIfPresent(String.self, forKey: .owner)
    }
}

struct LegacyFinanceHoldingDTO: Decodable {
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
    let lots: [LegacyFinanceLotDTO]?

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
        lots = try container.decodeIfPresent([LegacyFinanceLotDTO].self, forKey: .lots)
    }
}

struct LegacyFinanceLotDTO: Decodable {
    let date: String
    let type: String
    let pricePerShare: Decimal?
    let shares: Decimal?
    let amountInvested: Decimal?
    let note: String?
}

struct LegacyFinancesDTO: Decodable {
    let retirement: LegacyFinancesRetirementDTO
    let mason401k: LegacyFinanceAccountDTO?
    let lastUpdated: String?

    enum CodingKeys: String, CodingKey {
        case retirement
        case mason401k = "mason_401k"
        case lastUpdated = "last_updated"
        case camelLastUpdated = "lastUpdated"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        retirement = try container.decode(LegacyFinancesRetirementDTO.self, forKey: .retirement)
        mason401k = try container.decodeIfPresent(LegacyFinanceAccountDTO.self, forKey: .mason401k)
        lastUpdated = try container.decodeIfPresent(String.self, forKey: .lastUpdated)
            ?? container.decodeIfPresent(String.self, forKey: .camelLastUpdated)
    }
}

struct LegacySonBalancesDTO: Codable {
    let strike: Decimal
    let river: Decimal
    let coldcard: Decimal
    let total: Decimal
    let lastUpdated: String
}

struct LegacyMasonAllowanceDTO: Codable {
    let weekly: Decimal
    let source: String
}

struct LegacyMasonBudgetDTO: Codable {
    let month: String
    let owner: String
    let categories: [LegacyBudgetCategoryDTO]
    let allowance: LegacyMasonAllowanceDTO?
    let income: LegacyBudgetIncomeDTO?
}

struct LegacyTodoDTO: Codable {
    let id: String
    let title: String?
    let text: String?
    let project: String?
    let area: String?
    let category: String?
    let type: String?
    let dueDate: String?
    let due: String?
    let date: String?
    let deadline: String?
    let when: String?
    let priority: Int?
    let flag: Bool?
    let flagged: Bool?
    let done: Bool?
    let completed: Bool?
    let status: String?
    let owner: String?
    let assignee: String?
    let updatedAt: String?
    let createdAt: String?
    let completedAt: String?
    /// Exact row revision. Legacy blobs omit it; row reads preserve it.
    let updatedAtMs: Double?

    enum CodingKeys: String, CodingKey {
        case id, title, text, project, area, category, type, due, date, deadline, when, priority, flag, flagged, done, completed, status, owner, assignee
        case dueDate = "due_date"
        case camelDueDate = "dueDate"
        case updatedAt = "updated_at"
        case camelUpdatedAt = "updatedAt"
        case createdAt
        case completedAt
        case updatedAtMs
    }

    init(
        id: String,
        title: String,
        project: String? = nil,
        area: String? = nil,
        dueDate: String? = nil,
        priority: Int = 0,
        flag: Bool = false,
        done: Bool = false,
        owner: String = FamilyMember.victor.rawValue,
        createdAt: String? = nil,
        updatedAt: String? = nil,
        completedAt: String? = nil,
        updatedAtMs: Double? = nil,
    ) {
        self.id = id
        self.title = title
        text = nil
        self.project = project
        self.area = area
        category = "sats"
        type = "sats"
        self.dueDate = dueDate
        due = nil
        date = nil
        deadline = nil
        when = nil
        self.priority = priority
        self.flag = flag
        flagged = nil
        self.done = done
        completed = nil
        status = nil
        self.owner = owner
        assignee = owner
        self.updatedAt = updatedAt
        self.createdAt = createdAt
        self.completedAt = completedAt
        self.updatedAtMs = updatedAtMs
    }

    init(
        rowId: String,
        title: String,
        project: String?,
        area: String?,
        due: String?,
        notes: String?,
        priority: Int?,
        flagged: Bool,
        done: Bool,
        owner: FamilyMember,
        createdAt: String?,
        updatedAt: String?,
        completedAt: String?,
        updatedAtMs: Double,
    ) {
        id = rowId
        self.title = title
        text = notes
        self.project = project
        self.area = area
        category = nil
        type = nil
        dueDate = due
        self.due = nil
        date = nil
        deadline = nil
        when = nil
        self.priority = priority
        flag = nil
        self.flagged = flagged
        self.done = done
        completed = nil
        status = nil
        self.owner = owner.rawValue
        assignee = nil
        self.updatedAt = updatedAt
        self.createdAt = createdAt
        self.completedAt = completedAt
        self.updatedAtMs = updatedAtMs
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let decodedId = Self.decodeFlexibleString(from: container, forKey: .id) else {
            throw DecodingError.keyNotFound(
                CodingKeys.id,
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Todo id is missing"),
            )
        }
        id = decodedId
        title = try container.decodeIfPresent(String.self, forKey: .title)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        project = try container.decodeIfPresent(String.self, forKey: .project)
        area = try container.decodeIfPresent(String.self, forKey: .area)
        category = try container.decodeIfPresent(String.self, forKey: .category)
        type = try container.decodeIfPresent(String.self, forKey: .type)
        dueDate = try container.decodeIfPresent(String.self, forKey: .dueDate)
            ?? container.decodeIfPresent(String.self, forKey: .camelDueDate)
        due = try container.decodeIfPresent(String.self, forKey: .due)
        date = try container.decodeIfPresent(String.self, forKey: .date)
        deadline = try container.decodeIfPresent(String.self, forKey: .deadline)
        when = try container.decodeIfPresent(String.self, forKey: .when)
        priority = Self.decodePriority(from: container)
        flag = try container.decodeIfPresent(Bool.self, forKey: .flag)
        flagged = try container.decodeIfPresent(Bool.self, forKey: .flagged)
        done = try container.decodeIfPresent(Bool.self, forKey: .done)
        completed = try container.decodeIfPresent(Bool.self, forKey: .completed)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        owner = try container.decodeIfPresent(String.self, forKey: .owner)
        assignee = try container.decodeIfPresent(String.self, forKey: .assignee)
        updatedAt = Self.decodeFlexibleString(from: container, forKey: .updatedAt)
            ?? Self.decodeFlexibleString(from: container, forKey: .camelUpdatedAt)
        createdAt = Self.decodeFlexibleString(from: container, forKey: .createdAt)
        completedAt = Self.decodeFlexibleString(from: container, forKey: .completedAt)
        updatedAtMs = try container.decodeIfPresent(Double.self, forKey: .updatedAtMs)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(text, forKey: .text)
        try container.encodeIfPresent(project, forKey: .project)
        try container.encodeIfPresent(area, forKey: .area)
        try container.encodeIfPresent(category, forKey: .category)
        try container.encodeIfPresent(type, forKey: .type)
        try container.encodeIfPresent(dueDate, forKey: .dueDate)
        try container.encodeIfPresent(when, forKey: .when)
        try container.encodeIfPresent(priority, forKey: .priority)
        try container.encodeIfPresent(flag, forKey: .flag)
        try container.encodeIfPresent(flagged, forKey: .flagged)
        try container.encodeIfPresent(done, forKey: .done)
        try container.encodeIfPresent(completed, forKey: .completed)
        try container.encodeIfPresent(status, forKey: .status)
        try container.encodeIfPresent(owner, forKey: .owner)
        try container.encodeIfPresent(assignee, forKey: .assignee)
        try container.encodeIfPresent(updatedAt, forKey: .updatedAt)
        try container.encodeIfPresent(updatedAtMs, forKey: .updatedAtMs)
    }

    init(appTodo todo: TodoItem) {
        self.init(
            id: todo.id,
            title: todo.title,
            project: todo.project,
            area: todo.area,
            dueDate: todo.dueDate.map(Self.dateString),
            priority: todo.priority,
            flag: todo.isFlagged,
            done: todo.isDone,
            owner: todo.owner,
            createdAt: todo.createdAt.map(Self.dateTimeString),
            updatedAt: Self.dateTimeString(todo.updatedAt),
            completedAt: todo.completedAt.map(Self.dateTimeString),
            updatedAtMs: todo.updatedAtMs,
        )
    }

    var effectiveTitle: String {
        if let title, !title.isEmpty { return title }
        if let text, !text.isEmpty { return text }
        return "Untitled task"
    }

    var effectiveDueDate: String? {
        dueDate ?? due ?? date ?? deadline ?? when
    }

    var effectiveProject: String? {
        project ?? category ?? type
    }

    var effectiveOwner: FamilyMember? {
        let raw = owner ?? assignee
        guard let raw else { return .victor }
        return FamilyMember(rawValue: raw.lowercased())
    }

    var effectiveFlagged: Bool {
        flagged ?? flag ?? false
    }

    var effectiveDone: Bool {
        if let completed { return completed }
        if let done { return done }
        let normalized = status?.lowercased() ?? ""
        return normalized == "completed" || normalized == "done"
    }

    static func decodePriority(from container: KeyedDecodingContainer<CodingKeys>) -> Int? {
        if let intValue = try? container.decodeIfPresent(Int.self, forKey: .priority) {
            return intValue
        }
        guard let stringValue = try? container.decodeIfPresent(String.self, forKey: .priority) else {
            return nil
        }
        // Legacy wire strings rank smaller-is-more-urgent; the app's editor and
        // list queries rank 0=None..3=High, so remap onto that scale here.
        switch stringValue.lowercased() {
        case "urgent", "high": return 3
        case "medium", "normal": return 2
        case "low": return 1
        default: return Int(stringValue)
        }
    }

    static func decodeFlexibleString(
        from container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys,
    ) -> String? {
        if let stringValue = try? container.decodeIfPresent(String.self, forKey: key) {
            return stringValue
        }
        if let intValue = try? container.decodeIfPresent(Int.self, forKey: key) {
            return String(intValue)
        }
        if let doubleValue = try? container.decodeIfPresent(Double.self, forKey: key) {
            return String(doubleValue)
        }
        return nil
    }

    /// Delegates to the shared transaction formatter — one date-only wire
    /// format for every DTO in this file.
    static func dateString(_ date: Date) -> String {
        LegacyTransactionDTO.dateString(from: date)
    }

    private static let wireDateTimeFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func dateTimeString(_ date: Date) -> String {
        wireDateTimeFormatter.string(from: date)
    }

    func convexJSONObject() throws -> [String: Any] {
        let data = try JSONEncoder().encode(self)
        guard var object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ConvexError.decodeFailed("todo", NSError(domain: "LegacyBlobTodo", code: -1))
        }
        // Admin upsert stamps its own revision. Device writes use the dedicated
        // payload and send this value only as `baseUpdatedAtMs`.
        object.removeValue(forKey: "updatedAtMs")
        return object
    }
}

struct LegacyTodosWrapperDTO: Codable {
    let todos: [LegacyTodoDTO]
}
