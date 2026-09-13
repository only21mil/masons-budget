import Foundation

struct ConvexFinanceDocumentEnvelope: Decodable {
    let document: ConvexFinanceDocumentRow?
    let complete: Bool

    func legacyDTO(viewer: FamilyMember) throws -> LegacyFinancesDTO {
        guard complete else { throw ConvexRowDecodeError.incompleteSnapshot }
        guard let document else { throw ConvexRowDecodeError.missingDocument }
        guard document.accounts.allSatisfy({ viewer.canSee(dataOwnedBy: $0.owner) }) else {
            throw ConvexRowDecodeError.ownerOutOfScope
        }
        guard Set(document.accounts.map(\.key)).count == document.accounts.count else {
            throw ConvexRowDecodeError.ambiguousDocument
        }
        return try LegacyFinancesDTO(document: document)
    }
}

struct ConvexFinanceDocumentRow: Decodable {
    struct Lot: Decodable {
        let date: String
        let type: String
        let pricePerShareCents: Int64
        let sharesDecimal: String
        let amountInvestedCents: Int64
        let note: String?
    }

    struct Holding: Decodable {
        let name: String
        let category: String
        let ticker: String?
        let valueCents: Int64
        let costBasisCents: Int64
        let gainBps: Int64
        let sharesDecimal: String
        let avgCostCents: Int64
        let currentPricePerShareCents: Int64
        let isProxy: Bool
        let proxyNote: String?
        let lots: [Lot]
    }

    struct Account: Decodable {
        let key: String
        let owner: FamilyMember
        let provider: String
        let totalValueCents: Int64
        let weeklyContributionCents: Int64
        let weeklyContributionDay: String?
        let holdings: [Holding]
    }

    let lastUpdated: String
    let retirementTotalCents: Int64?
    let accounts: [Account]
    let updatedAtMs: Double
}

extension LegacyFinancesDTO {
    init(document: ConvexFinanceDocumentRow) throws {
        var accounts: [String: LegacyFinanceAccountDTO] = [:]
        for account in document.accounts {
            accounts[account.key] = try LegacyFinanceAccountDTO(row: account)
        }
        retirement = LegacyFinancesRetirementDTO(accounts: accounts)
        mason401k = nil // Typed accounts already carry their canonical owner.
        lastUpdated = document.lastUpdated
    }
}

extension LegacyFinancesRetirementDTO {
    init(accounts: [String: LegacyFinanceAccountDTO]) {
        self.accounts = accounts
    }
}

extension LegacyFinanceAccountDTO {
    init(row: ConvexFinanceDocumentRow.Account) throws {
        provider = row.provider
        total = decimalMinorUnits(row.totalValueCents, scale: 2)
        weeklyContribution = decimalMinorUnits(row.weeklyContributionCents, scale: 2)
        owner = row.owner.rawValue
        holdings = try row.holdings.map { try LegacyFinanceHoldingDTO(row: $0) }
    }
}

extension LegacyFinanceHoldingDTO {
    init(row: ConvexFinanceDocumentRow.Holding) throws {
        name = row.name
        category = row.category
        ticker = row.ticker
        value = decimalMinorUnits(row.valueCents, scale: 2)
        costBasis = decimalMinorUnits(row.costBasisCents, scale: 2)
        gainPct = decimalMinorUnits(row.gainBps, scale: 2)
        shares = try financeShares(row.sharesDecimal)
        avgCost = decimalMinorUnits(row.avgCostCents, scale: 2)
        currentPricePerShare = decimalMinorUnits(row.currentPricePerShareCents, scale: 2)
        proxy = row.isProxy
        proxyNote = row.proxyNote
        lots = try row.lots.map {
            try LegacyFinanceLotDTO(
                date: $0.date, type: $0.type,
                pricePerShare: decimalMinorUnits($0.pricePerShareCents, scale: 2),
                shares: financeShares($0.sharesDecimal, signed: true),
                amountInvested: decimalMinorUnits($0.amountInvestedCents, scale: 2), note: $0.note,
            )
        }
    }
}

private func financeShares(_ value: String, signed: Bool = false) throws -> Decimal {
    let pattern = signed ? #"^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$"# : #"^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$"#
    guard value.range(of: pattern, options: .regularExpression) != nil,
          let decimal = Decimal(string: value, locale: Locale(identifier: "en_US_POSIX")),
          !(value.hasPrefix("-") && decimal == 0)
    else { throw ConvexRowDecodeError.invalidShares }
    return decimal
}

extension ConvexBTCBalanceDocumentRow {
    func legacySnapshot() throws -> LegacyBTCSnapshotDTO {
        guard let version = Int(exactly: schemaVersion),
              Set(accounts.map(\.key)).count == accounts.count
        else { throw ConvexRowDecodeError.ambiguousDocument }
        let entries = Dictionary(uniqueKeysWithValues: accounts.map {
            ($0.key, LegacyBTCAccountEntryDTO(
                btc: decimalMinorUnits($0.sats, scale: 8),
                fiat: $0.fiatCents.map { decimalMinorUnits($0, scale: 2) } ?? 0,
                label: $0.label, custody: $0.custody.rawValue,
            ))
        })
        return LegacyBTCSnapshotDTO(
            schemaVersion: version, asOf: asOf, accounts: entries,
            totals: LegacyBTCTotalsDTO(
                btc: decimalMinorUnits(totals.sats, scale: 8),
                fiat: totals.fiatCents.map { decimalMinorUnits($0, scale: 2) } ?? 0,
                exchangeBtc: decimalMinorUnits(totals.exchangeSats, scale: 8),
                selfCustodyBtc: decimalMinorUnits(totals.selfCustodySats, scale: 8),
            ),
            metadata: LegacyBTCMetadataDTO(source: source, basis: basis, confidence: confidence),
            totalSats: totals.sats, totalBtc: decimalMinorUnits(totals.sats, scale: 8), totalUsdInvested: nil,
        )
    }
}

struct SyncedBTCAccount: Sendable {
    let key: String
    let label: String
    let custody: BTCCustody
    let btc: Decimal
    let fiat: Decimal
    let owner: FamilyMember

    func model() -> BTCAccount {
        BTCAccount(key: key, label: label, custody: custody, btc: btc, fiat: fiat, owner: owner)
    }
}
