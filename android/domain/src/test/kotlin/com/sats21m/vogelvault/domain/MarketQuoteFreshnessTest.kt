package com.sats21m.vogelvault.domain

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MarketQuoteFreshnessTest {
    private val observed = Instant.parse("2026-08-27T12:00:00Z").toEpochMilli()
    private val quote = MarketQuote(
        symbol = MarketSymbol.BTC,
        priceCents = 10_000_000L,
        source = "Kraken",
        fetchedAt = "2026-08-27T12:00:00Z",
        status = MarketQuoteStatus.LIVE,
    )

    @Test
    fun `freshness boundaries and future timestamps fail honestly`() {
        assertEquals(MarketQuoteStatus.LIVE, quote.at(observed + 15 * 60_000L - 1).status)
        assertEquals(MarketQuoteStatus.STALE, quote.at(observed + 15 * 60_000L).status)
        assertEquals(MarketQuoteStatus.STALE, quote.at(observed + 24 * 60 * 60_000L).status)
        val expired = quote.at(observed + 24 * 60 * 60_000L + 1)
        assertEquals(MarketQuoteStatus.UNAVAILABLE, expired.status)
        assertNull(expired.priceCents)
        assertEquals(MarketQuoteStatus.UNAVAILABLE, quote.at(observed - 1).status)
    }

    @Test
    fun `provider failure remains cached even inside live window`() {
        val failed = quote.copy(
            status = MarketQuoteStatus.STALE,
            lastAttemptedAt = "2026-08-27T12:05:00Z",
            errorCode = MarketQuoteErrorCode.TIMEOUT,
        )
        assertEquals(MarketQuoteStatus.STALE, failed.at(observed + 5 * 60_000L).status)
        assertEquals(5L, failed.ageMinutesAt(observed + 5 * 60_000L))
    }
}
