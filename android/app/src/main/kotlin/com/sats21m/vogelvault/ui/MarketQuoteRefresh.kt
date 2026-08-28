package com.sats21m.vogelvault.ui

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

internal const val MARKET_QUOTE_REFRESH_MILLIS = 5 * 60 * 1_000L

/** Refresh immediately, then every five minutes until the STARTED scope stops. */
internal suspend fun refreshMarketQuotesPeriodically(
    intervalMillis: Long = MARKET_QUOTE_REFRESH_MILLIS,
    refresh: () -> Unit,
    wait: suspend (Long) -> Unit = { delay(it) },
) {
    require(intervalMillis > 0L)
    while (currentCoroutineContext().isActive) {
        refresh()
        wait(intervalMillis)
    }
}
