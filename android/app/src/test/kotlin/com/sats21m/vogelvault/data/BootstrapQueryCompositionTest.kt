package com.sats21m.vogelvault.data

import android.app.Application
import android.content.Context
import android.util.Base64
import com.sats21m.vogelvault.initialConvexConfig
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.MarketSymbol
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Production-composition regression for the one-use bootstrap handoff.
 *
 * Every payload is synthetic. The test deliberately rebuilds the storage and
 * effective configuration objects between claiming and querying, matching the
 * process-reconstruction path used by VaultApplication without opening a socket.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BootstrapQueryCompositionTest {
    @Test
    fun `claimed credential survives reconstruction and authenticates every query family`() = runBlocking {
        val context: Application = RuntimeEnvironment.getApplication()
        val preferences = context.getSharedPreferences(
            "bootstrap-query-${UUID.randomUUID()}",
            Context.MODE_PRIVATE,
        )
        val claimPoster = SingleUseClaimPoster(READ_TOKEN)
        val storedDuringClaim = SecureConvexConfigSource(preferences, SyntheticConfigCipher)
        val effectiveDuringClaim = MutableConvexConfigSource(ConvexConfig())
        val bootstrap = ConvexReadBootstrapRepository(
            stored = storedDuringClaim,
            effective = effectiveDuringClaim,
            client = ConvexReadBootstrapClient(claimPoster),
        )

        assertEquals(ReadBootstrapStatus.CONNECTED, bootstrap.connect(BOOTSTRAP_BUNDLE))
        assertEquals(1, claimPoster.calls)

        // Recreate both objects instead of reusing the in-memory config updated by connect().
        val storedAfterRestart = SecureConvexConfigSource(preferences, SyntheticConfigCipher)
        val applicationConfig = MutableConvexConfigSource(
            initialConvexConfig(storedAfterRestart.current()),
        )
        assertEquals(ReadReadiness.READY, applicationConfig.current().readiness)

        val queryPoster = GoldenQueryPoster()
        val rows = RowQueryRepositories.convex(applicationConfig, queryPoster)
        val finance = FinanceQueryRepositories.convex(applicationConfig, queryPoster)

        val counts = assertIs<ConvexResult.Ok<RowCounts>>(rows.rowCounts()).value
        val bitcoin = assertIs<ConvexResult.Ok<RowSnapshot<BtcBalanceDocumentRow>>>(
            rows.listBtcBalanceDocuments(FamilyMember.VICTOR, RowVisibilityScope.NET_WORTH),
        ).value
        val retirement = assertIs<ConvexResult.Ok<FinanceDocumentSnapshot>>(
            finance.getFinanceDocument(FamilyMember.VICTOR, RowVisibilityScope.NET_WORTH),
        ).value
        val quotes = assertIs<ConvexResult.Ok<MarketQuoteReadSnapshot>>(
            finance.getMarketQuoteSnapshot(),
        ).value

        assertEquals(12, counts.transactions)
        assertEquals(100_000_000L, bitcoin.rows.single().totals.sats)
        assertEquals(25_000_000L, retirement.document?.retirementTotalCents)
        assertEquals(
            listOf(MarketSymbol.BTC, MarketSymbol.VOO, MarketSymbol.IBIT),
            quotes.snapshot.quotes.map { it.symbol },
        )

        assertEquals(
            listOf(
                "tables:rowCounts",
                "tables:listBtcBalanceDocuments",
                "tables:getFinanceDocument",
                "marketQuotes:getSnapshot",
            ),
            queryPoster.paths,
        )
        queryPoster.bodies.forEach { body ->
            val request = Json.parseToJsonElement(body).jsonObject
            assertEquals(
                READ_TOKEN,
                request["args"]!!.jsonObject["token"]!!.jsonPrimitive.content,
            )
            assertEquals("convex_encoded_json", request["format"]!!.jsonPrimitive.content)
        }
        assertEquals(1, claimPoster.calls, "application reconstruction must not claim again")
        assertTrue(queryPoster.paths.none { it == "dataFiles:claimAndroidReadBootstrap" })
        assertFalse(preferences.all.values.any { it.toString().contains(READ_TOKEN) })
    }

    private companion object {
        const val READ_TOKEN = "test_read_token_xxxxxxxxxxxxxxxxxxxxxxxxxxx"
        const val PAIR_ID = "android-read-bootstrapquerytest"
        const val PROOF = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        const val BOOTSTRAP_BUNDLE = "$PAIR_ID.$PROOF"
    }
}

private class SingleUseClaimPoster(
    private val token: String,
) : ReadBootstrapPoster {
    var calls: Int = 0
        private set

    override suspend fun post(body: String): ReadBootstrapHttpResponse {
        calls += 1
        val path = Json.parseToJsonElement(body).jsonObject["path"]!!.jsonPrimitive.content
        check(path == "dataFiles:claimAndroidReadBootstrap")
        return ReadBootstrapHttpResponse(
            200,
            """{"status":"success","value":{"ok":true,"readToken":"$token","pairedAt":1800000000000}}""",
        )
    }
}

private class GoldenQueryPoster : HttpPoster {
    val bodies = mutableListOf<String>()
    val paths = mutableListOf<String>()

    override suspend fun postJson(url: String, body: String): HttpTextResponse {
        check(url == "https://keen-elephant-452.convex.cloud/api/query")
        bodies += body
        val path = Json.parseToJsonElement(body).jsonObject["path"]!!.jsonPrimitive.content
        paths += path
        val fixture = when (path) {
            "tables:rowCounts" -> "row-counts.json"
            "tables:listBtcBalanceDocuments" -> "btc-balance.json"
            "tables:getFinanceDocument" -> "finance.json"
            "marketQuotes:getSnapshot" -> "quotes.json"
            else -> error("unexpected query path: $path")
        }
        val response = requireNotNull(
            javaClass.getResourceAsStream("/bootstrap-query-golden/$fixture"),
        ).bufferedReader().use { it.readText() }
        return HttpTextResponse(200, response)
    }
}

private object SyntheticConfigCipher : ConfigCipher {
    override fun encrypt(field: String, plaintext: String): String =
        Base64.encodeToString("synthetic:$field:$plaintext".toByteArray(), Base64.NO_WRAP)

    override fun decrypt(field: String, encoded: String): String {
        val decoded = String(Base64.decode(encoded, Base64.NO_WRAP))
        return decoded.removePrefix("synthetic:$field:")
    }
}
