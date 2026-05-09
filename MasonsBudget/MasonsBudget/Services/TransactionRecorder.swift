import Foundation
import SwiftData
import os

/// Shared write path for app-created transactions.
///
/// Both `DashboardTab` (manual + voice entry) and the `AddTransactionIntent`
/// AppIntent route through here so the SwiftData insert, local save, and
/// Convex push behave identically regardless of entry surface.
@MainActor
final class TransactionRecorder {
    enum Source: String {
        case manual
        case voice
        case siri
    }

    enum RecorderError: LocalizedError {
        case noActiveProfile

        var errorDescription: String? {
            switch self {
            case .noActiveProfile:
                return "No Vogel Vault profile is selected. Open the app and pick a profile first."
            }
        }
    }

    private let modelContext: ModelContext
    private let convex: ConvexClient
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "TransactionRecorder")

    init(modelContext: ModelContext, convex: ConvexClient = ConvexClient(deploymentURL: ConvexConfig.deploymentURL)) {
        self.modelContext = modelContext
        self.convex = convex
    }

    /// Resolve the currently selected family-member profile from `UserDefaults`.
    /// Used by AppIntents that don't have a SwiftUI environment.
    static func activeProfile() throws -> FamilyMember {
        let raw = UserDefaults.standard.string(forKey: "selected_family_member")
        guard let raw, let member = FamilyMember(rawValue: raw) else {
            throw RecorderError.noActiveProfile
        }
        return member
    }

    /// Insert a new transaction, save locally, and push to Convex on a detached task.
    @discardableResult
    func record(
        amount: Decimal,
        merchant: String,
        category: String,
        card: String? = nil,
        note: String? = nil,
        date: Date = .now,
        owner: FamilyMember,
        source: Source
    ) throws -> Transaction {
        let id = "\(source.rawValue)-\(Int(date.timeIntervalSince1970))-\(UUID().uuidString.prefix(6))"
        let tx = Transaction(
            id: id,
            date: date,
            merchant: merchant,
            amount: amount,
            category: category,
            card: card,
            note: note,
            owner: owner,
            createdBy: source.rawValue,
            createdAt: .now
        )
        modelContext.insert(tx)
        try modelContext.save()

        let dto = MC2Transaction(appTransaction: tx)
        let fileName = owner == .mason ? "mason-transactions" : "transactions"
        Task { [convex, log] in
            do {
                try await convex.appendTransaction(dto, to: fileName)
            } catch {
                log.error("Failed to push transaction to Convex: \(error.localizedDescription)")
            }
        }

        return tx
    }
}
