// The Vogel Vault — Convex Sync-Protocol Subscription Client
//
// Replaces the fixed-interval versions poll with a Convex WebSocket
// subscription — the `useQuery`/`onUpdate` equivalent Convex support
// prescribed for the 54k-function-calls/day burn. Implements the Convex
// sync protocol exactly as the official convex-js browser client does
// (traced from convex 1.46.0 `src/browser/sync/*`):
//
//   WS  wss://<deployment>/api/<version>/sync
//   →   {"type":"Connect","sessionId":…,"connectionCount":…,
//        "lastCloseReason":…,"clientTs":…}
//   →   {"type":"ModifyQuerySet","baseVersion":0,"newVersion":1,
//        "modifications":[{"type":"Add","queryId":0,
//        "udfPath":"dataFiles:getVersions","args":[{…convex JSON…}]}]}
//   ←   {"type":"Transition","startVersion":…,"endVersion":…,
//        "modifications":[{"type":"QueryUpdated","queryId":0,
//        "value":{…convex-encoded JSON…},"logLines":[],"journal":null}]}
//
// No Authenticate message is sent: like an unauthenticated convex-js
// client, this deployment authorizes reads via query args (the same
// `token` arg the HTTPS path attaches centrally in
// `ConvexClient.authenticatedArguments`), and the server starts with an
// unknown identity in that case — sending Authenticate would be wrong.
//
// The client yields the decoded versions dictionary on subscribe and on
// every server push, so the query re-runs only when its data changes.
// There is no timer in this file. A dropped socket reconnects with
// capped exponential backoff (reset once a connection has received a
// Transition), and a 60s receive watchdog (the same threshold convex-js
// uses) cancels a hung socket. Auth failures, server fatal errors and
// query failures are terminal: the loop logs them and ends the stream.

import Foundation
import os

/// Subscription failures. Transport drops, timeouts, version mismatches
/// and decode failures trigger a reconnect with backoff. `authFailed`,
/// `fatalError` and `queryFailed` are terminal (see `isTerminal`): the
/// loop logs them and finishes the stream instead of retrying.
enum ConvexSubscriptionError: LocalizedError {
    case invalidDeploymentURL
    case queryFailed(path: String, message: String)
    case authFailed(message: String)
    case fatalError(message: String)
    case versionMismatch
    case receiveTimeout
    case decodeFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidDeploymentURL:
            "Cannot derive the Convex sync WebSocket URL from the deployment URL."
        case let .queryFailed(path, message):
            "Convex subscription query '\(path)' failed: \(message)"
        case let .authFailed(message):
            "Convex subscription auth failed: \(message)"
        case let .fatalError(message):
            "Convex subscription fatal error: \(message)"
        case .versionMismatch:
            "Convex subscription lost sync with the server."
        case .receiveTimeout:
            "Convex subscription timed out waiting for the server."
        case let .decodeFailed(detail):
            "Convex subscription could not decode a server message: \(detail)"
        }
    }
}

