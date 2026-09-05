package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import kotlin.test.assertEquals

/**
 * The Pixel Fold inner display is 2076x2152 at density 390, or about 852x883dp.
 *
 * The shell below keeps that real unfolded width and constrains the usable
 * height to 720dp, covering system UI, larger display/font settings, and
 * split-window use. Every one of the seven rail items must be reachable in that
 * viewport without scrolling, and every destination under More must open from
 * the rail; a destination the rail cannot reach cannot ship.
 */
@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [34],
    qualifiers = "w852dp-h883dp-normal-long-notround-any-390dpi-keyshidden-nonav",
)
class VaultRailReachabilityTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>

    @Before
    fun openShell() {
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun closeShell() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `every primary destination is displayed and navigates from the Fold viewport`() {
        var navigatedTo: Destination? = null
        render(Destination.DASHBOARD, onNavigate = { navigatedTo = it })

        val primary = railPrimaryDestinations(Destination.entries.toList())
        assertEquals(RAIL_PRIMARY_ORDER, primary)
        primary.forEach { destination ->
            railDestination(destination).assertIsDisplayed().performClick()
            assertEquals(destination, navigatedTo)
        }
    }

    @Test
    fun `every overflow destination opens through More`() {
        val overflow = railOverflowDestinations(Destination.entries.toList())
        assertEquals(Destination.entries.size - RAIL_PRIMARY_ORDER.size, overflow.size)

        overflow.forEach { destination ->
            var navigatedTo: Destination? = null
            render(Destination.DASHBOARD, onNavigate = { navigatedTo = it })

            compose.onNodeWithTag(VAULT_RAIL_MORE_TEST_TAG).assertIsDisplayed().performClick()
            compose.onNodeWithText(destination.label).assertIsDisplayed().performClick()
            assertEquals(destination, navigatedTo)
        }
    }

    @Test
    fun `an initially selected overflow destination lights More`() {
        render(Destination.SETTINGS)

        compose.onNodeWithTag(VAULT_RAIL_MORE_TEST_TAG).assertIsDisplayed().assertIsSelected()
    }

    private fun render(
        destination: Destination,
        onNavigate: (Destination) -> Unit = {},
    ) {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 852.dp, height = 720.dp)) {
                        VaultApp(
                            state = VaultUiState.of(FamilyMember.VICTOR, destination),
                            onNavigate = onNavigate,
                            onSwitchProfile = {},
                        )
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    private fun railDestination(destination: Destination) =
        compose.onNode(
            hasText(destination.label, ignoreCase = true) and
                hasAnyAncestor(hasTestTag(VAULT_RAIL_TEST_TAG)),
        )
}
