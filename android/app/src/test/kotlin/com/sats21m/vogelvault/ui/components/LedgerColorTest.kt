package com.sats21m.vogelvault.ui.components

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.theme.LedgerPalettes
import com.sats21m.vogelvault.ui.theme.LedgerTreatment
import com.sats21m.vogelvault.ui.theme.SovereignLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultInfo
import com.sats21m.vogelvault.ui.theme.VaultWarning
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import com.sats21m.vogelvault.ui.theme.toMaterialScheme
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LedgerColorTest {
    @Test
    fun daylightButtonAndTextColorsClearAA() {
        val colors = LedgerPalettes.DaylightLight
        val scheme = colors.toMaterialScheme(LedgerTreatment.DAYLIGHT_LIGHT)
        fun contrast(a: Color, b: Color): Float =
            (maxOf(a.luminance(), b.luminance()) + 0.05f) / (minOf(a.luminance(), b.luminance()) + 0.05f)
        assertEquals(colors.bitcoin, scheme.primary)
        assertTrue(contrast(scheme.onPrimary, scheme.primary) >= 4.5f)
        assertTrue(contrast(colors.bitcoin, colors.panel) >= 4.5f)
        assertTrue(contrast(LedgerPalettes.TerminalDark.background, colors.bitcoinFill) >= 4.5f)
    }
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>

    @Before
    fun openHost() {
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun closeHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun legacyNoticeAliasesResolveToCurrentLedgerContrastRoles() {
        assertLegacyNoticeAliases(
            treatment = LedgerTreatment.TERMINAL_DARK,
            expectedWarning = LedgerPalettes.TerminalDark.loss,
            expectedInfo = LedgerPalettes.TerminalDark.foregroundSecondary,
        )
        assertLegacyNoticeAliases(
            treatment = LedgerTreatment.DAYLIGHT_LIGHT,
            expectedWarning = LedgerPalettes.DaylightLight.loss,
            expectedInfo = LedgerPalettes.DaylightLight.foregroundSecondary,
        )
    }

    private fun assertLegacyNoticeAliases(
        treatment: LedgerTreatment,
        expectedWarning: Color,
        expectedInfo: Color,
    ) {
        var warning: Color? = null
        var info: Color? = null
        compose.runOnUiThread {
            activityController.get().setContent {
                SovereignLedgerTheme(treatment) {
                    warning = ledgerColor(VaultWarning)
                    info = ledgerColor(VaultInfo)
                }
            }
        }
        compose.waitForIdle()

        assertEquals(expectedWarning, warning)
        assertEquals(expectedInfo, info)
    }
}
