package com.sats21m.vogelvault.data

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What we send and what we make of what comes back.
 *
 * Robolectric only because `org.json` is part of the Android framework and is a
 * throwing stub in a plain unit test. Nothing here needs a device, a display or
 * the network: the transport is a fake and the deployment is never contacted.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ConvexEnvelopeTest {

    @Test
    fun `the read token is attached to every query`() {
        val token = testToken()
        val poster = RecordingPoster(success("[]"))
        val repository = repositoryWith(poster, token)

        runBlocking { repository.list() }

        val args = sentArgs(poster)
        assertEquals(token, args.optString("token"))
    }

    @Test
    fun `an absent token is omitted rather than sent empty`() {
        val poster = RecordingPoster(success("[]"))
        val repository = repositoryWith(poster, token = null)

        runBlocking { repository.list() }

        // The server is the authority on whether a tokenless read is allowed.
        // Sending an empty string would turn "not configured" into "invalid
        // token" and muddy exactly the signal the cutover watches for.
        assertFalse(sentArgs(poster).has("token"), "no token means no token argument")
    }

    @Test
    fun `the request names the query and asks for json`() {
        val poster = RecordingPoster(success("[]"))
        val repository = repositoryWith(poster, testToken())

        runBlocking { repository.list() }

        val body = JSONObject(poster.bodies.single())
        assertEquals("dataFiles:list", body.optString("path"))
        assertEquals("json", body.optString("format"))
        assertEquals("$DEPLOYMENT/api/query", poster.urls.single())
    }

    @Test
    fun `fetch passes the file name through`() {
        val poster = RecordingPoster(success("[]"))
        val repository = repositoryWith(poster, testToken())

        runBlocking { repository.fetch("mason-transactions") }

        val body = JSONObject(poster.bodies.single())
        assertEquals("dataFiles:get", body.optString("path"))
        assertEquals("mason-transactions", sentArgs(poster).optString("name"))
    }

    @Test
    fun `an enforcing deployment reads as Unauthorized, not as a generic failure`() {
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"error","errorMessage":"Uncaught ConvexError: Unauthorized: invalid read token"}""",
            ),
        )
        val repository = repositoryWith(poster, testToken())

        assertEquals(ConvexResult.Unauthorized, runBlocking { repository.list() })
    }

    @Test
    fun `other convex errors do not echo the server's text`() {
        val poster = RecordingPoster(
            HttpTextResponse(200, """{"status":"error","errorMessage":"boom at Neighborhood Market 142.18"}"""),
        )
        val repository = repositoryWith(poster, testToken())

        val result = runBlocking { repository.list() }
        val failure = result as? ConvexResult.Failed ?: fail("expected Failed, got $result")

        // A reason ends up in a log eventually; a response body from this
        // deployment can contain the family's financial data.
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

        val result = runBlocking { repository.list() }
        assertTrue(result is ConvexResult.Failed, "got $result")
    }

    @Test
    fun `a missing data file is Missing, not a failure`() {
        val poster = RecordingPoster(HttpTextResponse(200, """{"status":"success","value":null}"""))
        val repository = repositoryWith(poster, testToken())

        assertEquals(ConvexResult.Missing, runBlocking { repository.fetch("nope") })
    }

    @Test
    fun `list decodes file metadata`() {
        val poster = RecordingPoster(
            success("""[{"name":"transactions","version":42,"updatedAt":1785076200000}]"""),
        )
        val repository = repositoryWith(poster, testToken())

        val result = runBlocking { repository.list() }
        val files = (result as? ConvexResult.Ok)?.value ?: fail("expected Ok, got $result")

        assertEquals(1, files.size)
        assertEquals(DataFileSummary("transactions", 42L, 1_785_076_200_000L), files.single())
    }

    @Test
    fun `versions decodes to a map`() {
        val poster = RecordingPoster(success("""{"transactions":42,"budget":7}"""))
        val repository = repositoryWith(poster, testToken())

        val result = runBlocking { repository.versions() }
        val versions = (result as? ConvexResult.Ok)?.value ?: fail("expected Ok, got $result")

        assertEquals(mapOf("transactions" to 42L, "budget" to 7L), versions)
    }

    @Test
    fun `a payload of the wrong shape fails instead of pretending`() {
        val poster = RecordingPoster(success("\"a string, not a list\""))
        val repository = repositoryWith(poster, testToken())

        val result = runBlocking { repository.list() }
        assertTrue(result is ConvexResult.Failed, "got $result")
    }

    @Test
    fun `a fetched payload is handed on as text and never printed`() {
        // A decimal amount, deliberately: routing money through org.json would
        // land it in a Double. The payload stays as text so the decoder can read
        // the literal and go through Money.parseCents.
        val body = """{"status":"success","value":[{"id":"tx-1","amount":-142.18}]}"""
        val poster = RecordingPoster(HttpTextResponse(200, body))
        val repository = repositoryWith(poster, testToken())

        val result = runBlocking { repository.fetch("transactions") }
        val payload = (result as? ConvexResult.Ok)?.value ?: fail("expected Ok, got $result")

        assertEquals(body, payload.rawResponseJson)
        assertFalse(payload.toString().contains("142.18"), "a payload must be safe to log")
        assertTrue(payload.toString().contains("transactions"))
    }

    @Test
    fun `the token never appears in a result`() {
        val token = testToken()
        val poster = RecordingPoster(success("[]"))
        val repository = repositoryWith(poster, token)

        val result = runBlocking { repository.list() }

        assertTrue(result.isOk, "got $result")
        assertFalse(result.toString().contains(token))
    }

    private fun success(value: String) = HttpTextResponse(200, """{"status":"success","value":$value}""")

    private fun sentArgs(poster: RecordingPoster): JSONObject =
        JSONObject(poster.bodies.single()).getJSONObject("args")

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
