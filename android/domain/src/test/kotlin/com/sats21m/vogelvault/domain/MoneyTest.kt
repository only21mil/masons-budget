package com.sats21m.vogelvault.domain

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Money is Decimal, never Double (AGENTS.md). These cases mirror the TypeScript
 * money suite so the two clients round and format identically.
 */
class MoneyTest {

    @Test
    fun `parses plain decimal strings exactly`() {
        assertEquals(0L, Money.parseCents("0"))
        assertEquals(100L, Money.parseCents("1"))
        assertEquals(150L, Money.parseCents("1.5"))
        assertEquals(123456L, Money.parseCents("1234.56"))
        assertEquals(-9500L, Money.parseCents("-95"))
        assertEquals(-1L, Money.parseCents("-0.01"))
    }

    @Test
    fun `treats absent values as zero`() {
        assertEquals(0L, Money.parseCents(null))
        assertEquals(0L, Money.parseCents(""))
        assertEquals(0L, Money.parseCents("   "))
    }

    @Test
    fun `rounds half away from zero, matching NSDecimalNumber plain`() {
        assertEquals(101L, Money.parseCents("1.005"))
        assertEquals(100L, Money.parseCents("1.004"))
        assertEquals(-101L, Money.parseCents("-1.005"))
        assertEquals(268L, Money.parseCents("2.675"))
    }

    @Test
    fun `BTC parses to satoshis at 8 decimal places`() {
        assertEquals(Money.SATS_PER_BTC, Money.parseBtcToSats("1"))
        assertEquals(350_000_000L, Money.parseBtcToSats("3.5"))
        assertEquals(5_000_000L, Money.parseBtcToSats("0.05"))
        assertEquals(1_000_000L, Money.parseBtcToSats("0.01"))
        assertEquals(1L, Money.parseBtcToSats("0.00000001"))
        assertEquals(2_100_000_000_000_000L, Money.parseBtcToSats("21000000"))
    }

    @Test
    fun `sub-satoshi precision rounds rather than truncating`() {
        assertEquals(0L, Money.parseBtcToSats("0.000000004"))
        assertEquals(1L, Money.parseBtcToSats("0.000000005"))
    }

    @Test
    fun `formats USD with grouping and sign`() {
        assertEquals("$1,234.56", Money.formatUsd(123456L))
        assertEquals("$0.00", Money.formatUsd(0L))
        assertEquals("-$95.00", Money.formatUsd(-9500L))
        assertEquals("+$5.00", Money.formatUsd(500L, showSign = true))
        assertEquals("$1,000,000.00", Money.formatUsd(100_000_000L))
        assertEquals("$0.05", Money.formatUsd(5L))
    }

    @Test
    fun `formats sats and BTC`() {
        assertEquals("1 234 567 sats", Money.formatSats(1_234_567L))
        assertEquals("0 sats", Money.formatSats(0L))
        assertEquals("3.50000000 BTC", Money.formatBtc(350_000_000L))
        assertEquals("0.00000001 BTC", Money.formatBtc(1L))
    }

    @Test
    fun `converts sats to USD at a given price`() {
        // 0.05 BTC at $100,000 -> $5,000
        assertEquals(500_000L, Money.satsToUsdCents(5_000_000L, 10_000_000L))
        assertEquals(0L, Money.satsToUsdCents(0L, 10_000_000L))
        assertEquals(654_321L, Money.satsToUsdCents(Money.SATS_PER_BTC, 654_321L))
        assertEquals(-10_000_000L, Money.satsToUsdCents(-Money.SATS_PER_BTC, 10_000_000L))
    }

    @Test
    fun `basisPoints guards divide by zero`() {
        assertEquals(5000, Money.basisPoints(50L, 100L))
        assertEquals(0, Money.basisPoints(0L, 100L))
        assertEquals(0, Money.basisPoints(100L, 0L))
    }
}
