import Foundation
import Observation

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
        let fiatCents: Int64
    }

    let owner: FamilyMember
    let asOf: String
    let totalSats: Int64
    let totalFiatCents: Int64
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

struct ConvexIncomeRow: Decodable, Sendable {
    let sourceKey: String
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
/// Income remains unavailable until Convex exports a scoped `income` query.
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
            btcBillPays = try await reader.canonicalBTCBillPayLedger(
                viewer: viewer,
                scope: .netWorth,
            )
        } catch {
            btcBillPays = .unavailable
        }
    }
}
