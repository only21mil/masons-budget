package com.sats21m.vogelvault.data.cache

import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Stable, credential-free identities for the row queries B3 fetches.
 *
 * Tokens are deliberately absent: rotating a read token must not orphan valid
 * cached data, and a secret must never become a Room primary-key value. Every
 * response-shaping argument is included so two query shapes cannot activate each
 * other's generations.
 */
object CacheQueryKeys {
    fun transactions(
        viewer: String,
        month: String? = null,
        limit: Long? = null,
    ): String = key("transactions", "viewer" to viewer, "month" to month, "limit" to limit?.toString())

    fun todos(
        viewer: String,
        done: Boolean? = null,
        limit: Long? = null,
    ): String = key("todos", "viewer" to viewer, "done" to done?.toString(), "limit" to limit?.toString())

    fun btcBuys(
        viewer: String,
        scope: String,
        month: String? = null,
        limit: Long? = null,
    ): String =
        key(
            "btc_buys",
            "viewer" to viewer,
            "scope" to scope,
            "month" to month,
            "limit" to limit?.toString(),
        )

    fun btcAccounts(
        viewer: String,
        scope: String,
    ): String = key("btc_accounts", "viewer" to viewer, "scope" to scope)

    private fun key(
        kind: String,
        vararg values: Pair<String, String?>,
    ): String =
        buildString {
            append(kind)
            for ((name, value) in values) {
                if (value == null) continue
                append('|')
                append(name)
                append('=')
                append(URLEncoder.encode(value, StandardCharsets.UTF_8.name()))
            }
        }
}