/// A single Convex query subscription over the sync-protocol WebSocket.
///
/// Yields the query's latest value every time the server pushes an
/// update. The socket reconnects automatically with capped exponential
/// backoff; callers iterate the stream until their task is cancelled or
/// a terminal error (auth, fatal, query failure) finishes it.
final class ConvexSubscriptionClient: Sendable {
    private let deploymentURL: URL
    private let protocolVersion: String
    private let urlSession: URLSession
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "ConvexSubscription")
    private let driverLock = NSLock()
    private var driverTask: Task<Void, Never>?

    /// - Parameter protocolVersion: the convex-js version whose sync
    ///   protocol this client implements. Pinned so a server-side
    ///   protocol change fails loudly instead of misbehaving silently.
    init(
        deploymentURL: URL = ConvexConfig.deploymentURL,
        protocolVersion: String = "1.46.0",
        urlSession: URLSession = .shared
    ) {
        self.deploymentURL = deploymentURL
        self.protocolVersion = protocolVersion
        self.urlSession = urlSession
    }

    /// Subscribes to `dataFiles:getVersions` with the given auth args.
    /// Yields the decoded versions immediately on subscribe and again on
    /// every server push. The stream ends when the consuming task is
    /// cancelled or the server reports a terminal error.
    func subscribeVersions(authArgs: [String: Any]) -> AsyncStream<[String: Double]> {
        AsyncStream { continuation in
            let task = Task {
                await self.run(authArgs: authArgs, continuation: continuation)
            }
            self.driverLock.lock()
            self.driverTask = task
            self.driverLock.unlock()
            continuation.onTermination = { [weak self] _ in
                task.cancel()
                self?.clearDriver(task)
            }
        }
    }

    /// Stops the active subscription, if any. The stream finishes, which
    /// ends any `for await` loop consuming it.
    func cancel() {
        driverLock.lock()
        let task = driverTask
        driverLock.unlock()
        task?.cancel()
    }

    private func clearDriver(_ task: Task<Void, Never>) {
        driverLock.lock()
        defer { driverLock.unlock() }
        if driverTask == task {
            driverTask = nil
        }
    }

    // MARK: - Connection loop

    private func run(
        authArgs: [String: Any],
        continuation: AsyncStream<[String: Double]>.Continuation
    ) async {
        var connectionCount = 0
        var lastCloseReason: String?
        var backoff = ReconnectBackoff()
        while !Task.isCancelled {
            connectionCount += 1
            var healthy = false
            do {
                try await serve(
                    connectionCount: connectionCount,
                    lastCloseReason: lastCloseReason,
                    authArgs: authArgs,
                    healthy: &healthy,
                    continuation: continuation
                )
                break // serve returns only on cancellation
            } catch is CancellationError {
                break
            } catch {
                if Self.isTerminal(error) {
                    log.error(
                        "Convex subscription ended on terminal error: \(error.localizedDescription, privacy: .public)"
                    )
                    break
                }
                if healthy {
                    // The connection worked before it dropped; start over at 1s.
                    backoff.reset()
                }
                lastCloseReason = error.localizedDescription
                let delay = backoff.next()
                log.warning(
                    "Convex subscription dropped (\(error.localizedDescription, privacy: .public)); reconnecting in \(Int(delay), privacy: .public)s"
                )
                do {
                    let jittered = delay * Double.random(in: 0.8 ... 1.2)
                    try await Task.sleep(nanoseconds: UInt64(jittered * 1_000_000_000))
                } catch {
                    break
                }
            }
        }
        continuation.finish()
    }

    /// Errors the reconnect loop must not retry: the server rejected the
    /// credentials, hit a fatal error, or failed/removed the query.
    /// Reconnecting would repeat the same failure forever.
    static func isTerminal(_ error: Error) -> Bool {
        guard let error = error as? ConvexSubscriptionError else { return false }
        switch error {
        case .authFailed, .fatalError, .queryFailed:
            return true
        case .invalidDeploymentURL, .versionMismatch, .receiveTimeout, .decodeFailed:
            return false
        }
    }

    private func serve(
        connectionCount: Int,
        lastCloseReason: String?,
        authArgs: [String: Any],
        healthy: inout Bool,
        continuation: AsyncStream<[String: Double]>.Continuation
    ) async throws {
        guard let wsURL = Self.syncURL(for: deploymentURL, protocolVersion: protocolVersion) else {
            throw ConvexSubscriptionError.invalidDeploymentURL
        }
        let socket = urlSession.webSocketTask(with: wsURL)
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }

        var version = StateVersion.initial
        var chunkBuffer: ChunkBuffer?

        var connect: [String: Any] = [
            "type": "Connect",
            "sessionId": UUID().uuidString,
            "connectionCount": connectionCount,
            "clientTs": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        connect["lastCloseReason"] = lastCloseReason ?? NSNull()
        try await send(socket, connect)

        // A fresh connection re-sends the whole query set from version 0,
        // exactly like convex-js `LocalSyncState.restart()`.
        try await send(socket, [
            "type": "ModifyQuerySet",
            "baseVersion": 0,
            "newVersion": 1,
            "modifications": [
                [
                    "type": "Add",
                    "queryId": 0,
                    "udfPath": "dataFiles:getVersions",
                    "args": [Self.convexJSON(authArgs)],
                ] as [String: Any],
            ],
        ])

        while !Task.isCancelled {
            let message = try await receive(socket)
            switch message {
            case let .string(text):
                try handleText(
                    text,
                    version: &version,
                    chunkBuffer: &chunkBuffer,
                    continuation: continuation
                )
                // The first applied Transition moves the version off
                // `.initial`; from then on the connection counts as healthy.
                if version != .initial {
                    healthy = true
                }
            case .data:
                // The sync protocol only sends text frames.
                continue
            @unknown default:
                continue
            }
        }
    }

    // MARK: - Wire I/O

    private func send(_ socket: URLSessionWebSocketTask, _ message: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: message)
        guard let text = String(data: data, encoding: .utf8) else {
            throw ConvexSubscriptionError.decodeFailed("client message is not UTF-8")
        }
        try await socket.send(.string(text))
    }

    /// Receives one message, giving up after 60s of server silence —
    /// the same inactivity threshold convex-js reconnects on.
    private func receive(_ socket: URLSessionWebSocketTask) async throws -> URLSessionWebSocketTask.Message {
        try await Self.withTimeout(
            seconds: 60,
            onTimeout: {
                // `socket.receive()` ignores task cancellation, so the task
                // group would wait on it forever. Cancelling the socket makes
                // the pending receive return with an error.
                socket.cancel(with: .goingAway, reason: nil)
            },
            operation: { try await socket.receive() }
        )
    }

    /// Races `operation` against a timer. On timeout it calls `onTimeout`
    /// (which must unblock `operation` if it ignores cancellation), then
    /// throws `ConvexSubscriptionError.receiveTimeout`.
    static func withTimeout<T: Sendable>(
        seconds: TimeInterval = 60,
        onTimeout: @escaping @Sendable () -> Void,
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        let timedOut = TimeoutFlag()
        return try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                timedOut.set()
                onTimeout()
                throw ConvexSubscriptionError.receiveTimeout
            }
            defer { group.cancelAll() }
            do {
                guard let value = try await group.next() else {
                    throw ConvexSubscriptionError.receiveTimeout
                }
                return value
            } catch {
                // After `onTimeout` the operation may fail first (for
                // example with URLError.cancelled); report the timeout.
                if timedOut.isSet { throw ConvexSubscriptionError.receiveTimeout }
                throw error
            }
        }
    }

    // MARK: - Server messages

    private func handleText(
        _ text: String,
        version: inout StateVersion,
        chunkBuffer: inout ChunkBuffer?,
        continuation: AsyncStream<[String: Double]>.Continuation
    ) throws {
        guard let data = text.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String
        else {
            throw ConvexSubscriptionError.decodeFailed("message is not a JSON object")
        }
        switch type {
        case "Ping":
            return // keepalive; receiving it already reset the watchdog
        case "TransitionChunk":
            guard let chunk = TransitionChunk(object: object) else {
                throw ConvexSubscriptionError.decodeFailed("malformed TransitionChunk")
            }
            if chunkBuffer == nil {
                chunkBuffer = ChunkBuffer(totalParts: chunk.totalParts, transitionId: chunk.transitionId)
            }
            if let transition = try chunkBuffer?.append(chunk) {
                chunkBuffer = nil
                try handleTransition(transition, version: &version, continuation: continuation)
            }
        case "Transition":
            if chunkBuffer != nil {
                log.warning("Received Transition while buffering chunks; dropping chunk buffer")
                chunkBuffer = nil
            }
            try handleTransition(object, version: &version, continuation: continuation)
        case "AuthError":
            throw ConvexSubscriptionError.authFailed(message: object["error"] as? String ?? "unknown")
        case "FatalError":
            throw ConvexSubscriptionError.fatalError(message: object["error"] as? String ?? "unknown")
        default:
            // MutationResponse / ActionResponse: this client never requests any.
            log.warning("Ignoring unexpected Convex sync message type: \(type, privacy: .public)")
        }
    }

    private func handleTransition(
        _ object: [String: Any],
        version: inout StateVersion,
        continuation: AsyncStream<[String: Double]>.Continuation
    ) throws {
        guard let start = (object["startVersion"] as? [String: Any]).flatMap(StateVersion.init),
              let end = (object["endVersion"] as? [String: Any]).flatMap(StateVersion.init)
        else {
            throw ConvexSubscriptionError.decodeFailed("Transition is missing its versions")
        }
        guard start == version else {
            throw ConvexSubscriptionError.versionMismatch
        }
        let modifications = object["modifications"] as? [[String: Any]] ?? []
        for modification in modifications {
            switch modification["type"] as? String {
            case "QueryUpdated":
                guard (modification["queryId"] as? Int) == 0 else { continue }
                let decoded = try ConvexTaggedInt64Decoder.decode(modification["value"] ?? NSNull())
                continuation.yield(Self.versions(from: decoded))
            case "QueryFailed":
                throw ConvexSubscriptionError.queryFailed(
                    path: "dataFiles:getVersions",
                    message: modification["errorMessage"] as? String ?? "unknown"
                )
            case "QueryRemoved":
                throw ConvexSubscriptionError.queryFailed(
                    path: "dataFiles:getVersions",
                    message: "server removed the subscription"
                )
            default:
                continue
            }
        }
        version = end
    }

    // MARK: - URL + value codecs

    /// `https://host` → `wss://host/api/<version>/sync`, mirroring
    /// convex-js `BaseConvexClient` (http → ws, https → wss).
    static func syncURL(for deploymentURL: URL, protocolVersion: String) -> URL? {
        guard var components = URLComponents(url: deploymentURL, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased()
        else { return nil }
        switch scheme {
        case "http": components.scheme = "ws"
        case "https": components.scheme = "wss"
        default: return nil
        }
        components.path = "/api/\(protocolVersion)/sync"
        components.query = nil
        components.fragment = nil
        return components.url
    }

    /// Mirrors convex-js `convexToJson` for the scalar/container types
    /// used in subscription args. Plain strings, booleans and finite
    /// doubles pass through; Int64 uses the `$integer` tag via the same
    /// encoder as the HTTPS path.
    static func convexJSON(_ value: Any) -> Any {
        switch value {
        case let string as String:
            return string
        case let bool as Bool:
            return bool
        case let double as Double:
            if double.isNaN || double.isInfinite {
                var bits = double.bitPattern.littleEndian
                let data = withUnsafeBytes(of: &bits) { Data($0) }
                return ["$float": data.base64EncodedString()]
            }
            return double
        case let int as Int64:
            return ConvexTaggedInt64Encoder.encode(int)
        case let int as Int:
            return convexJSON(Int64(int))
        case is NSNull:
            return NSNull()
        case let array as [Any]:
            return array.map(convexJSON)
        case let dict as [String: Any]:
            return dict.mapValues(convexJSON)
        default:
            return String(describing: value)
        }
    }

    /// Decodes a pushed `QueryUpdated` value into the versions map, the
    /// same shape `ConvexClient.fetchVersions()` produces.
    static func versions(from decoded: Any) -> [String: Double] {
        guard let dict = decoded as? [String: Any] else { return [:] }
        var result: [String: Double] = [:]
        for (key, value) in dict {
            // Int64 decodes (from the $integer tag) bridge to NSNumber;
            // doubleValue is exact for the small version counters here.
            if let number = value as? NSNumber {
                result[key] = number.doubleValue
            }
        }
        return result
    }
}

