import Foundation
import Observation

/// Explicit visibility choice for Bitcoin reads. Keeping this out of a Bool
/// prevents a call site from accidentally widening adult net worth to children.
enum ConvexRowScope: String, Sendable {
    case visible
    case netWorth
}

/// Closed public row-query catalogue. Arbitrary paths and arguments cannot cross
/// the client boundary, and every Bitcoin case requires an explicit scope.
enum ConvexRowQuery: Sendable {
    case transactions(viewer: FamilyMember)
    case income(viewer: FamilyMember, month: String?)
    case todos(viewer: FamilyMember)
    case btcBuys(viewer: FamilyMember, scope: ConvexRowScope)
    case btcBillPays(viewer: FamilyMember, scope: ConvexRowScope)
    case btcAccounts(viewer: FamilyMember, scope: ConvexRowScope)
    case btcBalanceDocuments(viewer: FamilyMember, scope: ConvexRowScope)
    case budget(viewer: FamilyMember)
    case btcSnapshotMetadata(viewer: FamilyMember, scope: ConvexRowScope)
    case rowCounts

    var path: String {
        switch self {
        case .transactions: "tables:listTransactions"
        case .income: "tables:listIncome"
        case .todos: "tables:listTodos"
        case .btcBuys: "tables:listBtcBuys"
        case .btcBillPays: "tables:listBtcBillPays"
        case .btcAccounts: "tables:listBtcAccounts"
        case .btcBalanceDocuments: "tables:listBtcBalanceDocuments"
        case .budget: "tables:getBudgetDocument"
        case .btcSnapshotMetadata: "tables:getBtcSnapshotMetadata"
        case .rowCounts: "tables:rowCounts"
        }
    }

    var arguments: [String: Any] {
        switch self {
        case let .transactions(viewer), let .todos(viewer):
            ["viewer": viewer.rawValue]
        case let .income(viewer, month):
            if let month {
                ["viewer": viewer.rawValue, "month": month]
            } else {
                ["viewer": viewer.rawValue]
            }
        case let .btcBuys(viewer, scope),
             let .btcBillPays(viewer, scope),
             let .btcAccounts(viewer, scope),
             let .btcBalanceDocuments(viewer, scope),
             let .btcSnapshotMetadata(viewer, scope):
            ["viewer": viewer.rawValue, "scope": scope.rawValue]
        case let .budget(viewer):
            ["viewer": viewer.rawValue, "scope": ConvexRowScope.netWorth.rawValue]
        case .rowCounts:
            [:]
        }
    }
}

enum ConvexRowDecodeError: LocalizedError, Equatable {
    case incompleteSnapshot
    case inconsistentMonth
    case invalidPriority
    case ambiguousDocument
    case missingDocument
    case ownerOutOfScope

    var errorDescription: String? {
        switch self {
        case .incompleteSnapshot:
            "A bounded row response cannot replace the local snapshot."
        case .inconsistentMonth:
            "A row month does not match its date."
        case .invalidPriority:
            "A todo priority does not fit Swift Int."
        case .ambiguousDocument:
            "A required financial source returned more than one document."
        case .missingDocument:
            "The requested row document does not exist."
        case .ownerOutOfScope:
            "A row owner is outside the requested viewer and visibility scope."
        }
    }
}

struct ConvexRowEnvelope<Row: Decodable>: Decodable {
    let rows: [Row]
    let complete: Bool

    func completeRows() throws -> [Row] {
        guard complete else { throw ConvexRowDecodeError.incompleteSnapshot }
        return rows
    }
}

struct ConvexTransactionRow: Decodable {
    let txId: String
    let owner: FamilyMember
    let date: String
    let month: String
    let merchant: String
    let amountCents: Int64
    let category: String
    let card: String?
    let note: String?
    let amountSats: Int64?
    let bitcoinAccountKey: String?
    let updatedAtMs: Double

    func legacyDTO() throws -> LegacyTransactionDTO {
        try validateDateMonth(date: date, month: month)
        return LegacyTransactionDTO(
            id: txId,
            date: date,
            merchant: merchant,
            amount: decimalMinorUnits(amountCents, scale: 2),
            category: category,
            card: card,
            note: note,
            owner: owner,
            amountSats: amountSats,
            // The server stores sats only on Income the user entered in BTC, so
            // their presence on a row coming back is the origin marker. Without
            // deriving it here, editing a synced Bitcoin income would re-push it
            // with no sats and quietly turn it into an ordinary dollar income.
            enteredInBitcoin: amountSats != nil,
            bitcoinAccountKey: bitcoinAccountKey,
            updatedAtMs: updatedAtMs,
        )
    }
}

