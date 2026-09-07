import CoreFoundation
import Foundation

/// A create is retried byte-for-byte. Never rebuild it from refreshed balances:
/// the original debit may already have posted when its response was lost.
struct BitcoinTransferIntent: Codable, Equatable, Sendable {
    static let mutationPath = "tables:upsertBtcTransferFromDevice"
    let id: String
    let owner: FamilyMember
    let date: String
    let fromAccountKey: String
    let toAccountKey: String
    let sats: Int64

    static func make(
        viewer: FamilyMember,
        balance: CanonicalBTCBalance?,
        from: String,
        to: String,
        satsText: String,
        date: Date,
    ) throws -> Self {
        guard viewer.isAdult, let balance, balance.owner == viewer.ledgerOwner else {
            throw BitcoinTransferError.householdRequired
        }
        let keys = balance.accounts.map(\.key)
        guard Set(keys).count == keys.count,
              !from.isEmpty, !to.isEmpty, from != to,
              from == from.trimmingCharacters(in: .whitespacesAndNewlines),
              to == to.trimmingCharacters(in: .whitespacesAndNewlines),
              let source = balance.accounts.first(where: { $0.key == from }),
              keys.contains(to)
        else { throw BitcoinTransferError.accountsRequired }
        let text = satsText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              let sats = Int64(text), sats > 0
        else { throw BitcoinTransferError.invalidAmount }
        guard sats <= source.sats else { throw BitcoinTransferError.insufficientFunds }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return Self(
            id: "btc-transfer-\(UUID().uuidString.lowercased())",
            owner: viewer.ledgerOwner,
            date: formatter.string(from: date),
            fromAccountKey: from,
            toAccountKey: to,
            sats: sats,
        )
    }

    func arguments(deviceID: String, deviceToken: String) -> [String: Any] {
        [
            "deviceId": deviceID,
            "deviceToken": deviceToken,
            "owner": owner.rawValue,
            "sourceFile": "btc-transfers",
            "transfer": [
                "id": id,
                "owner": owner.rawValue,
                "date": date,
                "fromAccountKey": fromAccountKey,
                "toAccountKey": toAccountKey,
                "sats": ConvexTaggedInt64Encoder.encode(sats),
                "feeSats": ConvexTaggedInt64Encoder.encode(0),
            ],
        ]
    }

    func validateReceipt(_ value: Any) throws {
        guard let receipt = value as? [String: Any],
              let ok = receipt["ok"] as? NSNumber,
              CFGetTypeID(ok) == CFBooleanGetTypeID(), ok.boolValue,
              receipt["entityId"] as? String == id,
              let outcome = receipt["outcome"] as? String,
              ["inserted", "updated"].contains(outcome)
        else { throw AppWritebackError.unexpectedResponse }
    }
}

enum BitcoinTransferError: LocalizedError, Equatable {
    case householdRequired, accountsRequired, invalidAmount, insufficientFunds
    case storageUnavailable, pendingTransfer, writesDisabled

    var errorDescription: String? {
        switch self {
        case .householdRequired: "Load the adult household Bitcoin accounts before transferring."
        case .accountsRequired: "Select two distinct accounts from the household Bitcoin ledger."
        case .invalidAmount: "Enter a positive whole number of sats within the supported range."
        case .insufficientFunds: "The source account does not have enough sats."
        case .storageUnavailable: "The transfer draft could not be stored or recovered. No new transfer can be submitted."
        case .pendingTransfer: "Recover the pending transfer before starting another."
        case .writesDisabled: "App writes are disabled. Your transfer remains available to retry."
        }
    }
}

/// A private atomic file survives closing the sheet or restarting the app. A
/// receipt is recorded before retiring the draft, so a failed cleanup cannot
/// make an accepted transfer look like an editable new transfer.
@MainActor
final class BitcoinTransferDraftStore {
    struct Draft: Codable, Equatable {
        let intent: BitcoinTransferIntent
        var accepted: Bool
    }

    private let fileURL: URL

    init(fileURL: URL? = nil) throws {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let support = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true,
            )
            self.fileURL = support.appendingPathComponent("BitcoinTransfers", isDirectory: true)
                .appendingPathComponent("household-draft.json")
        }
    }

    func load() throws -> Draft? {
        do {
            let data = try Data(contentsOf: fileURL)
            let draft = try JSONDecoder().decode(Draft.self, from: data)
            guard draft.intent.owner == .victor, !draft.intent.id.isEmpty,
                  draft.intent.sats > 0, !draft.intent.fromAccountKey.isEmpty,
                  !draft.intent.toAccountKey.isEmpty,
                  draft.intent.fromAccountKey != draft.intent.toAccountKey
            else { throw BitcoinTransferError.storageUnavailable }
            return draft
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return nil
        } catch {
            throw BitcoinTransferError.storageUnavailable
        }
    }

    func reserve(_ intent: BitcoinTransferIntent) throws {
        if let existing = try load() {
            guard existing.intent == intent, !existing.accepted else {
                throw BitcoinTransferError.pendingTransfer
            }
            return
        }
        try persist(Draft(intent: intent, accepted: false))
    }

    func accept(_ intent: BitcoinTransferIntent) throws {
        guard var existing = try load(), existing.intent == intent else {
            throw BitcoinTransferError.pendingTransfer
        }
        existing.accepted = true
        try persist(existing)
    }

    func retire(_ intent: BitcoinTransferIntent) throws {
        guard let existing = try load(), existing.intent == intent, existing.accepted else {
            throw BitcoinTransferError.pendingTransfer
        }
        do {
            try FileManager.default.removeItem(at: fileURL)
        } catch {
            throw BitcoinTransferError.storageUnavailable
        }
    }

    private func persist(_ draft: Draft) throws {
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700],
            )
            try JSONEncoder().encode(draft).write(to: fileURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
            guard try load() == draft else { throw BitcoinTransferError.storageUnavailable }
        } catch {
            throw BitcoinTransferError.storageUnavailable
        }
    }
}
