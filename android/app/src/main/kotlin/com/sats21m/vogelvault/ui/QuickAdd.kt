package com.sats21m.vogelvault.ui

import android.content.Context
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.Transaction
import java.math.BigDecimal
import java.math.RoundingMode

/** Defaults follow the canonical ledger owner, so child choices cannot seed adult drafts. */
internal class QuickAddDefaults(context: Context, owner: FamilyMember) {
    private val preferences = context.getSharedPreferences("quick-add-${owner.ledgerOwner.key}", Context.MODE_PRIVATE)
    fun category(): String = preferences.getString("category", "").orEmpty()
    fun source(): PaymentSource = PaymentSource.fromWireOrDefault(preferences.getString("source", null))
    fun selectSource(source: PaymentSource): Boolean = preferences.edit().putString("source", source.wire).commit()
    fun accept(category: String, source: PaymentSource) {
        preferences.edit().putString("category", category).putString("source", source.wire).apply()
    }
}

internal data class QuickAddSuggestions(val merchants: List<String>, val categories: List<String>, val lastCategory: String?)

internal fun quickAddSuggestions(rows: List<Transaction>, viewer: FamilyMember, categories: List<String>): QuickAddSuggestions {
    val owned = rows.filter { it.owner.ledgerOwner == viewer.ledgerOwner }.sortedByDescending { it.date }
    val counts = owned.groupingBy { it.category }.eachCount()
    return QuickAddSuggestions(
        merchants = owned.map { it.merchant.trim() }.filter { it.isNotEmpty() }.distinct().take(6),
        categories = categories.distinct().sortedByDescending { counts[it] ?: 0 }.take(6),
        lastCategory = owned.firstOrNull { it.category in categories }?.category,
    )
}

internal fun quickAddAmountError(amount: String, unit: DisplayUnit): String? = runCatching {
    val scale = when (unit) { DisplayUnit.USD -> 2; DisplayUnit.BTC -> 8; DisplayUnit.SATS -> 0 }
    require(Money.exactMinorUnits(Money.parsePositiveAmount(amount), scale, unit.name) > 0L) { "Enter a positive amount" }
}.exceptionOrNull()?.message

internal data class DerivedBitcoinBuy(val sats: String, val priceUsd: String, val purchaseUsd: String)

/** A quote supplies price only when the user has not supplied two receipt fields. */
internal fun deriveBitcoinBuy(sats: String, priceUsd: String, purchaseUsd: String, quoteCents: Long = 0): Result<DerivedBitcoinBuy> = runCatching {
    val entered = listOf(sats, priceUsd, purchaseUsd).count { it.isNotBlank() }
    require(entered >= 2 || (entered == 1 && priceUsd.isBlank() && quoteCents > 0)) { "Enter any two of sats, price and dollars" }
    var quantity = sats.takeIf { it.isNotBlank() }?.let {
        it.trim().toLongOrNull()?.takeIf { value -> value > 0 } ?: error("Sats must be a positive whole number")
    }
    fun cents(text: String): Long? = text.takeIf { it.isNotBlank() }?.let {
        Money.exactPositiveMinorUnitsOrNull(it, 2, allowZero = false) ?: error("Use a positive dollar amount with at most two decimals")
    }
    var price = cents(priceUsd)
    var dollars = cents(purchaseUsd)
    if (price == null && entered < 2) price = quoteCents
    if (quantity == null) quantity = Money.usdCentsToSats(checkNotNull(dollars), checkNotNull(price))
    if (price == null) price = BigDecimal(checkNotNull(dollars)).multiply(BigDecimal("100000000"))
        .divide(BigDecimal(quantity), 0, RoundingMode.HALF_UP).longValueExact()
    if (dollars == null) dollars = Money.satsToUsdCents(quantity, price)
    require(quantity > 0 && price > 0 && dollars > 0) { "Amount is below one sat or one cent" }
    fun usd(value: Long) = BigDecimal(value).movePointLeft(2).setScale(2).toPlainString()
    DerivedBitcoinBuy(quantity.toString(), usd(price), usd(dollars))
}
