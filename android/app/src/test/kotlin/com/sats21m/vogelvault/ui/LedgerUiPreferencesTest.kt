package com.sats21m.vogelvault.ui

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.util.UUID
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LedgerUiPreferencesTest {
    private lateinit var preferences: android.content.SharedPreferences
    private lateinit var store: LedgerUiPreferences

    @BeforeTest
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        preferences = context.getSharedPreferences("ledger-ui-${UUID.randomUUID()}", Context.MODE_PRIVATE)
        store = LedgerUiPreferences(preferences)
    }

    @Test
    fun `fresh install keeps system appearance while effects default off`() {
        val settings = store.current()

        assertEquals(LedgerAppearance.SYSTEM, settings.appearance)
        assertFalse(settings.scanlinesEnabled)
        assertFalse(settings.phosphorGlowEnabled)
    }

    @Test
    fun `inherited effect defaults migrate off without changing appearance`() {
        preferences.edit().putString("appearance", "daylight").commit()

        val settings = store.current()

        assertEquals(LedgerAppearance.DAYLIGHT, settings.appearance)
        assertFalse(settings.scanlinesEnabled)
        assertFalse(settings.phosphorGlowEnabled)
        assertEquals(false, preferences.all["scanlines"])
        assertEquals(false, preferences.all["phosphor_glow"])
    }

    @Test
    fun `migration preserves explicit effect values from the old schema`() {
        preferences.edit()
            .putBoolean("scanlines", true)
            .putBoolean("phosphor_glow", false)
            .commit()

        val settings = store.current()

        assertTrue(settings.scanlinesEnabled)
        assertFalse(settings.phosphorGlowEnabled)
    }

    @Test
    fun `a later user toggle survives subsequent reads`() {
        store.current()
        assertTrue(
            store.save(
                LedgerUiSettings(scanlinesEnabled = true, phosphorGlowEnabled = true),
            ),
        )

        assertTrue(store.current().scanlinesEnabled)
        assertTrue(store.current().phosphorGlowEnabled)
    }
}
