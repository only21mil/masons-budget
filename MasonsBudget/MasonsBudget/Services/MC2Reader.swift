// Mason's Budget App — MC2 Reader
// Reads and decodes MC2 mission-control JSON files from iCloud Drive (or local path).
// Pure read — does not modify files. See MC2Writer for writes.

import Foundation

/// Errors specific to MC2 file operations.
enum MC2Error: LocalizedError {
    case folderNotFound(URL)
    case fileNotFound(String)
    case decodeFailed(String, Error)

    var errorDescription: String? {
        switch self {
        case .folderNotFound(let url):
            return "MC2 mission-control folder not found at \(url.path)"
        case .fileNotFound(let name):
            return "MC2 file not found: \(name)"
        case .decodeFailed(let name, let error):
            return "Failed to decode \(name): \(error.localizedDescription)"
        }
    }
}

/// Reads MC2 mission-control JSON files from a given base URL.
///
/// Usage:
/// ```swift
/// let reader = MC2Reader(baseURL: mc2FolderURL)
/// let transactions = try reader.readTransactions()
/// let budget = try reader.readBudget()
/// ```
actor MC2Reader {
    let baseURL: URL

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    // MARK: - Public API

    /// Read all transactions from `transactions.json`.
    func readTransactions() throws -> [MC2Transaction] {
        try decode([MC2Transaction].self, from: "transactions.json")
    }

    /// Read the current budget from `budget.json`.
    func readBudget() throws -> MC2Budget {
        try decode(MC2Budget.self, from: "budget.json")
    }

    /// Read the BTC balance snapshot from `btc-balance-snapshot.json`.
    func readBTCSnapshot() throws -> MC2BTCSnapshot {
        try decode(MC2BTCSnapshot.self, from: "btc-balance-snapshot.json")
    }

    /// Read all BTC buy records from `bitcoin-buys.json`.
    func readBTCBuys() throws -> [MC2BTCBuy] {
        try decode([MC2BTCBuy].self, from: "bitcoin-buys.json")
    }

    /// Read all BTC bill pay records from `bitcoin-bill-pays.json`.
    func readBTCBillPays() throws -> [MC2BTCBillPay] {
        let wrapper = try decode(MC2BillPaysWrapper.self, from: "bitcoin-bill-pays.json")
        return wrapper.billPays
    }

    /// Read retirement/brokerage data from `finances.json`.
    func readFinances() throws -> MC2Finances {
        try decode(MC2Finances.self, from: "finances.json")
    }

    /// Read Mason's BTC balances from `son-balances.json`.
    func readSonBalances() throws -> MC2SonBalances {
        try decode(MC2SonBalances.self, from: "son-balances.json")
    }

    /// Read Mason's budget from `mason-budget.json`.
    func readMasonBudget() throws -> MC2MasonBudget {
        try decode(MC2MasonBudget.self, from: "mason-budget.json")
    }

    /// Read Mason's transactions from `mason-transactions.json`.
    func readMasonTransactions() throws -> [MC2Transaction] {
        try decode([MC2Transaction].self, from: "mason-transactions.json")
    }

    /// Check if the MC2 folder exists and is readable.
    func validateFolder() -> Bool {
        FileManager.default.isReadableFile(atPath: baseURL.path)
    }

    /// List available MC2 JSON files.
    func availableFiles() throws -> [String] {
        let contents = try FileManager.default.contentsOfDirectory(
            at: baseURL,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        )
        return contents
            .filter { $0.pathExtension == "json" }
            .map(\.lastPathComponent)
            .sorted()
    }

    // MARK: - Internal

    private func decode<T: Decodable>(_ type: T.Type, from filename: String) throws -> T {
        let fileURL = baseURL.appendingPathComponent(filename)

        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            throw MC2Error.fileNotFound(filename)
        }

        do {
            let data = try Data(contentsOf: fileURL)
            let decoder = JSONDecoder()
            return try decoder.decode(type, from: data)
        } catch let error as DecodingError {
            throw MC2Error.decodeFailed(filename, error)
        }
    }
}
