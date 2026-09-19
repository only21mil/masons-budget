// The Vogel Vault — Convex data reader
// Prefers public row tables and falls back to surviving `dataFiles` blobs where
// row coverage is not available. Blob responses use the compatibility DTOs.

import Foundation
import os

enum ConvexSnapshotSource: Equatable {
    case rowAPI
    case legacyBlob
}

struct ConvexReadBatch<Value> {
    let value: Value
    /// Nil means the legacy payload does not prove absence for unrepresented owners.
    let replacementOwners: Set<FamilyMember>?
    let source: ConvexSnapshotSource

    var isRowAuthoritative: Bool { source == .rowAPI }
}

/// Reads financial data from Convex row tables with explicit legacy-blob fallbacks.
///
/// Usage:
/// ```swift
/// let reader = ConvexDataReader()
/// let transactions = try await reader.readTransactions(viewer: .rachel)
/// let budget = try await reader.readBudget(viewer: .rachel)
/// ```
actor ConvexDataReader {
    private let client: ConvexClient
    private let rowReader: ConvexRowReader
    private let rowReadsEnabled: () -> Bool
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "ConvexDataReader")

    init(
        client: ConvexClient? = nil,
        rowReadsEnabled: @escaping () -> Bool = { ConvexConfig.rowReadsEnabled },
    ) {
        let resolvedClient = client ?? ConvexClient(deploymentURL: ConvexConfig.deploymentURL)
        self.client = resolvedClient
        rowReader = ConvexRowReader(client: resolvedClient)
        self.rowReadsEnabled = rowReadsEnabled
    }

    // MARK: - Public API

    /// Read all transactions from Convex.
    func readTransactions(viewer: FamilyMember) async throws -> ConvexReadBatch<[LegacyTransactionDTO]> {
        if rowReadsEnabled() {
            do {
                let rows = try await rowReader.transactions(viewer: viewer)
                let owners = Set(FamilyMember.allCases.filter { viewer.canSee(dataOwnedBy: $0) })
                return ConvexReadBatch(value: rows, replacementOwners: owners, source: .rowAPI)
            } catch let error as ConvexError where error.isRowAPIUnavailable {
                log.notice("Public row API is not deployed; reading authenticated transactions blob")
            }
        }

        let blob = try await client.fetchFile("transactions", as: [LegacyTransactionDTO].self)
        return ConvexReadBatch(value: blob, replacementOwners: nil, source: .legacyBlob)
    }

    /// Read the current budget from Convex.
    func readBudget(viewer: FamilyMember) async throws -> LegacyBudgetDTO {
        try await rowOrBlob(
            { try await rowReader.budget(viewer: viewer).adultBudgetDTO() },
            blob: { try await client.fetchFile("budget", as: LegacyBudgetDTO.self) },
        )
    }

    private func balanceDocument(viewer: FamilyMember, owner: FamilyMember? = nil) async throws -> ConvexBTCBalanceDocumentRow {
        if let owner, !viewer.canSee(dataOwnedBy: owner) { throw ConvexRowDecodeError.ownerOutOfScope }
        let scope: ConvexRowScope = owner == nil ? .netWorth : .visible
        let envelope = try await client.fetchRows(
            .btcBalanceDocuments(viewer: viewer, scope: scope),
            as: ConvexRowEnvelope<ConvexBTCBalanceDocumentRow>.self,
        )
        let visibleRows = try envelope.completeRows()
        guard visibleRows.allSatisfy({ row in
            scope == .visible ? viewer.canSee(dataOwnedBy: row.owner) : viewer.sharesNetWorth(with: row.owner)
        }) else {
            throw ConvexRowDecodeError.ownerOutOfScope
        }
        let rows = visibleRows.filter { row in
            owner.map { $0.sharesNetWorth(with: row.owner) } ?? viewer.sharesNetWorth(with: row.owner)
        }
        guard let document = rows.first else { throw ConvexRowDecodeError.missingDocument }
        guard rows.count == 1 else { throw ConvexRowDecodeError.ambiguousDocument }
        return document
    }

    /// Account rows retain dynamic account keys and canonical owners, including children.
    func readBalanceAccounts(viewer: FamilyMember, owner: FamilyMember? = nil) async throws -> [SyncedBTCAccount] {
        let targetOwner = owner ?? viewer.ledgerOwner
        guard viewer.canSee(dataOwnedBy: targetOwner) else { throw ConvexRowDecodeError.ownerOutOfScope }
        return try await rowOrBlob(
            {
                // Require a balance document: an empty account list alone cannot prove zero.
                let document = try await balanceDocument(viewer: viewer, owner: targetOwner)
                let visibleRows = try await rowReader.btcAccounts(viewer: viewer, scope: .visible)
                let rows = visibleRows.filter { targetOwner.sharesNetWorth(with: $0.owner) }
                guard Set(rows.map(\.key)).count == rows.count,
                      rows.count == document.accounts.count,
                      rows.allSatisfy({ row in
                          row.owner == document.owner && document.accounts.contains {
                              $0.key == row.key && $0.sats == row.sats && $0.custody == row.custody
                          }
                      })
                else { throw ConvexRowDecodeError.incompleteSnapshot }
                return rows.map {
                    SyncedBTCAccount(key: $0.key, label: $0.label, custody: $0.custody,
                               btc: decimalMinorUnits($0.sats, scale: 8),
                               fiat: $0.fiatCents.map { decimalMinorUnits($0, scale: 2) } ?? 0,
                               owner: $0.owner)
                }
            },
            blob: {
                if targetOwner.isAdult {
                    let dto = try await client.fetchFile("btc-balance-snapshot", as: LegacyBTCSnapshotDTO.self)
                    return dto.accounts.map { key, account in
                        SyncedBTCAccount(key: key, label: account.label,
                                         custody: BTCCustody(rawValue: account.custody) ?? .exchange,
                                         btc: account.btc, fiat: account.fiat, owner: .victor)
                    }
                }
                guard targetOwner == .mason else { throw ConvexRowDecodeError.missingDocument }
                let dto = try await client.fetchFile("son-balances", as: LegacySonBalancesDTO.self)
                return [
                    SyncedBTCAccount(key: "son-strike-mason", label: "Strike", custody: .exchange, btc: dto.strike, fiat: 0, owner: .mason),
                    SyncedBTCAccount(key: "son-river-mason", label: "River", custody: .exchange, btc: dto.river, fiat: 0, owner: .mason),
                    SyncedBTCAccount(key: "son-coldcard-mason", label: "Multisig", custody: .selfCustody, btc: dto.coldcard, fiat: 0, owner: .mason),
                ]
            },
        )
    }

    /// Read all BTC buy records from Convex. The batch source records whether
    /// the row list proved absence (row-authoritative) or came from the
    /// compatibility blob, which cannot.
    func readBTCBuys(viewer: FamilyMember) async throws -> ConvexReadBatch<[LegacyBTCBuyDTO]> {
        if rowReadsEnabled() {
            do {
                let rows = try await rowReader.btcBuys(viewer: viewer, scope: .netWorth)
                return ConvexReadBatch(value: rows, replacementOwners: nil, source: .rowAPI)
            } catch let error as ConvexError where error.isRowAPIUnavailable {
                log.notice("Public row API is not deployed; reading authenticated bitcoin-buys blob")
            }
        }

        let blob = try await client.fetchFile("bitcoin-buys", as: [LegacyBTCBuyDTO].self)
        return ConvexReadBatch(value: blob, replacementOwners: nil, source: .legacyBlob)
    }

    /// Read all BTC bill pay records from Convex.
    func readBTCBillPays(viewer: FamilyMember) async throws -> [LegacyBTCBillPayDTO] {
        try await rowOrBlob(
            { try await rowReader.btcBillPays(viewer: viewer, scope: .netWorth) },
            blob: {
                let wrapper = try await client.fetchFile(
                    "bitcoin-bill-pays",
                    as: LegacyBillPaysWrapperDTO.self,
                )
                return wrapper.billPays
            },
        )
    }

    /// Read retirement/brokerage data from Convex.
    func readFinances(viewer: FamilyMember = .victor) async throws -> LegacyFinancesDTO {
        try await rowOrBlob(
            {
                let envelope = try await client.fetchRows(
                    .finance(viewer: viewer), as: ConvexFinanceDocumentEnvelope.self,
                )
                return try envelope.legacyDTO(viewer: viewer)
            },
            blob: { try await client.fetchFile("finances", as: LegacyFinancesDTO.self) },
        )
    }

    /// Read Mason's budget from Convex.
    func readMasonBudget(viewer: FamilyMember) async throws -> LegacyMasonBudgetDTO {
        try await rowOrBlob(
            { try await rowReader.budget(viewer: viewer).childBudgetDTO() },
            blob: { try await client.fetchFile("mason-budget", as: LegacyMasonBudgetDTO.self) },
        )
    }

    /// Read Mason's transactions from Convex.
    func readMasonTransactions(viewer: FamilyMember) async throws -> [LegacyTransactionDTO] {
        try await rowOrBlob(
            { try await rowReader.transactions(viewer: viewer) },
            blob: {
                try await client.fetchFile(
                    "mason-transactions",
                    as: [LegacyTransactionDTO].self,
                )
            },
        )
    }

    /// Read Mason's BTC buys from Convex (same batch semantics as `readBTCBuys`).
    func readMasonBTCBuys(viewer: FamilyMember) async throws -> ConvexReadBatch<[LegacyBTCBuyDTO]> {
        if rowReadsEnabled() {
            do {
                let rows = try await rowReader.btcBuys(viewer: viewer, scope: .netWorth)
                return ConvexReadBatch(value: rows, replacementOwners: nil, source: .rowAPI)
            } catch let error as ConvexError where error.isRowAPIUnavailable {
                log.notice("Public row API is not deployed; reading authenticated mason-bitcoin-buys blob")
            }
        }

        let blob = try await client.fetchFile(
            "mason-bitcoin-buys",
            as: [LegacyBTCBuyDTO].self,
        )
        return ConvexReadBatch(value: blob, replacementOwners: nil, source: .legacyBlob)
    }

    /// Read todos. The legacy blob fallback supports a raw array or `{ "todos": [...] }`.
    func readTodos(viewer: FamilyMember) async throws -> ConvexReadBatch<[LegacyTodoDTO]> {
        if rowReadsEnabled() {
            do {
                let rows = try await rowReader.todos(viewer: viewer)
                let owners: Set<FamilyMember> = [viewer]
                return ConvexReadBatch(value: rows, replacementOwners: owners, source: .rowAPI)
            } catch let error as ConvexError where error.isRowAPIUnavailable {
                log.notice("Public row API is not deployed; reading authenticated todos blob")
            }
        }

        let raw = try await client.fetchFileValue("todos")
        let rawTodos: [Any]
        if let array = raw as? [Any] {
            rawTodos = array
        } else if let wrapper = raw as? [String: Any], let array = wrapper["todos"] as? [Any] {
            rawTodos = array
        } else {
            return ConvexReadBatch(value: [], replacementOwners: nil, source: .legacyBlob)
        }

        let todos: [LegacyTodoDTO] = rawTodos.compactMap { item in
            guard JSONSerialization.isValidJSONObject(item),
                  let data = try? JSONSerialization.data(withJSONObject: item)
            else {
                log.warning("Todo item is not valid JSON, skipping")
                return nil
            }
            do {
                return try JSONDecoder().decode(LegacyTodoDTO.self, from: data)
            } catch {
                // Todo ids/titles and decoder details can contain household
                // data. Keep diagnostics authored and value-free.
                log.warning("Skipped one malformed todo row")
                return nil
            }
        }
        return ConvexReadBatch(value: todos, replacementOwners: nil, source: .legacyBlob)
    }

    /// Check current data versions (lightweight — for change detection).
    func checkVersions() async throws -> [String: Double] {
        try await client.fetchVersions()
    }

    private func rowOrBlob<T>(
        _ rows: () async throws -> T,
        blob: () async throws -> T,
    ) async throws -> T {
        guard rowReadsEnabled() else {
            return try await blob()
        }

        do {
            return try await rows()
        } catch let error as ConvexError where error.isRowAPIUnavailable {
            log.notice("Public row API is not deployed; reading authenticated legacy blob")
            return try await blob()
        }
    }
}
