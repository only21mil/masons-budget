package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.DeviceCapabilities
import com.sats21m.vogelvault.data.DeviceCapability
import com.sats21m.vogelvault.domain.*
import com.sats21m.vogelvault.ui.components.LocalStateBlockRetry
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertEquals
import org.junit.*
import org.junit.runner.RunWith
import org.robolectric.*
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

internal class EmptyStateActionApplication : VaultApplication() {
    var grants = DeviceCapabilities()
    override val deviceCapabilities: DeviceCapabilities get() = grants
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = EmptyStateActionApplication::class,
    qualifiers = "w411dp-h900dp-normal-notlong-notround-any-420dpi-keyshidden-nonav")
class EmptyStateActionTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var host: ActivityController<ComponentActivity>
    private var retries = 0

    @Before fun openHost() {
        host = Robolectric.buildActivity(ComponentActivity::class.java)
        host.get().setTheme(R.style.Theme_VogelVault)
        host.setup()
    }

    @After fun closeHost() { host.pause().stop().destroy() }

    @Test fun `adult Bitcoin grant permits empty buy Add to open existing menu`() {
        showBitcoin(FamilyMember.VICTOR, DeviceCapabilities(FamilyMember.VICTOR, setOf(DeviceCapability.BITCOIN.wire)))
        scrollTo("Add")
        compose.onNodeWithText("Add").assertIsEnabled().performClick()
        compose.onNodeWithText("Buy BTC").assertExists()
    }

    @Test fun `shared adult grant permits Rachel empty buy Add`() {
        showBitcoin(FamilyMember.RACHEL, DeviceCapabilities(FamilyMember.VICTOR, setOf(DeviceCapability.BITCOIN.wire)))
        scrollTo("Add")
        compose.onNodeWithText("Add").assertIsEnabled().performClick()
        compose.onNodeWithText("Buy BTC").assertExists()
    }

    @Test fun `read only adult empty buy Add is disabled and explains missing capability`() {
        showBitcoin(FamilyMember.VICTOR, DeviceCapabilities(FamilyMember.VICTOR))
        scrollTo("Add")
        compose.onNodeWithText("Add").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Buy BTC").assertDoesNotExist()
        val reason = "This phone has read-only access to Bitcoin records."
        scrollTo(reason)
        check(compose.onAllNodes(hasText(reason)).fetchSemanticsNodes().isNotEmpty())
    }

    @Test fun `unpaired adult empty buy Add is disabled`() {
        showBitcoin(FamilyMember.VICTOR, DeviceCapabilities())
        scrollTo("Add")
        compose.onNodeWithText("Add").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Buy BTC").assertDoesNotExist()
    }

    @Test fun `child cannot open empty buy Add even with Bitcoin capability`() {
        showBitcoin(FamilyMember.MASON, DeviceCapabilities(FamilyMember.MASON, setOf(DeviceCapability.BITCOIN.wire)))
        compose.onAllNodes(hasScrollAction())[0].performScrollToNode(hasContentDescription("Recent buys"))
        settle()
        compose.onNodeWithText("Add").assertDoesNotExist()
        compose.onNodeWithText("+ Add").assertDoesNotExist()
        compose.onNodeWithText("Buy BTC").assertDoesNotExist()
    }

    @Test fun `unmatched Income query clears query and returns to All without refresh`() {
        showIncome(Freshness.LIVE)
        searchIncome()
        compose.onNodeWithText("Clear filters").performClick()
        settle()
        assertEquals("", compose.onNode(hasSetTextAction()).fetchSemanticsNode()
            .config[androidx.compose.ui.semantics.SemanticsProperties.EditableText].text)
        compose.onNodeWithContentDescription("All activity filter").assertIsSelected()
        assertEquals(0, retries)
        compose.onNodeWithContentDescription("Income activity filter").performClick()
        settle()
        compose.onNodeWithText("Salary fixture", useUnmergedTree = true).assertExists()
    }

    @Test fun `Income read error retains Retry and preserves query and selected filter`() {
        showIncome(Freshness.ERROR)
        searchIncome()
        compose.onNodeWithText("Clear filters").assertDoesNotExist()
        compose.onNodeWithText("Retry").performClick()
        assertEquals(1, retries)
        compose.onNode(hasSetTextAction()).assertTextEquals("no such income")
        compose.onNodeWithContentDescription("Income activity filter").assertIsSelected()
    }

    private fun searchIncome() {
        compose.onNodeWithContentDescription("Income activity filter").performClick()
        compose.onNode(hasSetTextAction()).performTextInput("no such income")
        settle()
    }

    private fun showIncome(status: Freshness) {
        val profile = FamilyMember.VICTOR
        val entry = IncomeEntry("income-fixture", "2026-09-01", "2026-09", 12345,
            "Salary fixture", null, profile)
        show(VaultUiState(activeProfile = profile, destination = Destination.ACTIVITY,
            data = Fixtures.envelope(profile, Freshness.LIVE).copy(
                income = Slice(status, listOf(entry), 1L, "income fixture"))))
    }

    private fun showBitcoin(profile: FamilyMember, capabilities: DeviceCapabilities) {
        (RuntimeEnvironment.getApplication() as EmptyStateActionApplication).grants = capabilities
        show(VaultUiState(activeProfile = profile, destination = Destination.BITCOIN,
            data = Fixtures.envelope(profile, Freshness.LIVE).copy(
                btcBuys = Slice(Freshness.LIVE, emptyList(), 1L, "buy fixture"))))
    }

    private fun show(state: VaultUiState) {
        compose.runOnUiThread {
            host.get().setContent {
                VogelVaultTheme {
                    CompositionLocalProvider(LocalStateBlockRetry provides { retries++ }) {
                        Box(Modifier.size(411.dp, 900.dp)) {
                            ScreenHost(destination = state.destination, state = state)
                        }
                    }
                }
            }
        }
        settle()
    }

    private fun scrollTo(text: String) {
        compose.onAllNodes(hasScrollAction())[0].performScrollToNode(hasText(text))
        settle()
    }

    private fun settle() {
        repeat(3) {
            shadowOf(Looper.getMainLooper()).idle()
            compose.waitForIdle()
        }
    }
}
