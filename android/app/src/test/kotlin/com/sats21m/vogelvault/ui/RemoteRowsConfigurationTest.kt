package com.sats21m.vogelvault.ui

import android.app.Application
import android.content.Context
import com.sats21m.vogelvault.removeStoredConvexConfigIfPresent
import com.sats21m.vogelvault.data.ConfigCipher
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.ReadReadiness
import com.sats21m.vogelvault.data.SecureConvexConfigSource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RemoteRowsConfigurationTest {
    @Test
    fun `remove clears encrypted storage and the process configuration`() {
        val context: Application = RuntimeEnvironment.getApplication()
        val preferences =
            context.getSharedPreferences(
                "remote-rows-configuration-test-${UUID.randomUUID()}",
                Context.MODE_PRIVATE,
            )
        val stored =
            SecureConvexConfigSource(
                preferences = preferences,
                cipher = PassthroughConfigCipher,
            )
        val configured =
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = "test-token",
                remoteReadEnabled = true,
            )
        val effective = MutableConvexConfigSource(configured)
        stored.update(configured)

        assertTrue(removeStoredConvexConfigIfPresent(stored, effective))

        assertTrue(preferences.all.isEmpty())
        assertEquals(ReadReadiness.DISABLED, stored.current().readiness)
        assertEquals(ReadReadiness.DISABLED, effective.current().readiness)
        assertFalse(effective.current().hasReadToken)
    }

    @Test
    fun `stale remove cannot disable a working fallback after self heal`() {
        val context: Application = RuntimeEnvironment.getApplication()
        val preferences =
            context.getSharedPreferences(
                "remote-rows-stale-configuration-test-${UUID.randomUUID()}",
                Context.MODE_PRIVATE,
            )
        val stored =
            SecureConvexConfigSource(
                preferences = preferences,
                cipher = PassthroughConfigCipher,
            )
        val fallback =
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = "working-fallback",
                remoteReadEnabled = true,
            )
        val effective = MutableConvexConfigSource(fallback)

        assertFalse(removeStoredConvexConfigIfPresent(stored, effective))
        assertEquals(ReadReadiness.READY, effective.current().readiness)
        assertTrue(effective.current().hasReadToken)
    }
}

private object PassthroughConfigCipher : ConfigCipher {
    override fun encrypt(
        field: String,
        plaintext: String,
    ): String = "$field:$plaintext"

    override fun decrypt(
        field: String,
        encoded: String,
    ): String = encoded.removePrefix("$field:")
}