struct ConvexTodoRow: Decodable {
    let todoId: String
    let owner: FamilyMember
    let title: String
    let done: Bool
    let flagged: Bool
    let lane: String?
    let project: String?
    let area: String?
    let due: String?
    let notes: String?
    let priority: Int64?
    let createdAt: String?
    let updatedAt: String?
    let completedAt: String?

    func legacyDTO() throws -> LegacyTodoDTO {
        let decodedPriority: Int?
        if let priority {
            guard let exact = Int(exactly: priority) else {
                throw ConvexRowDecodeError.invalidPriority
            }
            decodedPriority = exact
        } else {
            decodedPriority = nil
        }
        return LegacyTodoDTO(
            rowId: todoId,
            title: title,
            project: project ?? lane,
            area: area,
            due: due,
            notes: notes,
            priority: decodedPriority,
            flagged: flagged,
            done: done,
            owner: owner,
            createdAt: createdAt,
            updatedAt: updatedAt,
            completedAt: completedAt,
        )
    }
}

struct ConvexBTCBuyRow: Decodable {
    let buyId: String
    let owner: FamilyMember
    let date: String
    let month: String
    let source: String
    let sats: Int64
    let priceUsdCents: Int64
    let usdCents: Int64
    let note: String?
    let status: String?
    let costBasisStatus: String?
    let loggedBy: String?
    let archimedesRequestId: String?

    func legacyDTO() throws -> LegacyBTCBuyDTO {
        try validateDateMonth(date: date, month: month)
        return LegacyBTCBuyDTO(
            id: buyId,
            date: date,
            source: source,
            amountSats: sats,
            amountBtc: decimalMinorUnits(sats, scale: 8),
            priceUsd: decimalMinorUnits(priceUsdCents, scale: 2),
            usd: decimalMinorUnits(usdCents, scale: 2),
            note: note,
            status: status,
            costBasisStatus: costBasisStatus,
            loggedBy: loggedBy,
            archimedesRequestId: archimedesRequestId,
            owner: owner.rawValue,
        )
    }
}

struct ConvexBTCBillPayRow: Decodable {
    let billPayId: String
    let owner: FamilyMember
    let date: String
    let month: String
    let merchant: String
    let category: String
    let amountUsdCents: Int64
    let btcSpentSats: Int64
    let btcPriceCents: Int64
    let platform: String?
    let note: String?
    let feeUsdCents: Int64
    let reference: String?

    func legacyDTO() throws -> LegacyBTCBillPayDTO {
        try validateDateMonth(date: date, month: month)
        return LegacyBTCBillPayDTO(
            id: billPayId,
            date: date,
            merchant: merchant,
            category: category,
            amountUsd: decimalMinorUnits(amountUsdCents, scale: 2),
            btcSpent: decimalMinorUnits(btcSpentSats, scale: 8),
            btcPrice: decimalMinorUnits(btcPriceCents, scale: 2),
            platform: platform,
            note: note,
            feeUsd: decimalMinorUnits(feeUsdCents, scale: 2),
            reference: reference,
            owner: owner.rawValue,
        )
    }
}

struct ConvexBTCAccountRow: Decodable {
    let key: String
    let owner: FamilyMember
    let label: String
    let custody: BTCCustody
    let sats: Int64
    let fiatCents: Int64?
    let asOf: String
    let schemaVersion: Int64
}

struct ConvexBTCBalanceDocumentRow: Decodable, Sendable {
    struct Account: Decodable, Sendable {
        let key: String
        let label: String
        let custody: BTCCustody
        let sats: Int64
        let fiatCents: Int64?
    }

    struct Totals: Decodable, Sendable {
        let sats: Int64
        let fiatCents: Int64?
        let exchangeSats: Int64
        let selfCustodySats: Int64
    }

    let owner: FamilyMember
    let schemaVersion: Int64
    let asOf: String
    let accounts: [Account]
    let totals: Totals
    let source: String?
    let basis: String?
    let confidence: String?
}

struct ConvexBTCSnapshotMetadataRow: Decodable {
    let owner: FamilyMember
    let schemaVersion: Int64
    let asOf: String
    let source: String?
    let basis: String?
    let confidence: String?
}

struct ConvexRowCounts: Decodable, Equatable {
    let transactions: Int
    let todos: Int
    let btcBuys: Int
    let btcBillPays: Int
    let btcAccounts: Int
}

