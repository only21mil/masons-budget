package com.sats21m.vogelvault.ui.theme

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import com.sats21m.vogelvault.R
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
@Config(sdk = [34], qualifiers = "night")
class LedgerThemeAdoptionTest {
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
    fun appRootProvidesTerminalLedgerTokensAndMaterialColors() {
        var treatment: LedgerTreatment? = null
        var ledgerBackground: Color? = null
        var materialBackground: Color? = null
        var resolvedTextColor: Color? = null

        compose.runOnUiThread {
            activityController.get().setContent {
                LedgerTheme {
                    treatment = LocalLedgerTheme.current.treatment
                    ledgerBackground = LocalLedgerTheme.current.colors.background
                    materialBackground = MaterialTheme.colorScheme.background
                    Text(
                        text = "Ledger root",
                        onTextLayout = { resolvedTextColor = it.layoutInput.style.color },
                    )
                }
            }
        }
        compose.waitForIdle()

        assertEquals(LedgerTreatment.TERMINAL_DARK, treatment)
        assertEquals(LedgerPalettes.TerminalDark.background, ledgerBackground)
        assertEquals(LedgerPalettes.TerminalDark.background, materialBackground)
        assertEquals(LedgerPalettes.TerminalDark.foreground, resolvedTextColor)
    }
}
