// The Vogel Vault — legacy dataFiles reader
// Reads legacy blob data from the Convex backend.
// Decodes responses into the compatibility DTOs used by MC2Mapper.

import Foundation
import os

struct MC2ReadBatch<Value> {
    let value: Value
    /// Nil means the legacy payload does not prove absence for unrepresented owners.
    let replacementOwners: Set<FamilyMember>?
}

/// Reads legacy `dataFiles` blob data from the Convex cloud backend.
///
/// Usage:
/// ```swift
/// let reader = MC2Reader()
/// let transactions = try await reader.readTransactions(viewer: .rachel)
/// let budget = try await reader.readBudget(viewer: .rachel)
/// ```
actor MC2Reader {
    private let client: ConvexClient
    private let rowReader: ConvexRowReader
    private let rowReadsEnabled: () -> Bool
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "MC2Reader")

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
    func readTransactions(viewer: FamilyMember) async throws -> MC2ReadBatch<[MC2Transaction]> {
        if rowReadsEnabled() {
            do {
                let rows = try await rowReader.transactions(viewer: viewer)
                let owners = Set(FamilyMember.allCases.filter { viewer.canSee(dataOwnedBy: $0) })
                return MC2ReadBatch(value: rows, replacementOwners: owners)
            } catch let error as ConvexError where error.isRowAPIUnavailable {
                log.notice("Public row API is not deployed; reading authenticated transactions blob")
            }
        }

        let blob = try await client.fetchFile("transactions", as: [MC2Transaction].self)
        return MC2ReadBatch(value: blob, replacementOwners: nil)
    }

    /// Read the current budget from Convex.
    func readBudget(viewer: FamilyMember) async throws -> MC2Budget {
        try await rowOrBlob(
            { try await rowReader.budget(viewer: viewer).adultBudgetDTO() },
            blob: { try await client.fetchFile("budget", as: MC2Budget.self) },
        )
    }

    /// Read the BTC balance snapshot from Convex.
    func readBTCSnapshot() async throws -> MC2BTCSnapshot {
        try await client.fetchFile("btc-balance-snapshot", as: MC2BTCSnapshot.self)
    }

    /// Read all BTC buy records from Convex.
    func readBTCBuys(viewer: FamilyMember) async throws -> [MC2BTCBuy] {
        try await rowOrBlob(
            { try await rowReader.btcBuys(viewer: viewer, scope: .netWorth) },
            blob: { try await client.fetchFile("bitcoin-buys", as: [MC2BTCBuy].self) },
        )
    }

    /// Read all BTC bill pay records from Convex.
    func readBTCBillPays(viewer: FamilyMember) async throws -> [MC2BTCBillPay] {
        try await rowOrBlob(
            { try await rowReader.btcBillPays(viewer: viewer, scope: .netWorth) },
            blob: {
                let wrapper = try await client.fetchFile(
                    "bitcoin-bill-pays",
                    as: MC2BillPaysWrapper.self,
                )
                return wrapper.billPays
            },
        )
    }

    /// Read retirement/brokerage data from Convex.
    func readFinances() async throws -> MC2Finances {
        try await client.fetchFile("finances", as: MC2Finances.self)
    }

    /// Read Mason's BTC balances from Convex.
    func readSonBalances() async throws -> MC2SonBalances {
        try await client.fetchFile("son-balances", as: MC2SonBalances.self)
    }

    /// Read Mason's budget from Convex.
    func readMasonBudget(viewer: FamilyMember) async throws -> MC2MasonBudget {
        try await rowOrBlob(
            { try await rowReader.budget(viewer: viewer).childBudgetDTO() },
            blob: { try await client.fetchFile("mason-budget", as: MC2MasonBudget.self) },
        )
    }

    /// Read Mason's transactions from Convex.
    func readMasonTransactions(viewer: FamilyMember) async throws -> [MC2Transaction] {
        try await rowOrBlob(
            { try await rowReader.transactions(viewer: viewer) },
            blob: {
                try await client.fetchFile(
                    "mason-transactions",
                    as: [MC2Transaction].self,
                )
            },
        )
    }

    /// Read Mason's BTC buys from Convex.
    func readMasonBTCBuys(viewer: FamilyMember) async throws -> [MC2BTCBuy] {
        try await rowOrBlob(
            { try await rowReader.btcBuys(viewer: viewer, scope: .netWorth) },
            blob: {
                try await client.fetchFile(
                    "mason-bitcoin-buys",
                    as: [MC2BTCBuy].self,
                )
            },
        )
    }

    /// Read MC2 todos. Supports either a raw array or `{ "todos": [...] }`.
    func readTodos(viewer: FamilyMember) async throws -> MC2ReadBatch<[MC2TodoItem]> {
        if rowReadsEnabled() {
            do {
                let rows = try await rowReader.todos(viewer: viewer)
                let owners = Set(FamilyMember.allCases.filter { viewer.canSee(dataOwnedBy: $0) })
                return MC2ReadBatch(value: rows, replacementOwners: owners)
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
            return MC2ReadBatch(value: [], replacementOwners: nil)
        }

        let todos: [MC2TodoItem] = rawTodos.compactMap { item in
            guard JSONSerialization.isValidJSONObject(item),
                  let data = try? JSONSerialization.data(withJSONObject: item)
            else {
                log.warning("Todo item is not valid JSON, skipping")
                return nil
            }
            do {
                return try JSONDecoder().decode(MC2TodoItem.self, from: data)
            } catch {
                let id = (item as? [String: Any])?["id"] as? String ?? "unknown"
                log.warning("Failed to decode todo \(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
                return nil
            }
        }
        return MC2ReadBatch(value: todos, replacementOwners: nil)
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
