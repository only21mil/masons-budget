import Foundation

/// The outcome of a Convex write.
///
/// The Apple client reported every write as `Bool` until this type existed, so a
/// missing sync credential, an unauthorized profile and a rejected amount sign
/// were indistinguishable at the UI. Weeks of transactions were lost to exactly
/// that ambiguity: the write "failed" and nobody could be told why.
///
/// Deliberately an enum with associated values rather than `Result` or a typed
/// `Error`:
///
/// * `.disabled` and `.notConfigured` are ordinary states of this feature, not
///   failures. `Result` would shove them into the failure channel and force a
///   `try`/`catch` shape onto callers that have nothing to recover from.
/// * An existential `Error` gives no exhaustiveness — the exact property `Bool`
///   destroyed. A new cause must break every `switch` until it is handled.
/// * `Result` would force `.failure(.unauthorized)` double-nesting in every
///   SwiftUI `switch`.
///
/// The six cases are 1:1 with Android's `ConvexResult` so the two clients cannot
/// disagree about what a rejection means. Android's `Ok(value)` becomes a plain
/// `.ok`: Apple's write seam returns no value.
enum ConvexWriteResult: Sendable, Equatable {
    /// The write was accepted.
    case ok

    /// The write kill switch is off. No request was made.
    case disabled

    /// No usable Convex deployment URL. No request was made.
    case notConfigured

    /// The credential is missing locally, or the deployment rejected what we
    /// sent. Refused before network I/O where the credential is absent.
    case unauthorized

    /// The mutation succeeded but returned no result — the deployment wrote
    /// nothing we can confirm.
    case missing

    /// Everything else, narrowed to a cause this module authors itself.
    case failed(ConvexWriteFailure)

    var isOk: Bool { self == .ok }
}

/// The closed set of write failure causes.
///
/// Server text is deliberately never propagated into these values. A reason ends
/// up in a log eventually, and a response body from this deployment can contain
/// the household's financial data.
enum ConvexWriteFailure: Sendable, Equatable {
    /// The payload could not be built or encoded for the wire.
    case payloadEncoding

    /// The row mutation API is not deployed on this deployment.
    case rowAPIUnavailable

    /// The request never reached a Convex response.
    case transport

    /// The owning task was cancelled. Cancellation is terminal for this
    /// operation and must never consume retry attempts.
    case cancelled

    /// A pairing credential could not be committed to protected storage.
    case credentialStorage

    /// Convex returned an application-level error for the mutation.
    case serverRejected

    /// Convex answered, but not in the shape the mutation contract requires.
    case malformedResponse

    /// A money value cannot be written exactly (sub-cent precision or Int64
    /// overflow). `field` is an identifier this module authors, never user data.
    case invalidAmount(field: String)

    /// The row's owner does not match the profile being written to. `field` is an
    /// identifier this module authors; the offending owner value is not carried.
    case ownerMismatch(field: String)

    /// A pre-cutover device credential has no server-side profile binding.
    case profileBindingRequired

    /// A legacy or not-yet-refreshed task has no authoritative row revision.
    case revisionRequired

    /// The supplied task revision is no longer current.
    case staleWrite

    /// The task is deleted or has no authoritative row/tombstone to mutate.
    case entityUnavailable

    /// A non-200 HTTP status.
    case http(status: Int)

    /// A short, authored, user-safe description of the cause.
    var wireReason: String {
        switch self {
        case .payloadEncoding:
            "the entry could not be encoded"
        case .rowAPIUnavailable:
            "the sync API is not deployed"
        case .transport:
            "the network request failed"
        case .cancelled:
            "the operation was cancelled"
        case .credentialStorage:
            "the device credential could not be stored securely"
        case .serverRejected:
            "the server rejected the write"
        case .malformedResponse:
            "the server sent an unexpected response"
        case let .invalidAmount(field):
            "\(field) is not a writable amount"
        case let .ownerMismatch(field):
            "\(field) belongs to a different profile"
        case .profileBindingRequired:
            "the device credential must be paired to this profile"
        case .revisionRequired:
            "the task must refresh before it can be changed"
        case .staleWrite:
            "the task changed on another device"
        case .entityUnavailable:
            "the task is no longer available"
        case let .http(status):
            "HTTP \(status)"
        }
    }
}

