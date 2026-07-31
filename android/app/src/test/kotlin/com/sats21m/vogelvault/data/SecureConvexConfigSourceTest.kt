package com.sats21m.vogelvault.data

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import com.sats21m.vogelvault.initialConvexConfig
import com.sats21m.vogelvault.recoverRejectedStoredConvexConfig
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.UUID
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SecureConvexConfigSourceTest {
    private lateinit var source: SecureConvexConfigSource
    private lateinit var preferencesName: String
    private val context: Application
        get() = RuntimeEnvironment.getApplication()

    @BeforeTest
    fun setUp() {
        preferencesName = "secure-config-test-${UUID.randomUUID()}"
        source =
            SecureConvexConfigSource(
                preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE),
                cipher = TestConfigCipher,
            )
    }

    @Test
    fun `encrypted source round trips without storing plaintext`() {
        val token = "vv-test-${UUID.randomUUID()}"
        source.update(
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = token,
                remoteReadEnabled = true,
            ),
        )

        val restored = source.current()
        assertEquals(ReadReadiness.READY, restored.readiness)
        assertEquals(token, restored.readTokenOrNull())

        val stored = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).all.values
        assertTrue(stored.isNotEmpty())
        stored.forEach { value ->
            assertNotEquals(token, value)
            assertNotEquals("https://example.convex.cloud", value)
        }
    }

    @Test
    fun `encrypted sync token source authenticates a mutation without storing plaintext`() {
        val syncToken = "vv-sync-${UUID.randomUUID()}"
        source.updateSyncToken(syncToken)
        val poster = CapturingPoster()
        val client =
            ConvexMutationClient(
                configSource =
                    MutableConvexConfigSource(
                        ConvexConfig(deploymentUrl = "https://example.convex.cloud"),
                    ),
                syncTokenSource = SecureConvexSyncTokenSource(source),
                http = poster,
            )

        val result = runBlocking {
            client.mutate(
                ConvexMutation.UpsertBudgetCategory(
                    viewer = com.sats21m.vogelvault.domain.FamilyMember.VICTOR,
                    month = "2026-07",
                    category = BudgetCategoryInput("Food", 1L),
                ),
            )
        }

        assertTrue(result.isOk)
        val body = Json.parseToJsonElement(poster.body).jsonObject
        val sentToken =
            body["args"]
                ?.jsonObject
                ?.get("token")
                ?.jsonPrimitive
                ?.content
        assertEquals(syncToken, sentToken)
        context
            .getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
            .all
            .values
            .forEach { stored -> assertNotEquals(syncToken, stored) }
    }

    @Test
    fun `read and sync credentials can be removed independently`() {
        val readToken = "vv-read-${UUID.randomUUID()}"
        val syncToken = "vv-sync-${UUID.randomUUID()}"
        source.update(
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = readToken,
                remoteReadEnabled = true,
            ),
        )
        source.updateSyncToken(syncToken)

        source.clear()

        assertEquals(ReadReadiness.DISABLED, source.current().readiness)
        assertEquals(syncToken, SecureConvexSyncTokenSource(source).currentSyncToken())

        source.update(
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = readToken,
                remoteReadEnabled = true,
            ),
        )
        source.clearSyncToken()

        assertEquals(ReadReadiness.READY, source.current().readiness)
        assertEquals(readToken, source.current().readTokenOrNull())
        assertFalse(source.hasSyncToken())
    }

    @Test
    fun `paired device credential is encrypted atomic and independent of sync token`() {
        val device = ConvexDeviceCredential("android-device", "d".repeat(43))
        val syncToken = "vv-sync-${UUID.randomUUID()}"
        source.updateSyncToken(syncToken)
        source.updateDeviceCredential(device)

        assertEquals(device, SecureConvexDeviceCredentialSource(source).currentDeviceCredential())
        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).all.values.forEach { stored ->
            assertNotEquals(device.deviceId, stored)
            assertNotEquals(device.deviceToken, stored)
        }

        source.clearDeviceCredential()
        assertFalse(source.hasDeviceCredential())
        assertEquals(syncToken, SecureConvexSyncTokenSource(source).currentSyncToken())
    }

    @Test
    fun `partial or tampered paired credential fails closed`() {
        source.updateDeviceCredential(ConvexDeviceCredential("android-device", "d".repeat(43)))
        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
            .edit()
            .remove("device_token")
            .commit()

        assertFalse(source.hasDeviceCredential())
        assertNull(SecureConvexDeviceCredentialSource(source).currentDeviceCredential())
    }

    @Test
    fun `tampered sync token fails closed without disabling valid reads`() {
        source.update(
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = "vv-read-${UUID.randomUUID()}",
                remoteReadEnabled = true,
            ),
        )
        source.updateSyncToken("vv-sync-${UUID.randomUUID()}")
        context
            .getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
            .edit()
            .putString("sync_token", "not-valid-ciphertext")
            .commit()

        assertFalse(source.hasSyncToken())
        assertNull(SecureConvexSyncTokenSource(source).currentSyncToken())
        assertEquals(ReadReadiness.READY, source.current().readiness)
    }

    @Test
    fun `failed sync token removal is reported and retains the credential`() {
        val syncToken = "vv-sync-${UUID.randomUUID()}"
        source.updateSyncToken(syncToken)
        val failingSource =
            SecureConvexConfigSource(
                preferences =
                    ClearCommitFailingPreferences(
                        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE),
                    ),
                cipher = TestConfigCipher,
            )

        assertFailsWith<IOException> {
            failingSource.clearSyncToken()
        }

        assertEquals(syncToken, SecureConvexSyncTokenSource(failingSource).currentSyncToken())
    }

    @Test
    fun `manually entered token survives restart until rejection clears it`() {
        val manuallyEnteredToken = "vv-manual-${UUID.randomUUID()}"
        source.update(
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = manuallyEnteredToken,
                remoteReadEnabled = true,
            ),
        )

        val restartedSource =
            SecureConvexConfigSource(
                preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE),
                cipher = TestConfigCipher,
            )
        val startupConfig = initialConvexConfig(restartedSource.current())
        val effective = MutableConvexConfigSource(startupConfig)

        assertTrue(startupConfig.allowsRemoteRead)
        assertEquals(manuallyEnteredToken, startupConfig.readTokenOrNull())

        assertFalse(
            recoverRejectedStoredConvexConfig(
                rejected = startupConfig,
                stored = restartedSource,
                effective = effective,
            ),
        )
        assertEquals(ReadReadiness.DISABLED, restartedSource.current().readiness)
        assertEquals(ReadReadiness.DISABLED, effective.current().readiness)
        assertFalse(effective.current().hasReadToken)
    }

    @Test
    fun `rejected stored token fails closed`() {
        val storedConfig =
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = "vv-manual-${UUID.randomUUID()}",
                remoteReadEnabled = true,
            )
        source.update(storedConfig)
        val effective = MutableConvexConfigSource(storedConfig)

        // The return value answers "is there a usable credential to retry with?",
        // not "was the rejection handled" -- CachedRowDataSource feeds it straight
        // into retryWithFallback. There is no automatic fallback, so a second load
        // would be wasted.
        assertFalse(
            recoverRejectedStoredConvexConfig(
                rejected = storedConfig,
                stored = source,
                effective = effective,
            ),
        )

        assertEquals(ReadReadiness.DISABLED, source.current().readiness)
        assertEquals(ReadReadiness.DISABLED, effective.current().readiness)
        assertFalse(effective.current().hasReadToken)
    }

    @Test
    fun `failed encrypted-store clear cannot escape unauthorized recovery`() {
        val storedConfig =
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = "vv-manual-${UUID.randomUUID()}",
                remoteReadEnabled = true,
            )
        source.update(storedConfig)
        val failingSource =
            SecureConvexConfigSource(
                preferences =
                    ClearCommitFailingPreferences(
                        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE),
                    ),
                cipher = TestConfigCipher,
            )
        val effective = MutableConvexConfigSource(storedConfig)

        assertFalse(
            recoverRejectedStoredConvexConfig(
                rejected = storedConfig,
                stored = failingSource,
                effective = effective,
            ),
        )

        assertFalse(effective.current().hasReadToken)
        assertEquals(ReadReadiness.DISABLED, effective.current().readiness)
        assertEquals(storedConfig.readTokenOrNull(), failingSource.current().readTokenOrNull())
    }

    @Test
    fun `late rejection cannot clear a newer manually entered token`() {
        val rejectedConfig =
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = "vv-rejected-${UUID.randomUUID()}",
                remoteReadEnabled = true,
            )
        source.update(rejectedConfig)
        val effective = MutableConvexConfigSource(rejectedConfig)
        val newerToken = "vv-new-${UUID.randomUUID()}"
        val newerConfig =
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = newerToken,
                remoteReadEnabled = true,
            )
        source.update(newerConfig)
        effective.update(newerConfig)

        assertFalse(
            recoverRejectedStoredConvexConfig(
                rejected = rejectedConfig,
                stored = source,
                effective = effective,
            ),
        )
        assertEquals(newerToken, source.current().readTokenOrNull())
        assertEquals(newerToken, effective.current().readTokenOrNull())
    }

    @Test
    fun `tampered ciphertext fails closed instead of returning partial config`() {
        source.update(
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = "vv-test-${UUID.randomUUID()}",
                remoteReadEnabled = true,
            ),
        )
        context
            .getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
            .edit()
            .putString("read_token", "not-valid-ciphertext")
            .commit()

        val restored = source.current()
        assertEquals(ReadReadiness.DISABLED, restored.readiness)
        assertFalse(restored.remoteReadEnabled)
        assertFalse(restored.hasReadToken)
        assertNull(restored.deploymentUrl)
    }

    @Test
    fun `clear removes durable configuration`() {
        source.update(ConvexConfig("https://example.convex.cloud", "test", remoteReadEnabled = true))
        source.clear()

        assertEquals(ReadReadiness.DISABLED, source.current().readiness)
        assertTrue(context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).all.isEmpty())
    }

    @Test
    fun `write credential round trips encrypted and separately from read config`() {
        val writePreferences =
            context.getSharedPreferences("$preferencesName-write", Context.MODE_PRIVATE)
        val writeSource =
            SecureConvexConfigSource(
                preferences = writePreferences,
                cipher = TestConfigCipher,
            )
        val token = "vv-write-${UUID.randomUUID()}"

        writeSource.updateSyncToken(token)

        assertEquals(token, SecureConvexSyncTokenSource(writeSource).currentSyncToken())
        assertTrue(writeSource.hasSyncToken())
        assertNotEquals(token, writePreferences.all.values.single())
        assertEquals(ReadReadiness.DISABLED, source.current().readiness)
    }

    @Test
    fun `tampered write credential fails closed`() {
        val writePreferences =
            context.getSharedPreferences("$preferencesName-write", Context.MODE_PRIVATE)
        val writeSource =
            SecureConvexConfigSource(
                preferences = writePreferences,
                cipher = TestConfigCipher,
            )
        writeSource.updateSyncToken("vv-write-${UUID.randomUUID()}")
        writePreferences.edit().putString("sync_token", "not-valid-ciphertext").commit()

        assertNull(SecureConvexSyncTokenSource(writeSource).currentSyncToken())
        assertFalse(writeSource.hasSyncToken())
    }
}

private class ClearCommitFailingPreferences(
    private val delegate: SharedPreferences,
) : SharedPreferences by delegate {
    override fun edit(): SharedPreferences.Editor {
        val delegateEditor = delegate.edit()
        return object : SharedPreferences.Editor by delegateEditor {
            override fun clear(): SharedPreferences.Editor = this

            override fun commit(): Boolean = false
        }
    }
}

private class CapturingPoster : HttpPoster {
    lateinit var body: String

    override suspend fun postJson(
        url: String,
        body: String,
    ): HttpTextResponse {
        this.body = body
        return HttpTextResponse(200, """{"status":"success","value":{"outcome":"deleted"}}""")
    }
}

private object TestConfigCipher : ConfigCipher {
    override fun encrypt(
        field: String,
        plaintext: String,
    ): String = Base64.getEncoder().encodeToString("$field|$plaintext".toByteArray(StandardCharsets.UTF_8))

    override fun decrypt(
        field: String,
        encoded: String,
    ): String {
        val decoded = String(Base64.getDecoder().decode(encoded), StandardCharsets.UTF_8)
        val prefix = "$field|"
        require(decoded.startsWith(prefix)) { "field authentication failed" }
        return decoded.removePrefix(prefix)
    }
}
