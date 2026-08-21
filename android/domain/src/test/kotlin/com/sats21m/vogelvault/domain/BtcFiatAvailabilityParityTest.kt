package com.sats21m.vogelvault.domain

import com.google.gson.Gson
import com.google.gson.JsonObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class BtcFiatAvailabilityParityTest {
    private val fixtures: JsonObject = loadFixtures()

    @Test
    fun `shared BTC fiat availability cases match Kotlin domain semantics`() {
        for (fixtureElement in fixtures.getAsJsonArray("cases")) {
            val fixture = fixtureElement.asJsonObject
            val input = fixture.getAsJsonObject("input")
            val expected = fixture.getAsJsonObject("expected")
            val sats = Money.parseBtcToSats(input["btc"].asString)
            val legacyFiatCents = Money.parseCents(input["fiat"].asString)
            val explicit = input.getAsJsonObject("fiatValuation")
            val valuation = if (explicit == null) {
                legacyFiatValuation(sats, legacyFiatCents)
            } else {
                FiatValuation(
                    cents = explicit["cents"].asLong,
                    priceCents = explicit["priceCents"]?.asLong,
                    quotedAt = explicit["quotedAt"]?.asString,
                    source = explicit["source"]?.asString,
                    confidence = explicit["confidence"]?.asString,
                )
            }

            assertEquals(expected["sats"].asString.toLong(), sats, fixture["name"].asString)
            assertEquals(expected["fiatAvailable"].asBoolean, valuation != null, fixture["name"].asString)
            if (expected["fiatCents"].isJsonNull) {
                assertNull(valuation, fixture["name"].asString)
            } else {
                assertEquals(expected["fiatCents"].asString.toLong(), valuation?.cents, fixture["name"].asString)
            }
        }
    }

    private fun loadFixtures(): JsonObject {
        var dir: File? = File(System.getProperty("user.dir"))
        while (dir != null) {
            val candidate = File(dir, "shared/domain/fixtures/btc-fiat-availability-cases.json")
            if (candidate.isFile) return Gson().fromJson(candidate.readText(), JsonObject::class.java)
            dir = dir.parentFile
        }
        error("Could not locate BTC fiat availability fixtures")
    }
}
