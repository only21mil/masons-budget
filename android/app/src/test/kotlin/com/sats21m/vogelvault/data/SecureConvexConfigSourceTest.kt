package com.sats21m.vogelvault.data

import android.app.Application
import android.content.Context
import com.sats21m.vogelvault.buildTimeConvexConfig
import com.sats21m.vogelvault.initialConvexConfig
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
    fun `manually entered token survives restart when build token is present`() {
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
        val startupConfig =
            initialConvexConfig(
                buildTime = buildTimeConvexConfig("vv-baked-${UUID.randomUUID()}"),
                stored = restartedSource.current(),
            )

        assertTrue(startupConfig.allowsRemoteRead)
        assertEquals(manuallyEnteredToken, startupConfig.readTokenOrNull())
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
