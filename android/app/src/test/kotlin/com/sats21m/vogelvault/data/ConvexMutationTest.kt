package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ConvexMutationTest {
    @Test
    fun `each row mutation uses the mutation endpoint and its closed path`() {
        val mutations = listOf(
            ConvexMutation.UpsertTransaction(transaction()),
            ConvexMutation.UpsertTodo(JsonObject(mapOf("id" to JsonPrimitive("todo-1")))),
            ConvexMutation.DeleteTodo("todo-1"),
            ConvexMutation.UpsertBtcBuy(
                BtcBuyInput(
                    id = "buy-1",
                    date = "2026-07-29",
                    source = "Strike",
                    sats = 21_000L,
                    priceUsdCents = 11_700_000L,
                    usdCents = 2_100L,
                ),
            ),
            ConvexMutation.UpsertBtcAccount(
                BtcAccountInput(
                    key = "cold",
                    owner = FamilyMember.VICTOR,
                    label = "Cold storage",
                    custody = Custody.SELF_CUSTODY,
                    sats = 21_000_000L,
                    fiatCents = 11_700_000L,
                    asOf = "2026-07-29",
                ),
            ),
            ConvexMutation.UpsertBudgetCategory(
                viewer = FamilyMember.RACHEL,
                month = "2026-07",
                category = BudgetCategoryInput("Groceries", 97_500L),
            ),
        )
        val expectedPaths = listOf(
            "tables:upsertTransaction",
            "tables:upsertTodo",
            "tables:deleteTodo",
            "tables:upsertBtcBuy",
            "tables:upsertBtcAccount",
            "tables:upsertBudgetCategory",
        )

        mutations.zip(expectedPaths).forEach { (mutation, expectedPath) ->
            val poster = RecordingPoster(success())
            val result = runBlocking { client(poster).mutate(mutation) }

            assertTrue(result.isOk)
            assertEquals("$DEPLOYMENT/api/mutation", poster.urls.single())
            assertEquals(expectedPath, sentBody(poster)["path"]?.jsonPrimitive?.content)
            assertEquals(
                "convex_encoded_json",
                sentBody(poster)["format"]?.jsonPrimitive?.content,
            )
        }
    }

    @Test
    fun `sync token is attached and the read token is never substituted`() {
        val syncToken = testToken()
        val readToken = testToken()
        val poster = RecordingPoster(success())
        val client = ConvexMutationClient(
            configSource = source(readToken = readToken),
            syncTokenSource = ConvexSyncTokenSource { syncToken },
            http = poster,
        )

        runBlocking { client.mutate(ConvexMutation.DeleteTodo("todo-1")) }

        val sent = sentArgs(poster)["token"]?.jsonPrimitive?.content
        assertEquals(syncToken, sent)
        assertFalse(sent == readToken)
    }

    @Test
    fun `missing sync token fails closed before a socket opens`() {
        val poster = RecordingPoster(success())
        val client = ConvexMutationClient(
            configSource = source(readToken = testToken()),
            syncTokenSource = DisabledConvexSyncTokenSource,
            http = poster,
        )

        val result = runBlocking { client.mutate(ConvexMutation.DeleteTodo("todo-1")) }

        assertEquals(ConvexResult.Unauthorized, result)
        assertTrue(poster.urls.isEmpty())
        assertTrue(poster.bodies.isEmpty())
    }

    @Test
    fun `insecure deployment fails closed before exposing the sync token`() {
        val poster = RecordingPoster(success())
        val client = ConvexMutationClient(
            configSource = MutableConvexConfigSource(
                ConvexConfig(deploymentUrl = "http://example.convex.cloud"),
            ),
            syncTokenSource = ConvexSyncTokenSource { testToken() },
            http = poster,
        )

        val result = runBlocking { client.mutate(ConvexMutation.DeleteTodo("todo-1")) }

        assertEquals(ConvexResult.NotConfigured, result)
        assertTrue(poster.urls.isEmpty())
    }

    @Test
    fun `all int64 fields use canonical little endian tagged encoding`() {
        val poster = RecordingPoster(success())
        val mutation = ConvexMutation.UpsertBtcBuy(
            BtcBuyInput(
                id = "buy-1",
                date = "2026-07-29",
                source = "Strike",
                sats = 1L,
                priceUsdCents = -1L,
                usdCents = Long.MIN_VALUE,
            ),
        )

        runBlocking { client(poster).mutate(mutation) }

        val buy = sentArgs(poster)["buy"]!!.jsonObject
        assertTagged(buy, "sats", "AQAAAAAAAAA=")
        assertTagged(buy, "priceUsdCents", "//////////8=")
        assertTagged(buy, "usdCents", "AAAAAAAAAIA=")
    }

    @Test
    fun `budget category keeps viewer month and exact cents on the wire`() {
        val poster = RecordingPoster(success())

        runBlocking {
            client(poster).mutate(
                ConvexMutation.UpsertBudgetCategory(
                    viewer = FamilyMember.RACHEL,
                    month = "2026-07",
                    category = BudgetCategoryInput("Groceries", 97_501L),
                ),
            )
        }

        val args = sentArgs(poster)
        assertEquals("rachel", args["viewer"]?.jsonPrimitive?.content)
        assertEquals("2026-07", args["month"]?.jsonPrimitive?.content)
        val category = args["category"]!!.jsonObject
        assertEquals("Groceries", category["name"]?.jsonPrimitive?.content)
        assertTagged(category, "budgetCents", "3XwBAAAAAAA=")
    }

    @Test
    fun `transaction cents are tagged and purchase sign is preserved`() {
        val poster = RecordingPoster(success())

        runBlocking {
            client(poster).mutate(
                ConvexMutation.UpsertTransaction(transaction(amountCents = 14_218L)),
            )
        }

        val transaction = sentArgs(poster)["transaction"]!!.jsonObject
        assertTagged(transaction, "amountCents", "ijcAAAAAAAA=")
        assertEquals("spend", transaction["kind"]?.jsonPrimitive?.content)
    }

    @Test
    fun `refunds must be negative and are never corrected`() {
        assertFailsWith<IllegalArgumentException> {
            transaction(amountCents = 1L, kind = TransactionKind.CREDIT)
        }

        val refund = transaction(amountCents = -1L, kind = TransactionKind.CREDIT)
        val encoded = refund.toJson()["amountCents"]!!.jsonObject["\$integer"]
        assertEquals("//////////8=", encoded?.jsonPrimitive?.content)
    }

    @Test
    fun `purchases must be positive for every owner`() {
        FamilyMember.entries.forEach { owner ->
            assertFailsWith<IllegalArgumentException>(owner.key) {
                transaction(amountCents = -1L, owner = owner)
            }
        }
    }

    @Test
    fun `income must be a positive credit`() {
        assertFailsWith<IllegalArgumentException> {
            transaction(category = "Income", kind = TransactionKind.SPEND)
        }
        assertFailsWith<IllegalArgumentException> {
            transaction(
                category = "Income",
                kind = TransactionKind.CREDIT,
                amountCents = -1L,
            )
        }

        transaction(category = "Income", kind = TransactionKind.CREDIT, amountCents = 1L)
    }

    @Test
    fun `server rejections and transport failures are surfaced`() {
        val rejected = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"error","errorData":"sign does not agree","errorMessage":"redacted"}""",
            ),
        )
        val unavailable = RecordingPoster(HttpTextResponse(503, ""))

        assertEquals(
            ConvexResult.Failed("convex rejection"),
            runBlocking { client(rejected).mutate(ConvexMutation.DeleteTodo("todo-1")) },
        )
        assertEquals(
            ConvexResult.Failed("http 503"),
            runBlocking { client(unavailable).mutate(ConvexMutation.DeleteTodo("todo-1")) },
        )
    }

    @Test
    fun `server auth rejection is unauthorized and does not leak its text`() {
        val token = testToken()
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"error","errorData":"Unauthorized: invalid sync token","errorMessage":"redacted"}""",
            ),
        )

        val result = runBlocking { client(poster, token).mutate(ConvexMutation.DeleteTodo("todo-1")) }

        assertEquals(ConvexResult.Unauthorized, result)
        assertFalse(result.toString().contains(token))
    }

    @Test
    fun `network failure stays distinct from missing or rejected sync credentials`() {
        val missingToken =
            runBlocking {
                ConvexMutationClient(
                    configSource = source(readToken = testToken()),
                    syncTokenSource = DisabledConvexSyncTokenSource,
                    http = RecordingPoster(success()),
                ).mutate(ConvexMutation.DeleteTodo("todo-1"))
            }
        val rejectedToken =
            runBlocking {
                client(
                    RecordingPoster(
                        HttpTextResponse(
                            200,
                            """{"status":"error","errorData":"Unauthorized: invalid sync token"}""",
                        ),
                    ),
                ).mutate(ConvexMutation.DeleteTodo("todo-1"))
            }
        val networkFailure =
            runBlocking {
                ConvexMutationClient(
                    configSource = source(readToken = testToken()),
                    syncTokenSource = ConvexSyncTokenSource { testToken() },
                    http =
                        object : HttpPoster {
                            override suspend fun postJson(
                                url: String,
                                body: String,
                            ): HttpTextResponse = throw IOException("offline")
                        },
                ).mutate(ConvexMutation.DeleteTodo("todo-1"))
            }

        assertEquals(ConvexResult.Unauthorized, missingToken)
        assertEquals(ConvexResult.Unauthorized, rejectedToken)
        assertEquals(ConvexResult.Failed("transport failure (IOException)"), networkFailure)
    }

    @Test
    fun `malformed success response fails rather than being swallowed`() {
        val result = runBlocking {
            client(RecordingPoster(HttpTextResponse(200, "<html>")))
                .mutate(ConvexMutation.DeleteTodo("todo-1"))
        }

        val failure = result as? ConvexResult.Failed ?: fail("expected Failed, got $result")
        assertEquals("malformed response envelope", failure.reason)
    }

    private fun transaction(
        amountCents: Long = 1L,
        category: String = "Groceries",
        kind: TransactionKind = TransactionKind.SPEND,
        owner: FamilyMember? = FamilyMember.VICTOR,
    ) = TransactionInput(
        id = "tx-1",
        date = "2026-07-29",
        merchant = "Neighborhood Market",
        amountCents = amountCents,
        category = category,
        kind = kind,
        owner = owner,
    )

    private fun client(
        poster: RecordingPoster,
        syncToken: String = testToken(),
    ) = ConvexMutationClient(
        configSource = source(readToken = testToken()),
        syncTokenSource = ConvexSyncTokenSource { syncToken },
        http = poster,
    )

    private fun source(readToken: String?) = MutableConvexConfigSource(
        ConvexConfig(
            deploymentUrl = DEPLOYMENT,
            readToken = readToken,
            remoteReadEnabled = true,
        ),
    )

    private fun sentBody(poster: RecordingPoster): JsonObject =
        Json.parseToJsonElement(poster.bodies.single()).jsonObject

    private fun sentArgs(poster: RecordingPoster): JsonObject =
        sentBody(poster)["args"]!!.jsonObject

    private fun assertTagged(
        parent: JsonObject,
        key: String,
        encoded: String,
    ) {
        val tagged = parent[key]?.jsonObject ?: fail("$key was not a tagged int64")
        assertEquals(setOf("\$integer"), tagged.keys)
        assertEquals(encoded, tagged["\$integer"]?.jsonPrimitive?.content)
    }

    private fun success() =
        HttpTextResponse(200, """{"status":"success","value":{"outcome":"inserted"}}""")

    private companion object {
        const val DEPLOYMENT = "https://keen-elephant-452.convex.cloud"
    }
}
