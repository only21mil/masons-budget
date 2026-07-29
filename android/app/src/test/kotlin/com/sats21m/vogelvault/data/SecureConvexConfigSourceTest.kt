package com.sats21m.vogelvault.data

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import com.sats21m.vogelvault.buildTimeConvexConfig
import com.sats21m.vogelvault.initialConvexConfig
import com.sats21m.vogelvault.recoverRejectedStoredConvexConfig
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.UUID
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

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
    fun `manually entered token wins until rejected then baked token takes over`() {
        val manuallyEnteredToken = "vv-manual-${UUID.randomUUID()}"
        val bakedToken = "vv-baked-${UUID.randomUUID()}"
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
        val startupConfig =
            initialConvexConfig(
                buildTime = buildTimeConvexConfig(bakedToken),
                stored = restartedSource.current(),
            )
        val effective = MutableConvexConfigSource(startupConfig)

        assertTrue(startupConfig.allowsRemoteRead)
        assertEquals(manuallyEnteredToken, startupConfig.readTokenOrNull())

        assertTrue(
            recoverRejectedStoredConvexConfig(
                rejected = startupConfig,
                stored = restartedSource,
                effective = effective,
                fallback = buildTimeConvexConfig(bakedToken),
            ),
        )
        assertEquals(ReadReadiness.DISABLED, restartedSource.current().readiness)
        assertEquals(bakedToken, effective.current().readTokenOrNull())
        assertTrue(effective.current().allowsRemoteRead)
    }

    @Test
    fun `rejected stored token fails closed when release build has no baked token`() {
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
        // into retryWithFallback. A release build has no baked token, so there is
        // nothing to retry and a second load would be wasted. The recovery itself
        // still happens: both sources below must end up DISABLED rather than
        // holding a credential the server has already rejected.
        assertFalse(
            recoverRejectedStoredConvexConfig(
                rejected = storedConfig,
                stored = source,
                effective = effective,
                fallback = buildTimeConvexConfig(""),
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
        val fallback = buildTimeConvexConfig("vv-baked-${UUID.randomUUID()}")
        val effective = MutableConvexConfigSource(storedConfig)

        assertTrue(
            recoverRejectedStoredConvexConfig(
                rejected = storedConfig,
                stored = failingSource,
                effective = effective,
                fallback = fallback,
            ),
        )

        assertEquals(fallback.readTokenOrNull(), effective.current().readTokenOrNull())
        assertEquals(ReadReadiness.READY, effective.current().readiness)
        assertEquals(storedConfig.readTokenOrNull(), failingSource.current().readTokenOrNull())
    }

    @Test
    fun `rejected baked token is disabled when no stored credential remains`() {
        val bakedConfig = buildTimeConvexConfig("vv-baked-${UUID.randomUUID()}")
        val effective = MutableConvexConfigSource(bakedConfig)

        assertFalse(
            recoverRejectedStoredConvexConfig(
                rejected = bakedConfig,
                stored = source,
                effective = effective,
                fallback = bakedConfig,
            ),
        )

        assertEquals(ReadReadiness.DISABLED, effective.current().readiness)
        assertFalse(effective.current().hasReadToken)
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
                fallback = buildTimeConvexConfig("vv-baked-${UUID.randomUUID()}"),
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
