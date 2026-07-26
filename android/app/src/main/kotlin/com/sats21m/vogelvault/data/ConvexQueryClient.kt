package com.sats21m.vogelvault.data

import java.io.IOException
import org.json.JSONException
import org.json.JSONObject

/**
 * A Convex query result, kept in both forms.
 *
 * [parsed] is the decoded `value` member — a `JSONObject`, `JSONArray` or
 * primitive — which is all the structural queries (`list`, `getVersions`) need.
 *
 * [rawResponseJson] is the untouched response text, and it matters more than it
 * looks. MC2 writes money as JSON numbers, and `org.json` parses every non-integral
 * number into a `Double`. Decoding a balance through that path is exactly the
 * float-money bug this repo forbids (AGENTS.md: money is Decimal, never Double;
 * the Kotlin mirror lands it in integer minor units via `Money.parseCents`). So a
 * data-file payload is handed on as text and the decoder — a later lane — has to
 * read the decimal literals with something precision-preserving and feed them to
 * `Money`, rather than being handed a `Map` full of `Double`s and trusting itself.
 */
class ConvexValue(val parsed: Any, val rawResponseJson: String) {
    /** Redacted: the raw JSON is the family's financial data and must never be logged. */
    override fun toString(): String = "ConvexValue(bytes=${rawResponseJson.length})"
}

/**
 * Calls Convex's HTTP query API.
 *
 * Everything that must not be forgotten happens here, once:
 *
 *  - the kill switch is checked before a socket is opened,
 *  - the read token is attached centrally, so a new call site cannot forget it
 *    (the iOS client attaches it in the same single place, for the same reason),
 *  - the `{ status, value, errorMessage }` envelope is turned into a
 *    [ConvexResult], with "unauthorized" kept distinct from "broken".
 *
 * The token is omitted when absent rather than substituted with a placeholder.
 * The server is the authority: while `ALLOW_TOKENLESS_READ=true` a tokenless
 * read succeeds, and the moment that hatch is removed it fails closed with
 * [ConvexResult.Unauthorized]. Matching iOS here keeps all clients producing the
 * same signal during the cutover.
 */
class ConvexQueryClient(
    private val configSource: ConvexConfigSource,
    private val http: HttpPoster = UrlConnectionHttpPoster(),
) {

    suspend fun query(path: String, args: Map<String, String> = emptyMap()): ConvexResult<ConvexValue> {
        val config = configSource.current()

        when (config.readiness) {
            ReadReadiness.DISABLED -> return ConvexResult.Disabled
            ReadReadiness.NO_DEPLOYMENT_URL -> return ConvexResult.NotConfigured
            ReadReadiness.INSECURE_DEPLOYMENT_URL -> return ConvexResult.NotConfigured
            ReadReadiness.READY_WITHOUT_TOKEN, ReadReadiness.READY -> Unit
        }

        val endpoint = config.queryEndpoint() ?: return ConvexResult.NotConfigured
        val body = requestBody(path, args, config.readTokenOrNull())

        val response = try {
            http.postJson(endpoint, body)
        } catch (error: IOException) {
            // The class name, not the message: an IOException message can carry
            // the URL and, through it, whatever a proxy decided to echo.
            return ConvexResult.Failed("transport failure (${error.javaClass.simpleName})")
        }

        return parse(response)
    }

    private fun requestBody(path: String, args: Map<String, String>, token: String?): String {
        val jsonArgs = JSONObject()
        for ((key, value) in args) {
            jsonArgs.put(key, value)
        }
        if (token != null) {
            jsonArgs.put("token", token)
        }

        // Built with JSONObject rather than string concatenation on purpose:
        // hand-rolled escaping around a secret is how a token ends up mangled or,
        // worse, breaking out of the string it was supposed to be inside.
        return JSONObject()
            .put("path", path)
            .put("args", jsonArgs)
            .put("format", "json")
            .toString()
    }

    private fun parse(response: HttpTextResponse): ConvexResult<ConvexValue> {
        if (response.code != HTTP_OK) return ConvexResult.Failed("http ${response.code}")

        val envelope = try {
            JSONObject(response.body)
        } catch (error: JSONException) {
            return ConvexResult.Failed("malformed response envelope")
        }

        return when (envelope.optString("status")) {
            "success" -> {
                val value = envelope.opt("value")
                if (value == null || value === JSONObject.NULL) {
                    ConvexResult.Missing
                } else {
                    ConvexResult.Ok(ConvexValue(parsed = value, rawResponseJson = response.body))
                }
            }

            "error" -> {
                // Every read rejection thrown by `validateReadToken` starts with
                // "Unauthorized". Matching on that is coarse, but the alternative
                // is echoing server text into a result that gets logged.
                if (envelope.optString("errorMessage").contains("Unauthorized", ignoreCase = true)) {
                    ConvexResult.Unauthorized
                } else {
                    ConvexResult.Failed("convex error")
                }
            }

            else -> ConvexResult.Failed("unrecognised response envelope")
        }
    }

    private companion object {
        const val HTTP_OK = 200
    }
}
