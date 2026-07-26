package com.sats21m.vogelvault.data

/**
 * The outcome of a Convex read.
 *
 * A sealed result rather than exceptions, because "we are switched off" and "we
 * are not configured" are ordinary states of this feature, not failures, and
 * throwing for them would push a try/catch into every future call site.
 *
 * The states are split the way the read-token cutover needs them split:
 * [Unauthorized] is not [Failed]. Once the deployment stops allowing tokenless
 * reads, a client that is not sending a valid token gets a specific,
 * recognisable answer instead of disappearing into a generic error — which is
 * the difference between diagnosing the cutover and guessing at it.
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

    /**
     * Everything else.
     *
     * [reason] is drawn from a small set of strings this package authors itself.
     * Server text is deliberately not propagated: a reason ends up in a log
     * eventually, and a response body from this deployment can contain the
     * household's financial data.
     */
    data class Failed(val reason: String) : ConvexResult<Nothing>()

    val isOk: Boolean get() = this is Ok<*>

    fun valueOrNull(): T? = when (this) {
        is Ok -> value
        else -> null
    }
}
