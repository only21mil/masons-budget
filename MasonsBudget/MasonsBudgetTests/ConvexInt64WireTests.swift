import Foundation
import XCTest

final class ConvexInt64WireTests: XCTestCase {
    func testCanonicalConvexVectorsDecodeExactly() throws {
        let vectors: [(encoded: String, expected: Int64)] = [
            ("AAAAAAAAAAA=", 0),
            ("AQAAAAAAAAA=", 1),
            ("//////////8=", -1),
            ("/////////38=", .max),
            ("AAAAAAAAAIA=", .min),
        ]

        for vector in vectors {
            XCTAssertEqual(
                try ConvexTaggedInt64Decoder.decodePayload(vector.encoded),
                vector.expected,
                "Failed canonical Convex vector \(vector.encoded)",
            )
        }
    }

    func testCompleteSharedConvexFixtureWhenAvailable() throws {
        let bundle = Bundle(for: ConvexInt64WireTests.self)
        guard let url = bundle.url(forResource: "convex-int64-wire-cases", withExtension: "json")
            ?? bundle.url(
                forResource: "convex-int64-wire-cases",
                withExtension: "json",
                subdirectory: "fixtures",
            )
        else {
            throw XCTSkip("Shared int64 fixture is supplied by the prerequisite shared-domain change.")
        }

        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
        )
        let valid = try XCTUnwrap(root["valid"] as? [[String: Any]])
        let invalid = try XCTUnwrap(root["invalid"] as? [[String: Any]])

        for testCase in valid {
            let name = try XCTUnwrap(testCase["name"] as? String)
            let decimal = try XCTUnwrap(testCase["decimal"] as? String)
            let expected = try XCTUnwrap(Int64(decimal))
            let wire = try XCTUnwrap(testCase["wire"])
            XCTAssertEqual(
                try ConvexTaggedInt64Decoder.decodeTaggedValue(wire),
                expected,
                "Failed shared Convex vector: \(name)",
            )
        }

        for testCase in invalid {
            let name = try XCTUnwrap(testCase["name"] as? String)
            let wire = try XCTUnwrap(testCase["wire"])
            XCTAssertThrowsError(
                try ConvexTaggedInt64Decoder.decodeTaggedValue(wire),
                "Accepted malformed shared Convex vector: \(name)",
            )
        }
    }

    func testExactCentsAndSatoshisNeverPassThroughDouble() throws {
        let wire: [String: Any] = [
            "amountCents": ["$integer": "AQAAAAAAIAA="],
            "sats": ["$integer": "AEAHWvB1BwA="],
        ]

        let decoded = try XCTUnwrap(try ConvexTaggedInt64Decoder.decode(wire) as? [String: Any])
        let cents = try XCTUnwrap(decoded["amountCents"] as? Int64)
        let sats = try XCTUnwrap(decoded["sats"] as? Int64)

        XCTAssertEqual(cents, 9_007_199_254_740_993)
        XCTAssertEqual(sats, 2_100_000_000_000_000)
        XCTAssertFalse(decoded["amountCents"] is Double)
        XCTAssertFalse(decoded["sats"] is Double)
    }

    func testDecoderRecursesWithoutChangingOrdinaryBlobValues() throws {
        let wire: [String: Any] = [
            "rows": [
                ["amountCents": ["$integer": "QOIBAAAAAAA="], "merchant": "Test"],
            ],
            "legacy": ["amount": 12.5, "enabled": true],
        ]

        let decoded = try XCTUnwrap(try ConvexTaggedInt64Decoder.decode(wire) as? [String: Any])
        let rows = try XCTUnwrap(decoded["rows"] as? [[String: Any]])
        XCTAssertEqual(rows.first?["amountCents"] as? Int64, 123_456)
        XCTAssertEqual(rows.first?["merchant"] as? String, "Test")

        let legacy = try XCTUnwrap(decoded["legacy"] as? [String: Any])
        XCTAssertEqual(legacy["amount"] as? Double, 12.5)
        XCTAssertEqual(legacy["enabled"] as? Bool, true)
    }

    func testStrictTaggedDecoderRejectsNonTagsAndMalformedShapes() {
        let malformed: [Any] = [
            NSNull(),
            1,
            "1",
            [Any](),
            [String: Any](),
            ["$int64": "AQAAAAAAAAA="],
            ["$integer": "AAAAAAAAAAA=", "extra": true],
            ["$integer": 0],
            ["$integer": NSNull()],
        ]

        for value in malformed {
            XCTAssertThrowsError(try ConvexTaggedInt64Decoder.decodeTaggedValue(value)) { error in
                XCTAssertEqual(error as? ConvexTaggedInt64Decoder.DecodeError, .malformedTag)
            }
        }
    }

    func testMalformedPayloadsAreRejected() {
        let malformed = [
            "",
            "not-base64",
            "__________8=",
            "AAAAAAAAAA!=",
            "AAAA",
            "AAAAAAAAAAA",
            "AAAAAAAAAAA==",
            "AAAAAAAAAAB=",
            "AAAAAAAAAA==",
            "AAAAAAAAAAAA",
        ]

        for payload in malformed {
            XCTAssertThrowsError(try ConvexTaggedInt64Decoder.decodePayload(payload)) { error in
                XCTAssertEqual(error as? ConvexTaggedInt64Decoder.DecodeError, .malformedPayload)
            }
        }
    }
}
