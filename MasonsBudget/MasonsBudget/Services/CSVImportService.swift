import Foundation
import SwiftData

enum ImportSource: String, CaseIterable, Identifiable {
    case strike = "Strike"
    case cashApp = "Cash App"
    case coinbase = "Coinbase"
    case kraken = "Kraken"
    case selfCustody = "Self-Custody Node"
    case custom = "Custom CSV"

    var id: String { rawValue }
}

struct ColumnMapping {
    var dateIndex: Int?
    var amountIndex: Int?
    var memoIndex: Int?
    var typeIndex: Int?
    var feeIndex: Int?
}

struct ImportedTransaction: Identifiable {
    let id = UUID()
    let date: Date
    let merchant: String
    let sats: Int64
    let amountUsd: Decimal
    let category: String
    let method: String
    let isIncome: Bool
    let note: String?
}

enum CSVImportError: LocalizedError {
    case emptyFile
    case noHeaderRow
    case missingRequiredColumns
    case dateParseFailure(row: Int)
    case amountParseFailure(row: Int)

    var errorDescription: String? {
        switch self {
        case .emptyFile: "CSV file is empty"
        case .noHeaderRow: "No header row found"
        case .missingRequiredColumns: "Required columns (date, amount) not found"
        case .dateParseFailure(let row): "Could not parse date on row \(row)"
        case .amountParseFailure(let row): "Could not parse amount on row \(row)"
        }
    }
}

final class CSVImportService: Sendable {

    // MARK: - Public API

    func parseCSV(data: Data, source: ImportSource) throws -> [ImportedTransaction] {
        guard let content = String(data: data, encoding: .utf8), !content.isEmpty else {
            throw CSVImportError.emptyFile
        }

        var lines = content.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        guard !lines.isEmpty else { throw CSVImportError.emptyFile }

        let headerLine = lines.removeFirst()
        let headers = parseRow(headerLine)

        let mapping: ColumnMapping
        switch source {
        case .strike:
            mapping = mapStrike(headers: headers)
        case .cashApp:
            mapping = mapCashApp(headers: headers)
        case .coinbase:
            mapping = mapCoinbase(headers: headers)
        case .kraken:
            mapping = mapKraken(headers: headers)
        case .selfCustody, .custom:
            mapping = autoDetectColumns(headers: headers)
        }

        guard mapping.dateIndex != nil, mapping.amountIndex != nil else {
            throw CSVImportError.missingRequiredColumns
        }

        var results: [ImportedTransaction] = []
        for (idx, line) in lines.enumerated() {
            let cols = parseRow(line)
            guard let dateIdx = mapping.dateIndex, dateIdx < cols.count,
                  let amtIdx = mapping.amountIndex, amtIdx < cols.count else { continue }

            guard let date = parseDate(cols[dateIdx]) else {
                throw CSVImportError.dateParseFailure(row: idx + 2)
            }

            let rawAmount = cols[amtIdx]
                .replacingOccurrences(of: ",", with: "")
                .replacingOccurrences(of: "$", with: "")
                .replacingOccurrences(of: " ", with: "")

            guard let amount = Decimal(string: rawAmount) else {
                throw CSVImportError.amountParseFailure(row: idx + 2)
            }

            let memo: String = {
                if let mIdx = mapping.memoIndex, mIdx < cols.count {
                    return sanitize(cols[mIdx])
                }
                return ""
            }()

            let sats = convertToSats(amount: amount, source: source)
            let isIncome = sats > 0
            let category = guessCategory(memo: memo)

            results.append(ImportedTransaction(
                date: date,
                merchant: memo.isEmpty ? source.rawValue : memo,
                sats: sats,
                amountUsd: usdValue(fromSats: sats),
                category: category,
                method: "on-chain",
                isIncome: isIncome,
                note: nil
            ))
        }

        return results
    }

