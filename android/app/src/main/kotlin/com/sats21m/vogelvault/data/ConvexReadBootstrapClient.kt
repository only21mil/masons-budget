package com.sats21m.vogelvault.data

import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

/** A secret-free result safe for UI state, logs, and crash reports. */
internal enum class ReadBootstrapStatus {
    CONNECTED,
    UNAVAILABLE,
    INVALID_BUNDLE,
    ALREADY_CLAIMED,
    EXPIRED,
    NOT_FOUND,
    PROOF_REJECTED,
    SERVER_MISCONFIGURED,
    NETWORK_ERROR,
    INVALID_RESPONSE,
    STORAGE_ERROR,
}

/** The two trusted fields decoded from the build-generated bootstrap value. */
internal class ReadBootstrapClaim private constructor(
    val pairId: String,
    val proof: String,
) {
    override fun toString(): String = "ReadBootstrapClaim(redacted)"

    companion object {
        private val PAIR_ID = Regex("^android-read-[A-Za-z0-9_-]{16,64}$")
        private val PROOF = Regex("^[A-Za-z0-9_-]{43}$")

        fun parse(value: String): ReadBootstrapClaim? {
            if (value.length !in MIN_BUNDLE_LENGTH..MAX_BUNDLE_LENGTH) return null
            val separator = value.indexOf('.')
            if (separator <= 0 || separator != value.lastIndexOf('.')) return null
            val pairId = value.substring(0, separator)
            val proof = value.substring(separator + 1)
            if (!PAIR_ID.matches(pairId) || !PROOF.matches(proof)) return null

            val decoded = try {
                Base64.decode(proof, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            } catch (_: IllegalArgumentException) {
                return null
            }
            if (decoded.size != PROOF_BYTES) return null
            val canonical = Base64.encodeToString(
                decoded,
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
            )
            if (canonical != proof) return null
            return ReadBootstrapClaim(pairId, proof)
        }

        private const val PROOF_BYTES = 32
        private const val MIN_BUNDLE_LENGTH = 1 + 13 + 16 + 43
        private const val MAX_BUNDLE_LENGTH = 1 + 13 + 64 + 43
    }
}

internal class ReadBootstrapHttpResponse(
    val code: Int,
    val body: String?,
    val oversized: Boolean = false,
) {
    override fun toString(): String =
        "ReadBootstrapHttpResponse(code=$code, bytes=${body?.length ?: 0}, oversized=$oversized)"
}

internal fun interface ReadBootstrapPoster {
    suspend fun post(body: String): ReadBootstrapHttpResponse
}

/** Fixed-origin, no-redirect transport with a hard response-body ceiling. */
internal class ProductionReadBootstrapPoster : ReadBootstrapPoster {
    override suspend fun post(body: String): ReadBootstrapHttpResponse =
        withContext(Dispatchers.IO) {
            val connection = URI.create(BOOTSTRAP_ENDPOINT).toURL().openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.instanceFollowRedirects = false
                connection.connectTimeout = CONNECT_TIMEOUT_MS
                connection.readTimeout = READ_TIMEOUT_MS
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Accept", "application/json")
                connection.outputStream.use { stream ->
                    stream.write(body.toByteArray(StandardCharsets.UTF_8))
                }

                val code = connection.responseCode
                if (code !in 200..299) return@withContext ReadBootstrapHttpResponse(code, null)
                val declaredLength = connection.contentLengthLong
                if (declaredLength > MAX_RESPONSE_BYTES) {
                    return@withContext ReadBootstrapHttpResponse(code, null, oversized = true)
                }
                val bytes = connection.inputStream.use { input ->
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(4_096)
                    var total = 0
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > MAX_RESPONSE_BYTES) return@use null
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                } ?: return@withContext ReadBootstrapHttpResponse(code, null, oversized = true)
                ReadBootstrapHttpResponse(code, String(bytes, StandardCharsets.UTF_8))
            } finally {
                connection.disconnect()
            }
        }

    private companion object {
        const val BOOTSTRAP_ENDPOINT =
            "https://keen-elephant-452.convex.cloud/api/mutation"
        const val CONNECT_TIMEOUT_MS = 10_000
        const val READ_TIMEOUT_MS = 20_000
        const val MAX_RESPONSE_BYTES = 64 * 1_024
    }
}

