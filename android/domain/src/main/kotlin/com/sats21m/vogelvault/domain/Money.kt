package com.sats21m.vogelvault.domain

import java.math.BigDecimal
import java.math.BigInteger
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
    const val SHARES_DECIMAL_MAX_INTEGER_DIGITS = 12
    const val SHARES_DECIMAL_MAX_SCALE = 12
    const val SHARES_DECIMAL_MAX_PRECISION = 24
    const val SHARES_DECIMAL_MAX_LENGTH = 25

    /** A signed lot quantity spends one extra character on the leading minus. */
    const val SHARES_DECIMAL_SIGNED_MAX_LENGTH = SHARES_DECIMAL_MAX_LENGTH + 1

    private const val USD_SCALE = 2
    private const val BTC_SCALE = 8

    /**
     * The sign group is always captured so the digit groups keep stable indices;
     * a leading minus is only *accepted* when the caller opts into signed
     * quantities. Exponents, whitespace, leading-zero ambiguity, and a bare "1."
     * stay refused.
     */
    private val sharesDecimalPattern = Regex("^(-?)(0|[1-9]\\d*)(?:\\.(\\d+))?$")

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
        val digits = magnitudeDigits(amount).padStart(scale + 1, '0')
        val whole = digits.substring(0, digits.length - scale)
        val frac = if (scale > 0) "." + digits.substring(digits.length - scale) else ""
        return (if (negative) "-" else "") + whole + frac
    }

    fun formatUsd(cents: Long, showSign: Boolean = false): String {
        val negative = cents < 0
        val plain = formatMinorUnits(cents, USD_SCALE).removePrefix("-")
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
        val grouped = group(magnitudeDigits(sats), " ")
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
            .longValueExact()
    }

    /**
     * Convert USD cents to satoshis at a positive integer-cent BTC price.
     *
     * Unknown/non-positive prices are refused rather than presented as zero.
     */
    fun usdCentsToSats(cents: Long, btcPriceCents: Long): Long {
        require(btcPriceCents > 0L) { "BTC price must be positive integer cents: $btcPriceCents" }
        return BigDecimal(cents)
            .multiply(BigDecimal(SATS_PER_BTC))
            .divide(BigDecimal(btcPriceCents), 0, RoundingMode.HALF_UP)
            .longValueExact()
    }

    /**
     * Return [value] only when it matches the bounded exact shares wire contract.
     *
     * Holdings are position sizes and stay unsigned; a lot passes [signed] =
     * true, because a statement-reconciliation lot removes shares and is stored
     * as a negative quantity. Minus zero is refused either way: it spells one
     * value two ways and so is not canonical. The server canonicalizes before
     * writing, so this side only asserts — it never repairs.
     */
    fun sharesDecimalOrNull(value: String?, signed: Boolean = false): String? {
        val maxLength =
            if (signed) SHARES_DECIMAL_SIGNED_MAX_LENGTH else SHARES_DECIMAL_MAX_LENGTH
        if (value == null || value.length > maxLength) return null
        val match = sharesDecimalPattern.matchEntire(value) ?: return null
        val negative = match.groupValues[1] == "-"
        val whole = match.groupValues[2]
        val fraction = match.groupValues[3]
        if (negative && (!signed || isZeroMagnitude(whole, fraction))) return null
        if (
            whole.length > SHARES_DECIMAL_MAX_INTEGER_DIGITS ||
            fraction.length > SHARES_DECIMAL_MAX_SCALE ||
            whole.length + fraction.length > SHARES_DECIMAL_MAX_PRECISION
        ) return null
        return value
    }

    fun requireSharesDecimal(value: String, signed: Boolean = false): String =
        requireNotNull(sharesDecimalOrNull(value, signed)) {
            "Not a canonical share quantity: $value"
        }

    /**
     * Value an exact lexical share quantity at an integer-cent share price.
     *
     * Only holding quantities reach this today, so the default stays unsigned
     * and a negative holding still throws. `BigDecimal` carries the sign
     * exactly, and HALF_UP rounds away from zero on both sides.
     */
    fun sharesToValueCents(
        sharesDecimal: String,
        pricePerShareCents: Long,
        signed: Boolean = false,
    ): Long =
        BigDecimal(requireSharesDecimal(sharesDecimal, signed))
            .multiply(BigDecimal(pricePerShareCents))
            .setScale(0, RoundingMode.HALF_UP)
            .longValueExact()

    /** Percentage of [part] against [whole] in basis points, guarding zero. */
    fun basisPoints(part: Long, whole: Long): Int {
        if (whole == 0L) return 0
        return BigDecimal(part)
            .multiply(BigDecimal(10_000))
            .divide(BigDecimal(whole), 0, RoundingMode.DOWN)
            .toInt()
    }

    /** The pattern forbids leading zeroes, so "0" is the only zero whole part. */
    private fun isZeroMagnitude(whole: String, fraction: String): Boolean =
        whole == "0" && fraction.none { it in '1'..'9' }

    private fun group(digits: String, separator: String): String {
        val builder = StringBuilder()
        for ((index, char) in digits.withIndex()) {
            if (index > 0 && (digits.length - index) % 3 == 0) builder.append(separator)
            builder.append(char)
        }
        return builder.toString()
    }

    /** `Long.MIN_VALUE` has no positive `Long`; take its magnitude outside Long arithmetic. */
    private fun magnitudeDigits(value: Long): String =
        BigInteger.valueOf(value).abs().toString()
}
