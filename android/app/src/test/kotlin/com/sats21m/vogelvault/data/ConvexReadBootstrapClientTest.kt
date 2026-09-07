package com.sats21m.vogelvault.data

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import com.sats21m.vogelvault.domain.FamilyMember
import java.io.IOException
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ConvexReadBootstrapClientTest {
    private val pairId = "android-read-abcdefghijklmnop"
    private val proof = Base64.encodeToString(
        ByteArray(32) { it.toByte() },
        Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
    )
    private val bundle = "$pairId.$proof"
    private val readToken = "r".repeat(43)
    private val deviceId = canonicalBase64Url(ByteArray(16) { (it + 1).toByte() })
    private val deviceToken = canonicalBase64Url(ByteArray(32) { (it + 17).toByte() })

    @Test
    fun `parser accepts only locked canonical wire format`() {
        val parsed = requireNotNull(ReadBootstrapClaim.parse(bundle))

        assertEquals(pairId, parsed.pairId)
        assertEquals(proof, parsed.proof)
        assertEquals("ReadBootstrapClaim(redacted)", parsed.toString())

        val zeroProof = "A".repeat(43)
        val malformed = listOf(
            " $bundle",
            "$bundle ",
            "android-write-abcdefghijklmnop.$proof",
            "android-read-abcdefghijklmno.$proof",
            "android-read-${"a".repeat(65)}.$proof",
            "$pairId.${proof.dropLast(1)}",
            "$pairId.${proof.dropLast(1)}=",
            "$pairId.${proof.dropLast(1)}.",
            "$pairId.${zeroProof.dropLast(1)}B",
        )
        malformed.forEach { assertNull(ReadBootstrapClaim.parse(it), it) }
    }

    @Test
    fun `claim sends exact fixed mutation args and returns a redacted credential result`() = runBlocking {
        val poster = RecordingBootstrapPoster(success(readToken))
        val result = ConvexReadBootstrapClient(
            poster,
            ReadBootstrapDeviceCredentialGenerator { error("read-only claim generated a device credential") },
        ).claim(requireNotNull(ReadBootstrapClaim.parse(bundle)))

        val success = assertIs<BootstrapClientResult.Success>(result)
        assertEquals(readToken, success.credential.readToken)
        assertFalse(success.toString().contains(readToken))
        assertFalse(success.credential.toString().contains(readToken))

        val wire = Json.parseToJsonElement(requireNotNull(poster.body)).jsonObject
        assertEquals(setOf("path", "args", "format"), wire.keys)
        assertEquals("dataFiles:claimAndroidReadBootstrap", wire["path"]!!.jsonPrimitive.content)
        assertEquals("convex_encoded_json", wire["format"]!!.jsonPrimitive.content)
        val args = wire["args"]!!.jsonObject
        assertEquals(setOf("pairId", "proof"), args.keys)
        assertEquals(pairId, args["pairId"]!!.jsonPrimitive.content)
        assertEquals(proof, args["proof"]!!.jsonPrimitive.content)
        assertFalse("readToken" in args)
        assertFalse("syncToken" in args)
        assertFalse("token" in args)
        assertFalse(poster.toString().contains(proof))
    }

    @Test
    fun `todo write claim generates canonical local credential and requires matching response`() = runBlocking {
        val poster = EchoingWriteBootstrapPoster(readToken)
        val result = ConvexReadBootstrapClient(poster).claim(
            requireNotNull(ReadBootstrapClaim.parse(bundle)),
            requestTodoWrite = true,
        )

        val success = assertIs<BootstrapClientResult.Success>(result)
        val wire = Json.parseToJsonElement(requireNotNull(poster.body)).jsonObject
        val args = wire["args"]!!.jsonObject
        assertEquals(setOf("pairId", "proof", "deviceId", "deviceToken"), args.keys)
        val deviceId = args["deviceId"]!!.jsonPrimitive.content
        val deviceToken = args["deviceToken"]!!.jsonPrimitive.content
        assertEquals(22, deviceId.length)
        assertEquals(16, decodeCanonicalBase64Url(deviceId).size)
        assertEquals(43, deviceToken.length)
        assertEquals(32, decodeCanonicalBase64Url(deviceToken).size)
        assertEquals(deviceId, success.credential.deviceCredential?.deviceId)
        assertEquals(deviceToken, success.credential.deviceCredential?.deviceToken)
        assertEquals(FamilyMember.MASON, success.credential.deviceCredential?.profile)
        assertFalse("readToken" in args)
        assertFalse("syncToken" in args)
        assertFalse("token" in args)
        assertFalse(success.toString().contains(deviceToken))
        assertFalse(success.credential.toString().contains(deviceToken))
        assertFalse(poster.toString().contains(deviceToken))
    }

    @Test
    fun `todo write claim fails closed before transport for a malformed local credential`() = runBlocking {
        val poster = RecordingBootstrapPoster(writeSuccess(readToken, deviceId))
        val result = ConvexReadBootstrapClient(
            poster,
            ReadBootstrapDeviceCredentialGenerator {
                ConvexDeviceCredential("legacy:device", deviceToken)
            },
        ).claim(
            requireNotNull(ReadBootstrapClaim.parse(bundle)),
            requestTodoWrite = true,
        )

        assertEquals(
            ReadBootstrapStatus.INVALID_BUNDLE,
            assertIs<BootstrapClientResult.Failure>(result).status,
        )
        assertNull(poster.body)
    }

    @Test
    fun `strict success decoder rejects extras coercions and malformed credentials`() = runBlocking {
        val invalidBodies = listOf(
            """{"status":"success","value":{"ok":true,"readToken":"$readToken","pairedAt":1}}""",
            """{"status":"success","value":{"ok":true,"readToken":"$readToken","pairedAt":1,"capabilities":[],"extra":true}}""",
            """{"status":"success","value":{"ok":"true","readToken":"$readToken","pairedAt":1,"capabilities":[]}}""",
            """{"status":"success","value":{"ok":true,"readToken":"short","pairedAt":1,"capabilities":[]}}""",
            """{"status":"success","value":{"ok":true,"readToken":"$readToken","pairedAt":"1","capabilities":[]}}""",
            """{"status":"success","value":{"ok":true,"readToken":"$readToken","pairedAt":-1,"capabilities":[]}}""",
            """{"status":"success","value":{"ok":true,"readToken":"$readToken","pairedAt":1,"capabilities":["todos:write","budget:write"]}}""",
            """{"status":"success","value":{"ok":true,"readToken":"$readToken","pairedAt":1,"capabilities":[],"deviceId":"unexpected"}}""",
            """{"status":"success","value":{"ok":true,"readToken":"$readToken","pairedAt":1,"capabilities":{}},"extra":true}""",
            """{"status":"success","value":{"ok":true,"readToken":"$readToken","pairedAt":1,"capabilities":[]},"extra":true}""",
        )

        invalidBodies.forEach { body ->
            val result = clientResult(HttpTextResponseFixture(200, body))
            assertEquals(ReadBootstrapStatus.INVALID_RESPONSE, assertIs<BootstrapClientResult.Failure>(result).status)
        }
    }

    @Test
    fun `todo write success rejects device and capability confusion`() = runBlocking {
        val requested = ConvexDeviceCredential(
            deviceId = deviceId,
            deviceToken = deviceToken,
        )
        val validValue =
            """{"ok":true,"readToken":"$readToken","pairedAt":1,"deviceId":"${requested.deviceId}","capabilities":["todos:write","budget:write"],"profile":"mason"}"""
        val invalidValues = listOf(
            """{"ok":true,"readToken":"$readToken","pairedAt":1,"capabilities":["todos:write","budget:write"]}""",
            validValue.replace(requested.deviceId, "different-device"),
            validValue.replace("[\"todos:write\",\"budget:write\"]", "[\"todos:write\"]"),
            validValue.replace("[\"todos:write\",\"budget:write\"]", "[]"),
            validValue.replace("[\"todos:write\",\"budget:write\"]", "[\"todos:write\",\"todos:write\"]"),
            validValue.replace("todos:write", "budget:write"),
            validValue.replace("\"mason\"", "\"unknown\""),
            validValue.replace("[\"todos:write\",\"budget:write\"]", "\"todos:write\""),
            validValue.dropLast(1) + ",\"extra\":true}",
        )

        invalidValues.forEach { value ->
            val result = ConvexReadBootstrapClient(
                RecordingBootstrapPoster("""{"status":"success","value":$value}"""),
                ReadBootstrapDeviceCredentialGenerator { requested },
            ).claim(
                requireNotNull(ReadBootstrapClaim.parse(bundle)),
                requestTodoWrite = true,
            )
            assertEquals(
                ReadBootstrapStatus.INVALID_RESPONSE,
                assertIs<BootstrapClientResult.Failure>(result).status,
            )
        }
    }

    @Test
    fun `locked structured failures map without exposing remote text`() = runBlocking {
        val expected = mapOf(
            "ANDROID_READ_BOOTSTRAP_ALREADY_CLAIMED" to ReadBootstrapStatus.ALREADY_CLAIMED,
            "ANDROID_READ_BOOTSTRAP_EXPIRED" to ReadBootstrapStatus.EXPIRED,
            "ANDROID_READ_BOOTSTRAP_NOT_FOUND" to ReadBootstrapStatus.NOT_FOUND,
            "ANDROID_READ_BOOTSTRAP_PROOF_INVALID" to ReadBootstrapStatus.PROOF_REJECTED,
            "CONFIG_MISSING" to ReadBootstrapStatus.SERVER_MISCONFIGURED,
            "VALIDATION_FAILED" to ReadBootstrapStatus.INVALID_BUNDLE,
        )
        expected.forEach { (code, status) ->
            val secretText = "remote-secret-$code"
            val result = clientResult(
                HttpTextResponseFixture(
                    200,
                    """{"status":"error","errorData":{"code":"$code","message":"$secretText"}}""",
                ),
            )
            val failure = assertIs<BootstrapClientResult.Failure>(result)
            assertEquals(status, failure.status)
            assertFalse(failure.toString().contains(secretText))
        }
    }

    @Test
    fun `transport rejection oversize and exception stay secret free`() = runBlocking {
        val rejected = clientResult(HttpTextResponseFixture(403, null))
        assertEquals(ReadBootstrapStatus.PROOF_REJECTED, assertIs<BootstrapClientResult.Failure>(rejected).status)

        val oversized = clientResult(HttpTextResponseFixture(200, null, oversized = true))
        assertEquals(ReadBootstrapStatus.INVALID_RESPONSE, assertIs<BootstrapClientResult.Failure>(oversized).status)

        val throwing = ConvexReadBootstrapClient(ReadBootstrapPoster { throw IOException("secret-url-detail") })
            .claim(requireNotNull(ReadBootstrapClaim.parse(bundle)))
        assertEquals(ReadBootstrapStatus.NETWORK_ERROR, assertIs<BootstrapClientResult.Failure>(throwing).status)
        assertFalse(throwing.toString().contains("secret-url-detail"))
    }

    @Test
    fun `repository commits encrypted read config before changing effective config and preserves writes`() = runBlocking {
        val context: Application = RuntimeEnvironment.getApplication()
        val preferences = context.getSharedPreferences("bootstrap-${UUID.randomUUID()}", Context.MODE_PRIVATE)
        val stored = SecureConvexConfigSource(preferences, TestCipher)
        val syncToken = "s".repeat(43)
        val device = ConvexDeviceCredential(
            "existing-device",
            "d".repeat(43),
            FamilyMember.MASON,
        )
        stored.updateSyncToken(syncToken)
        stored.updateDeviceCredential(device)
        val effective = MutableConvexConfigSource(ConvexConfig())
        val repository = ConvexReadBootstrapRepository(
            stored,
            effective,
            ConvexReadBootstrapClient(RecordingBootstrapPoster(success(readToken))),
        )

        assertEquals(ReadBootstrapStatus.CONNECTED, repository.connect(bundle))
        assertEquals(ReadReadiness.READY, stored.current().readiness)
        assertEquals(ReadReadiness.READY, effective.current().readiness)
        assertEquals(readToken, effective.current().readTokenOrNull())
        assertEquals(syncToken, SecureConvexSyncTokenSource(stored).currentSyncToken())
        assertEquals(device, SecureConvexDeviceCredentialSource(stored).currentDeviceCredential())
        preferences.all.values.forEach { value -> assertNotEquals(readToken, value) }
    }

    @Test
    fun `repository hands combined credential to atomic storage and uses durable readback`() = runBlocking {
        val device = ConvexDeviceCredential(
            deviceId = deviceId,
            deviceToken = deviceToken,
        )
        val store = RecordingBootstrapCredentialStore()
        val effective = MutableConvexConfigSource(ConvexConfig())
        val repository = ConvexReadBootstrapRepository(
            store,
            effective,
            ConvexReadBootstrapClient(
                RecordingBootstrapPoster(writeSuccess(readToken, device.deviceId)),
                ReadBootstrapDeviceCredentialGenerator { device },
            ),
        )

        assertEquals(
            ReadBootstrapStatus.CONNECTED,
            repository.connect(bundle, requestTodoWrite = true),
        )
        assertEquals(device.copy(profile = FamilyMember.MASON), store.deviceCredential)
        assertEquals(readToken, store.readConfig?.readTokenOrNull())
        assertEquals(readToken, effective.current().readTokenOrNull())
    }

    @Test
    fun `repository rejects a todo only response before storing any credential`() = runBlocking {
        val store = RecordingBootstrapCredentialStore()
        val effective = MutableConvexConfigSource(ConvexConfig())
        val repository = ConvexReadBootstrapRepository(
            store,
            effective,
            ConvexReadBootstrapClient(
                RecordingBootstrapPoster(
                    writeSuccess(readToken, deviceId).replace(
                        "[\"todos:write\",\"budget:write\"]",
                        "[\"todos:write\"]",
                    ),
                ),
                ReadBootstrapDeviceCredentialGenerator {
                    ConvexDeviceCredential(deviceId, deviceToken)
                },
            ),
        )
        assertEquals(
            ReadBootstrapStatus.INVALID_RESPONSE,
            repository.connect(bundle, requestTodoWrite = true),
        )
        assertNull(store.readConfig)
        assertNull(store.deviceCredential)
        assertFalse(effective.current().hasReadToken)
    }

    @Test
    fun `empty bundle is inert and failed commit never updates effective config`() = runBlocking {
        val context: Application = RuntimeEnvironment.getApplication()
        val delegate = context.getSharedPreferences("bootstrap-fail-${UUID.randomUUID()}", Context.MODE_PRIVATE)
        val stored = SecureConvexConfigSource(CommitFailingPreferences(delegate), TestCipher)
        val effective = MutableConvexConfigSource(ConvexConfig())
        val poster = RecordingBootstrapPoster(success(readToken))
        val repository = ConvexReadBootstrapRepository(
            stored,
            effective,
            ConvexReadBootstrapClient(poster),
        )

        assertEquals(ReadBootstrapStatus.UNAVAILABLE, repository.connect(""))
        assertNull(poster.body)
        assertEquals(ReadBootstrapStatus.STORAGE_ERROR, repository.connect(bundle))
        assertEquals(ReadReadiness.DISABLED, effective.current().readiness)
        assertFalse(effective.current().hasReadToken)
    }

    private suspend fun clientResult(response: HttpTextResponseFixture): BootstrapClientResult =
        ConvexReadBootstrapClient(
            ReadBootstrapPoster {
                ReadBootstrapHttpResponse(response.code, response.body, response.oversized)
            },
        ).claim(requireNotNull(ReadBootstrapClaim.parse(bundle)))

    private fun success(token: String): String =
        """{"status":"success","value":{"ok":true,"readToken":"$token","pairedAt":1800000000000,"capabilities":[]}}"""

    private fun writeSuccess(token: String, deviceId: String): String =
        """{"status":"success","value":{"ok":true,"readToken":"$token","pairedAt":1800000000000,"deviceId":"$deviceId","capabilities":["todos:write","budget:write"],"profile":"mason"}}"""
}

