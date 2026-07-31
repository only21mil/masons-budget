package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertEquals
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
@Config(sdk = [34], qualifiers = "w180dp-h480dp-normal-notlong-notround-any-320dpi-keyshidden-nonav")
class BitcoinUnitToggleTest {
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
    fun `selector is grouped named tappable and scrolls in compact width`() {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.width(80.dp)) {
                        BitcoinUnitToggle(selected = DisplayUnit.BTC, onSelect = {})
                    }
                }
            }
        }
        compose.waitForIdle()

        val btc = compose.onNodeWithContentDescription("BTC display unit")
        btc.assertIsSelected().assertHasClickAction()
        val btcConfig = btc.fetchSemanticsNode().config
        assertEquals("Selected", btcConfig[SemanticsProperties.StateDescription])
        assertEquals("Show amounts in BTC", btcConfig[SemanticsActions.OnClick].label)
        val density = activityController.get().resources.displayMetrics.density
        assertTrue(btc.fetchSemanticsNode().boundsInRoot.height >= 48f * density)

        val group = compose.onNodeWithTag(BITCOIN_UNIT_TOGGLE_TEST_TAG).fetchSemanticsNode().config
        assertTrue(group.contains(SemanticsProperties.SelectableGroup))
        assertTrue(group.contains(SemanticsProperties.HorizontalScrollAxisRange))
    }
}
