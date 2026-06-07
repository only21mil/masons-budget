// The Vogel Vault — MC2 Reader
// Reads MC2 data from the Convex backend.
// Decodes responses into the same DTOs used by MC2Mapper.

import Foundation
import os

/// Reads MC2 data from the Convex cloud backend.
///
/// Usage:
/// ```swift
/// let reader = MC2Reader()
/// let transactions = try await reader.readTransactions()
/// let budget = try await reader.readBudget()
/// ```
actor MC2Reader {
    private let client: ConvexClient
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "MC2Reader")

    init(client: ConvexClient? = nil) {
        self.client = client ?? ConvexClient(deploymentURL: ConvexConfig.deploymentURL)
    }

    // MARK: - Public API

    /// Read all transactions from Convex.
    func readTransactions() async throws -> [MC2Transaction] {
        try await client.fetchFile("transactions", as: [MC2Transaction].self)
    }

    /// Read the current budget from Convex.
    func readBudget() async throws -> MC2Budget {
        try await client.fetchFile("budget", as: MC2Budget.self)
    }

    /// Read the BTC balance snapshot from Convex.
    func readBTCSnapshot() async throws -> MC2BTCSnapshot {
        try await client.fetchFile("btc-balance-snapshot", as: MC2BTCSnapshot.self)
    }

    /// Read all BTC buy records from Convex.
    func readBTCBuys() async throws -> [MC2BTCBuy] {
        try await client.fetchFile("bitcoin-buys", as: [MC2BTCBuy].self)
    }

    /// Read all BTC bill pay records from Convex.
    func readBTCBillPays() async throws -> [MC2BTCBillPay] {
        let wrapper = try await client.fetchFile("bitcoin-bill-pays", as: MC2BillPaysWrapper.self)
        return wrapper.billPays
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
    func readMasonBudget() async throws -> MC2MasonBudget {
        try await client.fetchFile("mason-budget", as: MC2MasonBudget.self)
    }

    /// Read Mason's transactions from Convex.
    func readMasonTransactions() async throws -> [MC2Transaction] {
        try await client.fetchFile("mason-transactions", as: [MC2Transaction].self)
    }

    /// Read Mason's BTC buys from Convex.
    func readMasonBTCBuys() async throws -> [MC2BTCBuy] {
        try await client.fetchFile("mason-bitcoin-buys", as: [MC2BTCBuy].self)
    }

    /// Read MC2 todos. Supports either a raw array or `{ "todos": [...] }`.
    func readTodos() async throws -> [MC2TodoItem] {
        let raw = try await client.fetchFileValue("todos")
        let rawTodos: [Any]
        if let array = raw as? [Any] {
            rawTodos = array
        } else if let wrapper = raw as? [String: Any], let array = wrapper["todos"] as? [Any] {
            rawTodos = array
        } else {
            return []
        }

        return rawTodos.compactMap { item in
            guard JSONSerialization.isValidJSONObject(item),
                  let data = try? JSONSerialization.data(withJSONObject: item) else {
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
    }

    /// Check current data versions (lightweight — for change detection).
    func checkVersions() async throws -> [String: Double] {
        try await client.fetchVersions()
    }
}
