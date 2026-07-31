package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.HoldingValuationBasis
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.domain.selectNetWorth
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class FinanceQueryRepositoryTest {
    @Test
    fun `finance document maps exact retirement units and requests explicit visible scope`() {
        val poster = RecordingPoster(success(financeEnvelope()))
        val repository = repositoryWith(poster)

        val result = runBlocking {
            repository.getFinanceDocument(FamilyMember.RACHEL, RowVisibilityScope.VISIBLE)
        }
        val snapshot = assertIs<ConvexResult.Ok<FinanceDocumentSnapshot>>(result).value
        val document = snapshot.document!!
        val adult = document.accounts.first()
        val mason = document.accounts.last()

        assertEquals(true, snapshot.complete)
        assertEquals(77_330_746L, document.retirementTotalCents)
        assertEquals(FamilyMember.VICTOR, adult.owner)
        assertEquals(25_000L, adult.weeklyContributionCents)
        assertEquals("Friday", adult.weeklyContributionDay)
        assertEquals("12.34567890", adult.holdings.single().sharesDecimal)
        assertEquals(6_812_345L, adult.holdings.single().currentPricePerShareCents)
        assertEquals(2_500L, mason.totalValueCents)
        assertEquals(FamilyMember.MASON, mason.owner)

        val request = Json.parseToJsonElement(poster.bodies.single()).jsonObject
        assertEquals("tables:getFinanceDocument", request["path"]!!.jsonPrimitive.content)
        val args = request["args"]!!.jsonObject
        assertEquals("rachel", args["viewer"]!!.jsonPrimitive.content)
        assertEquals("visible", args["scope"]!!.jsonPrimitive.content)
        assertFalse(args["token"]!!.jsonPrimitive.content.isBlank())
    }

    @Test
    fun `net worth selector excludes child retirement and does not add document total twice`() {
        val poster = RecordingPoster(success(financeEnvelope()))
        val document = assertIs<ConvexResult.Ok<FinanceDocumentSnapshot>>(
            runBlocking {
                repositoryWith(poster).getFinanceDocument(
                    FamilyMember.VICTOR,
                    RowVisibilityScope.VISIBLE,
                )
            },
        ).value.document!!
        val quotes = quoteSnapshot(
            btc = quote("BTC", int64(6_485_500), "live", "2026-07-30T15:00:00Z"),
            voo = quote("VOO", int64(68_000), "live", "2026-07-30T15:00:00Z"),
            ibit = unavailable("IBIT"),
        )
        val decodedQuotes = assertIs<ConvexResult.Ok<MarketQuoteReadSnapshot>>(
            runBlocking { repositoryWith(RecordingPoster(success(quotes))).getMarketQuoteSnapshot() },
        ).value.snapshot.quotes

        val selection = selectNetWorth(
            viewer = FamilyMember.VICTOR,
            bitcoinSats = 100_000_000L,
            financeAccounts = document.accounts,
            quotes = decodedQuotes,
        )

        assertEquals(listOf("401k"), selection.accounts.map { it.account.key })
        assertEquals(839_506L, selection.retirementValueCents)
        assertEquals(7_325_006L, selection.totalValueCents)
        assertEquals(HoldingValuationBasis.MARKET_QUOTE, selection.accounts.single().holdings.single().basis)
    }

    @Test
    fun `partial quote availability preserves usable provenance and explicit unavailable state`() {
        val poster = RecordingPoster(
            success(
                quoteSnapshot(
                    btc = quote("BTC", int64(6_485_500), "live", "2026-07-30T15:00:00Z"),
                    voo = quote("VOO", int64(68_179), "stale", "2026-07-29T15:00:00Z"),
                    ibit = unavailable("IBIT"),
                ),
            ),
        )

        val result = assertIs<ConvexResult.Ok<MarketQuoteReadSnapshot>>(
            runBlocking { repositoryWith(poster).getMarketQuoteSnapshot() },
        ).value

        assertEquals(true, result.complete)
        assertEquals(
            listOf(MarketSymbol.BTC, MarketSymbol.VOO, MarketSymbol.IBIT),
            result.snapshot.quotes.map { it.symbol },
        )
        assertEquals(MarketQuoteStatus.STALE, result.snapshot.quotes[1].status)
        assertEquals(68_179L, result.snapshot.quotes[1].priceCents)
        assertEquals("reviewed-provider", result.snapshot.quotes[1].source)
        assertEquals("2026-07-29T15:00:00Z", result.snapshot.quotes[1].fetchedAt)
        assertEquals(MarketQuoteStatus.UNAVAILABLE, result.snapshot.quotes[2].status)
        assertNull(result.snapshot.quotes[2].priceCents)
        assertNull(result.snapshot.quotes[2].fetchedAt)

        val request = Json.parseToJsonElement(poster.bodies.single()).jsonObject
        assertEquals("marketQuotes:getSnapshot", request["path"]!!.jsonPrimitive.content)
        assertEquals(setOf("token"), request["args"]!!.jsonObject.keys)
    }

    @Test
    fun `missing duplicate and contradictory quote data fail closed`() {
        val malformed = listOf(
            quoteSnapshot(
                btc = quote("BTC", int64(6_485_500), "live", "2026-07-30T15:00:00Z"),
                voo = quote("VOO", int64(68_179), "live", "2026-07-30T15:00:00Z"),
                ibit = null,
            ),
            quoteSnapshot(
                btc = quote("BTC", int64(6_485_500), "live", "2026-07-30T15:00:00Z"),
                voo = quote("BTC", int64(6_485_500), "live", "2026-07-30T15:00:00Z"),
                ibit = unavailable("IBIT"),
            ),
            quoteSnapshot(
                btc = """{"symbol":"BTC","priceCents":${int64(6_485_500)},"source":"reviewed-provider","fetchedAt":null,"status":"live"}""",
                voo = quote("VOO", int64(68_179), "live", "2026-07-30T15:00:00Z"),
                ibit = unavailable("IBIT"),
            ),
            quoteSnapshot(
                btc = """{"symbol":"BTC","priceCents":${int64(6_485_500)},"source":"reviewed-provider","fetchedAt":null,"status":"unavailable"}""",
                voo = quote("VOO", int64(68_179), "live", "2026-07-30T15:00:00Z"),
                ibit = unavailable("IBIT"),
            ),
        )

        for (payload in malformed) {
            assertEquals(
                ConvexResult.Failed("unexpected payload shape"),
                runBlocking {
                    repositoryWith(RecordingPoster(success(payload))).getMarketQuoteSnapshot()
                },
            )
        }
    }

    @Test
    fun `malformed nested retirement money and share quantities fail closed`() {
        val malformedMoney = financeEnvelope().replace(
            "\"totalValueCents\":${int64(77330746)}",
            "\"totalValueCents\":\"77330746\"",
        )
        val malformedShares = financeEnvelope().replace(
            "\"sharesDecimal\":\"12.34567890\"",
            "\"sharesDecimal\":\"not-shares\"",
        )

        for (payload in listOf(malformedMoney, malformedShares)) {
            assertEquals(
                ConvexResult.Failed("unexpected payload shape"),
                runBlocking {
                    repositoryWith(RecordingPoster(success(payload))).getFinanceDocument(
                        FamilyMember.VICTOR,
                        RowVisibilityScope.NET_WORTH,
                    )
                },
            )
        }
    }

    @Test
    fun `share quantities reject exponent and unbounded lexical forms`() {
        val malformed = listOf(
            financeEnvelope().replace(
                "\"sharesDecimal\":\"12.34567890\"",
                "\"sharesDecimal\":\"1e3\"",
            ),
            financeEnvelope().replace(
                "\"sharesDecimal\":\"12.34567890\"",
                "\"sharesDecimal\":\"${"1".repeat(65)}\"",
            ),
        )

        for (payload in malformed) {
            assertEquals(
                ConvexResult.Failed("unexpected payload shape"),
                runBlocking {
                    repositoryWith(RecordingPoster(success(payload))).getFinanceDocument(
                        FamilyMember.VICTOR,
                        RowVisibilityScope.NET_WORTH,
                    )
                },
            )
        }
    }

    @Test
    fun `missing finance document remains an explicit complete empty snapshot`() {
        val result = assertIs<ConvexResult.Ok<FinanceDocumentSnapshot>>(
            runBlocking {
                repositoryWith(
                    RecordingPoster(success("""{"document":null,"complete":true}""")),
                ).getFinanceDocument(FamilyMember.MASON, RowVisibilityScope.NET_WORTH)
            },
        ).value

        assertEquals(true, result.complete)
        assertNull(result.document)
    }

    private fun repositoryWith(poster: RecordingPoster): FinanceQueryRepository =
        FinanceQueryRepositories.convex(
            configSource = MutableConvexConfigSource(
                ConvexConfig(DEPLOYMENT, testToken(), remoteReadEnabled = true),
            ),
            http = poster,
        )

    private fun financeEnvelope(): String =
        """{
            "document":{
                "lastUpdated":"2026-07-30",
                "retirementTotalCents":${int64(77330746)},
                "accounts":[
                    {
                        "key":"401k",
                        "owner":"victor",
                        "provider":"Principal",
                        "totalValueCents":${int64(77330746)},
                        "weeklyContributionCents":${int64(25000)},
                        "weeklyContributionDay":"Friday",
                        "holdings":[{
                            "name":"Vanguard S&P 500",
                            "category":"Equity",
                            "ticker":"VOO",
                            "valueCents":${int64(77330746)},
                            "costBasisCents":${int64(70000000)},
                            "gainBps":${int64(1047)},
                            "sharesDecimal":"12.34567890",
                            "avgCostCents":${int64(5670000)},
                            "currentPricePerShareCents":${int64(6812345)},
                            "isProxy":false,
                            "lots":[{
                                "date":"2026-07-25",
                                "type":"weekly_buy",
                                "pricePerShareCents":${int64(6800000)},
                                "sharesDecimal":"0.00367647",
                                "amountInvestedCents":${int64(25000)},
                                "note":"Friday auto buy"
                            }]
                        }]
                    },
                    {
                        "key":"mason_401k",
                        "owner":"mason",
                        "provider":"Mason",
                        "totalValueCents":${int64(2500)},
                        "weeklyContributionCents":${int64(2500)},
                        "weeklyContributionDay":"Friday",
                        "holdings":[]
                    }
                ],
                "updatedAtMs":1785423600000.0
            },
            "complete":true
        }""".trimIndent()

    private fun quoteSnapshot(
        btc: String,
        voo: String,
        ibit: String?,
    ): String = """{"quotes":[${listOfNotNull(btc, voo, ibit).joinToString(",")}],"complete":true}"""

    private fun quote(symbol: String, price: String, status: String, fetchedAt: String): String =
        """{"symbol":"$symbol","priceCents":$price,"source":"reviewed-provider","fetchedAt":"$fetchedAt","status":"$status"}"""

    private fun unavailable(symbol: String): String =
        """{"symbol":"$symbol","priceCents":null,"source":"reviewed-provider","fetchedAt":null,"status":"unavailable"}"""

    private fun success(value: String): HttpTextResponse =
        HttpTextResponse(200, """{"status":"success","value":$value}""")

    private fun int64(value: Long): String {
        val bytes = ByteArray(Long.SIZE_BYTES)
        for (index in bytes.indices) {
            bytes[index] = ((value ushr (index * 8)) and 0xff).toByte()
        }
        return """{"${'$'}integer":"${Base64.getEncoder().encodeToString(bytes)}"}"""
    }

    private companion object {
        const val DEPLOYMENT = "https://keen-elephant-452.convex.cloud"
    }
}
