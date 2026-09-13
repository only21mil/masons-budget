package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.core.view.WindowCompat
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ledgerSystemBarAppearance
import com.sats21m.vogelvault.ui.theme.LedgerTreatment
import com.sats21m.vogelvault.ui.theme.SovereignLedgerTheme
import kotlin.test.assertEquals
import kotlin.test.assertNotSame
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-notnight")
class LedgerSheetSystemBarsTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var controller: ActivityController<ComponentActivity>

    @Before fun start() {
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
    }

    @After fun stop() { controller.pause().stop().destroy() }

    @Test fun `terminal sheet has light icons when the OS is light`() {
        checkSheetAppearance(LedgerTreatment.TERMINAL_DARK)
    }

    @Test
    @Config(qualifiers = "w411dp-h891dp-night")
    fun `daylight sheet has dark icons when the OS is dark`() {
        checkSheetAppearance(LedgerTreatment.DAYLIGHT_LIGHT)
    }

    private fun checkSheetAppearance(initial: LedgerTreatment) {
        val treatment = mutableStateOf(initial)
        val visible = mutableStateOf(true)
        val rootWindow = controller.get().window
        val rootBars = WindowCompat.getInsetsController(rootWindow, rootWindow.decorView)
        val rootAppearance = ledgerSystemBarAppearance(initial)
        rootBars.isAppearanceLightStatusBars = rootAppearance.useDarkIcons
        rootBars.isAppearanceLightNavigationBars = rootAppearance.useDarkIcons

        controller.get().setContent {
            SovereignLedgerTheme(treatment.value) {
                if (visible.value) {
                    LedgerSheet("Edit", { visible.value = false }, actions = { Text("Save") }) {
                        Text("Field")
                    }
                }
            }
        }

        fun assertBars() {
            compose.runOnIdle {
                val dialogWindow = requireNotNull(ShadowDialog.getLatestDialog().window)
                assertNotSame(rootWindow, dialogWindow)
                val bars = WindowCompat.getInsetsController(dialogWindow, dialogWindow.decorView)
                val expected = ledgerSystemBarAppearance(treatment.value)
                assertEquals(expected.useDarkIcons, bars.isAppearanceLightStatusBars, "dialog status icons")
                assertEquals(expected.useDarkIcons, bars.isAppearanceLightNavigationBars, "dialog navigation icons")
                assertEquals(rootAppearance.useDarkIcons, rootBars.isAppearanceLightStatusBars, "root status unchanged")
                assertEquals(rootAppearance.useDarkIcons, rootBars.isAppearanceLightNavigationBars, "root navigation unchanged")
            }
        }

        assertBars()
        compose.runOnIdle {
            treatment.value = if (initial == LedgerTreatment.TERMINAL_DARK) {
                LedgerTreatment.DAYLIGHT_LIGHT
            } else {
                LedgerTreatment.TERMINAL_DARK
            }
        }
        assertBars()
        compose.runOnIdle { visible.value = false }
        compose.runOnIdle {
            assertEquals(rootAppearance.useDarkIcons, rootBars.isAppearanceLightStatusBars)
            assertEquals(rootAppearance.useDarkIcons, rootBars.isAppearanceLightNavigationBars)
            treatment.value = initial
            visible.value = true
        }
        assertBars()
    }
}
