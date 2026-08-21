package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
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
import kotlin.test.assertTrue

/**
 * The Pixel Fold inner display is 2076x2152 at density 390, or about 852x883dp.
 *
 * The shell below retains that real unfolded width and constrains the usable
 * height to 720dp. That covers the reproduced clipped rail as well as system UI,
 * larger display/font settings, and split-window use. The test first proves the
 * rail genuinely overflows, then drives the production scroll action so a
 * non-scrolling destination list cannot ship again.
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
    fun `every unfolded destination can be scrolled into the Fold viewport`() {
        var navigatedTo: Destination? = null
        render(Destination.DASHBOARD, onNavigate = { navigatedTo = it })

        val scrollRange = compose.onNodeWithTag(VAULT_RAIL_TEST_TAG)
            .fetchSemanticsNode()
            .config[SemanticsProperties.VerticalScrollAxisRange]
        assertTrue(scrollRange.maxValue() > 0f, "The regression viewport did not overflow.")

        Destination.entries.forEachIndexed { index, destination ->
            compose.onNodeWithTag(VAULT_RAIL_TEST_TAG).performScrollToIndex(index)
            compose.waitForIdle()
            railDestination(destination).assertIsDisplayed().performClick()
            assertEquals(destination, navigatedTo)
        }
    }

    @Test
    fun `an initially selected destination below the fold is brought into view`() {
        render(Destination.SETTINGS)

        railDestination(Destination.SETTINGS).assertIsDisplayed()
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
            hasText(destination.label) and
                hasAnyAncestor(hasTestTag(VAULT_RAIL_TEST_TAG)),
        )
}