/// Set once by the watchdog timer, read by the racing receive.
private final class TimeoutFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set() {
        lock.lock()
        value = true
        lock.unlock()
    }
}

// MARK: - Reconnect backoff

/// Capped exponential reconnect delay: 1, 2, 4, … 30 seconds.
struct ReconnectBackoff: Equatable {
    static let initialDelay: TimeInterval = 1
    static let maxDelay: TimeInterval = 30

    private(set) var current: TimeInterval = Self.initialDelay

    /// Returns the delay to wait now and doubles the next one, up to the cap.
    mutating func next() -> TimeInterval {
        let delay = current
        current = min(current * 2, Self.maxDelay)
        return delay
    }

    /// Back to the initial delay after a healthy connection.
    mutating func reset() {
        current = Self.initialDelay
    }
}

// MARK: - Protocol value types

/// The `{querySet, ts, identity}` state version carried by Transitions.
/// On the wire `ts` is a u64 encoded as base64 of its 8 little-endian
/// bytes (the first Transition carries `"AAAAAAAAAAA="`, i.e. 0). It is
/// decoded to `UInt64` on parse so comparisons are numeric, and encoded
/// back to the same base64 form when sent.
struct StateVersion: Equatable, Comparable {
    var querySet: Int
    var ts: UInt64
    var identity: Int