extension ConvexWriteResult {
    /// Maps a thrown write error onto its cause.
    ///
    /// This is the boundary that used to be a bare `} catch { return false }`.
    /// `ConvexClient` already produces every one of these causes; nothing about
    /// the transport changes here.
    static func classify(_ error: Error) -> ConvexWriteResult {
        switch error {
        case let convex as ConvexError:
            switch convex {
            case .notConfigured:
                return .notConfigured
            case .networkError:
                return .failed(.transport)
            case let .httpError(status):
                return status == 401 || status == 403
                    ? .unauthorized
                    : .failed(.http(status: status))
            case .decodeFailed:
                return .failed(.malformedResponse)
            case .noData:
                // Android calls this Missing: the call succeeded and the answer
                // was null.
                return .missing
            case .serverError:
                return .failed(.serverRejected)
            case .unauthorized:
                return .unauthorized
            case .rowAPIUnavailable:
                return .failed(.rowAPIUnavailable)
            }

        case let row as ConvexRowMutationError:
            switch row {
            case let .fractionalMinorUnit(field), let .minorUnitOverflow(field):
                return .failed(.invalidAmount(field: field))
            case let .ownerMismatch(field, _, _):
                return .failed(.ownerMismatch(field: field))
            case .unexpectedResponse:
                return .failed(.malformedResponse)
            case .bitcoinPostingRequiresTypedSatsAndAccount:
                // A Bitcoin-native source must post typed sats to a named
                // account; the guard refuses before any network call, so the
                // write failed locally, not on the wire.
                return .failed(.invalidAmount(field: "transaction.amountSats"))
            }

        case let validation as TransactionWriteValidationError:
            switch validation {
            case .ownerMismatch:
                return .failed(.ownerMismatch(field: "transaction"))
            case .transactionMustBeNonZero, .incomeMustBePositive:
                return .failed(.invalidAmount(field: "transaction.amount"))
            }

        case let writeback as AppWritebackError:
            switch writeback {
            case .notConfigured, .invalidPairingURL:
                // No paired-device credential exists, or the one we have can no
                // longer be claimed. Android refuses the same state up front.
                return .unauthorized
            case .invalidBaseURL:
                return .notConfigured
            case let .httpError(status):
                return status == 401 || status == 403
                    ? .unauthorized
                    : .failed(.http(status: status))
            case .serverError:
                return .failed(.serverRejected)
            case .credentialStorageFailed:
                return .failed(.credentialStorage)
            case .unexpectedResponse:
                return .failed(.malformedResponse)
            case let .remote(code):
                switch code {
                case .deviceUnauthorized:
                    return .unauthorized
                case .profileBindingRequired:
                    return .failed(.profileBindingRequired)
                case .revisionRequired:
                    return .failed(.revisionRequired)
                case .entityConflict:
                    return .failed(.staleWrite)
                case .entityDeleted, .entityNotFound:
                    return .failed(.entityUnavailable)
                case .ownerMismatch, .ownerSourceMismatch:
                    return .failed(.ownerMismatch(field: "todo"))
                case .validationFailed:
                    return .failed(.serverRejected)
                }
            }

        case is AppWriteSyncError:
            return .failed(.malformedResponse)

        case is EncodingError:
            return .failed(.payloadEncoding)

        case is DecodingError:
            return .failed(.malformedResponse)

        case is CancellationError:
            return .failed(.cancelled)

        default:
            // URLError and Foundation I/O land here; every
            // remaining thrower on these paths is a request that never completed.
            return .failed(.transport)
        }
    }

    /// Whether another attempt could plausibly change the outcome.
    ///
    /// A missing credential, an unwritable amount and a profile mismatch are
    /// deterministic. Retrying them burned three attempts and four seconds of the
    /// user's time to reach the same rejection.
    var isRetryable: Bool {
        switch self {
        case .ok:
            false
        case .unauthorized, .notConfigured, .disabled:
            false
        case .missing:
            true
        case let .failed(failure):
            switch failure {
            case .invalidAmount, .ownerMismatch, .payloadEncoding, .credentialStorage, .cancelled,
                 .profileBindingRequired, .revisionRequired, .staleWrite, .entityUnavailable:
                false
            case .transport:
                true
            case .rowAPIUnavailable, .serverRejected, .malformedResponse:
                false
            case let .http(status):
                status == 408 || status == 425 || status == 429 || (500 ... 599).contains(status)
            }
        }
    }

    /// Authored diagnostic text only. It never contains response bodies,
    /// localized transport details, user-entered labels, or credentials.
    var diagnosticCode: String {
        switch self {
        case .ok: "ok"
        case .disabled: "disabled"
        case .notConfigured: "not_configured"
        case .unauthorized: "unauthorized"
        case .missing: "missing"
        case let .failed(failure):
            switch failure {
            case .payloadEncoding: "payload_encoding"
            case .rowAPIUnavailable: "row_api_unavailable"
            case .transport: "transport"
            case .cancelled: "cancelled"
            case .credentialStorage: "credential_storage"
            case .serverRejected: "server_rejected"
            case .malformedResponse: "malformed_response"
            case .invalidAmount: "invalid_amount"
            case .ownerMismatch: "owner_mismatch"
            case .profileBindingRequired: "PROFILE_BINDING_REQUIRED"
            case .revisionRequired: "REVISION_REQUIRED"
            case .staleWrite: "ENTITY_CONFLICT"
            case .entityUnavailable: "ENTITY_NOT_FOUND"
            case let .http(status): "http_\(status)"
            }
        }
    }

    /// The user-visible message for this outcome, keyed off the operation label.
    ///
    /// Messages are operation-scoped so todo, budget, pairing, and transaction
    /// failures never masquerade as one another.
    func userMessage(operation: String) -> String? {
        switch self {
        case .ok:
            nil
        case .unauthorized:
            "The sync credential is missing or was rejected"
        case .notConfigured:
            "\(operation) writing is not configured"
        case .disabled:
            "\(operation) writing is disabled"
        case .missing:
            "Convex returned no write result"
        case let .failed(failure):
            "\(operation) was not saved (\(failure.wireReason))"
        }
    }
}
