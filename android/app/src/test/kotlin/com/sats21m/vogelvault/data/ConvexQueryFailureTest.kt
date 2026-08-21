package com.sats21m.vogelvault.data

import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** Query failure classification tests. All transports are in-memory fakes. */
class ConvexQueryFailureTest {
    @Test
    fun `transport failures discard exception text`() {
        val secret = "https://deployment.example/query?token=secret"
        val result = queryWith(
            poster { throw IOException(secret) },
        )

        assertEquals(ConvexResult.Failed(ConvexFailure.Transport), result)
        assertFalse(result.toString().contains(secret))
    }

    @Test
    fun `http failures retain only the status code`() {
        val secretBody = "server echoed private household data"
        val result = queryWith(response(503, secretBody))

        assertEquals(ConvexResult.Failed(ConvexFailure.Http(503)), result)
        assertFalse(result.toString().contains(secretBody))
    }

    @Test
    fun `http unauthorized remains distinct`() {
        assertEquals(ConvexResult.Unauthorized, queryWith(response(401, "ignored")))
    }

    @Test
    fun `deployment misconfiguration is distinct and redacted`() {
        val serverText =
            "Unauthorized: CONVEX_READ_TOKEN is not configured; secret deployment detail"
        val result = queryWith(error(serverText))

        assertEquals(
            ConvexResult.Failed(ConvexFailure.DeploymentMisconfigured),
            result,
        )
        assertFalse(result.toString().contains(serverText))
    }

    @Test
    fun `server rejection is distinct and redacted`() {
        val serverText = "Rejected query with private record contents"
        val result = queryWith(error(serverText))

        assertEquals(ConvexResult.Failed(ConvexFailure.ServerRejected()), result)
        assertFalse(result.toString().contains(serverText))
    }

    @Test
    fun `legacy failure input is classified and discarded`() {
        val secret = "caller accidentally supplied a private response body"
        val result = ConvexResult.Failed(secret)

        assertEquals(ConvexFailure.ServerRejected(), result.failure)
        assertFalse(result.reason.contains(secret))
        assertFalse(result.toString().contains(secret))
    }

    @Test
    fun `malformed and invalid envelopes are distinct`() {
        assertEquals(
            ConvexResult.Failed(ConvexFailure.MalformedResponse),
            queryWith(response(200, "<html>not json</html>")),
        )
        assertEquals(
            ConvexResult.Failed(ConvexFailure.InvalidResponse),
            queryWith(response(200, """{"status":"surprise","private":"secret"}""")),
        )
    }

    private fun queryWith(poster: HttpPoster): ConvexResult<ConvexValue> =
        runBlocking { client(poster).query(ConvexQuery.ListDataFiles) }

    private fun queryWith(httpResponse: HttpTextResponse): ConvexResult<ConvexValue> =
        queryWith(poster { httpResponse })

    private fun poster(block: suspend () -> HttpTextResponse): HttpPoster =
        object : HttpPoster {
            override suspend fun postJson(url: String, body: String): HttpTextResponse = block()
        }

    private fun client(poster: HttpPoster) = ConvexQueryClient(
        configSource = MutableConvexConfigSource(
            ConvexConfig(
                deploymentUrl = "https://query-failure-test.convex.cloud",
                readToken = "test-read-token",
                remoteReadEnabled = true,
            ),
        ),
        http = poster,
    )

    private fun response(code: Int, body: String): HttpTextResponse =
        HttpTextResponse(code, body)

    private fun error(serverText: String): HttpTextResponse =
        response(
            200,
            """{"status":"error","errorData":${jsonString(serverText)}}""",
        )

    private fun jsonString(value: String): String =
        Json.encodeToString(
            JsonElement.serializer(),
            JsonPrimitive(value),
        )
}
