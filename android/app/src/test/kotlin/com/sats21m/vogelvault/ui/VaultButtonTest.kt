package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createEmptyComposeRule
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

    private fun assertPrimaryActionColors(treatment: LedgerTreatment, colors: LedgerColors) {
        var labelColor: Color? = null
        var containerColor: Color? = null

        compose.runOnUiThread {
            activityController.get().setContent {
                SovereignLedgerTheme(treatment) {
                    containerColor = vaultButtonColors().containerColor
                    VaultButton(onClick = {}) {
                        Text(
                            text = "Action",
                            onTextLayout = { labelColor = it.layoutInput.style.color },
                        )
                    }
                }
            }
        }
        compose.waitForIdle()

        assertEquals(colors.bitcoinFill, containerColor)
        assertEquals(LedgerPalettes.TerminalDark.background, labelColor)
    }
}