    static let initial = StateVersion(querySet: 0, ts: 0, identity: 0)

    static func < (lhs: StateVersion, rhs: StateVersion) -> Bool {
        (lhs.querySet, lhs.ts, lhs.identity) < (rhs.querySet, rhs.ts, rhs.identity)
    }

    /// Decodes a base64 little-endian u64. Nil unless exactly 8 bytes.
    static func decodeTs(_ base64: String) -> UInt64? {
        guard let data = Data(base64Encoded: base64), data.count == 8 else { return nil }
        return data.enumerated().reduce(UInt64(0)) { $0 | (UInt64($1.element) << (8 * UInt64($1.offset))) }
    }

    /// Encodes a u64 as base64 of its 8 little-endian bytes.
    static func encodeTs(_ ts: UInt64) -> String {
        var bits = ts.littleEndian
        return withUnsafeBytes(of: &bits) { Data($0) }.base64EncodedString()
    }

    /// Wire form, for any client message that carries a state version.
    var wireObject: [String: Any] {
        ["querySet": querySet, "ts": Self.encodeTs(ts), "identity": identity]
    }
}

// Declared in an extension so the synthesized memberwise init stays available.
extension StateVersion {
    init?(object: [String: Any]) {
        guard let querySet = object["querySet"] as? Int,
              let tsString = object["ts"] as? String,
              let ts = Self.decodeTs(tsString),
              let identity = object["identity"] as? Int
        else { return nil }
        self.querySet = querySet
        self.ts = ts
        self.identity = identity
    }
}

