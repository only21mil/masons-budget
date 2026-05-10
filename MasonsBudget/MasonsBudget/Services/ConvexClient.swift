// The Vogel Vault — Convex HTTP Client
// Communicates with the Convex backend to fetch and sync financial data.
// Replaces the local-file-based MC2 reader with a cloud-native approach.

import Foundation
import os

/// Configuration for the Convex deployment.
enum ConvexConfig {
    /// The Convex deployment URL. Updated after `npx convex deploy`.
    /// Store in UserDefaults so it can be changed without an app update.
    static var deploymentURL: URL {
        if let saved = UserDefaults.standard.string(forKey: "convex_deployment_url"),
           let url = URL(string: saved) {
            return url
        }
        return URL(string: "https://keen-elephant-452.convex.cloud")!
    }

    static func setDeploymentURL(_ urlString: String) {
        UserDefaults.standard.set(urlString, forKey: "convex_deployment_url")
    }

    /// Whether the Convex URL has been configured (not placeholder).
    static var isConfigured: Bool {
        let url = deploymentURL.absoluteString
        return !url.contains("placeholder")
    }

    static let syncToken = "40baea8c22e35057930eb7427aa6d0a4559fcfedd46b3c13d10343e4e707c804"
}

/// Errors specific to Convex operations.
enum ConvexError: LocalizedError {
    case notConfigured
    case networkError(Error)
    case httpError(Int)
    case decodeFailed(String, Error)
    case noData(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Convex backend not configured. Please set up in Settings."
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .httpError(let code):
            return "Server returned HTTP \(code)"
        case .decodeFailed(let name, let error):
            return "Failed to decode \(name): \(error.localizedDescription)"
        case .noData(let name):
            return "No data found for '\(name)'"
        }
    }
}

/// Response envelope from the Convex HTTP API.
private struct ConvexQueryResponse: Decodable {
    let status: String
    let value: AnyCodable?
    let errorMessage: String?
}

/// Type-erased Codable wrapper for Convex responses.
struct AnyCodable: Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int64.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unsupported type")
            )
        }
    }
}

/// HTTP client for the Convex backend.
/// Handles query and mutation calls via the Convex HTTP API.
final class ConvexClient: Sendable {
    private let deploymentURL: URL
    private let session: URLSession
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "Convex")

    init(deploymentURL: URL) {
        self.deploymentURL = deploymentURL
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)
    }

    /// Fetch a data file from Convex and decode it as the given type.
    func fetchFile<T: Decodable>(_ name: String, as type: T.Type) async throws -> T {
        let rawData = try await query("dataFiles:get", args: ["name": name])

        // rawData is the raw JSON value returned by Convex
        // Re-encode it to Data so we can use JSONDecoder with our DTOs
        let jsonData = try JSONSerialization.data(withJSONObject: rawData)
        do {
            return try JSONDecoder().decode(type, from: jsonData)
        } catch {
            throw ConvexError.decodeFailed(name, error)
        }
    }

    /// Fetch a data file without decoding it so callers can handle legacy or mixed schemas.
    func fetchFileValue(_ name: String) async throws -> Any {
        try await query("dataFiles:get", args: ["name": name])
    }

    /// Fetch current data file versions (lightweight change detection).
    func fetchVersions() async throws -> [String: Double] {
        let raw = try await query("dataFiles:getVersions", args: [:])
        guard let versions = raw as? [String: Any] else { return [:] }
        var result: [String: Double] = [:]
        for (key, val) in versions {
            if let v = val as? Double { result[key] = v }
            else if let v = val as? Int { result[key] = Double(v) }
        }
        return result
    }

    /// Replace a whole data file payload and bump its sync version.
    @discardableResult
    func syncFile(name: String, data: Any) async throws -> Double {
        let raw = try await mutation("dataFiles:sync", args: [
            "name": name,
            "data": data
        ])
        guard let result = raw as? [String: Any] else { return 0 }
        if let version = result["version"] as? Double { return version }
        if let version = result["version"] as? Int { return Double(version) }
        return 0
    }

    /// Push one app-created transaction into the shared MC2 transactions document.
    @discardableResult
    func appendTransaction(_ transaction: MC2Transaction, to name: String = "transactions") async throws -> Double {
        let raw = try await mutation("dataFiles:appendTransaction", args: [
            "name": name,
            "transaction": try transaction.convexJSONObject()
        ])
        guard let result = raw as? [String: Any] else { return 0 }
        if let version = result["version"] as? Double { return version }
        if let version = result["version"] as? Int { return Double(version) }
        return 0
    }

    /// Upsert one app-created or app-edited todo into the shared MC2 todos document.
    @discardableResult
    func upsertTodo(_ todo: MC2TodoItem, to name: String = "todos") async throws -> Double {
        let raw = try await mutation("dataFiles:upsertTodo", args: [
            "name": name,
            "todo": try todo.convexJSONObject()
        ])
        guard let result = raw as? [String: Any] else { return 0 }
        if let version = result["version"] as? Double { return version }
        if let version = result["version"] as? Int { return Double(version) }
        return 0
    }

    /// Push one app-created bill pay into the bitcoin-bill-pays document.
    @discardableResult
    func appendBillPay(_ billPay: MC2BTCBillPay) async throws -> Double {
        let data = try JSONEncoder().encode(billPay)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ConvexError.decodeFailed("billPay", NSError(domain: "MC2BTCBillPay", code: -1))
        }
        let raw = try await mutation("dataFiles:appendBillPay", args: [
            "billPay": object
        ])
        guard let result = raw as? [String: Any] else { return 0 }
        if let version = result["version"] as? Double { return version }
        if let version = result["version"] as? Int { return Double(version) }
        return 0
    }

    // MARK: - Internal

    /// Execute a Convex query and return the raw result.
    private func query(_ path: String, args: [String: Any]) async throws -> Any {
        try await call(endpoint: "api/query", path: path, args: args)
    }

    /// Execute a Convex mutation and return the raw result.
    private func mutation(_ path: String, args: [String: Any]) async throws -> Any {
        try await call(endpoint: "api/mutation", path: path, args: args)
    }

    private func call(endpoint: String, path: String, args: [String: Any]) async throws -> Any {
        let url = deploymentURL.appendingPathComponent(endpoint)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var finalArgs = args
        if endpoint == "api/mutation" {
            let token = ConvexConfig.syncToken
            if !token.isEmpty {
                finalArgs["token"] = token
            }
        }

        let body: [String: Any] = [
            "path": path,
            "args": finalArgs,
            "format": "json",
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw ConvexError.httpError(0)
        }
        guard http.statusCode == 200 else {
            log.error("Convex call failed: HTTP \(http.statusCode)")
            throw ConvexError.httpError(http.statusCode)
        }

        // Parse the Convex response envelope
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let status = json?["status"] as? String else {
            throw ConvexError.decodeFailed(path, NSError(domain: "Convex", code: -1))
        }

        if status == "error" {
            let msg = json?["errorMessage"] as? String ?? "Unknown error"
            log.error("Convex call error: \(msg)")
            throw ConvexError.decodeFailed(path, NSError(domain: "Convex", code: -1, userInfo: [
                NSLocalizedDescriptionKey: msg
            ]))
        }

        guard let value = json?["value"] else {
            throw ConvexError.noData(path)
        }

        // Convex returns NSNull for null values
        if value is NSNull {
            throw ConvexError.noData(path)
        }

        return value
    }
}
