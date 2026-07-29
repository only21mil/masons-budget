package com.sats21m.vogelvault.data

import java.io.IOException
import java.net.URI
import java.net.URISyntaxException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Supplies the write credential without coupling transport to a storage choice.
 *
 * Production must back this with the encrypted Android configuration store.
 * The read token is deliberately not accepted as a fallback.
 */
internal fun interface ConvexSyncTokenSource {
    fun currentSyncToken(): String?
}

internal object DisabledConvexSyncTokenSource : ConvexSyncTokenSource {
    override fun currentSyncToken(): String? = null
}

/**
 * Calls Convex's HTTP mutation API for the closed [ConvexMutation] catalogue.
 *
 * Missing credentials, non-HTTPS deployments, network failures, non-success
 * HTTP responses, and Convex rejections all produce explicit non-OK results.
 */
internal class ConvexMutationClient(
    private val configSource: ConvexConfigSource,
    private val syncTokenSource: ConvexSyncTokenSource,
    private val http: HttpPoster = UrlConnectionHttpPoster(),
) {
    suspend fun mutate(mutation: ConvexMutation): ConvexResult<ConvexValue> {
        val endpoint = mutationEndpoint(configSource.current().deploymentUrl)
            ?: return ConvexResult.NotConfigured
        val token = syncTokenSource.currentSyncToken()?.trim()?.takeIf { it.isNotEmpty() }
            ?: return ConvexResult.Unauthorized
        val body = requestBody(mutation, token)

        val response = try {
            http.postJson(endpoint, body)
        } catch (error: IOException) {
            return ConvexResult.Failed("transport failure (${error.javaClass.simpleName})")
        }

        return parse(response)
    }

    private fun requestBody(mutation: ConvexMutation, token: String): String {
        val args = JsonObject(mutation.arguments() + ("token" to JsonPrimitive(token)))
        val request = JsonObject(
            linkedMapOf(
                "path" to JsonPrimitive(mutation.path),
                "args" to args,
                "format" to JsonPrimitive(CONVEX_RESPONSE_FORMAT),
            ),
        )
        return JSON.encodeToString(JsonElement.serializer(), request)
    }

    private fun parse(response: HttpTextResponse): ConvexResult<ConvexValue> {
        if (response.code != HTTP_OK) return ConvexResult.Failed("http ${response.code}")

        val envelope = try {
            JSON.parseToJsonElement(response.body) as? JsonObject
        } catch (error: SerializationException) {
            null
        } ?: return ConvexResult.Failed("malformed response envelope")

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
                val errorData = envelope["errorData"]
                val message = if (errorData == null || errorData is JsonNull) {
                    envelope["errorMessage"].stringOrNull()
                } else {
                    errorData.stringOrNull()
                }
                if (message?.contains("Unauthorized", ignoreCase = true) == true) {
                    ConvexResult.Unauthorized
                } else {
                    ConvexResult.Failed("convex rejection")
                }
            }

            else -> ConvexResult.Failed("unrecognised response envelope")
        }
    }

    private fun JsonObject.string(key: String): String? = get(key).stringOrNull()

    private fun JsonElement?.stringOrNull(): String? =
        (this as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private companion object {
        const val HTTP_OK = 200
        const val CONVEX_RESPONSE_FORMAT = "convex_encoded_json"
        val JSON = Json {
            isLenient = false
            allowSpecialFloatingPointValues = false
        }

        fun mutationEndpoint(deploymentUrl: String?): String? {
            val base = deploymentUrl?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val secure = try {
                val uri = URI(base)
                uri.scheme?.lowercase() == "https" && !uri.host.isNullOrEmpty()
            } catch (error: URISyntaxException) {
                false
            }
            return if (secure) base.trimEnd('/') + "/api/mutation" else null
        }
    }
}
