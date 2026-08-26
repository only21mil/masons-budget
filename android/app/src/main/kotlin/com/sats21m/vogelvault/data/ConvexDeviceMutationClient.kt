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

internal data class ConvexDeviceCredential(
    val deviceId: String,
    val deviceToken: String,
) {
    init {
        require(DEVICE_ID.matches(deviceId)) { "device id is malformed" }
        require(DEVICE_TOKEN.matches(deviceToken)) { "device token is malformed" }
    }

    companion object {
        // Server-minted components are Base64URL. Retain colon compatibility
        // for legacy IDs, but reserve dot exclusively for the envelope separator.
        private val DEVICE_ID = Regex("^[A-Za-z0-9_:-]{1,128}$")
        private val DEVICE_TOKEN = Regex("^[A-Za-z0-9_-]{32,256}$")

        /** Provisioning format: `<device id>.<device token>`. */
        fun parse(value: String): ConvexDeviceCredential {
            val separator = value.indexOf('.')
            require(
                separator in 1 until value.lastIndex && separator == value.lastIndexOf('.'),
            ) { "device credential is malformed" }
            return ConvexDeviceCredential(
                deviceId = value.substring(0, separator),
                deviceToken = value.substring(separator + 1),
            )
        }
    }
}

internal fun interface ConvexDeviceCredentialSource {
    fun currentDeviceCredential(): ConvexDeviceCredential?
}

internal const val DEVICE_ENTITY_DELETED_REASON = "task was deleted on another device"
internal const val DEVICE_ENTITY_NOT_FOUND_REASON = "task no longer exists"
internal const val DEVICE_PROFILE_BINDING_REQUIRED_REASON =
    "PROFILE_BINDING_REQUIRED: pair a credential bound to this profile"
internal const val DEVICE_REVISION_REQUIRED_REASON =
    "REVISION_REQUIRED: refresh tasks before retrying"

/**
 * Mutation transport for the capability-scoped device endpoints.
 *
 * This is intentionally separate from [ConvexMutationClient]: adding a sync
 * token to these calls would turn an authentication mistake into a silent
 * fallback to the unsafe legacy write contract.
 */
internal class ConvexDeviceMutationClient(
    private val configSource: ConvexConfigSource,
    private val credentialSource: ConvexDeviceCredentialSource,
    private val http: HttpPoster = UrlConnectionHttpPoster(),
) {
    suspend fun mutate(mutation: ConvexMutation): ConvexResult<ConvexValue> {
        val endpoint = mutationEndpoint(configSource.current().deploymentUrl)
            ?: return ConvexResult.NotConfigured
        val credential = credentialSource.currentDeviceCredential()
            ?: return ConvexResult.Unauthorized
        val args = JsonObject(
            mutation.arguments() + mapOf(
                "deviceId" to JsonPrimitive(credential.deviceId),
                "deviceToken" to JsonPrimitive(credential.deviceToken),
            ),
        )
        val body = JsonObject(
            linkedMapOf(
                "path" to JsonPrimitive(mutation.path),
                "args" to args,
                "format" to JsonPrimitive(CONVEX_RESPONSE_FORMAT),
            ),
        ).let { JSON.encodeToString(JsonElement.serializer(), it) }

        val response = try {
            http.postJson(endpoint, body)
        } catch (error: IOException) {
            return ConvexResult.Failed("transport failure (${error.javaClass.simpleName})")
        }
        return parse(response)
    }

    private fun parse(response: HttpTextResponse): ConvexResult<ConvexValue> {
        if (response.code == 401 || response.code == 403) return ConvexResult.Unauthorized
        if (response.code != HTTP_OK) return ConvexResult.Failed("http ${response.code}")
        val envelope = try {
            JSON.parseToJsonElement(response.body) as? JsonObject
        } catch (error: SerializationException) {
            null
        } ?: return ConvexResult.Failed("malformed response envelope")

        return when (envelope.string("status")) {
            "success" -> envelope["value"]
                ?.takeUnless { it is JsonNull }
                ?.let { ConvexResult.Ok(ConvexValue(it, response.body)) }
                ?: ConvexResult.Missing
            "error" -> classifyDeviceError(envelope["errorData"])
            else -> ConvexResult.Failed("unrecognised response envelope")
        }
    }

    private fun classifyDeviceError(raw: JsonElement?): ConvexResult<Nothing> {
        val data = when (raw) {
            is JsonObject -> raw
            is JsonPrimitive -> raw.contentOrNull?.let {
                runCatching { JSON.parseToJsonElement(it) as? JsonObject }.getOrNull()
            }
            else -> null
        } ?: return ConvexResult.Failed("convex rejection")
        return when (data.string("code")) {
            "DEVICE_UNAUTHORIZED" -> ConvexResult.Unauthorized
            "PROFILE_BINDING_REQUIRED" -> ConvexResult.Failed(DEVICE_PROFILE_BINDING_REQUIRED_REASON)
            "REVISION_REQUIRED" -> ConvexResult.Failed(DEVICE_REVISION_REQUIRED_REASON)
            "ENTITY_CONFLICT" -> ConvexResult.Failed("task changed on another device")
            "ENTITY_DELETED" -> ConvexResult.Failed(DEVICE_ENTITY_DELETED_REASON)
            "ENTITY_NOT_FOUND" -> ConvexResult.Failed(DEVICE_ENTITY_NOT_FOUND_REASON)
            "OWNER_MISMATCH", "OWNER_SOURCE_MISMATCH" -> ConvexResult.Failed("task owner was rejected")
            "VALIDATION_FAILED" -> ConvexResult.Failed("task was rejected as invalid")
            else -> ConvexResult.Failed("convex rejection")
        }
    }

    private fun JsonObject.string(key: String): String? =
        (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private companion object {
        const val HTTP_OK = 200
        const val CONVEX_RESPONSE_FORMAT = "convex_encoded_json"
        val JSON = Json { isLenient = false; allowSpecialFloatingPointValues = false }

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