private data class HttpTextResponseFixture(
    val code: Int,
    val body: String?,
    val oversized: Boolean = false,
)

private class RecordingBootstrapPoster(private val responseBody: String) : ReadBootstrapPoster {
    var body: String? = null
        private set

    override suspend fun post(body: String): ReadBootstrapHttpResponse {
        this.body = body
        return ReadBootstrapHttpResponse(200, responseBody)
    }

    override fun toString(): String = "RecordingBootstrapPoster(bytes=${body?.length ?: 0})"
}

private class EchoingWriteBootstrapPoster(private val readToken: String) : ReadBootstrapPoster {
    var body: String? = null
        private set

    override suspend fun post(body: String): ReadBootstrapHttpResponse {
        this.body = body
        val args = Json.parseToJsonElement(body).jsonObject["args"]!!.jsonObject
        val deviceId = args["deviceId"]!!.jsonPrimitive.content
        return ReadBootstrapHttpResponse(
            200,
            """{"status":"success","value":{"ok":true,"readToken":"$readToken","pairedAt":1,"deviceId":"$deviceId","capabilities":["todos:write","budget:write"],"profile":"mason"}}""",
        )
    }

    override fun toString(): String = "EchoingWriteBootstrapPoster(bytes=${body?.length ?: 0})"
}

