package com.sats21m.vogelvault.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.Json

class ConvexInt64Test {
    @Test
    fun `decodes canonical signed little endian int64 values`() {
        val cases = mapOf(
            "{\"\$integer\":\"AAAAAAAAAAA=\"}" to 0L,
            "{\"\$integer\":\"AQAAAAAAAAA=\"}" to 1L,
            "{\"\$integer\":\"//////////8=\"}" to -1L,
            "{\"\$integer\":\"FYHpffQQIhE=\"}" to 1_234_567_890_123_456_789L,
            "{\"\$integer\":\"634Wggvv3e4=\"}" to -1_234_567_890_123_456_789L,
            "{\"\$integer\":\"/////////38=\"}" to Long.MAX_VALUE,
            "{\"\$integer\":\"AAAAAAAAAIA=\"}" to Long.MIN_VALUE,
        )

        for ((wire, expected) in cases) {
            assertEquals(expected, Json.parseToJsonElement(wire).decodeConvexInt64OrNull(), wire)
        }
    }

    @Test
    fun `rejects fallback shapes aliases and malformed base64`() {
        val invalid = listOf(
            "null",
            "1",
            "\"1\"",
            "[]",
            "{}",
            "{\"\$int64\":\"AQAAAAAAAAA=\"}",
            "{\"\$integer\":\"AQAAAAAAAAA=\",\"value\":\"1\"}",
            "{\"\$integer\":1}",
            "{\"\$integer\":\"1\"}",
            "{\"\$integer\":\"__________8=\"}",
            "{\"\$integer\":\"AAAAAAAAAA!\"}",
            "{\"\$integer\":\"AQAAAAAAAAA\"}",
            "{\"\$integer\":\"AAAAAAAAAAB=\"}",
            "{\"\$integer\":\"AAAAAAAAAA==\"}",
            "{\"\$integer\":\"AAAAAAAAAAAA\"}",
        )

        for (wire in invalid) {
            assertNull(Json.parseToJsonElement(wire).decodeConvexInt64OrNull(), wire)
        }
    }
}
