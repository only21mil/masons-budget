import Foundation

final class MC2Writer {
    let baseURL: URL
    let user: FamilyMember
    private let fileManager = FileManager.default
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()

    init(baseURL: URL, user: FamilyMember) {
        self.baseURL = baseURL
        self.user = user
    }

    // MARK: - Append-only writes

    func appendTransaction(_ dto: MC2Transaction) async throws -> URL {
        let folder = baseURL.appendingPathComponent("transactions")
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
        let filename = "tx-\(dto.date)-\(user)-\(Self.nanoid(length: 12)).json"
        let url = folder.appendingPathComponent(filename)
        try await writeJSON(dto, to: url)
        return url
    }

    func appendBTCBuy(_ dto: MC2BTCBuy) async throws -> URL {
        let folder = baseURL.appendingPathComponent("bitcoin-buys")
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
        let filename = "buy-\(dto.date)-\(Self.nanoid(length: 12)).json"
        let url = folder.appendingPathComponent(filename)
        try await writeJSON(dto, to: url)
        return url
    }

    func appendBTCBillPay(_ dto: MC2BTCBillPay) async throws -> URL {
        let folder = baseURL.appendingPathComponent("bitcoin-bill-pays")
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
        let filename = "bp-\(dto.date)-\(Self.nanoid(length: 12)).json"
        let url = folder.appendingPathComponent(filename)
        try await writeJSON(dto, to: url)
        return url
    }

    // MARK: - Snapshot writes

    func writeBTCSnapshot(_ snapshot: MC2BTCSnapshot) async throws {
        try await writeAtomic(snapshot, toFile: "btc-balance-snapshot.json")
    }

    func writeBillPays(_ wrapper: MC2BillPaysWrapper) async throws {
        try await writeAtomic(wrapper, toFile: "bitcoin-bill-pays.json")
    }

    func writeAtomic<T: Encodable>(_ value: T, toFile filename: String) async throws {
        let targetURL = baseURL.appendingPathComponent(filename)
        let tmpURL = targetURL.appendingPathExtension("tmp")
        let data = try encoder.encode(value)

        if fileManager.fileExists(atPath: tmpURL.path) {
            try fileManager.removeItem(at: tmpURL)
        }

        try data.write(to: tmpURL, options: .atomic)
        if fileManager.fileExists(atPath: targetURL.path) {
            try fileManager.removeItem(at: targetURL)
        }
        try fileManager.moveItem(at: tmpURL, to: targetURL)
    }

    // MARK: - Helpers

    private func writeJSON<T: Encodable>(_ value: T, to url: URL) async throws {
        let data = try encoder.encode(value)
        try data.write(to: url, options: .atomic)
    }

    // MARK: - DTO converters

    static func dto(from tx: Transaction) -> MC2Transaction {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(secondsFromGMT: 0)

        return MC2Transaction(
            id: tx.id,
            date: df.string(from: tx.date),
            merchant: tx.merchant,
            amount: tx.amount,
            category: tx.category,
            card: tx.card ?? "",
            note: tx.note ?? ""
        )
    }

    static func dto(from buy: BTCBuy) -> MC2BTCBuy {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(secondsFromGMT: 0)

        return MC2BTCBuy(
            id: buy.id,
            date: df.string(from: buy.date),
            source: buy.source,
            amountSats: buy.amountSats,
            amountBtc: buy.amountBTC,
            priceUsd: buy.priceUSD,
            usd: buy.usd,
            note: buy.note,
            status: buy.status,
            costBasisStatus: buy.costBasisStatus,
            loggedBy: buy.loggedBy,
            archimedesRequestId: buy.archimedesRequestId
        )
    }

    static func dto(from pay: BTCBillPay) -> MC2BTCBillPay {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(secondsFromGMT: 0)

        return MC2BTCBillPay(
            id: pay.id,
            date: df.string(from: pay.date),
            merchant: pay.merchant,
            category: pay.category,
            amountUsd: pay.amountUSD,
            btcSpent: pay.btcSpent,
            btcPrice: pay.btcPrice,
            platform: pay.platform,
            note: pay.note ?? "",
            feeUsd: pay.feeUSD,
            reference: pay.reference
        )
    }

    // MARK: - Nanoid

    static func nanoid(length: Int = 21) -> String {
        let chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
        return String((0..<length).map { _ in chars.randomElement()! })
    }
}
