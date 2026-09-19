import Foundation
import os

actor StockPriceService {
    static let shared = StockPriceService()
    static let vooPriceKey = "voo_live_price_usd"
    static let ibitPriceKey = "ibit_live_price_usd"
    static let stockUpdatedAtKey = "stock_live_price_updated_at"

    private let quotes: MarketQuoteService
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "StockPrice")

    init(session: URLSession = .shared) {
        quotes = MarketQuoteService(client: ConvexClient(deploymentURL: ConvexConfig.deploymentURL, session: session))
    }

    static var vooPrice: Decimal? { MarketQuoteService.price(.voo) }
    static var ibitPrice: Decimal? { MarketQuoteService.price(.ibit) }

    func refreshAndStore() async {
        do {
            _ = try await quotes.refresh()
            for (symbol, key) in [(MarketQuote.Symbol.voo, Self.vooPriceKey), (.ibit, Self.ibitPriceKey)] {
                if let price = MarketQuoteService.price(symbol) {
                    UserDefaults.standard.set(Double(truncating: price as NSNumber), forKey: key)
                } else {
                    UserDefaults.standard.removeObject(forKey: key)
                }
            }
            // The two symbols can have different timestamps; never invent one combined observation.
            UserDefaults.standard.removeObject(forKey: Self.stockUpdatedAtKey)
        } catch {
            log.warning("Stock quote refresh unavailable")
        }
    }
}
