import Foundation
import SwiftData
import XCTest

final class FinanceSourceTests: XCTestCase {
    @MainActor
    func testTypedFinanceMapsExactValuesAndCanonicalOwners() throws {
        let data = Data(#"""
        {"complete":true,"document":{"lastUpdated":"2026-09-01","updatedAtMs":1234,"accounts":[
          {"key":"adult_401k","owner":"victor","provider":"Example","totalValueCents":123456,
           "weeklyContributionCents":12345,"holdings":[
            {"name":"Index","category":"Equity","ticker":"VOO","valueCents":123456,"costBasisCents":120000,
             "gainBps":288,"sharesDecimal":"2.500000000001","avgCostCents":48000,
             "currentPricePerShareCents":49382,"isProxy":false,"lots":[
              {"date":"2026-09-01","type":"adjustment","pricePerShareCents":49382,
               "sharesDecimal":"-0.005","amountInvestedCents":-247}]}]},
          {"key":"mason_401k","owner":"mason","provider":"Child","totalValueCents":800,
           "weeklyContributionCents":100,"holdings":[]}]}}
        """#.utf8)
        let envelope = try JSONDecoder().decode(ConvexFinanceDocumentEnvelope.self, from: data)
        let dto = try envelope.legacyDTO(viewer: .rachel)
        let accounts = LedgerMapper.mapFinances(dto, owner: .rachel)
        XCTAssertEqual(Set(accounts.map(\.ownerMember)), [.victor, .mason])
        let adult = try XCTUnwrap(accounts.first { $0.ownerMember == .victor })
        XCTAssertEqual(adult.totalValue, Decimal(string: "1234.56"))
        XCTAssertEqual(adult.weeklyContribution, Decimal(string: "123.45"))
        XCTAssertEqual(adult.holdings.first?.shares, Decimal(string: "2.500000000001"))
        XCTAssertEqual(adult.holdings.first?.lots.first?.shares, Decimal(string: "-0.005"))
        XCTAssertThrowsError(try envelope.legacyDTO(viewer: .mason))
    }

    func testFinanceEmptyAndIncompleteCannotReplaceData() throws {
        for payload in [#"{"complete":false,"document":null}"#, #"{"complete":true,"document":null}"#] {
            let envelope = try JSONDecoder().decode(ConvexFinanceDocumentEnvelope.self, from: Data(payload.utf8))
            XCTAssertThrowsError(try envelope.legacyDTO(viewer: .victor))
        }
        XCTAssertEqual(ConvexRowQuery.finance(viewer: .rachel).path, "tables:getFinanceDocument")
        XCTAssertEqual(ConvexRowQuery.finance(viewer: .rachel).arguments["viewer"] as? String, "rachel")
        XCTAssertEqual(ConvexRowQuery.finance(viewer: .rachel).arguments["scope"] as? String, "visible")
    }

    func testBalanceDocumentPreservesDynamicAccountAndExactSats() throws {
        let data = Data(#"""
        {"owner":"mason","schemaVersion":2,"asOf":"2026-09-01","accounts":[
          {"key":"new-wallet","label":"New wallet","custody":"self_custody","sats":123456789}],
         "totals":{"sats":123456789,"exchangeSats":0,"selfCustodySats":123456789}}
        """#.utf8)
        let document = try JSONDecoder().decode(ConvexBTCBalanceDocumentRow.self, from: data)
        let dto = try document.legacySnapshot()
        XCTAssertEqual(dto.accounts["new-wallet"]?.btc, Decimal(string: "1.23456789"))
        XCTAssertEqual(dto.totalSats, 123_456_789)
        XCTAssertFalse(FamilyMember.rachel.sharesNetWorth(with: document.owner))
        XCTAssertTrue(FamilyMember.rachel.canSee(dataOwnedBy: document.owner))
    }

    func testQuoteSelectorMatchesSharedFinanceFixture() throws {
        let bundle = Bundle(for: Self.self)
        let resources = bundle.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? []
        let url = try XCTUnwrap(resources.first { $0.lastPathComponent == "finance-market-cases.json" })
        var fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let snapshot = try XCTUnwrap(fixture["marketSnapshot"] as? [String: Any])
        var quotes = try XCTUnwrap(snapshot["quotes"] as? [[String: Any]])
        for index in quotes.indices {
            quotes[index]["priceCents"] = Int64(try XCTUnwrap(quotes[index]["priceCents"] as? String))
        }
        fixture = ["quotes": quotes, "complete": true]
        let decoded = try JSONDecoder().decode(MarketQuoteSnapshot.self, from: JSONSerialization.data(withJSONObject: fixture)).validated()
        XCTAssertEqual(try usableMarketQuote(decoded.quotes, symbol: .btc)?.priceCents, 10_000_000)
        XCTAssertEqual(try usableMarketQuote(decoded.quotes, symbol: .voo)?.priceCents, 55_000)
        XCTAssertEqual(try usableMarketQuote(decoded.quotes, symbol: .ibit)?.status, .stale)
        let unavailable = MarketQuote(symbol: .btc, priceCents: nil, source: "Example", fetchedAt: nil, status: .unavailable)
        XCTAssertNil(try usableMarketQuote([unavailable], symbol: .btc))
        let contradictory = MarketQuote(symbol: .btc, priceCents: 1, source: "Example", fetchedAt: nil, status: .unavailable)
        XCTAssertThrowsError(try usableMarketQuote([contradictory], symbol: .btc))
    }

    func testQuoteCacheAgesWithoutInventingFreshness() throws {
        let quote = MarketQuote(symbol: .btc, priceCents: 10_000_000, source: "Example", fetchedAt: "2026-09-01T00:00:00Z", status: .live)
        let date = try XCTUnwrap(quote.observationDate)
        XCTAssertEqual(quote.effectiveStatus(now: date.addingTimeInterval(899)), .live)
        XCTAssertEqual(quote.effectiveStatus(now: date.addingTimeInterval(900)), .stale)
        XCTAssertEqual(quote.effectiveStatus(now: date.addingTimeInterval(86_401)), .unavailable)
        XCTAssertEqual(quote.effectiveStatus(now: date.addingTimeInterval(-1)), .unavailable)
        let malformed = MarketQuote(symbol: .btc, priceCents: 1, source: "Example", fetchedAt: "2026-02-30T00:00:00Z", status: .live)
        XCTAssertThrowsError(try malformed.validated())
    }

    func testNetWorthHistoryUsesOnlyObservedMonthsAndTotalChange() throws {
        let formatter = ISO8601DateFormatter()
        func point(_ date: String, total: Decimal) throws -> NetWorthHistoryPoint {
            NetWorthHistoryPoint(date: try XCTUnwrap(formatter.date(from: date)), total: total, btc: total / 2, holdings: total / 2)
        }
        let first = try point("2026-07-03T00:00:00Z", total: 100)
        let current = try point("2026-09-13T00:00:00Z", total: 140)
        let points = NetWorthHistory.recentMonths(snapshots: [first], current: current, calendar: Calendar(identifier: .gregorian))
        XCTAssertEqual(points.count, 2)
        XCTAssertEqual(points.first?.date, first.date)
        XCTAssertEqual(NetWorthHistory.change(points), 40)
        XCTAssertFalse(NetWorthHistory.spanLabel(points).contains("year"))
        XCTAssertNil(NetWorthHistory.change([current]))
        XCTAssertEqual(NetWorthHistory.recentMonths(snapshots: [], current: current).count, 1)
    }
    func testRetirementIncomeFallbackRequiresAvailableEmptyAdultLedger() throws {
        let empty = CanonicalIncomeSummary(rows: [], monthCents: [:], yearCents: [:])
        XCTAssertEqual(RetirementProjectionInputs.income(viewer: .rachel, summary: empty, month: "2026-09", matchingSnapshotIncome: 500), 500)
        XCTAssertNil(RetirementProjectionInputs.income(viewer: .mason, summary: empty, month: "2026-09", matchingSnapshotIncome: 500))
        XCTAssertNil(RetirementProjectionInputs.income(viewer: .victor, summary: nil, month: "2026-09", matchingSnapshotIncome: 500))
        XCTAssertNil(RetirementProjectionInputs.income(viewer: .victor, summary: empty, month: "2026-09", matchingSnapshotIncome: nil))
        let row = ConvexIncomeRow(incomeId: "sample", owner: .victor, date: "2026-08-01", month: "2026-08", amountCents: 100,
                                  source: "Pay", loggedBy: nil, note: nil, archimedesRequestId: nil)
        let populated = CanonicalIncomeSummary(rows: [row], monthCents: ["2026-08": 100], yearCents: [2026: 100])
        XCTAssertEqual(RetirementProjectionInputs.income(viewer: .victor, summary: populated, month: "2026-09", matchingSnapshotIncome: 500), 0)
    }

}
