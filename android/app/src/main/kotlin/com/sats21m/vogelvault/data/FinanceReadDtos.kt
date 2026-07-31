package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.FinanceAccount
import com.sats21m.vogelvault.domain.FinanceDocument
import com.sats21m.vogelvault.domain.FinanceHolding
import com.sats21m.vogelvault.domain.FinanceLot
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteSnapshot
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import java.math.BigDecimal
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class FinanceDocumentSnapshot(
    val document: FinanceDocument?,
    val complete: Boolean,
)

data class MarketQuoteReadSnapshot(
    val snapshot: MarketQuoteSnapshot,
    val complete: Boolean,
)

internal object FinanceReadDecoder {
    fun financeDocument(element: JsonElement): FinanceDocumentSnapshot? {
        val envelope = element as? JsonObject ?: return null
        val complete = envelope.requiredBoolean("complete") ?: return null
        val encodedDocument = envelope["document"] ?: return null
        if (encodedDocument is JsonNull) return FinanceDocumentSnapshot(null, complete)
        val document = decodeFinanceDocument(encodedDocument as? JsonObject ?: return null)
            ?: return null
        return FinanceDocumentSnapshot(document, complete)
    }

    fun marketQuotes(element: JsonElement): MarketQuoteReadSnapshot? {
        val envelope = element as? JsonObject ?: return null
        val complete = envelope.requiredBoolean("complete") ?: return null
        val encodedQuotes = envelope["quotes"] as? JsonArray ?: return null
        val quotes = encodedQuotes.map { decodeMarketQuote(it as? JsonObject ?: return null) ?: return null }
        val snapshot = try {
            MarketQuoteSnapshot(quotes)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return MarketQuoteReadSnapshot(snapshot, complete)
    }

    private fun decodeFinanceDocument(row: JsonObject): FinanceDocument? {
        val retirementTotal = row.optionalInt64("retirementTotalCents") ?: return null
        return FinanceDocument(
            updatedAtMs = row.requiredLong("updatedAtMs") ?: return null,
            lastUpdated = row.nonEmptyString("lastUpdated") ?: return null,
            retirementTotalCents = retirementTotal.value,
            accounts = row.objectArray("accounts", ::decodeFinanceAccount) ?: return null,
        )
    }

    private fun decodeFinanceAccount(row: JsonObject): FinanceAccount? {
        val contributionDay = row.optionalString("weeklyContributionDay") ?: return null
        return FinanceAccount(
            key = row.nonEmptyString("key") ?: return null,
            owner = FamilyMember.fromKeyOrNull(row.nonEmptyString("owner")) ?: return null,
            provider = row.nonEmptyString("provider") ?: return null,
            totalValueCents = row.int64("totalValueCents") ?: return null,
            weeklyContributionCents = row.int64("weeklyContributionCents") ?: return null,
            weeklyContributionDay = contributionDay.value,
            holdings = row.objectArray("holdings", ::decodeFinanceHolding) ?: return null,
        )
    }

    private fun decodeFinanceHolding(row: JsonObject): FinanceHolding? {
        val ticker = row.optionalString("ticker") ?: return null
        val proxyNote = row.optionalString("proxyNote") ?: return null
        return FinanceHolding(
            name = row.nonEmptyString("name") ?: return null,
            category = row.nonEmptyString("category") ?: return null,
            ticker = ticker.value,
            valueCents = row.int64("valueCents") ?: return null,
            costBasisCents = row.int64("costBasisCents") ?: return null,
            gainBps = row.int64("gainBps") ?: return null,
            sharesDecimal = row.exactDecimal("sharesDecimal") ?: return null,
            avgCostCents = row.int64("avgCostCents") ?: return null,
            currentPricePerShareCents = row.int64("currentPricePerShareCents") ?: return null,
            isProxy = row.requiredBoolean("isProxy") ?: return null,
            proxyNote = proxyNote.value,
            lots = row.objectArray("lots", ::decodeFinanceLot) ?: return null,
        )
    }

    private fun decodeFinanceLot(row: JsonObject): FinanceLot? {
        val note = row.optionalString("note") ?: return null
        return FinanceLot(
            date = row.nonEmptyString("date") ?: return null,
            type = row.nonEmptyString("type") ?: return null,
            pricePerShareCents = row.int64("pricePerShareCents") ?: return null,
            sharesDecimal = row.exactDecimal("sharesDecimal") ?: return null,
            amountInvestedCents = row.int64("amountInvestedCents") ?: return null,
            note = note.value,
        )
    }

    private fun decodeMarketQuote(row: JsonObject): MarketQuote? {
        val symbol = when (row.nonEmptyString("symbol")) {
            "BTC" -> MarketSymbol.BTC
            "VOO" -> MarketSymbol.VOO
            "IBIT" -> MarketSymbol.IBIT
            else -> return null
        }
        val status = when (row.nonEmptyString("status")) {
            "live" -> MarketQuoteStatus.LIVE
            "stale" -> MarketQuoteStatus.STALE
            "unavailable" -> MarketQuoteStatus.UNAVAILABLE
            else -> return null
        }
        val price = row.optionalInt64("priceCents") ?: return null
        val fetchedAt = row.optionalString("fetchedAt") ?: return null
        return try {
            MarketQuote(
                symbol = symbol,
                priceCents = price.value,
                source = row.nonEmptyString("source") ?: return null,
                fetchedAt = fetchedAt.value,
                status = status,
            )
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}

private data class OptionalValue<T>(val value: T?)

private fun JsonObject.nonEmptyString(key: String): String? =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }

private fun JsonObject.int64(key: String): Long? = get(key)?.decodeConvexInt64OrNull()

private fun JsonObject.optionalString(key: String): OptionalValue<String>? =
    optional(key) { element ->
        (element as? JsonPrimitive)?.takeIf { it.isString }?.content
    }

private fun JsonObject.optionalInt64(key: String): OptionalValue<Long>? =
    optional(key, JsonElement::decodeConvexInt64OrNull)

private inline fun <T> JsonObject.optional(
    key: String,
    decode: (JsonElement) -> T?,
): OptionalValue<T>? {
    if (!containsKey(key) || getValue(key) is JsonNull) return OptionalValue(null)
    return OptionalValue(decode(getValue(key)) ?: return null)
}

private fun JsonObject.exactDecimal(key: String): String? {
    val value = nonEmptyString(key) ?: return null
    return try {
        BigDecimal(value)
        value
    } catch (_: NumberFormatException) {
        null
    }
}

private fun <T> JsonObject.objectArray(
    key: String,
    decode: (JsonObject) -> T?,
): List<T>? {
    val encoded = get(key) as? JsonArray ?: return null
    val decoded = ArrayList<T>(encoded.size)
    for (element in encoded) {
        decoded += decode(element as? JsonObject ?: return null) ?: return null
    }
    return decoded
}
