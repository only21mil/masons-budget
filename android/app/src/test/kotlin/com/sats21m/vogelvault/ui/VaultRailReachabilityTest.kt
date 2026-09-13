package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.performScrollToNode
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
 * split-window use. All five primary tabs must be visible without scrolling.
 * Secondary destinations must remain reachable through their parent screens.
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
    fun `every secondary destination opens through its parent screen`() {
        val routes = listOf(
            Triple(Destination.BITCOIN, "Buys · See all", Destination.BTC_BUYS),
            Triple(Destination.BITCOIN, "Bill Pays · See all", Destination.BTC_BILL_PAYS),
            Triple(Destination.BITCOIN, "Net Worth", Destination.NET_WORTH),
            Triple(Destination.BITCOIN, "Retirement", Destination.RETIREMENT),
            Triple(Destination.TODAY, "Task lists", Destination.TASKS),
            Triple(Destination.SETTINGS, "Family", Destination.FAMILY),
            Triple(Destination.SETTINGS, "Export", Destination.EXPORT),
        )
        assertEquals(
            Destination.entries.toSet() - RAIL_PRIMARY_ORDER.toSet() - Destination.SETTINGS,
            routes.map { it.third }.toSet(),
        )
        routes.forEach { (parent, label, destination) ->
            var navigatedTo: Destination? = null
            render(parent, onNavigate = { navigatedTo = it })
            val link = hasText(label) and hasClickAction()
            if (destination != Destination.TASKS) {
                compose.onNode(hasScrollToIndexAction() and
                    hasAnyAncestor(hasTestTag(VAULT_SCREEN_CONTENT_TEST_TAG))).performScrollToNode(link)
            }
            compose.onNode(link).assertIsDisplayed().performClick()
            assertEquals(destination, navigatedTo)
        }
    }

    @Test
    fun `Settings opens from the profile menu and keeps its originating tab selected`() {
        var navigatedTo: Destination? = null
        render(Destination.DASHBOARD, onNavigate = { navigatedTo = it })
        compose.onNode(hasText("Victor") and hasClickAction()).performClick()
        compose.onNodeWithText("Settings").assertIsDisplayed().performClick()
        assertEquals(Destination.SETTINGS, navigatedTo)
        railDestination(Destination.DASHBOARD).assertIsDisplayed().assertIsSelected()
        compose.onNodeWithTag(VAULT_RAIL_MORE_TEST_TAG).assertDoesNotExist()
    }

    private fun render(
        destination: Destination,
        onNavigate: (Destination) -> Unit = {},
    ) {
        val current = mutableStateOf(destination)
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 852.dp, height = 720.dp)) {
                        VaultApp(
                            state = VaultUiState.of(FamilyMember.VICTOR, current.value),
                            onNavigate = { current.value = it; onNavigate(it) },
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
            hasContentDescription(destination.label, ignoreCase = true) and
                hasAnyAncestor(hasTestTag(VAULT_RAIL_TEST_TAG)),
        )
}
