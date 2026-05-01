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

    private let session: URLSession
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "BTCPrice")

    init(session: URLSession = .shared) {
        self.session = session
    }

    static var storedPrice: Decimal? {
        let value = UserDefaults.standard.double(forKey: priceKey)
        return value > 0 ? Decimal(value) : nil
    }

    static var storedChange24h: Decimal? {
        guard UserDefaults.standard.object(forKey: change24hKey) != nil else { return nil }
        return Decimal(UserDefaults.standard.double(forKey: change24hKey))
    }

    static var storedUpdatedAt: Date? {
        let value = UserDefaults.standard.double(forKey: updatedAtKey)
        return value > 0 ? Date(timeIntervalSince1970: value) : nil
    }

    func refreshAndStore() async {
        do {
            let quote = try await fetchLivePrice()
            await MainActor.run {
                UserDefaults.standard.set(Double(truncating: quote.priceUSD as NSNumber), forKey: Self.priceKey)
                if let change24h = quote.change24h {
                    UserDefaults.standard.set(Double(truncating: change24h as NSNumber), forKey: Self.change24hKey)
                } else {
                    UserDefaults.standard.removeObject(forKey: Self.change24hKey)
                }
                UserDefaults.standard.set(quote.source, forKey: Self.sourceKey)
                UserDefaults.standard.set(quote.fetchedAt.timeIntervalSince1970, forKey: Self.updatedAtKey)
            }
        } catch {
            log.warning("BTC price refresh failed: \(error.localizedDescription)")
        }
    }

    func fetchLivePrice() async throws -> BTCPriceQuote {
        if let quote = try? await fetchMC2Price() { return quote }
        if let quote = try? await fetchCoinGeckoPrice() { return quote }
        return try await fetchCoinbasePrice()
    }

    private func fetchMC2Price() async throws -> BTCPriceQuote {
        let url = URL(string: "https://sats21m.com/api/price/btc")!
        let payload = try await fetchJSON(url)
        guard let price = numberDecimal(payload["price"]) else {
            throw PriceError.invalidResponse("MC2 price missing")
        }
        return BTCPriceQuote(
            priceUSD: price,
            change24h: numberDecimal(payload["change24h"]),
            source: "MC2",
            fetchedAt: Date()
        )
    }

    private func fetchCoinGeckoPrice() async throws -> BTCPriceQuote {
        let url = URL(string: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true")!
        let payload = try await fetchJSON(url)
        guard let bitcoin = payload["bitcoin"] as? [String: Any],
              let price = numberDecimal(bitcoin["usd"]) else {
            throw PriceError.invalidResponse("CoinGecko price missing")
        }
        return BTCPriceQuote(
            priceUSD: price,
            change24h: numberDecimal(bitcoin["usd_24h_change"]),
            source: "CoinGecko",
            fetchedAt: Date()
        )
    }

    private func fetchCoinbasePrice() async throws -> BTCPriceQuote {
        let url = URL(string: "https://api.coinbase.com/v2/prices/BTC-USD/spot")!
        let payload = try await fetchJSON(url)
        guard let data = payload["data"] as? [String: Any],
              let price = numberDecimal(data["amount"]) else {
            throw PriceError.invalidResponse("Coinbase price missing")
        }
        return BTCPriceQuote(
            priceUSD: price,
            change24h: nil,
            source: "Coinbase",
            fetchedAt: Date()
        )
    }

    private func fetchJSON(_ url: URL) async throws -> [String: Any] {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PriceError.invalidResponse("No HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw PriceError.httpStatus(http.statusCode)
        }
        guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PriceError.invalidResponse("JSON root was not an object")
        }
        return payload
    }

    private func numberDecimal(_ value: Any?) -> Decimal? {
        if let number = value as? NSNumber { return Decimal(number.doubleValue) }
        if let string = value as? String { return Decimal(string: string) }
        return nil
    }

    enum PriceError: LocalizedError {
        case httpStatus(Int)
        case invalidResponse(String)

        var errorDescription: String? {
            switch self {
            case .httpStatus(let code): return "Price API returned HTTP \(code)"
            case .invalidResponse(let message): return message
            }
        }
    }
}
