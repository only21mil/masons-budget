package com.sats21m.vogelvault.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Transport and legacy-envelope tests. No Android runtime or network is used. */
class ConvexEnvelopeTest {
    @Test
    fun `the read token is attached to every query`() {
        val token = testToken()
        val poster = RecordingPoster(success("[]"))
        val repository = repositoryWith(poster, token)

        runBlocking { repository.list() }

        assertEquals(token, sentArgs(poster)["token"]?.jsonPrimitive?.content)
    }

    @Test
    fun `an absent token refuses the read before a socket opens`() {
        val poster = RecordingPoster(success("[]"))
        val repository = repositoryWith(poster, token = null)

        assertEquals(ConvexResult.Unauthorized, runBlocking { repository.list() })
        assertTrue(poster.urls.isEmpty(), "no token means no socket")
        assertTrue(poster.bodies.isEmpty())
    }

    @Test
    fun `the request names the query and asks for json`() {
        val poster = RecordingPoster(success("[]"))
        val repository = repositoryWith(poster, testToken())

        runBlocking { repository.list() }

        val body = sentBody(poster)
        assertEquals("dataFiles:list", body["path"]?.jsonPrimitive?.content)
        assertEquals("json", body["format"]?.jsonPrimitive?.content)
        assertEquals("$DEPLOYMENT/api/query", poster.urls.single())
    }

    @Test
    fun `fetch passes the file name through`() {
        val poster = RecordingPoster(success("[]"))
        val repository = repositoryWith(poster, testToken())

        runBlocking { repository.fetch("mason-transactions") }

        assertEquals("dataFiles:get", sentBody(poster)["path"]?.jsonPrimitive?.content)
        assertEquals("mason-transactions", sentArgs(poster)["name"]?.jsonPrimitive?.content)
    }

    @Test
    fun `errorData classifies production auth errors before redacted errorMessage`() {
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"error","errorData":"Unauthorized: invalid read token","errorMessage":"[Request ID: abc] Server Error"}""",
            ),
        )
        val repository = repositoryWith(poster, testToken())

        assertEquals(ConvexResult.Unauthorized, runBlocking { repository.list() })
    }

    @Test
    fun `present errorData wins over an unauthorized fallback message`() {
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"error","errorData":"Validation failed","errorMessage":"Unauthorized"}""",
            ),
        )
        val repository = repositoryWith(poster, testToken())

        assertEquals(ConvexResult.Failed("convex error"), runBlocking { repository.list() })
    }

    @Test
    fun `malformed present errorData does not fall back to errorMessage`() {
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"error","errorData":7,"errorMessage":"Unauthorized"}""",
            ),
        )

        assertEquals(
            ConvexResult.Failed("convex error"),
            runBlocking { repositoryWith(poster, testToken()).list() },
        )
    }

    @Test
    fun `other convex errors do not echo server text`() {
        val poster = RecordingPoster(
            HttpTextResponse(200, """{"status":"error","errorData":"boom at Neighborhood Market 142.18"}"""),
        )
        val repository = repositoryWith(poster, testToken())

        val result = runBlocking { repository.list() }
        val failure = result as? ConvexResult.Failed ?: fail("expected Failed, got $result")
        assertFalse(failure.reason.contains("Neighborhood"))
        assertFalse(failure.reason.contains("142.18"))
    }

    @Test
    fun `a transport error reports only the status code`() {
        val poster = RecordingPoster(HttpTextResponse(503, ""))
        val repository = repositoryWith(poster, testToken())

        assertEquals(ConvexResult.Failed("http 503"), runBlocking { repository.list() })
    }

    @Test
    fun `a response that is not json fails rather than throwing`() {
        val poster = RecordingPoster(HttpTextResponse(200, "<html>captive portal</html>"))
        val repository = repositoryWith(poster, testToken())

        assertTrue(runBlocking { repository.list() } is ConvexResult.Failed)
    }

    @Test
    fun `a missing data file is Missing not a failure`() {
        val poster = RecordingPoster(HttpTextResponse(200, """{"status":"success","value":null}"""))
        val repository = repositoryWith(poster, testToken())

        assertEquals(ConvexResult.Missing, runBlocking { repository.fetch("nope") })
    }

    @Test
    fun `list decodes file metadata atomically`() {
        val good = RecordingPoster(
            success("""[{"name":"transactions","version":42,"updatedAt":1785076200000}]"""),
        )
        val repository = repositoryWith(good, testToken())

        val result = runBlocking { repository.list() }
        val files = (result as? ConvexResult.Ok)?.value ?: fail("expected Ok, got $result")
        assertEquals(listOf(DataFileSummary("transactions", 42L, 1_785_076_200_000L)), files)

        val malformed = RecordingPoster(
            success("""[{"name":"transactions","version":42,"updatedAt":1785076200000},{"name":"budget","version":"7","updatedAt":1}]"""),
        )
        assertTrue(runBlocking { repositoryWith(malformed, testToken()).list() } is ConvexResult.Failed)
    }

    @Test
    fun `versions decodes to a strict integral map`() {
        val poster = RecordingPoster(success("""{"transactions":42,"budget":7}"""))
        val repository = repositoryWith(poster, testToken())

        val result = runBlocking { repository.versions() }
        val versions = (result as? ConvexResult.Ok)?.value ?: fail("expected Ok, got $result")
        assertEquals(mapOf("transactions" to 42L, "budget" to 7L), versions)
    }

    @Test
    fun `a fetched payload remains lexical text and never prints its contents`() {
        val body = """{"status":"success","value":[{"id":"tx-1","amount":-142.18}]}"""
        val poster = RecordingPoster(HttpTextResponse(200, body))
        val repository = repositoryWith(poster, testToken())

        val result = runBlocking { repository.fetch("transactions") }
        val payload = (result as? ConvexResult.Ok)?.value ?: fail("expected Ok, got $result")
        assertEquals(body, payload.rawResponseJson)
        assertFalse(payload.toString().contains("142.18"))
        assertTrue(payload.toString().contains("transactions"))
    }

    @Test
    fun `the token never appears in a result`() {
        val token = testToken()
        val repository = repositoryWith(RecordingPoster(success("[]")), token)

        val result = runBlocking { repository.list() }

        assertTrue(result.isOk)
        assertFalse(result.toString().contains(token))
    }

    private fun success(value: String) = HttpTextResponse(200, """{"status":"success","value":$value}""")

    private fun sentBody(poster: RecordingPoster): JsonObject =
        Json.parseToJsonElement(poster.bodies.single()).jsonObject

    private fun sentArgs(poster: RecordingPoster): JsonObject = sentBody(poster)["args"]!!.jsonObject

    private fun repositoryWith(poster: RecordingPoster, token: String?): DataFileRepository =
        DataFileRepositories.convex(
            configSource = MutableConvexConfigSource(
                ConvexConfig(deploymentUrl = DEPLOYMENT, readToken = token, remoteReadEnabled = true),
            ),
            http = poster,
        )

    private companion object {
        const val DEPLOYMENT = "https://keen-elephant-452.convex.cloud"
    }
}
