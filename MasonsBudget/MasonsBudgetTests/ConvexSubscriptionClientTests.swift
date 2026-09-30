import Foundation
import XCTest

final class ConvexSubscriptionClientTests: XCTestCase {
    /// The first Transition a real deployment sent after subscribe.
    private let firstTransition = """
    {"type":"Transition","startVersion":{"querySet":0,"identity":0,"ts":"AAAAAAAAAAA="},\
    "endVersion":{"querySet":1,"identity":0,"ts":"OkGZgwtD2Rg="}}
    """

    private func versions() throws -> (start: StateVersion, end: StateVersion) {
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(firstTransition.utf8)) as? [String: Any],
        )
        let start = try XCTUnwrap(
            (object["startVersion"] as? [String: Any]).flatMap(StateVersion.init(object:)),
        )
        let end = try XCTUnwrap(
            (object["endVersion"] as? [String: Any]).flatMap(StateVersion.init(object:)),
        )
        return (start, end)
    }

    // MARK: - StateVersion

    func testFirstTransitionVersionsParse() throws {
        let (start, end) = try versions()
        XCTAssertEqual(start, .initial)
        XCTAssertEqual(end, StateVersion(querySet: 1, ts: 1_790_536_043_588_043_066, identity: 0))
    }

    func testStateVersionComparesNumerically() throws {
        let (start, end) = try versions()
        XCTAssertLessThan(start, end)
        XCTAssertGreaterThan(end, start)
        // Numeric, not lexicographic on the base64 string: 256 > 1 even
        // though "AAEAAAAAAAA=" sorts before "AQAAAAAAAAA=".
        let low = StateVersion(querySet: 1, ts: 1, identity: 0)
        let high = StateVersion(querySet: 1, ts: 256, identity: 0)
        XCTAssertLessThan(low, high)
        XCTAssertEqual(StateVersion.encodeTs(low.ts), "AQAAAAAAAAA=")
        XCTAssertEqual(StateVersion.encodeTs(high.ts), "AAEAAAAAAAA=")
        XCTAssertLessThan(StateVersion.encodeTs(high.ts), StateVersion.encodeTs(low.ts))
    }

    func testTsDecodeRejectsWrongLength() {
        XCTAssertNil(StateVersion.decodeTs("AAAA"))
        XCTAssertNil(StateVersion.decodeTs("not base64"))
    }

    func testStateVersionRoundTripsThroughWireForm() throws {
        let (start, end) = try versions()
        XCTAssertEqual(StateVersion.encodeTs(0), "AAAAAAAAAAA=")
        XCTAssertEqual(StateVersion.encodeTs(1_790_536_043_588_043_066), "OkGZgwtD2Rg=")
        for version in [start, end] {
            XCTAssertEqual(StateVersion(object: version.wireObject), version)
        }
        XCTAssertEqual(end.wireObject["ts"] as? String, "OkGZgwtD2Rg=")
    }

    // MARK: - Terminal errors

    func testTerminalErrorClassification() {
        XCTAssertTrue(ConvexSubscriptionClient.isTerminal(ConvexSubscriptionError.authFailed(message: "x")))
        XCTAssertTrue(ConvexSubscriptionClient.isTerminal(ConvexSubscriptionError.fatalError(message: "x")))

        XCTAssertFalse(
            ConvexSubscriptionClient.isTerminal(ConvexSubscriptionError.queryFailed(path: "p", message: "x")),
        )
        XCTAssertFalse(ConvexSubscriptionClient.isTerminal(ConvexSubscriptionError.receiveTimeout))
        XCTAssertFalse(ConvexSubscriptionClient.isTerminal(ConvexSubscriptionError.versionMismatch))
        XCTAssertFalse(ConvexSubscriptionClient.isTerminal(ConvexSubscriptionError.decodeFailed("x")))
        XCTAssertFalse(ConvexSubscriptionClient.isTerminal(URLError(.networkConnectionLost)))
    }

    // MARK: - QueryFailed recovery

    func testQueryFailedKeepsSubscriptionAndLaterUpdateEmits() async throws {
        let client = try ConvexSubscriptionClient(
            deploymentURL: XCTUnwrap(URL(string: "https://example.convex.cloud")),
        )
        let (start, middle) = try versions()
        let end = StateVersion(querySet: 1, ts: middle.ts + 1, identity: 0)
        let (stream, continuation) = AsyncStream<[String: Double]>.makeStream()
        var version = start

        let failed: [String: Any] = [
            "type": "Transition",
            "startVersion": start.wireObject,
            "endVersion": middle.wireObject,
            "modifications": [
                ["type": "QueryFailed", "queryId": 0, "errorMessage": "transient", "logLines": [String]()],
            ],
        ]
        XCTAssertNoThrow(try client.handleTransition(failed, version: &version, continuation: continuation))
        XCTAssertEqual(version, middle)

        let updated: [String: Any] = [
            "type": "Transition",
            "startVersion": middle.wireObject,
            "endVersion": end.wireObject,
            "modifications": [
                ["type": "QueryUpdated", "queryId": 0, "value": ["budget": 3], "logLines": [String]()],
            ],
        ]
        try client.handleTransition(updated, version: &version, continuation: continuation)
        XCTAssertEqual(version, end)
        continuation.finish()

        var emitted: [[String: Double]] = []
        for await value in stream {
            emitted.append(value)
        }
        // The failure emitted nothing; the later update emitted once.
        XCTAssertEqual(emitted, [["budget": 3]])
    }

    // MARK: - Backoff

    func testBackoffDoublesToCapAndResets() {
        var backoff = ReconnectBackoff()
        XCTAssertEqual((0 ..< 7).map { _ in backoff.next() }, [1, 2, 4, 8, 16, 30, 30])
        backoff.reset()
        XCTAssertEqual(backoff.next(), 1)
        XCTAssertEqual(backoff.next(), 2)
    }

    // MARK: - Watchdog

    func testTimeoutUnblocksOperationThatIgnoresCancellation() async {
        let gate = Gate()
        let fired = expectation(description: "onTimeout called")
        do {
            _ = try await ConvexSubscriptionClient.withTimeout(
                seconds: 0.05,
                onTimeout: {
                    fired.fulfill()
                    gate.open() // stands in for socket.cancel(...)
                },
                operation: { try await gate.wait() }
            )
            XCTFail("expected receiveTimeout")
        } catch ConvexSubscriptionError.receiveTimeout {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        await fulfillment(of: [fired], timeout: 1)
    }

    func testTimeoutReturnsValueWhenOperationWins() async throws {
        let value = try await ConvexSubscriptionClient.withTimeout(
            seconds: 5,
            onTimeout: { XCTFail("timeout must not fire") },
            operation: { 42 }
        )
        XCTAssertEqual(value, 42)
    }

    func testCancellationClosesBlockedReceiveBeforeWatchdog() async {
        let gate = Gate()
        let receiving = expectation(description: "receive started")
        let finished = expectation(description: "receive finished after cancellation")
        let task = Task {
            defer { finished.fulfill() }
            _ = try? await ConvexSubscriptionClient.withTimeout(
                seconds: 60,
                onTimeout: { XCTFail("watchdog must not fire") },
                onCancel: { gate.open() }, // stands in for socket.cancel(...)
                operation: {
                    receiving.fulfill()
                    try await gate.wait()
                }
            )
        }
        await fulfillment(of: [receiving], timeout: 1)
        task.cancel()
        await fulfillment(of: [finished], timeout: 1)
    }
}

/// An await that ignores task cancellation and only returns once `open()`
/// is called, like `URLSessionWebSocketTask.receive()` on a hung socket.
private final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var waiter: CheckedContinuation<Void, Error>?

    func wait() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            lock.lock()
            if isOpen {
                lock.unlock()
                continuation.resume(throwing: URLError(.cancelled))
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }

    func open() {
        lock.lock()
        isOpen = true
        let continuation = waiter
        waiter = nil
        lock.unlock()
        continuation?.resume(throwing: URLError(.cancelled))
    }
}
