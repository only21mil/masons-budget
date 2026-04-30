// Mason's Budget App — MC2Writer tests (SAT-309)
//
// Uses a tmp directory per test so iCloud isn't required. The Writer's
// NSFileCoordinator wrapper is a transparent pass-through outside iCloud.

import XCTest
import Foundation

final class MC2WriterTests: XCTestCase {
    private var tmpDir: URL!

    override func setUpWithError() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("MC2WriterTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        tmpDir = dir
    }

    override func tearDownWithError() throws {
        if let dir = tmpDir, FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.removeItem(at: dir)
        }
        tmpDir = nil
    }

    // MARK: - Helpers

    private func ymd(_ s: String) -> Date {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.date(from: s)!
    }

    private func decodeFile<T: Decodable>(_ url: URL, as type: T.Type) throws -> T {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(type, from: data)
    }

    // MARK: - appendTransaction

    func testAppendTransaction_CreatesSubfolderAndFile() async throws {
        let writer = MC2Writer(baseURL: tmpDir, user: .mason)
        let dto = MC2Transaction(
            id: "t-2026-04-30-test",
            date: "2026-04-30",
            merchant: "Costco",
            amount: Decimal(string: "45.99")!,
            category: "Groceries",
            card: "Aven",
            note: ""
        )

        let url = try await writer.appendTransaction(dto)

        let folder = tmpDir.appendingPathComponent("transactions")
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        XCTAssertTrue(url.lastPathComponent.hasPrefix("tx-2026-04-30-mason-"))
        XCTAssertTrue(url.lastPathComponent.hasSuffix(".json"))
    }

    func testAppendTransaction_RoundTripsThroughDecoder() async throws {
        let writer = MC2Writer(baseURL: tmpDir, user: .victor)
        let dto = MC2Transaction(
            id: "tx-abc",
            date: "2026-04-15",
            merchant: "Kroger",
            amount: Decimal(string: "76.81")!,
            category: "Groceries",
            card: "Aven",
            note: "weekly run"
        )

        let url = try await writer.appendTransaction(dto)
        let decoded = try decodeFile(url, as: MC2Transaction.self)

        XCTAssertEqual(decoded.id, "tx-abc")
        XCTAssertEqual(decoded.merchant, "Kroger")
        XCTAssertEqual(decoded.amount, Decimal(string: "76.81"))
        XCTAssertEqual(decoded.date, "2026-04-15")
        XCTAssertEqual(decoded.card, "Aven")
        XCTAssertEqual(decoded.note, "weekly run")
    }

    func testAppendTransaction_TwoCallsTwoUniqueFiles() async throws {
        let writer = MC2Writer(baseURL: tmpDir, user: .mason)
        let dto1 = MC2Transaction(id: "t1", date: "2026-04-30", merchant: "Costco", amount: 5, category: "Groceries", card: "", note: "")
        let dto2 = MC2Transaction(id: "t2", date: "2026-04-30", merchant: "Costco", amount: 6, category: "Groceries", card: "", note: "")

        let url1 = try await writer.appendTransaction(dto1)
        let url2 = try await writer.appendTransaction(dto2)

        XCTAssertNotEqual(url1, url2, "Each append should produce a distinct file")
        let folder = tmpDir.appendingPathComponent("transactions")
        let files = try FileManager.default.contentsOfDirectory(atPath: folder.path)
        XCTAssertEqual(files.count, 2)
    }

    func testAppendTransaction_UserAppearsInFilename() async throws {
        let writer = MC2Writer(baseURL: tmpDir, user: .maddox)
        let dto = MC2Transaction(id: "x", date: "2026-04-30", merchant: "X", amount: 1, category: "Y", card: "", note: "")
        let url = try await writer.appendTransaction(dto)
        XCTAssertTrue(url.lastPathComponent.contains("-maddox-"))
    }

    // MARK: - appendBTCBuy

    func testAppendBTCBuy_FilenameAndPayload() async throws {
        let writer = MC2Writer(baseURL: tmpDir, user: .victor)
        let dto = MC2BTCBuy(
            id: "b-strike-2026-04-30",
            date: "2026-04-30",
            source: "Strike",
            amountSats: 52000,
            amountBtc: Decimal(string: "0.00052")!,
            priceUsd: Decimal(string: "95000")!,
            usd: Decimal(string: "49.40")!,
            note: "Direct deposit auto-buy",
            status: "complete",
            costBasisStatus: "complete",
            loggedBy: "user-screenshot",
            archimedesRequestId: nil
        )

        let url = try await writer.appendBTCBuy(dto)

        XCTAssertTrue(url.lastPathComponent.hasPrefix("buy-2026-04-30-"))
        XCTAssertTrue(url.lastPathComponent.hasSuffix(".json"))
        let decoded = try decodeFile(url, as: MC2BTCBuy.self)
        XCTAssertEqual(decoded.id, "b-strike-2026-04-30")
        XCTAssertEqual(decoded.amountSats, 52000)
        XCTAssertEqual(decoded.source, "Strike")
        XCTAssertEqual(decoded.usd, Decimal(string: "49.40"))
    }

    // MARK: - appendBTCBillPay

    func testAppendBillPay_FilenameAndPayload() async throws {
        let writer = MC2Writer(baseURL: tmpDir, user: .victor)
        let dto = MC2BTCBillPay(
            id: "bp-mortgage-2026-04",
            date: "2026-04-15",
            merchant: "PennyMac",
            category: "Bills & Utilities",
            amountUsd: Decimal(string: "3613.79")!,
            btcSpent: Decimal(string: "0.05425107")!,
            btcPrice: Decimal(string: "66612.33")!,
            platform: "Strike",
            note: "Monthly mortgage",
            feeUsd: Decimal(string: "28.55")!,
            reference: nil
        )

        let url = try await writer.appendBTCBillPay(dto)

        XCTAssertTrue(url.lastPathComponent.hasPrefix("bp-2026-04-15-"))
        let decoded = try decodeFile(url, as: MC2BTCBillPay.self)
        XCTAssertEqual(decoded.merchant, "PennyMac")
        XCTAssertEqual(decoded.amountUsd, Decimal(string: "3613.79"))
        XCTAssertEqual(decoded.platform, "Strike")
        XCTAssertEqual(decoded.feeUsd, Decimal(string: "28.55"))
    }

    // MARK: - Atomic snapshots

    func testWriteBTCSnapshot_CreatesFile() async throws {
        let writer = MC2Writer(baseURL: tmpDir, user: .victor)
        let snapshot = MC2BTCSnapshot(
            schemaVersion: 1,
            asOf: "2026-04-30",
            accounts: [
                "strike": MC2BTCAccountEntry(btc: Decimal(string: "0.00874765")!, fiat: 0, label: "Strike", custody: "exchange"),
                "coldcard": MC2BTCAccountEntry(btc: Decimal(string: "4.51718914")!, fiat: 0, label: "Coldcard", custody: "self_custody"),
            ],
            totals: MC2BTCTotals(
                btc: Decimal(string: "4.52593679")!,
                fiat: 0,
                exchangeBtc: Decimal(string: "0.00874765")!,
                selfCustodyBtc: Decimal(string: "4.51718914")!
            ),
            metadata: nil,
            totalSats: nil,
            totalBtc: nil,
            totalUsdInvested: nil
        )

        try await writer.writeBTCSnapshot(snapshot)

        let target = tmpDir.appendingPathComponent("btc-balance-snapshot.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))
        let decoded = try decodeFile(target, as: MC2BTCSnapshot.self)
        XCTAssertEqual(decoded.schemaVersion, 1)
        XCTAssertEqual(decoded.accounts.count, 2)
        XCTAssertEqual(decoded.accounts["coldcard"]?.custody, "self_custody")
    }

    func testWriteBTCSnapshot_OverwritesExisting() async throws {
        let writer = MC2Writer(baseURL: tmpDir, user: .victor)
        let zero = MC2BTCTotals(btc: 0, fiat: 0, exchangeBtc: 0, selfCustodyBtc: 0)
        let v1 = MC2BTCSnapshot(schemaVersion: 1, asOf: "2026-04-29", accounts: [:], totals: zero, metadata: nil, totalSats: nil, totalBtc: nil, totalUsdInvested: nil)
        let v2 = MC2BTCSnapshot(schemaVersion: 1, asOf: "2026-04-30", accounts: [:], totals: zero, metadata: nil, totalSats: nil, totalBtc: nil, totalUsdInvested: nil)

        try await writer.writeBTCSnapshot(v1)
        try await writer.writeBTCSnapshot(v2)

        let decoded = try decodeFile(
            tmpDir.appendingPathComponent("btc-balance-snapshot.json"),
            as: MC2BTCSnapshot.self
        )
        XCTAssertEqual(decoded.asOf, "2026-04-30")
    }

    func testWriteAtomic_NoTmpFileLeftBehind() async throws {
        let writer = MC2Writer(baseURL: tmpDir, user: .victor)
        struct Tiny: Codable { let x: Int }
        try await writer.writeAtomic(Tiny(x: 42), toFile: "test.json")

        let entries = try FileManager.default.contentsOfDirectory(atPath: tmpDir.path)
        XCTAssertTrue(entries.contains("test.json"))
        // .atomic write is supposed to leave only the final file behind.
        let leftover = entries.filter { $0 != "test.json" && !$0.hasPrefix(".") }
        XCTAssertTrue(leftover.isEmpty, "Unexpected files left behind: \(leftover)")
    }

    func testWriteBillPaysWrapper() async throws {
        let writer = MC2Writer(baseURL: tmpDir, user: .victor)
        let wrapper = MC2BillPaysWrapper(billPays: [
            MC2BTCBillPay(
                id: "bp1",
                date: "2026-04-15",
                merchant: "PennyMac",
                category: "Bills & Utilities",
                amountUsd: 2800,
                btcSpent: Decimal(string: "0.029")!,
                btcPrice: 96551,
                platform: "Strike",
                note: "",
                feeUsd: nil,
                reference: nil
            )
        ])

        try await writer.writeBillPays(wrapper)
        let decoded = try decodeFile(
            tmpDir.appendingPathComponent("bitcoin-bill-pays.json"),
            as: MC2BillPaysWrapper.self
        )
        XCTAssertEqual(decoded.billPays.count, 1)
        XCTAssertEqual(decoded.billPays[0].merchant, "PennyMac")
    }

    // MARK: - SwiftData model → DTO converters

    func testDtoFromTransaction_FormatsFields() {
        let tx = Transaction(
            id: "t-1",
            date: ymd("2026-04-30"),
            merchant: "Costco",
            amount: Decimal(string: "45.99")!,
            category: "Groceries",
            card: "Aven",
            note: "weekly run",
            createdBy: "mason"
        )

        let dto = MC2Writer.dto(from: tx)

        XCTAssertEqual(dto.id, "t-1")
        XCTAssertEqual(dto.date, "2026-04-30")
        XCTAssertEqual(dto.merchant, "Costco")
        XCTAssertEqual(dto.amount, Decimal(string: "45.99"))
        XCTAssertEqual(dto.card, "Aven")
        XCTAssertEqual(dto.note, "weekly run")
    }

    func testDtoFromTransaction_NilOptionalsBecomeEmptyStrings() {
        let tx = Transaction(
            id: "t-2",
            date: ymd("2026-04-30"),
            merchant: "X",
            amount: 1,
            category: "Y",
            createdBy: "victor"
        )
        let dto = MC2Writer.dto(from: tx)
        XCTAssertEqual(dto.card, "")
        XCTAssertEqual(dto.note, "")
    }

    func testDtoFromBTCBuy() {
        let buy = BTCBuy(
            id: "b-strike-2026-04-30",
            date: ymd("2026-04-30"),
            source: "Strike",
            amountBTC: Decimal(string: "0.00052")!,
            amountSats: 52000,
            priceUSD: Decimal(string: "95000")!,
            usd: Decimal(string: "49.40")!
        )
        let dto = MC2Writer.dto(from: buy)
        XCTAssertEqual(dto.id, "b-strike-2026-04-30")
        XCTAssertEqual(dto.date, "2026-04-30")
        XCTAssertEqual(dto.amountSats, 52000)
        XCTAssertEqual(dto.status, "complete")
    }

    func testDtoFromBTCBillPay() {
        let pay = BTCBillPay(
            id: "bp-1",
            date: ymd("2026-04-15"),
            merchant: "PennyMac",
            category: "Bills & Utilities",
            amountUSD: 2800,
            btcSpent: Decimal(string: "0.029")!,
            btcPrice: 96551,
            feeUSD: Decimal(string: "28.55")!
        )
        let dto = MC2Writer.dto(from: pay)
        XCTAssertEqual(dto.merchant, "PennyMac")
        XCTAssertEqual(dto.platform, "Strike")  // model default
        XCTAssertEqual(dto.feeUsd, Decimal(string: "28.55"))
    }

    // MARK: - End-to-end aggregation (mirrors how MC2 will read append-only)

    func testEndToEnd_AppendThenAggregate() async throws {
        let writer = MC2Writer(baseURL: tmpDir, user: .mason)
        let dtos = [
            MC2Transaction(id: "tx-a", date: "2026-04-30", merchant: "Costco", amount: 12, category: "Groceries", card: "", note: ""),
            MC2Transaction(id: "tx-b", date: "2026-04-30", merchant: "Kroger", amount: 8, category: "Groceries", card: "", note: ""),
            MC2Transaction(id: "tx-c", date: "2026-04-29", merchant: "Chevron", amount: 40, category: "Auto & Transport", card: "", note: ""),
        ]
        for dto in dtos {
            _ = try await writer.appendTransaction(dto)
        }

        let folder = tmpDir.appendingPathComponent("transactions")
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 3)

        let aggregated: [MC2Transaction] = try files.map {
            try JSONDecoder().decode(MC2Transaction.self, from: Data(contentsOf: $0))
        }
        let totalAmount = aggregated.reduce(Decimal(0)) { $0 + $1.amount }
        XCTAssertEqual(totalAmount, 60)
    }

    // MARK: - Nanoid

    func testNanoid_CorrectLengthAndCharset() {
        let id = MC2Writer.nanoid(length: 12)
        XCTAssertEqual(id.count, 12)
        let allowed = Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
        XCTAssertTrue(id.allSatisfy { allowed.contains($0) })
    }

    func testNanoid_HighlyUnlikelyCollision() {
        var seen = Set<String>()
        for _ in 0..<200 {
            let id = MC2Writer.nanoid()
            XCTAssertFalse(seen.contains(id), "Collision in nanoid: \(id)")
            seen.insert(id)
        }
    }
}
