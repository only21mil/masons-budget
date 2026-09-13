package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.requiredSize
import android.view.View
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.theme.LedgerTheme
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = FoldStateTestApplication::class, qualifiers = "w1000dp-h1100dp-420dpi")
class FabSystemInsetTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var composeView: View
    private lateinit var controller: ActivityController<ComponentActivity>

    @Before fun start() {
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
    }
    @After fun stop() { controller.pause().stop().destroy() }

    private fun render(width: Int = 841, hinge: LedgerHinge? = null) {
        assertEquals(2.625f, controller.get().resources.displayMetrics.density)
        controller.get().setContent {
            LedgerTheme {
                composeView = LocalView.current
                Box(Modifier.requiredSize(width.dp, (1840f / 2.625f).dp)) {
                    VaultApp(
                        state = VaultUiState(activeProfile = FamilyMember.VICTOR, destination = Destination.ACTIVITY,
                            data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)),
                        onNavigate = {}, onSwitchProfile = {}, hingeOverride = hinge,
                        safeDrawingInsets = WindowInsets(0, 64, 0, 0),
                    )
                }
            }
        }
        compose.waitForIdle()
        setBottomInset(0)
    }

    private fun setBottomInset(pixels: Int) {
        compose.runOnIdle {
            ViewCompat.dispatchApplyWindowInsets(composeView,
                WindowInsetsCompat.Builder()
                    .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.of(0, 64, 0, pixels))
                    .build())
        }
        compose.waitForIdle()
    }

    private fun fabBottom() = compose.onNodeWithTag("quick-add-fab").fetchSemanticsNode().boundsInRoot.bottom

    @Test fun `lower horizontal fallback clears system bottom at fractional density`() {
        // Upper region is below 320dp; the lower region retains the rail.
        render(hinge = LedgerHinge((845f / 2.625f).dp, (850f / 2.625f).dp, true))
        val before = fabBottom()
        setBottomInset(63)
        assertEquals(before - 63f, fabBottom(), "physical-bottom FAB must move by the system inset")
    }

    @Test fun `full height rail clears system bottom`() {
        render()
        val before = fabBottom()
        setBottomInset(63)
        assertEquals(before - 63f, fabBottom())
    }

    @Test fun `upper tabletop does not apply system bottom twice`() {
        render(hinge = LedgerHinge(360.dp, 365.dp, true))
        val before = fabBottom()
        setBottomInset(63)
        assertEquals(before, fabBottom(), "upper pane ends at the hinge, above system bars")
    }

    @Test fun `folded navigation owns its bottom inset`() {
        render(width = 411)
        val before = fabBottom()
        setBottomInset(63)
        assertEquals(before - 63f, fabBottom(), "bottom navigation applies the inset exactly once")
    }
}