    func autoDetectColumns(headers: [String]) -> ColumnMapping {
        var mapping = ColumnMapping()
        let lower = headers.map { $0.lowercased() }

        for (i, h) in lower.enumerated() {
            if mapping.dateIndex == nil && (h.contains("date") || h.contains("time")) {
                mapping.dateIndex = i
            } else if mapping.amountIndex == nil && (h.contains("amount") || h.contains("qty") || h.contains("quantity") || h.contains("sats") || h.contains("btc")) {
                mapping.amountIndex = i
            } else if mapping.memoIndex == nil && (h.contains("memo") || h.contains("note") || h.contains("description") || h.contains("merchant") || h.contains("narrative")) {
                mapping.memoIndex = i
            } else if mapping.typeIndex == nil && h.contains("type") {
                mapping.typeIndex = i
            } else if mapping.feeIndex == nil && h.contains("fee") {
                mapping.feeIndex = i
            }
        }

        return mapping
    }

    func guessCategory(memo: String) -> String {
        let m = memo.lowercased()
        let map: [(keywords: [String], category: String)] = [
            (["rent", "mortgage", "landlord"], "Housing"),
            (["grocery", "costco", "walmart", "trader joe", "whole foods", "safeway", "kroger"], "Groceries"),
            (["pharmacy", "cvs", "walgreens", "medicine", "rx"], "Health"),
            (["uber", "lyft", "gas", "shell", "chevron", "parking", "transit"], "Transport"),
            (["restaurant", "doordash", "grubhub", "chipotle", "mcdonald", "starbucks", "coffee"], "Dining"),
            (["netflix", "spotify", "hulu", "disney", "apple tv", "youtube"], "Entertainment"),
            (["electric", "water", "internet", "comcast", "verizon", "tmobile", "at&t"], "Utilities"),
            (["amazon", "target", "bestbuy", "apple.com"], "Shopping"),
            (["salary", "payroll", "direct deposit", "income"], "Income"),
            (["btc", "bitcoin", "sats", "lightning", "strike"], "Bitcoin"),
        ]

        for entry in map {
            if entry.keywords.contains(where: { m.contains($0) }) {
                return entry.category
            }
        }
        return "Other"
    }

    func convertToSats(amount: Decimal, source: ImportSource) -> Int64 {
        switch source {
        case .strike, .coinbase, .cashApp:
            return Int64(truncating: (amount * 100_000_000) as NSNumber)
        case .kraken, .selfCustody, .custom:
            let absVal = abs(Double(truncating: amount as NSNumber))
            if absVal < 1 {
                return Int64(truncating: (amount * 100_000_000) as NSNumber)
            } else {
                return Int64(truncating: amount as NSNumber)
            }
        }
    }

    // MARK: - Duplicate Detection

    func filterDuplicates(
        _ imported: [ImportedTransaction],
        existing: [Transaction]
    ) -> [ImportedTransaction] {
        let existingKeys = Set(existing.map { duplicateKey(date: $0.date, sats: $0.satsValue(), merchant: $0.merchant) })
        return imported.filter { tx in
            let key = duplicateKey(date: tx.date, sats: Decimal(tx.sats), merchant: tx.merchant)
            return !existingKeys.contains(key)
        }
    }

    // MARK: - Conversion to Transaction

    func toTransactions(
        _ imported: [ImportedTransaction],
        owner: FamilyMember,
        sourceTag: String
    ) -> [Transaction] {
        imported.map { tx in
            Transaction(
                id: UUID().uuidString,
                date: tx.date,
                merchant: tx.merchant,
                amount: tx.amountUsd,
                category: tx.category,
                amountSats: tx.sats,
                note: tx.note,
                owner: owner,
                createdBy: "csv_import",
                sourceFile: sourceTag
            )
        }
    }

    // MARK: - Private Helpers

    private func parseRow(_ line: String) -> [String] {
        var fields: [String] = []
        var current = ""
        var inQuotes = false

        for char in line {
            if char == "\"" {
                inQuotes.toggle()
            } else if char == "," && !inQuotes {
                fields.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(char)
            }
        }
        fields.append(current.trimmingCharacters(in: .whitespaces))
        return fields
    }