struct ConvexBudgetDocumentEnvelope: Decodable {
    let document: ConvexBudgetDocumentRow?
    let complete: Bool

    func completeDocument() throws -> ConvexBudgetDocumentRow {
        guard complete else { throw ConvexRowDecodeError.incompleteSnapshot }
        guard let document else { throw ConvexRowDecodeError.missingDocument }
        return document
    }
}

struct ConvexBudgetDocumentRow: Decodable {
    struct Category: Decodable {
        let name: String
        let icon: String?
        let budgetCents: Int64
    }

    struct Paycheck: Decodable {
        let date: String
        let platform: String?
        let source: String?
        let amountCents: Int64
        let netCents: Int64
        let note: String?
    }

    struct Income: Decodable {
        let weeklyGrossCents: Int64
        let weeklyStrikeCents: Int64
        let weeklyRiverCents: Int64
        let payFrequency: String?
        let monthlyGrossCents: Int64
        let mtdIncomeCents: Int64
        let ytdIncomeCents: Int64
        let paychecks: [Paycheck]
    }

    struct MonthlyHistory: Decodable {
        let month: String
        let incomeCents: Int64
        let expensesCents: Int64
        let savingsBps: Int64
    }

    let owner: FamilyMember
    let month: String
    let coinbaseOneBalanceCents: Int64
    let categories: [Category]
    let effectiveApr: String?
    let strategyNote: String?
    let income: Income?
    let mtdIncomeCents: Int64
    let ytdIncomeCents: Int64
    let monthlyHistory: [MonthlyHistory]

    func adultBudgetDTO() -> LegacyBudgetDTO {
        LegacyBudgetDTO(
            month: month,
            coinbaseOneBalance: decimalMinorUnits(coinbaseOneBalanceCents, scale: 2),
            categories: categories.map {
                LegacyBudgetCategoryDTO(
                    name: $0.name,
                    icon: $0.icon,
                    budget: decimalMinorUnits($0.budgetCents, scale: 2),
                    spent: nil,
                )
            },
            strategy: LegacyBudgetStrategyDTO(
                effectiveApr: effectiveApr.flatMap {
                    Decimal(string: $0, locale: Locale(identifier: "en_US_POSIX"))
                },
                strategyNote: strategyNote,
            ),
            income: income?.legacyDTO(),
            mtdIncome: decimalMinorUnits(mtdIncomeCents, scale: 2),
            ytdIncome: decimalMinorUnits(ytdIncomeCents, scale: 2),
            monthlyHistory: monthlyHistory.map {
                LegacyMonthlyHistoryEntryDTO(
                    month: $0.month,
                    income: decimalMinorUnits($0.incomeCents, scale: 2),
                    expenses: decimalMinorUnits($0.expensesCents, scale: 2),
                    savingsPct: decimalMinorUnits($0.savingsBps, scale: 2),
                )
            },
        )
    }

    func childBudgetDTO() -> LegacyMasonBudgetDTO {
        LegacyMasonBudgetDTO(
            month: month,
            owner: owner.rawValue,
            categories: categories.map {
                LegacyBudgetCategoryDTO(
                    name: $0.name,
                    icon: $0.icon,
                    budget: decimalMinorUnits($0.budgetCents, scale: 2),
                    spent: nil,
                )
            },
            allowance: nil,
            income: income?.legacyDTO(),
        )
    }
}

private extension ConvexBudgetDocumentRow.Income {
    func legacyDTO() -> LegacyBudgetIncomeDTO {
        LegacyBudgetIncomeDTO(
            weeklyGross: decimalMinorUnits(weeklyGrossCents, scale: 2),
            weeklyStrike: decimalMinorUnits(weeklyStrikeCents, scale: 2),
            weeklyRiver: decimalMinorUnits(weeklyRiverCents, scale: 2),
            payFrequency: payFrequency,
            monthlyGross: decimalMinorUnits(monthlyGrossCents, scale: 2),
            mtdIncome: decimalMinorUnits(mtdIncomeCents, scale: 2),
            ytdIncome: decimalMinorUnits(ytdIncomeCents, scale: 2),
            paychecks: paychecks.map {
                LegacyPaycheckDTO(
                    date: $0.date,
                    platform: $0.platform,
                    source: $0.source,
                    amount: decimalMinorUnits($0.amountCents, scale: 2),
                    net: decimalMinorUnits($0.netCents, scale: 2),
                    note: $0.note,
                )
            },
        )
    }
}