private class RecordingBootstrapCredentialStore : ConvexBootstrapCredentialStore {
    var readConfig: ConvexConfig? = null
        private set
    var deviceCredential: ConvexDeviceCredential? = null
        private set

    override fun commitBootstrap(
        readConfig: ConvexConfig,
        deviceCredential: ConvexDeviceCredential?,
    ): StoredConvexBootstrap {
        this.readConfig = readConfig
        this.deviceCredential = deviceCredential
        return StoredConvexBootstrap(readConfig, deviceCredential)
    }
}

private fun decodeCanonicalBase64Url(value: String): ByteArray {
    val decoded = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    assertEquals(
        value,
        Base64.encodeToString(
            decoded,
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        ),
    )
    return decoded
}

private fun canonicalBase64Url(value: ByteArray): String =
    Base64.encodeToString(
        value,
        Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
    )

private object TestCipher : ConfigCipher {
    override fun encrypt(field: String, plaintext: String): String =
        Base64.encodeToString(
            "$field|$plaintext".toByteArray(),
            Base64.NO_WRAP,
        )

    override fun decrypt(field: String, encoded: String): String {
        val decoded = String(Base64.decode(encoded, Base64.NO_WRAP))
        return decoded.removePrefix("$field|")
    }
}

private class CommitFailingPreferences(
    private val delegate: SharedPreferences,
) : SharedPreferences by delegate {
    override fun edit(): SharedPreferences.Editor {
        val editor = delegate.edit()
        return object : SharedPreferences.Editor by editor {
            override fun commit(): Boolean = false
        }
    }
}
