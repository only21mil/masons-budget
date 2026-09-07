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

    /// Read the BTC balance snapshot from Convex.
    func readBTCSnapshot() async throws -> LegacyBTCSnapshotDTO {
        try await client.fetchFile("btc-balance-snapshot", as: LegacyBTCSnapshotDTO.self)
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
    func readFinances() async throws -> LegacyFinancesDTO {
        try await client.fetchFile("finances", as: LegacyFinancesDTO.self)
    }

    /// Read Mason's BTC balances from Convex.
    func readSonBalances() async throws -> LegacySonBalancesDTO {
        try await client.fetchFile("son-balances", as: LegacySonBalancesDTO.self)
    }

    /// Read Mason's budget from Convex.
    func readMasonBudget(viewer: FamilyMember) async throws -> LegacyMasonBudgetDTO {
        try await rowOrBlob(
            { try await rowReader.budget(viewer: viewer).childBudgetDTO() },
            blob: { try await client.fetchFile("mason-budget", as: LegacyMasonBudgetDTO.self) },
        )
    }

    /// Read Mason's transactions from Convex. The batch source determines
    /// whether the result can prove that a missing local row was deleted.
    func readMasonTransactions(viewer: FamilyMember) async throws -> ConvexReadBatch<[LegacyTransactionDTO]> {
        if rowReadsEnabled() {
            do {
                let rows = try await rowReader.transactions(viewer: viewer)
                return ConvexReadBatch(
                    value: rows,
                    replacementOwners: Set([viewer]),
                    source: .rowAPI,
                )
            } catch let error as ConvexError where error.isRowAPIUnavailable {
                log.notice("Public row API is not deployed; reading authenticated mason-transactions blob")
            }
        }

        let blob = try await client.fetchFile(
            "mason-transactions",
            as: [LegacyTransactionDTO].self,
        )
        return ConvexReadBatch(value: blob, replacementOwners: nil, source: .legacyBlob)
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