private struct TransitionChunk {
    let chunk: String
    let partNumber: Int
    let totalParts: Int
    let transitionId: String

    init?(object: [String: Any]) {
        guard let chunk = object["chunk"] as? String,
              let partNumber = object["partNumber"] as? Int,
              let totalParts = object["totalParts"] as? Int,
              let transitionId = object["transitionId"] as? String
        else { return nil }
        self.chunk = chunk
        self.partNumber = partNumber
        self.totalParts = totalParts
        self.transitionId = transitionId
    }
}

/// Reassembles a Transition split across TransitionChunk frames, with
/// the same ordering checks convex-js applies.
private struct ChunkBuffer {
    let totalParts: Int
    let transitionId: String
    private var parts: [String] = []

    init(totalParts: Int, transitionId: String) {
        self.totalParts = totalParts
        self.transitionId = transitionId
    }

    /// Returns the reassembled Transition object once the final part
    /// arrives, nil while more parts are outstanding.
    mutating func append(_ chunk: TransitionChunk) throws -> [String: Any]? {
        guard chunk.totalParts == totalParts,
              chunk.transitionId == transitionId,
              chunk.totalParts > 0,
              chunk.partNumber == parts.count
        else {
            throw ConvexSubscriptionError.decodeFailed("invalid TransitionChunk sequence")
        }
        parts.append(chunk.chunk)
        guard parts.count == totalParts else { return nil }
        let full = parts.joined()
        guard let data = full.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["type"] as? String == "Transition"
        else {
            throw ConvexSubscriptionError.decodeFailed("reassembled chunks are not a Transition")
        }
        return object
    }
}