/** Holds a credential only long enough for the repository to persist it. */
internal class BootstrapCredential(val readToken: String) {
    override fun toString(): String = "BootstrapCredential(redacted)"
}

internal sealed interface BootstrapClientResult {
    class Success(val credential: BootstrapCredential) : BootstrapClientResult {
        override fun toString(): String = "BootstrapClientResult.Success(redacted)"
    }

    class Failure(val status: ReadBootstrapStatus) : BootstrapClientResult
}

/** Dedicated client: it never creates a [ConvexValue] or retains raw response JSON. */
internal class ConvexReadBootstrapClient(
    private val poster: ReadBootstrapPoster = ProductionReadBootstrapPoster(),
) {
    suspend fun claim(claim: ReadBootstrapClaim): BootstrapClientResult {
        val body = JsonObject(
            linkedMapOf(
                "path" to JsonPrimitive(BOOTSTRAP_PATH),
                "args" to JsonObject(
                    linkedMapOf(
                        "pairId" to JsonPrimitive(claim.pairId),
                        "proof" to JsonPrimitive(claim.proof),
                    ),
                ),
                "format" to JsonPrimitive(CONVEX_RESPONSE_FORMAT),
            ),
        ).let { JSON.encodeToString(JsonElement.serializer(), it) }

        val response = try {
            poster.post(body)
        } catch (_: IOException) {
            return BootstrapClientResult.Failure(ReadBootstrapStatus.NETWORK_ERROR)
        } catch (_: SecurityException) {
            return BootstrapClientResult.Failure(ReadBootstrapStatus.NETWORK_ERROR)
        }
        if (response.oversized) {
            return BootstrapClientResult.Failure(ReadBootstrapStatus.INVALID_RESPONSE)
        }
        if (response.code == 401 || response.code == 403) {
            return BootstrapClientResult.Failure(ReadBootstrapStatus.PROOF_REJECTED)
        }
        if (response.code != 200 || response.body == null) {
            return BootstrapClientResult.Failure(ReadBootstrapStatus.NETWORK_ERROR)
        }

        val envelope = try {
            JSON.parseToJsonElement(response.body) as? JsonObject
        } catch (_: SerializationException) {
            null
        } ?: return BootstrapClientResult.Failure(ReadBootstrapStatus.INVALID_RESPONSE)

        return when ((envelope["status"] as? JsonPrimitive)?.contentOrNull) {
            "success" -> parseSuccess(envelope)
            "error" -> BootstrapClientResult.Failure(parseError(envelope))
            else -> BootstrapClientResult.Failure(ReadBootstrapStatus.INVALID_RESPONSE)
        }
    }

    private fun parseSuccess(envelope: JsonObject): BootstrapClientResult {
        if (envelope.keys != setOf("status", "value")) {
            return BootstrapClientResult.Failure(ReadBootstrapStatus.INVALID_RESPONSE)
        }
        val value = envelope["value"] as? JsonObject
            ?: return BootstrapClientResult.Failure(ReadBootstrapStatus.INVALID_RESPONSE)
        if (value.keys != setOf("ok", "readToken", "pairedAt")) {
            return BootstrapClientResult.Failure(ReadBootstrapStatus.INVALID_RESPONSE)
        }
        val ok = value["ok"] as? JsonPrimitive
        if (ok == null || ok.isString || ok.booleanOrNull != true) {
            return BootstrapClientResult.Failure(ReadBootstrapStatus.INVALID_RESPONSE)
        }
        val token = (value["readToken"] as? JsonPrimitive)
            ?.takeIf(JsonPrimitive::isString)
            ?.contentOrNull
            ?.takeIf(::isBoundedReadToken)
            ?: return BootstrapClientResult.Failure(ReadBootstrapStatus.INVALID_RESPONSE)
        val pairedAtPrimitive = value["pairedAt"] as? JsonPrimitive
        val pairedAt = pairedAtPrimitive?.takeUnless { it.isString }?.doubleOrNull
        if (pairedAt == null || !pairedAt.isFinite() || pairedAt < 0.0) {
            return BootstrapClientResult.Failure(ReadBootstrapStatus.INVALID_RESPONSE)
        }
        return BootstrapClientResult.Success(BootstrapCredential(token))
    }

    private fun parseError(envelope: JsonObject): ReadBootstrapStatus {
        if (envelope.keys !in setOf(
                setOf("status", "errorData"),
                setOf("status", "errorData", "errorMessage"),
            )
        ) {
            return ReadBootstrapStatus.INVALID_RESPONSE
        }
        val raw = envelope["errorData"]
        val data = when (raw) {
            is JsonObject -> raw
            is JsonPrimitive -> raw.contentOrNull?.takeIf { it.length <= MAX_ERROR_DATA_BYTES }?.let {
                runCatching { JSON.parseToJsonElement(it) as? JsonObject }.getOrNull()
            }
            else -> null
        } ?: return ReadBootstrapStatus.INVALID_RESPONSE
        val code = (data["code"] as? JsonPrimitive)
            ?.takeIf(JsonPrimitive::isString)
            ?.contentOrNull
            ?: return ReadBootstrapStatus.INVALID_RESPONSE
        return when (code.uppercase(Locale.ROOT)) {
            "ANDROID_READ_BOOTSTRAP_ALREADY_CLAIMED" ->
                ReadBootstrapStatus.ALREADY_CLAIMED
            "ANDROID_READ_BOOTSTRAP_EXPIRED" -> ReadBootstrapStatus.EXPIRED
            "ANDROID_READ_BOOTSTRAP_NOT_FOUND" -> ReadBootstrapStatus.NOT_FOUND
            "ANDROID_READ_BOOTSTRAP_PROOF_INVALID" ->
                ReadBootstrapStatus.PROOF_REJECTED
            "CONFIG_MISSING" -> ReadBootstrapStatus.SERVER_MISCONFIGURED
            "VALIDATION_FAILED" -> ReadBootstrapStatus.INVALID_BUNDLE
            else -> ReadBootstrapStatus.INVALID_RESPONSE
        }
    }

    private companion object {
        const val BOOTSTRAP_PATH = "dataFiles:claimAndroidReadBootstrap"
        const val CONVEX_RESPONSE_FORMAT = "convex_encoded_json"
        const val MAX_ERROR_DATA_BYTES = 4_096
        val JSON = Json { isLenient = false; allowSpecialFloatingPointValues = false }

        fun isBoundedReadToken(value: String): Boolean =
            value.length in 32..512 && value.all { it.code in 0x21..0x7e }
    }
}

