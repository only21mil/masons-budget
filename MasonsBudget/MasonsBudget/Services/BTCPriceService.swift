import Foundation
import os

struct BTCPriceQuote: Equatable {
    let priceUSD: Decimal
    let change24h: Decimal?
    let source: String
    let fetchedAt: Date
}

actor BTCPriceService {
    static let shared = BTCPriceService()
    static let priceKey = "btc_live_price_usd"
    static let change24hKey = "btc_live_price_change_24h"
    static let sourceKey = "btc_live_price_source"
    static let updatedAtKey = "btc_live_price_updated_at"
    // Legacy callers still accept a numeric fallback. Finance screens require a usable quote.
    static let fallbackPriceUSD: Decimal = 104_000

    private let quotes: MarketQuoteService
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "BTCPrice")

    init(session: URLSession = .shared) {
        quotes = MarketQuoteService(client: ConvexClient(deploymentURL: ConvexConfig.deploymentURL, session: session))
    }

    static var storedPrice: Decimal? { MarketQuoteService.price(.btc) }
    static var storedChange24h: Decimal? { nil }
    static var storedUpdatedAt: Date? { MarketQuoteService.quote(.btc)?.observationDate }

    func refreshAndStore() async {
        do {
            let quote = try await fetchLivePrice()
            UserDefaults.standard.set(Double(truncating: quote.priceUSD as NSNumber), forKey: Self.priceKey)
            UserDefaults.standard.removeObject(forKey: Self.change24hKey)
            UserDefaults.standard.set(quote.source, forKey: Self.sourceKey)
            UserDefaults.standard.set(quote.fetchedAt.timeIntervalSince1970, forKey: Self.updatedAtKey)
        } catch {
            log.warning("Bitcoin quote refresh unavailable")
            // Never stamp failed acquisition as fresh. The snapshot retains its source timestamp.
            if Self.storedPrice == nil {
                UserDefaults.standard.removeObject(forKey: Self.priceKey)
                UserDefaults.standard.removeObject(forKey: Self.updatedAtKey)
            }
        }
    }

    func fetchLivePrice() async throws -> BTCPriceQuote {
        let snapshot = try await quotes.refresh()
        guard let quote = try usableMarketQuote(snapshot.quotes, symbol: .btc),
              quote.effectiveStatus() != .unavailable,
              let cents = quote.priceCents, let fetchedAt = quote.observationDate
        else { throw MarketQuoteError.unavailable }
        return BTCPriceQuote(priceUSD: decimalMinorUnits(cents, scale: 2), change24h: nil,
                             source: quote.source, fetchedAt: fetchedAt)
    }
}
