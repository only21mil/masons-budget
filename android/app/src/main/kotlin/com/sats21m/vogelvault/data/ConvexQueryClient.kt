package com.sats21m.vogelvault.data

import java.io.IOException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** One decoded Convex value plus the untouched response for the legacy blob path. */
internal class ConvexValue(val parsed: JsonElement, val rawResponseJson: String) {
    /** Redacted: the raw JSON is the family's financial data and must never be logged. */
    override fun toString(): String = "ConvexValue(bytes=${rawResponseJson.length})"
}

/**
 * Calls Convex's HTTP query API.
 *
 * The kill switch and required read token are checked before a socket opens. A
 * request path and its arguments come from [ConvexQuery], so transport call sites
 * cannot invent an untyped query. Responses are parsed as kotlinx.serialization
 * [JsonElement] trees; response-side org.json coercions never touch row data.
 */
internal class ConvexQueryClient(
    private val configSource: ConvexConfigSource,
    private val http: HttpPoster = UrlConnectionHttpPoster(),
) {

    suspend fun query(query: ConvexQuery): ConvexResult<ConvexValue> {
        val config = configSource.current()

        when (config.readiness) {
            ReadReadiness.DISABLED -> return ConvexResult.Disabled
            ReadReadiness.NO_DEPLOYMENT_URL,
            ReadReadiness.INSECURE_DEPLOYMENT_URL,
            -> return ConvexResult.NotConfigured
            ReadReadiness.NO_READ_TOKEN -> return ConvexResult.Unauthorized
            ReadReadiness.READY -> Unit
        }

        val endpoint = config.queryEndpoint() ?: return ConvexResult.NotConfigured
        val token = config.readTokenOrNull() ?: return ConvexResult.Unauthorized
        val body = requestBody(query, token)

        val response = try {
            http.postJson(endpoint, body)
        } catch (_: IOException) {
            return ConvexResult.Failed(ConvexFailure.Transport)
        }

        return parse(response)
    }

    private fun requestBody(query: ConvexQuery, token: String): String {
        val args = JsonObject(query.arguments() + ("token" to JsonPrimitive(token)))
        val request = JsonObject(
            linkedMapOf(
                "path" to JsonPrimitive(query.path),
                "args" to args,
                "format" to JsonPrimitive(CONVEX_RESPONSE_FORMAT),
            ),
        )
        return JSON.encodeToString(JsonElement.serializer(), request)
    }

    private fun parse(response: HttpTextResponse): ConvexResult<ConvexValue> {
        if (response.code == HTTP_UNAUTHORIZED) {
            // A bare 401 is ambiguous, but preserving a genuinely rejected token
            // bricks every restart. Clearing a good token after a transient proxy
            // rejection is recoverable, so fail toward credential self-healing.
            return ConvexResult.Unauthorized
        }
        if (response.code != HTTP_OK) {
            return ConvexResult.Failed(ConvexFailure.Http(response.code))
        }

        val envelope = try {
            JSON.parseToJsonElement(response.body) as? JsonObject
        } catch (error: SerializationException) {
            null
        } ?: return ConvexResult.Failed(ConvexFailure.MalformedResponse)

        return when (envelope.string("status")) {
            "success" -> {
                val value = envelope["value"]
                if (value == null || value is JsonNull) {
                    ConvexResult.Missing
                } else {
                    ConvexResult.Ok(ConvexValue(parsed = value, rawResponseJson = response.body))
                }
            }

            "error" -> {
                // Production redacts errorMessage but preserves ConvexError data in
                // errorData. When both exist, errorData is authoritative.
                val errorData = envelope["errorData"]
                val message = if (errorData == null || errorData is JsonNull) {
                    envelope["errorMessage"].stringOrNull()
                } else {
                    errorData.stringOrNull()
                }
                classifyConvexError(message)
            }

            else -> ConvexResult.Failed(ConvexFailure.InvalidResponse)
        }
    }

    private fun JsonObject.string(key: String): String? = get(key).stringOrNull()

    private fun JsonElement?.stringOrNull(): String? =
        (this as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private companion object {
        const val HTTP_OK = 200
        const val HTTP_UNAUTHORIZED = 401
        const val CONVEX_RESPONSE_FORMAT = "convex_encoded_json"
        val JSON = Json {
            isLenient = false
            allowSpecialFloatingPointValues = false
        }
    }
}

/**
 * Classifies a Convex `status: "error"` envelope.
 *
 * Extracted and directly tested because ConvexResult.Unauthorized now DESTROYS
 * the stored credential — that is what stops a rejected token surviving every
 * restart. Precision is therefore load-bearing, and the deployment throws an
 * "Unauthorized: ..." ConvexError for TWO unrelated conditions:
 *
 *  - "Unauthorized: invalid read token" — the client's credential is wrong.
 *  - "Unauthorized: CONVEX_READ_TOKEN is not configured (fail-closed)." — the
 *    DEPLOYMENT is misconfigured. That is a server fault every device sees at
 *    once, so clearing credentials would wipe a perfectly good token
 *    fleet-wide the moment the backend broke: a far worse failure than the one
 *    the self-heal exists to fix.
 */
internal fun <T> classifyConvexError(message: String?): ConvexResult<T> {
    if (message?.contains("is not configured", ignoreCase = true) == true) {
        return ConvexResult.Failed(ConvexFailure.DeploymentMisconfigured)
    }
    if (message?.contains("Unauthorized", ignoreCase = true) == true) {
        return ConvexResult.Unauthorized
    }
    return ConvexResult.Failed(ConvexFailure.ServerRejected())
}
