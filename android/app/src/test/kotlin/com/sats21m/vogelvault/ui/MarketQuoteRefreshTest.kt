package com.sats21m.vogelvault.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.coroutines.runBlocking

class MarketQuoteRefreshTest {
    private class Stop : RuntimeException()

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