/// Exact integer-minor-unit conversion. No money value passes through Double.
func decimalMinorUnits(_ value: Int64, scale: Int16) -> Decimal {
    var result = Decimal(value)
    var divisor = Decimal(1)
    for _ in 0 ..< Int(scale) {
        divisor *= 10
    }
    result /= divisor
    return result
}

private func validateDateMonth(date: String, month: String) throws {
    guard date.count >= 7, String(date.prefix(7)) == month else {
        throw ConvexRowDecodeError.inconsistentMonth
    }
}

struct ConvexRowReader: Sendable {
    let client: ConvexClient

    func transactions(viewer: FamilyMember) async throws -> [LegacyTransactionDTO] {
        let envelope = try await client.fetchRows(
            .transactions(viewer: viewer),
            as: ConvexRowEnvelope<ConvexTransactionRow>.self,
        )
        let rows = try envelope.completeRows()
        guard rows.allSatisfy({ viewer.canSee(dataOwnedBy: $0.owner) }) else {
            throw ConvexRowDecodeError.ownerOutOfScope
        }
        return try rows.map { try $0.legacyDTO() }
    }

    func todos(viewer: FamilyMember) async throws -> [LegacyTodoDTO] {
        let envelope = try await client.fetchRows(
            .todos(viewer: viewer),
            as: ConvexRowEnvelope<ConvexTodoRow>.self,
        )
        let rows = try envelope.completeRows()
        guard rows.allSatisfy({ viewer.canSee(dataOwnedBy: $0.owner) }) else {
            throw ConvexRowDecodeError.ownerOutOfScope
        }
        return try rows.map { try $0.legacyDTO() }
    }

    func canonicalIncome(
        viewer: FamilyMember,
    ) async throws -> RequiredFinancialSource<CanonicalIncomeSummary> {
        let envelope = try await client.fetchRows(
            .income(viewer: viewer, month: nil),
            as: ConvexRowEnvelope<ConvexIncomeRow>.self,
        )
        let rows = try envelope.completeRows()
        guard rows.allSatisfy({ viewer.canSee(dataOwnedBy: $0.owner) }) else {
            throw ConvexRowDecodeError.ownerOutOfScope
        }
        let householdRows = rows.filter { viewer.sharesNetWorth(with: $0.owner) }
        return try CanonicalFinancialProjection.income(rows: householdRows, complete: true)
    }

    func btcBuys(viewer: FamilyMember, scope: ConvexRowScope) async throws -> [LegacyBTCBuyDTO] {
        let envelope = try await client.fetchRows(
            .btcBuys(viewer: viewer, scope: scope),
            as: ConvexRowEnvelope<ConvexBTCBuyRow>.self,
        )
        let rows = try envelope.completeRows()
        guard rows.allSatisfy({ ownerIsVisible($0.owner, to: viewer, scope: scope) }) else {
            throw ConvexRowDecodeError.ownerOutOfScope
        }
        return try rows.map { try $0.legacyDTO() }
    }

    func btcBillPays(viewer: FamilyMember, scope: ConvexRowScope) async throws -> [LegacyBTCBillPayDTO] {
        let envelope = try await client.fetchRows(
            .btcBillPays(viewer: viewer, scope: scope),
            as: ConvexRowEnvelope<ConvexBTCBillPayRow>.self,
        )
        let rows = try envelope.completeRows()
        guard rows.allSatisfy({ ownerIsVisible($0.owner, to: viewer, scope: scope) }) else {
            throw ConvexRowDecodeError.ownerOutOfScope
        }
        return try rows.map { try $0.legacyDTO() }
    }

    func canonicalBTCBalance(
        viewer: FamilyMember,
        scope: ConvexRowScope,
    ) async throws -> RequiredFinancialSource<CanonicalBTCBalance> {
        let envelope = try await client.fetchRows(
            .btcBalanceDocuments(viewer: viewer, scope: scope),
            as: ConvexRowEnvelope<ConvexBTCBalanceDocumentRow>.self,
        )
        let rows = try envelope.completeRows()
        guard rows.allSatisfy({ ownerIsVisible($0.owner, to: viewer, scope: scope) }) else {
            throw ConvexRowDecodeError.ownerOutOfScope
        }
        return try CanonicalFinancialProjection.btcBalance(documents: rows)
    }

