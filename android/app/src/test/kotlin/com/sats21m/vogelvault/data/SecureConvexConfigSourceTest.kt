package com.sats21m.vogelvault.data

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import com.sats21m.vogelvault.initialConvexConfig
import com.sats21m.vogelvault.recoverRejectedStoredConvexConfig
import com.sats21m.vogelvault.resetStoredConvexBootstrap
import com.sats21m.vogelvault.domain.FamilyMember
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
    fun `all grants and empty grants survive encrypted restart without widening`() {
        for (grants in listOf(DeviceCapabilities.supported, emptySet())) {
            val credential = ConvexDeviceCredential("android-device", "d".repeat(43), FamilyMember.RACHEL, grants)
            source.updateDeviceCredential(credential)
            assertEquals(grants, reconstructedSource().currentDeviceCredential()?.capabilities)
        }
    }

    @Test
    fun `legacy stored credentials retain only task access`() {
        source.updateDeviceCredential(ConvexDeviceCredential("android-device", "d".repeat(43), FamilyMember.MASON))
        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit().remove("device_capabilities").commit()
        assertEquals(DeviceCapabilities.legacy, reconstructedSource().currentDeviceCredential()?.capabilities)
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
    fun `combined bootstrap commit survives reconstructed source restart`() {
        val readToken = "vv-read-${UUID.randomUUID()}"
        val readConfig =
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = readToken,
                remoteReadEnabled = true,
            )
        val device = ConvexDeviceCredential("android-device", "d".repeat(43), FamilyMember.MASON)

        val committed = source.commitBootstrap(readConfig, device)
        val restarted = reconstructedSource()
        val restored = restarted.currentBootstrap()

        assertEquals(readToken, committed.readConfig.readTokenOrNull())
        assertEquals(device, committed.deviceCredential)
        assertEquals(readToken, restored.readConfig.readTokenOrNull())
        assertEquals(ReadReadiness.READY, restored.readConfig.readiness)
        assertEquals(device, restored.deviceCredential)
        assertFalse(committed.toString().contains(readToken))
        assertFalse(committed.toString().contains(device.deviceToken))
    }

    @Test
    fun `read-only bootstrap preserves an existing valid device credential across restart`() {
        val existingDevice = ConvexDeviceCredential("existing-device", "e".repeat(43), FamilyMember.MASON)
        source.updateDeviceCredential(existingDevice)
        val nextRead =
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = "vv-read-${UUID.randomUUID()}",
                remoteReadEnabled = true,
            )

        val committed = source.commitBootstrap(nextRead)
        val restored = reconstructedSource().currentBootstrap()

        assertEquals(existingDevice, committed.deviceCredential)
        assertEquals(existingDevice, restored.deviceCredential)
        assertEquals(nextRead.readTokenOrNull(), restored.readConfig.readTokenOrNull())
        assertEquals(ReadReadiness.READY, restored.readConfig.readiness)
    }

    @Test
    fun `reconstructed source keeps read and device credentials independently removable`() {
        val readToken = "vv-read-${UUID.randomUUID()}"
        val readConfig =
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = readToken,
                remoteReadEnabled = true,
            )
        val device = ConvexDeviceCredential("android-device", "d".repeat(43), FamilyMember.MASON)
        source.commitBootstrap(readConfig, device)

        source.clearDeviceCredential()
        var restored = reconstructedSource().currentBootstrap()
        assertEquals(readToken, restored.readConfig.readTokenOrNull())
        assertNull(restored.deviceCredential)

        source.updateDeviceCredential(device)
        source.clear()
        restored = reconstructedSource().currentBootstrap()
        assertEquals(ReadReadiness.DISABLED, restored.readConfig.readiness)
        assertEquals(device, restored.deviceCredential)
    }

    @Test
    fun `bootstrap reset clears read and device credentials and empty reset succeeds`() {
        val readConfig =
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = "vv-read-${UUID.randomUUID()}",
                remoteReadEnabled = true,
            )
        val device = ConvexDeviceCredential("android-device", "d".repeat(43), FamilyMember.MASON)
        val effective = MutableConvexConfigSource(readConfig)
        source.commitBootstrap(readConfig, device)

        assertTrue(resetStoredConvexBootstrap(source, effective))

        val restored = reconstructedSource().currentBootstrap()
        assertEquals(ReadReadiness.DISABLED, restored.readConfig.readiness)
        assertNull(restored.deviceCredential)
        assertEquals(ReadReadiness.DISABLED, effective.current().readiness)
        assertTrue(resetStoredConvexBootstrap(source, effective))
    }

    @Test
    fun `partial combined storage fails closed after restart`() {
        source.commitBootstrap(
            readConfig =
                ConvexConfig(
                    deploymentUrl = "https://example.convex.cloud",
                    readToken = "vv-read-${UUID.randomUUID()}",
                    remoteReadEnabled = true,
                ),
            deviceCredential = ConvexDeviceCredential(
                "android-device",
                "d".repeat(43),
                FamilyMember.MASON,
            ),
        )
        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
            .edit()
            .remove("read_token")
            .remove("device_token")
            .commit()

        val restored = reconstructedSource().currentBootstrap()

        assertFalse(restored.readConfig.allowsRemoteRead)
        assertNull(restored.deviceCredential)
    }

    @Test
    fun `failed combined commit activates neither new read nor new device state`() {
        val oldRead =
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = "vv-old-${UUID.randomUUID()}",
                remoteReadEnabled = true,
            )
        val oldDevice = ConvexDeviceCredential("old-device", "o".repeat(43), FamilyMember.MASON)
        source.commitBootstrap(oldRead, oldDevice)
        val failingSource =
            SecureConvexConfigSource(
                preferences =
                    ClearCommitFailingPreferences(
                        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE),
                    ),
                cipher = TestConfigCipher,
            )

        assertFailsWith<IOException> {
            failingSource.commitBootstrap(
                readConfig =
                    ConvexConfig(
                        deploymentUrl = "https://new.example.convex.cloud",
                        readToken = "vv-new-${UUID.randomUUID()}",
                        remoteReadEnabled = true,
                    ),
                deviceCredential = ConvexDeviceCredential(
                    "new-device",
                    "n".repeat(43),
                    FamilyMember.MASON,
                ),
            )
        }

        val restored = reconstructedSource().currentBootstrap()
        assertEquals(oldRead.readTokenOrNull(), restored.readConfig.readTokenOrNull())
        assertEquals(oldRead.deploymentUrl, restored.readConfig.deploymentUrl)
        assertEquals(oldDevice, restored.deviceCredential)
    }

    @Test
    fun `rejected read recovery preserves paired device credentials`() {
        val readToken = "vv-read-${UUID.randomUUID()}"
        val device = ConvexDeviceCredential("android-device", "d".repeat(43), FamilyMember.MASON)
        val rejected =
            ConvexConfig(
                deploymentUrl = "https://example.convex.cloud",
                readToken = readToken,
                remoteReadEnabled = true,
            )
        source.update(rejected)
        source.updateDeviceCredential(device)
        val effective = MutableConvexConfigSource(rejected)

        assertFalse(
            recoverRejectedStoredConvexConfig(
                rejected = rejected,
                stored = source,
                effective = effective,
            ),
        )

        assertEquals(ReadReadiness.DISABLED, source.current().readiness)
        assertEquals(ReadReadiness.DISABLED, effective.current().readiness)
        assertEquals(device, SecureConvexDeviceCredentialSource(source).currentDeviceCredential())
    }

    @Test
    fun `paired device credential is encrypted and atomic`() {
        val device = ConvexDeviceCredential("android-device", "d".repeat(43), FamilyMember.MASON)
        source.updateDeviceCredential(device)

        assertEquals(device, SecureConvexDeviceCredentialSource(source).currentDeviceCredential())
        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).all.values.forEach { stored ->
            assertNotEquals(device.deviceId, stored)
            assertNotEquals(device.deviceToken, stored)
        }

        source.clearDeviceCredential()
        assertFalse(source.hasDeviceCredential())
    }

    @Test
    fun `partial or tampered paired credential fails closed`() {
        source.updateDeviceCredential(
            ConvexDeviceCredential("android-device", "d".repeat(43), FamilyMember.MASON),
        )
        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
            .edit()
            .remove("device_token")
            .commit()

        assertFalse(source.hasDeviceCredential())
        assertNull(SecureConvexDeviceCredentialSource(source).currentDeviceCredential())
    }

    @Test
    fun `legacy credential without a persisted profile stays disabled after restart`() {
        source.updateDeviceCredential(
            ConvexDeviceCredential("android-device", "d".repeat(43), FamilyMember.MASON),
        )
        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
            .edit()
            .remove("device_profile")
            .commit()

        val restarted = reconstructedSource()

        assertFalse(restarted.hasDeviceCredential())
        assertNull(SecureConvexDeviceCredentialSource(restarted).currentDeviceCredential())
    }

    @Test
    fun `unbound raw task credential cannot become durable`() {
        assertFailsWith<IllegalArgumentException> {
            source.updateDeviceCredential(
                ConvexDeviceCredential("android-device", "d".repeat(43)),
            )
        }

        assertFalse(source.hasDeviceCredential())
        assertNull(reconstructedSource().currentDeviceCredential())
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

    private fun reconstructedSource(): SecureConvexConfigSource =
        SecureConvexConfigSource(
            preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE),
            cipher = TestConfigCipher,
        )
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
