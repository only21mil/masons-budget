package com.sats21m.vogelvault.ui

import android.content.Context
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
    private lateinit var store: LedgerUiPreferences

    @BeforeTest
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val preferences = context.getSharedPreferences("ledger-ui-${UUID.randomUUID()}", Context.MODE_PRIVATE)
        store = LedgerUiPreferences(preferences)
    }

    @Test
    fun `fresh install defaults to Terminal with its effects on`() {
        val settings = store.current()

        assertEquals(LedgerAppearance.TERMINAL, settings.appearance)
        assertTrue(settings.scanlinesEnabled)
        assertTrue(settings.phosphorGlowEnabled)
    }

    @Test
    fun `explicit System appearance survives storage and still follows the phone`() {
        assertTrue(store.save(LedgerUiSettings(appearance = LedgerAppearance.SYSTEM)))

        val restored = store.current()
        assertEquals(LedgerAppearance.SYSTEM, restored.appearance)
        assertEquals(LedgerTreatment.TERMINAL_DARK, restored.treatment(systemDark = true))
        assertEquals(LedgerTreatment.DAYLIGHT_LIGHT, restored.treatment(systemDark = false))
    }

    @Test
    fun `explicit effect choices survive appearance changes`() {
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