    func canonicalBTCBillPayLedger(
        viewer: FamilyMember,
        scope: ConvexRowScope,
    ) async throws -> RequiredFinancialSource<CanonicalBTCBillPayLedger> {
        let envelope = try await client.fetchRows(
            .btcBillPays(viewer: viewer, scope: scope),
            as: ConvexRowEnvelope<ConvexBTCBillPayRow>.self,
        )
        let rows = try envelope.completeRows()
        guard rows.allSatisfy({ ownerIsVisible($0.owner, to: viewer, scope: scope) }) else {
            throw ConvexRowDecodeError.ownerOutOfScope
        }
        return CanonicalFinancialProjection.btcBillPays(rows: rows)
    }

    func budget(viewer: FamilyMember) async throws -> ConvexBudgetDocumentRow {
        let envelope = try await client.fetchRows(
            .budget(viewer: viewer),
            as: ConvexBudgetDocumentEnvelope.self,
        )
        let document = try envelope.completeDocument()
        guard viewer.sharesNetWorth(with: document.owner) else {
            throw ConvexRowDecodeError.ownerOutOfScope
        }
        return document
    }

    func btcAccounts(
        viewer: FamilyMember,
        scope: ConvexRowScope,
    ) async throws -> [ConvexBTCAccountRow] {
        let envelope = try await client.fetchRows(
            .btcAccounts(viewer: viewer, scope: scope),
            as: ConvexRowEnvelope<ConvexBTCAccountRow>.self,
        )
        let rows = try envelope.completeRows()
        guard rows.allSatisfy({ ownerIsVisible($0.owner, to: viewer, scope: scope) }) else {
            throw ConvexRowDecodeError.ownerOutOfScope
        }
        return rows
    }

    func btcSnapshotMetadata(
        viewer: FamilyMember,
        scope: ConvexRowScope,
    ) async throws -> [ConvexBTCSnapshotMetadataRow] {
        let envelope = try await client.fetchRows(
            .btcSnapshotMetadata(viewer: viewer, scope: scope),
            as: ConvexRowEnvelope<ConvexBTCSnapshotMetadataRow>.self,
        )
        let rows = try envelope.completeRows()
        guard rows.allSatisfy({ ownerIsVisible($0.owner, to: viewer, scope: scope) }) else {
            throw ConvexRowDecodeError.ownerOutOfScope
        }
        return rows
    }

    func rowCounts() async throws -> ConvexRowCounts {
        try await client.fetchRows(.rowCounts, as: ConvexRowCounts.self)
    }
}

private func ownerIsVisible(
    _ owner: FamilyMember,
    to viewer: FamilyMember,
    scope: ConvexRowScope,
) -> Bool {
    switch scope {
    case .visible:
        viewer.canSee(dataOwnedBy: owner)
    case .netWorth:
        viewer.sharesNetWorth(with: owner)
    }
}

/// A required financial source must prove that it exists before the UI may
/// render a numeric value. In particular, an empty row response is not zero.
enum RequiredFinancialSource<Value: Sendable>: Sendable {
    case loading
    case available(Value)
    case unavailable

    var value: Value? {
        guard case let .available(value) = self else { return nil }
        return value
    }
}

struct CanonicalBTCBalance: Sendable {
    struct Account: Sendable {
        let key: String
        let label: String
        let custody: BTCCustody
        let sats: Int64
        let fiatCents: Int64?
    }

    let owner: FamilyMember
    let asOf: String
    let totalSats: Int64
    let totalFiatCents: Int64?
    let exchangeSats: Int64
    let selfCustodySats: Int64
    let accounts: [Account]
}

struct CanonicalBTCBillPayLedger: Sendable {
    let count: Int
    let totalUSDCents: Int64
    let totalSpentSats: Int64
}

struct CanonicalIncomeSummary: Sendable {
    let monthCents: [String: Int64]
    let yearCents: [Int: Int64]

    func cents(forMonth month: String) -> Int64? {
        monthCents[month]
    }

    func cents(forYear year: Int) -> Int64? {
        yearCents[year]
    }
}

/// The public income projection from `tables:projectIncome`. The server
/// deliberately strips the storage-only `sourceKey` field at this boundary
/// and pins its absence in `tables.test.ts`. This row carries the nine
/// fields it needs; the wire also sends `updatedAtMs`, which this row does
/// not use.
struct ConvexIncomeRow: Decodable, Sendable {
    let incomeId: String
    let owner: FamilyMember
    let date: String
    let month: String
    let amountCents: Int64
    let source: String
    let loggedBy: String?
    let note: String?
    let archimedesRequestId: String?
}

