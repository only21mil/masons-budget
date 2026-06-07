import Foundation
import os

actor StockPriceService {
    static let shared = StockPriceService()

    static let vooPriceKey = "voo_live_price_usd"
    static let ibitPriceKey = "ibit_live_price_usd"
    static let stockUpdatedAtKey = "stock_live_price_updated_at"

    private let session: URLSession
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "StockPrice")

    init(session: URLSession = .shared) {
        self.session = session
    }

    static var vooPrice: Decimal? {
        let value = UserDefaults.standard.double(forKey: vooPriceKey)
        return value > 0 ? Decimal(value) : nil
    }

    static var ibitPrice: Decimal? {
        let value = UserDefaults.standard.double(forKey: ibitPriceKey)
        return value > 0 ? Decimal(value) : nil
    }

    func refreshAndStore() async {
        async let voo: () = fetchAndStore("voo", key: Self.vooPriceKey)
        async let ibit: () = fetchAndStore("ibit", key: Self.ibitPriceKey)
        _ = await (voo, ibit)
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.stockUpdatedAtKey)
    }

    private func fetchAndStore(_ ticker: String, key: String) async {
        do {
            let price = try await fetchPrice(ticker)
            await MainActor.run {
                UserDefaults.standard.set(Double(truncating: price as NSNumber), forKey: key)
            }
        } catch {
            log.warning("\(ticker) price refresh failed: \(error.localizedDescription)")
        }
    }

    func fetchPrice(_ ticker: String) async throws -> Decimal {
        if let quote = try? await fetchMC2Price(ticker) { return quote }
        return try await fetchYahooPrice(ticker)
    }

    private func fetchMC2Price(_ ticker: String) async throws -> Decimal {
        let url = URL(string: "https://sats21m.com/api/price/\(ticker)")!
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let price = json?["price"] as? Double, price > 0 else {
            throw URLError(.cannotParseResponse)
        }
        return Decimal(price)
    }

    private func fetchYahooPrice(_ ticker: String) async throws -> Decimal {
        let url = URL(string: "https://query1.finance.yahoo.com/v8/finance/chart/\(ticker.uppercased())?interval=1m&range=1d")!
        var request = URLRequest(url: url)
        request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let chart = json?["chart"] as? [String: Any],
              let result = (chart["result"] as? [[String: Any]])?.first,
              let meta = result["meta"] as? [String: Any],
              let price = meta["regularMarketPrice"] as? Double, price > 0
        else {
            throw URLError(.cannotParseResponse)
        }
        return Decimal(price)
    }
}