    private func sanitize(_ input: String) -> String {
        input
            .replacingOccurrences(of: "<", with: "")
            .replacingOccurrences(of: ">", with: "")
            .replacingOccurrences(of: "&", with: "and")
            .prefix(200)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func duplicateKey(date: Date, sats: Decimal, merchant: String) -> String {
        let cal = Calendar.current
        let day = cal.startOfDay(for: date)
        return "\(day.timeIntervalSince1970)-\(sats)-\(merchant.lowercased().prefix(20))"
    }

    private func usdValue(fromSats sats: Int64) -> Decimal {
        let price = BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice
        return (Decimal(sats) / 100_000_000) * price
    }

    private static let dateFormatters: [DateFormatter] = {
        let formats = [
            "yyyy-MM-dd'T'HH:mm:ss",
            "yyyy-MM-dd'T'HH:mm:ssZ",
            "yyyy-MM-dd HH:mm:ss",
            "yyyy-MM-dd",
            "MM/dd/yyyy",
            "MM/dd/yyyy HH:mm:ss",
            "M/d/yyyy",
            "dd/MM/yyyy",
        ]
        return formats.map { fmt in
            let f = DateFormatter()
            f.dateFormat = fmt
            f.locale = Locale(identifier: "en_US_POSIX")
            return f
        }
    }()

    private func parseDate(_ string: String) -> Date? {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        for formatter in Self.dateFormatters {
            if let date = formatter.date(from: trimmed) {
                return date
            }
        }
        return nil
    }

    // MARK: - Source-Specific Column Mappings

    private func mapStrike(headers: [String]) -> ColumnMapping {
        let lower = headers.map { $0.lowercased() }
        return ColumnMapping(
            dateIndex: lower.firstIndex(where: { $0.contains("date") }),
            amountIndex: lower.firstIndex(where: { $0.contains("amount") || $0.contains("btc") }),
            memoIndex: lower.firstIndex(where: { $0.contains("memo") || $0.contains("description") }),
            typeIndex: lower.firstIndex(where: { $0.contains("type") }),
            feeIndex: nil
        )
    }

    private func mapCashApp(headers: [String]) -> ColumnMapping {
        let lower = headers.map { $0.lowercased() }
        return ColumnMapping(
            dateIndex: lower.firstIndex(where: { $0.contains("date") }),
            amountIndex: lower.firstIndex(where: { $0.contains("asset amount") || $0.contains("amount") }),
            memoIndex: lower.firstIndex(where: { $0.contains("notes") || $0.contains("note") }),
            typeIndex: nil,
            feeIndex: lower.firstIndex(where: { $0.contains("fee") })
        )
    }

    private func mapCoinbase(headers: [String]) -> ColumnMapping {
        let lower = headers.map { $0.lowercased() }
        return ColumnMapping(
            dateIndex: lower.firstIndex(where: { $0.contains("timestamp") || $0.contains("date") }),
            amountIndex: lower.firstIndex(where: { $0.contains("quantity") || $0.contains("amount") }),
            memoIndex: lower.firstIndex(where: { $0.contains("notes") || $0.contains("type") }),
            typeIndex: lower.firstIndex(where: { $0.contains("type") || $0.contains("transaction type") }),
            feeIndex: lower.firstIndex(where: { $0.contains("fee") })
        )
    }

    private func mapKraken(headers: [String]) -> ColumnMapping {
        let lower = headers.map { $0.lowercased() }
        return ColumnMapping(
            dateIndex: lower.firstIndex(where: { $0.contains("time") || $0.contains("date") }),
            amountIndex: lower.firstIndex(where: { $0.contains("amount") || $0.contains("vol") }),
            memoIndex: lower.firstIndex(where: { $0.contains("type") }),
            typeIndex: lower.firstIndex(where: { $0.contains("type") }),
            feeIndex: lower.firstIndex(where: { $0.contains("fee") })
        )
    }
}
