package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.theme.LedgerColors
import com.sats21m.vogelvault.ui.theme.LedgerPalettes
import com.sats21m.vogelvault.ui.theme.LedgerTreatment
import com.sats21m.vogelvault.ui.theme.SovereignLedgerTheme
import kotlin.test.assertEquals
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
class VaultButtonTest {
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
    fun `Terminal primary actions use the full Bitcoin fill`() {
        assertPrimaryActionColors(LedgerTreatment.TERMINAL_DARK, LedgerPalettes.TerminalDark)
    }

    @Test
    fun `Daylight primary actions keep full orange as a fill`() {
        assertPrimaryActionColors(LedgerTreatment.DAYLIGHT_LIGHT, LedgerPalettes.DaylightLight)
    }

    @Test
    fun `secondary and disabled actions drop to the panel fill and line border`() {
        var secondary: LedgerButtonColors? = null
        var disabled: LedgerButtonColors? = null
        compose.runOnUiThread {
            activityController.get().setContent {
                SovereignLedgerTheme(LedgerTreatment.TERMINAL_DARK) {
                    secondary = vaultButtonColors(secondary = true)
                    disabled = vaultButtonColors(enabled = false)
                }
            }
        }
        compose.waitForIdle()

        val colors = LedgerPalettes.TerminalDark
        assertEquals(colors.panel, secondary?.containerColor)
        assertEquals(colors.line, secondary?.borderColor)
        assertEquals(colors.foreground, secondary?.labelColor)
        assertEquals(colors.panel, disabled?.containerColor)
        assertEquals(colors.foregroundTertiary, disabled?.labelColor)
    }

    @Test
    fun `label is drawn uppercase but spoken and matched in the caller's casing`() {
        var clicks = 0
        compose.runOnUiThread {
            activityController.get().setContent {
                SovereignLedgerTheme(LedgerTreatment.TERMINAL_DARK) {
                    Column {
                        VaultButton(label = "Save task", onClick = { clicks++ })
                        VaultButton(label = "Locked", enabled = false, onClick = { clicks++ })
                    }
                }
            }
        }
        compose.waitForIdle()

        compose.onNode(hasText("Save task") and hasClickAction()).assertIsEnabled().performClick()
        compose.waitForIdle()
        assertEquals(1, clicks)
        compose.onNode(hasText("Locked")).assertIsNotEnabled().performClick()
        compose.waitForIdle()
        assertEquals(1, clicks)
        assertEquals(0, compose.onAllNodes(hasText("SAVE TASK")).fetchSemanticsNodes().size)
    }

    private fun assertPrimaryActionColors(treatment: LedgerTreatment, colors: LedgerColors) {
        var primary: LedgerButtonColors? = null
        var labelColor: Color? = null

        compose.runOnUiThread {
            activityController.get().setContent {
                SovereignLedgerTheme(treatment) {
                    primary = vaultButtonColors()
                    labelColor = primary?.labelColor
                    VaultButton(label = "Action", onClick = {})
                }
            }
        }
        compose.waitForIdle()

        assertEquals(colors.bitcoinFill, primary?.containerColor)
        assertEquals(LedgerPalettes.TerminalDark.background, labelColor)
        compose.onNode(hasText("Action") and hasClickAction()).fetchSemanticsNode()
    }
}