/** Owns the only transition from a response credential into durable app configuration. */
internal class ConvexReadBootstrapRepository(
    private val stored: SecureConvexConfigSource,
    private val effective: MutableConvexConfigSource,
    private val client: ConvexReadBootstrapClient = ConvexReadBootstrapClient(),
    private val storageLock: Any = Any(),
) {
    suspend fun connect(bundledPair: String): ReadBootstrapStatus {
        if (bundledPair.isEmpty()) return ReadBootstrapStatus.UNAVAILABLE
        val claim = ReadBootstrapClaim.parse(bundledPair)
            ?: return ReadBootstrapStatus.INVALID_BUNDLE
        return when (val result = client.claim(claim)) {
            is BootstrapClientResult.Failure -> result.status
            is BootstrapClientResult.Success -> persist(result.credential)
        }
    }

    private fun persist(credential: BootstrapCredential): ReadBootstrapStatus {
        val next = ConvexConfig(
            deploymentUrl = PRODUCTION_DEPLOYMENT,
            readToken = credential.readToken,
            remoteReadEnabled = true,
        )
        return synchronized(storageLock) {
            try {
                // SecureConvexConfigSource.update writes the complete read config with
                // one synchronous SharedPreferences commit. Sync/device fields are untouched.
                stored.update(next)
                val durable = stored.current()
                if (!durable.hasSameReadCredential(next)) return@synchronized ReadBootstrapStatus.STORAGE_ERROR
                effective.update(durable)
                ReadBootstrapStatus.CONNECTED
            } catch (_: Exception) {
                ReadBootstrapStatus.STORAGE_ERROR
            }
        }
    }
}

private fun ConvexConfig.hasSameReadCredential(other: ConvexConfig): Boolean =
    deploymentUrl == other.deploymentUrl &&
        readTokenOrNull() == other.readTokenOrNull() &&
        remoteReadEnabled == other.remoteReadEnabled

private const val PRODUCTION_DEPLOYMENT = "https://keen-elephant-452.convex.cloud"
