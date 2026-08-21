package com.sats21m.vogelvault.data

/**
 * A closed, secret-free diagnosis for a failed Convex request.
 *
 * Failures deliberately retain no response body, server message, URL, request
 * arguments, or exception text. [Http] keeps only the status code because it is
 * useful for diagnosis and cannot contain household data.
 */
sealed interface ConvexFailure {
    /** The request did not produce an HTTP response. */
    data object Transport : ConvexFailure

    /** Convex or an intermediary returned a non-success HTTP status. */
    data class Http(val statusCode: Int) : ConvexFailure

    /** The deployment reported that its read-auth configuration is missing. */
    data object DeploymentMisconfigured : ConvexFailure

    /** Convex accepted the HTTP request but rejected the server/query operation. */
    data class ServerRejected(
        val kind: ConvexServerRejection = ConvexServerRejection.GENERIC_ERROR,
    ) : ConvexFailure

    /** The response was not a JSON object with a readable Convex envelope. */
    data object MalformedResponse : ConvexFailure

    /** The response was JSON, but its Convex envelope or value was invalid. */
    data object InvalidResponse : ConvexFailure

    /**
     * Stable, non-sensitive copy for call sites that still render a reason.
     * New classification code should switch on [ConvexFailure] instead.
     */
    val safeReason: String
        get() = when (this) {
            Transport -> "transport failure (IOException)"
            is Http -> "http $statusCode"
            DeploymentMisconfigured -> "convex deployment misconfigured"
            is ServerRejected -> kind.safeReason
            MalformedResponse -> "malformed response envelope"
            InvalidResponse -> "unrecognised response envelope"
        }

    companion object {
        /**
         * Temporary source-compatibility for existing mutation and test callers.
         * The input is classified and discarded; it is never retained or echoed.
         */
        internal fun fromLegacyReason(reason: String): ConvexFailure {
            val httpStatus = HTTP_REASON.matchEntire(reason)?.groupValues?.get(1)?.toIntOrNull()
            return when {
                reason.startsWith("transport failure", ignoreCase = true) -> Transport
                httpStatus != null -> Http(httpStatus)
                reason.contains("deployment misconfigured", ignoreCase = true) ->
                    DeploymentMisconfigured
                reason.contains("malformed", ignoreCase = true) -> MalformedResponse
                reason.contains("unrecognised", ignoreCase = true) ||
                    reason.contains("unexpected payload", ignoreCase = true) ||
                    reason.contains("invalid write response", ignoreCase = true) ||
                    reason.contains("decode", ignoreCase = true) -> InvalidResponse
                else -> ServerRejected(ConvexServerRejection.fromLegacyReason(reason))
            }
        }

        private val HTTP_REASON = Regex("http ([0-9]{3})", RegexOption.IGNORE_CASE)
    }
}

/** Allow-listed server rejection detail retained for existing write UX. */
enum class ConvexServerRejection(internal val safeReason: String) {
    GENERIC_ERROR("convex error"),
    GENERIC_REJECTION("convex rejection"),
    TASK_CHANGED("task changed on another device"),
    TASK_DELETED("task was deleted on another device"),
    TASK_MISSING("task no longer exists"),
    OWNER_REJECTED("task owner was rejected"),
    VALIDATION_REJECTED("task was rejected as invalid"),
    ;

    companion object {
        internal fun fromLegacyReason(reason: String): ConvexServerRejection = when (reason) {
            GENERIC_REJECTION.safeReason -> GENERIC_REJECTION
            TASK_CHANGED.safeReason -> TASK_CHANGED
            TASK_DELETED.safeReason -> TASK_DELETED
            TASK_MISSING.safeReason -> TASK_MISSING
            OWNER_REJECTED.safeReason -> OWNER_REJECTED
            VALIDATION_REJECTED.safeReason -> VALIDATION_REJECTED
            else -> GENERIC_ERROR
        }
    }
}

/**
 * The outcome of a Convex read.
 *
 * A sealed result rather than exceptions, because "we are switched off" and "we
 * are not configured" are ordinary states of this feature, not failures, and
 * throwing for them would push a try/catch into every future call site.
 *
 * The states are split the way the read-token cutover needs them split:
 * [Unauthorized] is not [Failed]. A missing local credential is refused before
 * network I/O, while a server rejection of an invalid credential produces the
 * same specific result instead of disappearing into a generic transport error.
 */
sealed class ConvexResult<out T> {

    data class Ok<out T>(val value: T) : ConvexResult<T>()

    /** The kill switch is off. No request was made. */
    object Disabled : ConvexResult<Nothing>()

    /** Switched on, but with no usable HTTPS deployment URL. No request was made. */
    object NotConfigured : ConvexResult<Nothing>()

    /** The deployment is enforcing read auth and rejected what we sent (or did not send). */
    object Unauthorized : ConvexResult<Nothing>()

    /** The query succeeded and the answer was null — the deployment has no such file. */
    object Missing : ConvexResult<Nothing>()

    /** Everything else, classified without retaining server or transport text. */
    data class Failed(val failure: ConvexFailure) : ConvexResult<Nothing>() {
        /** Compatibility copy derived only from the closed failure taxonomy. */
        val reason: String get() = failure.safeReason

        /**
         * Keeps existing callers source-compatible while they migrate. The
         * supplied text is reduced to an allow-listed [ConvexFailure] and then
         * discarded, so it cannot cross the result boundary.
         */
        constructor(reason: String) : this(ConvexFailure.fromLegacyReason(reason))
    }

    val isOk: Boolean get() = this is Ok<*>

    fun valueOrNull(): T? = when (this) {
        is Ok -> value
        else -> null
    }
}
