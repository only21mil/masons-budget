package com.sats21m.vogelvault.ui.theme

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ledgerSystemBarAppearance
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
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
@Config(sdk = [34], qualifiers = "notnight")
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
    fun appRootDefaultsToTerminalEvenWhenThePhoneIsLight() {
        var treatment: LedgerTreatment? = null
        var ledgerBackground: Color? = null
        var materialColors: ColorScheme? = null
        var resolvedTextColor: Color? = null

        compose.runOnUiThread {
            activityController.get().setContent {
                LedgerTheme {
                    treatment = LocalLedgerTheme.current.treatment
                    ledgerBackground = LocalLedgerTheme.current.colors.background
                    materialColors = MaterialTheme.colorScheme
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
        assertEquals(LedgerPalettes.TerminalDark.foreground, resolvedTextColor)
        assertLedgerMaterialColors(materialColors, LedgerPalettes.TerminalDark)
    }

    @Test
    fun daylightMapsEveryMaterialContainerAndPrimaryInk() {
        var materialColors: ColorScheme? = null

        compose.runOnUiThread {
            activityController.get().setContent {
                SovereignLedgerTheme(LedgerTreatment.DAYLIGHT_LIGHT) {
                    materialColors = MaterialTheme.colorScheme
                }
            }
        }
        compose.waitForIdle()

        assertLedgerMaterialColors(materialColors, LedgerPalettes.DaylightLight)
    }

    @Test
    fun systemBarsMatchTheResolvedLedgerTreatmentAndIconContrast() {
        val terminal = ledgerSystemBarAppearance(LedgerTreatment.TERMINAL_DARK)
        val daylight = ledgerSystemBarAppearance(LedgerTreatment.DAYLIGHT_LIGHT)

        assertEquals(LedgerPalettes.TerminalDark.background.toArgb(), terminal.background)
        assertFalse(terminal.useDarkIcons)
        assertEquals(LedgerPalettes.DaylightLight.background.toArgb(), daylight.background)
        assertTrue(daylight.useDarkIcons)
        assertEquals(
            LedgerPalettes.TerminalDark.background.toArgb(),
            activityController.get().getColor(R.color.ledger_terminal_background),
        )
    }

    private fun assertLedgerMaterialColors(
        materialColors: ColorScheme?,
        palette: LedgerColors,
    ) {
        requireNotNull(materialColors)
        assertEquals(palette.background, materialColors.background)
        assertEquals(palette.background, materialColors.surfaceContainerLowest)
        assertEquals(palette.panel, materialColors.surfaceContainerLow)
        assertEquals(palette.panel, materialColors.surfaceContainer)
        assertEquals(palette.panelRaised, materialColors.surfaceContainerHigh)
        assertEquals(palette.panelRaised, materialColors.surfaceContainerHighest)
        assertEquals(palette.bitcoinFill, materialColors.primary)
        assertEquals(palette.bitcoinFill, materialColors.surfaceTint)
        assertEquals(palette.bitcoinSoft, materialColors.primaryContainer)
        assertEquals(LedgerPalettes.TerminalDark.background, materialColors.onPrimary)
        assertEquals(palette.background, materialColors.inversePrimary)
        assertEquals(palette.foregroundSecondary, materialColors.secondary)
        assertEquals(palette.background, materialColors.onSecondary)
        assertEquals(palette.panelRaised, materialColors.secondaryContainer)
        assertEquals(palette.foreground, materialColors.onSecondaryContainer)
        assertEquals(palette.foregroundTertiary, materialColors.tertiary)
        assertEquals(palette.background, materialColors.onTertiary)
        assertEquals(palette.panelRaised, materialColors.tertiaryContainer)
        assertEquals(palette.foreground, materialColors.onTertiaryContainer)
        assertEquals(palette.foreground, materialColors.inverseSurface)
        assertEquals(palette.background, materialColors.inverseOnSurface)
        assertEquals(palette.background, materialColors.surfaceDim)
        assertEquals(palette.panelRaised, materialColors.surfaceBright)
        assertEquals(palette.panelRaised, materialColors.errorContainer)
        assertEquals(palette.loss, materialColors.onErrorContainer)
    }
}
