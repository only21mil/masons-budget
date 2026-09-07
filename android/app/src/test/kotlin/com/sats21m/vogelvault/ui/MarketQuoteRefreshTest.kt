package com.sats21m.vogelvault.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch

class MarketQuoteRefreshTest {
    private class Stop : RuntimeException()

    @Test
    fun `stopping the foreground scope cancels an in-flight quote read and future ticks`() = runBlocking {
        var attempts = 0
        var cancelled = false
        var waits = 0
        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            refreshMarketQuotesPeriodically(
                refresh = {
                    attempts++
                    try { awaitCancellation() } finally { cancelled = true }
                },
                wait = { waits++ },
            )
        }
        job.cancelAndJoin()
        assertEquals(1, attempts)
        assertEquals(true, cancelled)
        assertEquals(0, waits)
    }

    @Test
    fun `refresh runs immediately and waits five minutes between attempts`() {
        var refreshes = 0
        val waits = mutableListOf<Long>()

        assertFailsWith<Stop> {
            runBlocking {
                refreshMarketQuotesPeriodically(
                    refresh = { refreshes += 1 },
                    wait = { millis ->
                        waits += millis
                        if (waits.size == 2) throw Stop()
                    },
                )
            }
        }

        assertEquals(2, refreshes)
        assertEquals(listOf(MARKET_QUOTE_REFRESH_MILLIS, MARKET_QUOTE_REFRESH_MILLIS), waits)
    }
}
