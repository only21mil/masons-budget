import Foundation

actor MarketQuoteService {
    static let shared = MarketQuoteService()
    static let cacheKey = "market_quote_snapshot_v1"
    private let client: ConvexClient

    init(client: ConvexClient? = nil) {
        self.client = client ?? ConvexClient(deploymentURL: ConvexConfig.deploymentURL)
    }

    func refresh() async throws -> MarketQuoteSnapshot {
        let snapshot = try await client.fetchRows(.marketQuotes, as: MarketQuoteSnapshot.self).validated()
        UserDefaults.standard.set(try JSONEncoder().encode(snapshot), forKey: Self.cacheKey)
        return snapshot
    }

    static func quote(_ symbol: MarketQuote.Symbol, now: Date = Date()) -> MarketQuote? {
        guard let data = UserDefaults.standard.data(forKey: cacheKey),
              let snapshot = try? JSONDecoder().decode(MarketQuoteSnapshot.self, from: data).validated(),
              let quote = try? usableMarketQuote(snapshot.quotes, symbol: symbol),
              quote.effectiveStatus(now: now) != .unavailable
        else { return nil }
        return quote
    }

    static func price(_ symbol: MarketQuote.Symbol) -> Decimal? {
        quote(symbol)?.priceCents.map { decimalMinorUnits($0, scale: 2) }
    }

    static func label(_ symbol: MarketQuote.Symbol, now: Date = Date()) -> String {
        guard let quote = quote(symbol, now: now), let date = quote.observationDate else {
            return "\(symbol.rawValue) price unavailable"
        }
        let status = quote.effectiveStatus(now: now) == .live ? "Live" : "Stale"
        return "\(symbol.rawValue) · \(quote.source) · \(status) · \(date.formatted(date: .abbreviated, time: .shortened))"
    }
}