enum CanonicalFinancialProjection {
    static func btcBalance(
        documents: [ConvexBTCBalanceDocumentRow],
    ) throws -> RequiredFinancialSource<CanonicalBTCBalance> {
        guard !documents.isEmpty else { return .unavailable }
        guard documents.count == 1, let document = documents.first else {
            throw ConvexRowDecodeError.ambiguousDocument
        }
        return .available(
            CanonicalBTCBalance(
                owner: document.owner,
                asOf: document.asOf,
                totalSats: document.totals.sats,
                totalFiatCents: document.totals.fiatCents,
                exchangeSats: document.totals.exchangeSats,
                selfCustodySats: document.totals.selfCustodySats,
                accounts: document.accounts.map {
                    CanonicalBTCBalance.Account(
                        key: $0.key,
                        label: $0.label,
                        custody: $0.custody,
                        sats: $0.sats,
                        fiatCents: $0.fiatCents,
                    )
                },
            ),
        )
    }

    static func btcBillPays(
        rows: [ConvexBTCBillPayRow],
    ) -> RequiredFinancialSource<CanonicalBTCBillPayLedger> {
        guard !rows.isEmpty else { return .unavailable }
        var usdCents: Int64 = 0
        var spentSats: Int64 = 0
        for row in rows {
            let (nextUSD, usdOverflow) = usdCents.addingReportingOverflow(row.amountUsdCents)
            let (nextSats, satsOverflow) = spentSats.addingReportingOverflow(row.btcSpentSats)
            guard !usdOverflow, !satsOverflow else { return .unavailable }
            usdCents = nextUSD
            spentSats = nextSats
        }
        return .available(
            CanonicalBTCBillPayLedger(
                count: rows.count,
                totalUSDCents: usdCents,
                totalSpentSats: spentSats,
            ),
        )
    }

    static func income(
        rows: [ConvexIncomeRow],
        complete: Bool,
    ) throws -> RequiredFinancialSource<CanonicalIncomeSummary> {
        guard complete else { throw ConvexRowDecodeError.incompleteSnapshot }
        guard !rows.isEmpty else { return .unavailable }

        var monthCents: [String: Int64] = [:]
        var yearCents: [Int: Int64] = [:]
        for row in rows {
            try validateIncomeDateMonth(date: row.date, month: row.month)
            let currentMonth = monthCents[row.month, default: 0]
            let (nextMonth, monthOverflow) = currentMonth.addingReportingOverflow(row.amountCents)
            guard !monthOverflow else { return .unavailable }
            monthCents[row.month] = nextMonth

            guard let year = Int(row.month.prefix(4)) else {
                throw ConvexRowDecodeError.inconsistentMonth
            }
            let currentYear = yearCents[year, default: 0]
            let (nextYear, yearOverflow) = currentYear.addingReportingOverflow(row.amountCents)
            guard !yearOverflow else { return .unavailable }
            yearCents[year] = nextYear
        }
        return .available(CanonicalIncomeSummary(monthCents: monthCents, yearCents: yearCents))
    }

    private static func validateIncomeDateMonth(date: String, month: String) throws {
        guard date.count >= 7, String(date.prefix(7)) == month else {
            throw ConvexRowDecodeError.inconsistentMonth
        }
    }
}

/// Shared UI state for sources that must never fall back to an inferred zero.
@MainActor
@Observable
final class CanonicalFinancialSourceStore {
    private(set) var btcBalance: RequiredFinancialSource<CanonicalBTCBalance> = .loading
    private(set) var income: RequiredFinancialSource<CanonicalIncomeSummary> = .unavailable
    private(set) var btcBillPays: RequiredFinancialSource<CanonicalBTCBillPayLedger> = .loading

    private let reader: ConvexRowReader

    init(client: ConvexClient? = nil) {
        let resolvedClient = client ?? ConvexClient(deploymentURL: ConvexConfig.deploymentURL)
        reader = ConvexRowReader(client: resolvedClient)
    }

    func load(viewer: FamilyMember) async {
        btcBalance = .loading
        income = .unavailable
        btcBillPays = .loading

        do {
            btcBalance = try await reader.canonicalBTCBalance(viewer: viewer, scope: .netWorth)
        } catch {
            btcBalance = .unavailable
        }

        do {
            income = try await reader.canonicalIncome(viewer: viewer)
        } catch {
            income = .unavailable
        }

        do {
            btcBillPays = try await reader.canonicalBTCBillPayLedger(
                viewer: viewer,
                scope: .netWorth,
            )
        } catch {
            btcBillPays = .unavailable
        }
    }
}
