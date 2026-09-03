package com.sats21m.vogelvault.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import java.math.BigDecimal

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
    fun `formats Long MIN exactly in BTC SATS and USD`() {
        assertEquals("-92233720368.54775808", Money.formatMinorUnits(Long.MIN_VALUE, 8))
        assertEquals("-92233720368.54775808 BTC", Money.formatBtc(Long.MIN_VALUE))
        assertEquals("-9 223 372 036 854 775 808 sats", Money.formatSats(Long.MIN_VALUE))
        assertEquals("-$92,233,720,368,547,758.08", Money.formatUsd(Long.MIN_VALUE))
        assertEquals(
            "-$92,233,720,368,547,758.08",
            Money.formatBitcoin(Long.MIN_VALUE, DisplayUnit.USD, Money.SATS_PER_BTC),
        )
    }

    @Test
    fun `display unit names match the Apple client and survive persistence`() {
        assertEquals(listOf("btc", "sats", "usd"), DisplayUnit.entries.map { it.storageKey })
        assertEquals(listOf("BTC", "SATS", "USD"), DisplayUnit.entries.map { it.label })
        assertEquals(DisplayUnit.SATS, DisplayUnit.fromStorageKey("sats"))
        assertEquals(DisplayUnit.BTC, DisplayUnit.fromStorageKey("unknown"))
        assertEquals(DisplayUnit.BTC, DisplayUnit.fromStorageKey(null))
    }

    @Test
    fun `formats exact BTC boundaries without precision loss`() {
        val cases = listOf(
            1L to "0.00000001 BTC",
            99_999_999L to "0.99999999 BTC",
            Money.SATS_PER_BTC to "1.00000000 BTC",
            2_100_000_000_000_000L to "21000000.00000000 BTC",
        )

        for ((sats, expected) in cases) {
            assertEquals(expected, Money.formatBitcoin(sats, DisplayUnit.BTC))
        }
    }

    @Test
    fun `formats each Bitcoin display mode from integer minor units`() {
        val sats = 123_456_789L
        val priceCents = 9_500_000L

        assertEquals("1.23456789 BTC", Money.formatBitcoin(sats, DisplayUnit.BTC))
        assertEquals("123 456 789 sats", Money.formatBitcoin(sats, DisplayUnit.SATS))
        assertEquals("$117,283.95", Money.formatBitcoin(sats, DisplayUnit.USD, priceCents))
    }

    @Test
    fun `fiat display is unavailable without a known positive price`() {
        assertEquals(Money.PRICE_UNAVAILABLE, Money.formatBitcoin(1L, DisplayUnit.USD))
        assertEquals(Money.PRICE_UNAVAILABLE, Money.formatBitcoin(1L, DisplayUnit.USD, 0L))
        assertEquals(Money.PRICE_UNAVAILABLE, Money.formatBitcoin(1L, DisplayUnit.USD, -1L))
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
    fun `conversion overflow fails instead of wrapping`() {
        assertFailsWith<ArithmeticException> {
            Money.satsToUsdCents(Long.MAX_VALUE, Long.MAX_VALUE)
        }
        assertFailsWith<ArithmeticException> {
            Money.usdCentsToSats(Long.MAX_VALUE, 1L)
        }
        assertFailsWith<ArithmeticException> {
            Money.sharesToValueCents("999999999999.999999999999", 10_000_000L)
        }
    }

    @Test
    fun `share quantities reject overbound values before arithmetic`() {
        assertFailsWith<IllegalArgumentException> {
            Money.sharesToValueCents("1000000000000", 1L)
        }
    }

    @Test
    fun `basisPoints guards divide by zero`() {
        assertEquals(5000, Money.basisPoints(50L, 100L))
        assertEquals(0, Money.basisPoints(0L, 100L))
        assertEquals(0, Money.basisPoints(100L, 0L))
    }

    @Test
    fun `parsePositiveAmount strips adornments and refuses non-positive input`() {
        assertEquals("1234.56", Money.parsePositiveAmount(" $1,234.56 ").toPlainString())
        assertEquals("12.34", Money.parsePositiveAmount("₿12.34").toPlainString())
        assertEquals("0.50", Money.parsePositiveAmount("0.50").toPlainString())

        assertEquals("Enter an amount", assertFailsWith<IllegalArgumentException> {
            Money.parsePositiveAmount("   ")
        }.message)
        assertEquals("Enter a valid amount", assertFailsWith<IllegalArgumentException> {
            Money.parsePositiveAmount("abc")
        }.message)
        assertEquals("Amount must be positive", assertFailsWith<IllegalArgumentException> {
            Money.parsePositiveAmount("0.00")
        }.message)
    }

    @Test
    fun `exactMinorUnits converts exactly and refuses scale overflow`() {
        assertEquals(12_345L, Money.exactMinorUnits(BigDecimal("123.45"), 2, "USD"))
        assertEquals(100L, Money.exactMinorUnits(BigDecimal("1"), 2, "USD"))
        assertEquals(21_000_000L, Money.exactMinorUnits(BigDecimal("0.21"), 8, "BTC"))
        assertEquals(50_000_000L, Money.exactMinorUnits(BigDecimal("50000000"), 0, "sats"))

        assertEquals(
            "USD supports at most 2 decimal places",
            assertFailsWith<IllegalArgumentException> {
                Money.exactMinorUnits(BigDecimal("1.001"), 2, "USD")
            }.message,
        )
        assertEquals(
            "sats must be a whole number",
            assertFailsWith<IllegalArgumentException> {
                Money.exactMinorUnits(BigDecimal("1.5"), 0, "sats")
            }.message,
        )
    }

    @Test
    fun `exactPositiveMinorUnitsOrNull applies the sign policy or reports null`() {
        assertEquals(19_999L, Money.exactPositiveMinorUnitsOrNull("$199.99", 2, allowZero = false))
        assertEquals(999_999L, Money.exactPositiveMinorUnitsOrNull("9,999.99", 2, allowZero = false))
        assertEquals(0L, Money.exactPositiveMinorUnitsOrNull("0", 2, allowZero = true))
        assertEquals(null, Money.exactPositiveMinorUnitsOrNull("0", 2, allowZero = false))
        assertEquals(null, Money.exactPositiveMinorUnitsOrNull("-5.00", 2, allowZero = false))
        assertEquals(null, Money.exactPositiveMinorUnitsOrNull("1.001", 2, allowZero = false))
        assertEquals(null, Money.exactPositiveMinorUnitsOrNull("", 2, allowZero = false))
        assertEquals(null, Money.exactPositiveMinorUnitsOrNull("abc", 2, allowZero = false))
    }
}
