package com.sats21m.vogelvault.data

import android.app.Application
import android.content.Context
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SecureConvexSyncTokenSourceTest {
    private val context: Application
        get() = RuntimeEnvironment.getApplication()

    @Test
    fun `sync token is encrypted trimmed durable and removable`() {
        val preferences = context.getSharedPreferences("sync-token-${UUID.randomUUID()}", Context.MODE_PRIVATE)
        val source = SecureConvexSyncTokenSource(preferences, SyncTokenTestCipher)
        val token = "vv-sync-${UUID.randomUUID()}"

        source.update("  $token  ")

        assertEquals(token, source.currentSyncToken())
        assertFalse(preferences.all.values.contains(token))
        assertTrue(preferences.all.isNotEmpty())

        source.clear()
        assertNull(source.currentSyncToken())
        assertTrue(preferences.all.isEmpty())
    }
}

private object SyncTokenTestCipher : ConfigCipher {
    override fun encrypt(field: String, plaintext: String): String =
        Base64.getEncoder().encodeToString("$field|$plaintext".toByteArray(StandardCharsets.UTF_8))

    override fun decrypt(field: String, encoded: String): String {
        val value = String(Base64.getDecoder().decode(encoded), StandardCharsets.UTF_8)
        return value.removePrefix("$field|")
    }
}
