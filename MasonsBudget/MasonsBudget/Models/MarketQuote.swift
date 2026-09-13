import Foundation

/// Same closed symbol and usability contract as shared/domain/src/finance.ts.
struct MarketQuote: Codable, Equatable, Sendable {
    enum Symbol: String, Codable, CaseIterable, Sendable { case btc = "BTC", voo = "VOO", ibit = "IBIT" }
    enum Status: String, Codable, Sendable { case live, stale, unavailable }

    let symbol: Symbol
    let priceCents: Int64?
    let source: String
    let fetchedAt: String?
    let status: Status

    var observationDate: Date? {
        guard let fetchedAt,
              fetchedAt.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$"#, options: .regularExpression) != nil
        else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = fetchedAt.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        guard let date = formatter.date(from: fetchedAt), formatter.string(from: date) == fetchedAt else { return nil }
        return date
    }

    func validated() throws -> Self {
        guard !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw MarketQuoteError.invalidSnapshot }
        if status == .unavailable {
            guard priceCents == nil else { throw MarketQuoteError.invalidSnapshot }
        } else {
            guard let priceCents, priceCents > 0, observationDate != nil else { throw MarketQuoteError.invalidSnapshot }
        }
        return self
    }

    func effectiveStatus(now: Date = Date()) -> Status {
        guard status != .unavailable, let date = observationDate else { return .unavailable }
        let age = now.timeIntervalSince(date)
        guard age >= 0, age <= 24 * 60 * 60 else { return .unavailable }
        return status == .stale || age >= 15 * 60 ? .stale : .live
    }
}

struct MarketQuoteSnapshot: Codable, Sendable {
    let quotes: [MarketQuote]
    let complete: Bool

    func validated() throws -> Self {
        guard complete, quotes.count == MarketQuote.Symbol.allCases.count,
              Set(quotes.map(\.symbol)).count == quotes.count
        else { throw MarketQuoteError.invalidSnapshot }
        for quote in quotes { _ = try quote.validated() }
        return self
    }
}

enum MarketQuoteError: Error { case invalidSnapshot, unavailable }

/// Parity with usableMarketQuote. Cache age is applied separately at the store boundary.
func usableMarketQuote(_ quotes: [MarketQuote], symbol: MarketQuote.Symbol) throws -> MarketQuote? {
    guard let quote = quotes.first(where: { $0.symbol == symbol }) else { return nil }
    _ = try quote.validated()
    return quote.status == .unavailable ? nil : quote
}
