package com.sats21m.vogelvault.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class FinanceReadDecoderBoundsTest {
    @Test
    fun `finance arrays accept the shared Linux limits`() {
        val accounts = assertNotNull(
            FinanceReadDecoder.financeDocument(envelope(accountCount = 64)),
        ).document
        val holdings = assertNotNull(
            FinanceReadDecoder.financeDocument(envelope(holdingCount = 512)),
        ).document
        val lots = assertNotNull(
            FinanceReadDecoder.financeDocument(envelope(lotCount = 2_000)),
        ).document

        assertEquals(64, assertNotNull(accounts).accounts.size)
        assertEquals(512, assertNotNull(holdings).accounts.single().holdings.size)
        assertEquals(2_000, assertNotNull(lots).accounts.single().holdings.single().lots.size)
    }

    @Test
    fun `finance arrays reject one item beyond each shared Linux limit`() {
        assertNull(FinanceReadDecoder.financeDocument(envelope(accountCount = 65)))
        assertNull(FinanceReadDecoder.financeDocument(envelope(holdingCount = 513)))
        assertNull(FinanceReadDecoder.financeDocument(envelope(lotCount = 2_001)))
    }

    private fun envelope(
        accountCount: Int = 1,
        holdingCount: Int = 1,
        lotCount: Int = 0,
    ): JsonObject {
        val lot = JsonObject(
            mapOf(
                "date" to JsonPrimitive("2026-07-25"),
                "type" to JsonPrimitive("weekly_buy"),
                "pricePerShareCents" to int64(1L),
                "sharesDecimal" to JsonPrimitive("1"),
                "amountInvestedCents" to int64(1L),
            ),
        )
        val holding = JsonObject(
            mapOf(
                "name" to JsonPrimitive("Holding"),
                "category" to JsonPrimitive("Equity"),
                "valueCents" to int64(1L),
                "costBasisCents" to int64(1L),
                "gainBps" to int64(0L),
                "sharesDecimal" to JsonPrimitive("1"),
                "avgCostCents" to int64(1L),
                "currentPricePerShareCents" to int64(1L),
                "isProxy" to JsonPrimitive(false),
                "lots" to JsonArray(List(lotCount) { lot }),
            ),
        )
        val account = JsonObject(
            mapOf(
                "key" to JsonPrimitive("account"),
                "owner" to JsonPrimitive("victor"),
                "provider" to JsonPrimitive("Provider"),
                "totalValueCents" to int64(1L),
                "weeklyContributionCents" to int64(1L),
                "holdings" to JsonArray(List(holdingCount) { holding }),
            ),
        )
        val document = JsonObject(
            mapOf(
                "lastUpdated" to JsonPrimitive("2026-07-31"),
                "accounts" to JsonArray(List(accountCount) { account }),
                "updatedAtMs" to JsonPrimitive(1L),
            ),
        )
        return JsonObject(
            mapOf(
                "document" to document,
                "complete" to JsonPrimitive(true),
            ),
        )
    }

    private fun int64(value: Long): JsonObject {
        val bytes = ByteArray(Long.SIZE_BYTES)
        for (index in bytes.indices) {
            bytes[index] = ((value ushr (index * 8)) and 0xff).toByte()
        }
        return JsonObject(
            mapOf(
                "${'$'}integer" to JsonPrimitive(java.util.Base64.getEncoder().encodeToString(bytes)),
            ),
        )
    }
}
