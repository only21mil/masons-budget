package com.sats21m.vogelvault.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json

class PublicBtcBuyFeeDtoTest {
    @Test
    fun `absent fee decodes as explicit zero`() {
        val decoded = requireNotNull(PublicBtcBuyDto.decode(row()))

        assertEquals(0L, decoded.feeUsdCents)
        assertEquals(0L, decoded.toDomain().feeUsdCents)
    }

    @Test
    fun `exact fee survives public DTO and domain mapping`() {
        val decoded = requireNotNull(PublicBtcBuyDto.decode(row(25L.toConvexInt64())))

        assertEquals(25L, decoded.feeUsdCents)
        assertEquals(25L, decoded.toDomain().feeUsdCents)
    }

    @Test
    fun `negative fractional and overflow fees fail closed`() {
        assertNull(PublicBtcBuyDto.decode(row((-1L).toConvexInt64())))
        assertNull(PublicBtcBuyDto.decode(row(Json.parseToJsonElement("1.5"))))
        assertNull(PublicBtcBuyDto.decode(row(Json.parseToJsonElement("9223372036854775808"))))
    }

    private fun row(fee: kotlinx.serialization.json.JsonElement? = null): JsonObject =
        buildMap<String, kotlinx.serialization.json.JsonElement> {
            put("buyId", JsonPrimitive("buy-1"))
            put("owner", JsonPrimitive("victor"))
            put("date", JsonPrimitive("2026-08-25"))
            put("month", JsonPrimitive("2026-08"))
            put("source", JsonPrimitive("River"))
            put("sats", 100_000L.toConvexInt64())
            put("priceUsdCents", 6_500_000L.toConvexInt64())
            put("usdCents", 6_500L.toConvexInt64())
            fee?.let { put("feeUsdCents", it) }
            put("updatedAtMs", JsonPrimitive(1_800_000_000_000L))
        }.let(::JsonObject)
}
