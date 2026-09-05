package com.sats21m.vogelvault.ui

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import com.sats21m.vogelvault.ui.theme.LedgerTreatment
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
    private lateinit var preferences: SharedPreferences
    private lateinit var store: LedgerUiPreferences

    @BeforeTest
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        preferences = context.getSharedPreferences("ledger-ui-${UUID.randomUUID()}", Context.MODE_PRIVATE)
        store = LedgerUiPreferences(preferences)
    }

    @Test
    fun `fresh install defaults to Terminal with scanlines off and glow on`() {
        val settings = store.current()

        assertEquals(LedgerAppearance.TERMINAL, settings.appearance)
        assertFalse(settings.scanlinesEnabled)
        assertTrue(settings.phosphorGlowEnabled)
    }

    @Test
    fun `scanlines a user turned on survive the off default`() {
        preferences.edit().putBoolean("scanlines", true).commit()

        assertTrue(store.current().scanlinesEnabled)

        assertTrue(store.save(LedgerUiSettings(scanlinesEnabled = true)))
        assertTrue(store.current().scanlinesEnabled)
    }

    @Test
    fun `pre-correction System migrates to Terminal without changing other preferences`() {
        preferences.edit()
            .putString("appearance", LedgerAppearance.SYSTEM.storageKey)
            .putBoolean("scanlines", false)
            .putBoolean("phosphor_glow", false)
            .putBoolean("reduce_motion", true)
            .putBoolean("reduce_transparency", true)
            .commit()

        val migrated = store.current()

        assertEquals(LedgerAppearance.TERMINAL, migrated.appearance)
        assertFalse(migrated.scanlinesEnabled)
        assertFalse(migrated.phosphorGlowEnabled)
        assertTrue(migrated.reduceMotion)
        assertTrue(migrated.reduceTransparency)
    }

    @Test
    fun `pre-correction Daylight migrates to Terminal`() {
        preferences.edit()
            .putString("appearance", LedgerAppearance.DAYLIGHT.storageKey)
            .commit()

        assertEquals(LedgerAppearance.TERMINAL, store.current().appearance)
    }

    @Test
    fun `System chosen after migration survives storage and still follows the phone`() {
        store.current()
        assertTrue(store.save(LedgerUiSettings(appearance = LedgerAppearance.SYSTEM)))

        val restored = store.current()
        assertEquals(LedgerAppearance.SYSTEM, restored.appearance)
        assertEquals(LedgerTreatment.TERMINAL_DARK, restored.treatment(systemDark = true))
        assertEquals(LedgerTreatment.DAYLIGHT_LIGHT, restored.treatment(systemDark = false))
    }

    @Test
    fun `explicit effect choices survive appearance changes`() {
        store.current()
        assertTrue(
            store.save(
                LedgerUiSettings(
                    appearance = LedgerAppearance.DAYLIGHT,
                    scanlinesEnabled = false,
                    phosphorGlowEnabled = true,
                ),
            ),
        )

        val restored = store.current()
        assertEquals(LedgerAppearance.DAYLIGHT, restored.appearance)
        assertFalse(restored.scanlinesEnabled)
        assertTrue(restored.phosphorGlowEnabled)
    }
}
