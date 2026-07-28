package com.sats21m.vogelvault.domain

import java.math.BigDecimal
import java.math.RoundingMode

/**
 * Bitcoin display choices, matching the Apple client's `DisplayUnit` names and
 * persisted raw values.
 */
enum class DisplayUnit(
    val storageKey: String,
    val label: String,
) {
    BTC("btc", "BTC"),
    SATS("sats", "SATS"),
    USD("usd", "USD");

    companion object {
        fun fromStorageKey(value: String?): DisplayUnit =
            entries.firstOrNull { it.storageKey == value } ?: BTC
    }
}

/**
 * The Vogel Vault — decimal-safe money, Kotlin mirror.
 *
 * Repo convention (AGENTS.md): "Money is Decimal, never Double." Kotlin has
 * `BigDecimal`, so parsing goes through it and lands in integer minor units:
 * USD as cents, BTC as satoshis. Nothing ever transits a `Double`.
 *
 * Rounding is HALF_UP, matching `NSDecimalNumber`'s `.plain` mode on the Swift
 * side and the TypeScript port's round-half-away-from-zero.
 */
object Money {

    const val SATS_PER_BTC: Long = 100_000_000L
    const val PRICE_UNAVAILABLE = "Price unavailable"

    private const val USD_SCALE = 2
    private const val BTC_SCALE = 8

    /** Parse a decimal value into integer minor units at [scale]. */
    fun parseMinorUnits(value: String?, scale: Int): Long {
        if (value.isNullOrBlank()) return 0L
        return BigDecimal(value.trim())
            .setScale(scale, RoundingMode.HALF_UP)
            .movePointRight(scale)
            .toLong()
    }

    fun parseCents(value: String?): Long = parseMinorUnits(value, USD_SCALE)

    /** BTC amounts carry 8 decimal places; the result is satoshis. */
    fun parseBtcToSats(value: String?): Long = parseMinorUnits(value, BTC_SCALE)

    fun formatMinorUnits(amount: Long, scale: Int): String {
        val negative = amount < 0
        val digits = kotlin.math.abs(amount).toString().padStart(scale + 1, '0')
        val whole = digits.substring(0, digits.length - scale)
        val frac = if (scale > 0) "." + digits.substring(digits.length - scale) else ""
        return (if (negative) "-" else "") + whole + frac
    }

    fun formatUsd(cents: Long, showSign: Boolean = false): String {
        val negative = cents < 0
        val plain = formatMinorUnits(kotlin.math.abs(cents), USD_SCALE)
        val parts = plain.split(".")
        val grouped = group(parts[0], ",")
        val sign = if (negative) "-" else if (showSign) "+" else ""
        return "$sign$$grouped.${parts[1]}"
    }

    /**
     * Sats with space grouping, e.g. "1 234 567 sats".
     *
     * An ASCII space, not U+202F: a narrow no-break space breaks copy-paste into
     * spreadsheets and trips the repo's non-ASCII static-text scans.
     */
    fun formatSats(sats: Long): String {
        val negative = sats < 0
        val grouped = group(kotlin.math.abs(sats).toString(), " ")
        return (if (negative) "-" else "") + grouped + " sats"
    }

    /** Sats as BTC with 8 dp, trailing zeros kept — ledger convention. */
    fun formatBtc(sats: Long): String = formatMinorUnits(sats, BTC_SCALE) + " BTC"

    /**
     * Format one integer satoshi value in the selected presentation unit.
     *
     * USD needs an explicitly supplied integer-cent price. Zero, a negative
     * value, or no price is unknown rather than "$0.00".
     */
    fun formatBitcoin(
        sats: Long,
        unit: DisplayUnit,
        btcPriceCents: Long? = null,
    ): String = when (unit) {
        DisplayUnit.BTC -> formatBtc(sats)
        DisplayUnit.SATS -> formatSats(sats)
        DisplayUnit.USD -> btcPriceCents
            ?.takeIf { it > 0L }
            ?.let { formatUsd(satsToUsdCents(sats, it)) }
            ?: PRICE_UNAVAILABLE
    }

    /** Convert sats to USD cents at a given BTC price (also in cents). */
    fun satsToUsdCents(sats: Long, btcPriceCents: Long): Long {
        val numerator = BigDecimal(sats).multiply(BigDecimal(btcPriceCents))
        return numerator
            .divide(BigDecimal(SATS_PER_BTC), 0, RoundingMode.HALF_UP)
            .toLong()
    }

    /** Percentage of [part] against [whole] in basis points, guarding zero. */
    fun basisPoints(part: Long, whole: Long): Int {
        if (whole == 0L) return 0
        return BigDecimal(part)
            .multiply(BigDecimal(10_000))
            .divide(BigDecimal(whole), 0, RoundingMode.DOWN)
            .toInt()
    }

    private fun group(digits: String, separator: String): String {
        val builder = StringBuilder()
        for ((index, char) in digits.withIndex()) {
            if (index > 0 && (digits.length - index) % 3 == 0) builder.append(separator)
            builder.append(char)
        }
        return builder.toString()
    }
}
