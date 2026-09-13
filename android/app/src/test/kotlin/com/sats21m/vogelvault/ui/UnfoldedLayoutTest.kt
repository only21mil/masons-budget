package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.DeviceCapabilities
import com.sats21m.vogelvault.data.DeviceCapability
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
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = FoldStateTestApplication::class, qualifiers = "w1000dp-h1100dp-mdpi")
class UnfoldedLayoutTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var controller: ActivityController<ComponentActivity>
    private var width by mutableStateOf(841.dp)
    private var hinge by mutableStateOf<LedgerHinge?>(null)

    @Before fun start() {
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
    }
    @After fun stop() { controller.pause().stop().destroy() }
    private fun render(destination: Destination) {
        controller.get().setContent {
            LedgerTheme {
                Box(Modifier.size(width, 945.dp)) {
                    VaultApp(
                        state = VaultUiState(activeProfile = FamilyMember.VICTOR, destination = destination,
                            data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE).let { fixture ->
                                fixture.copy(btcBalanceReadOwner = FamilyMember.VICTOR,
                                    btcBalance = fixture.btcBalance.copy(value = fixture.btcBalance.value?.copy(updatedAtMs = 1L)))
                            }),
                        onNavigate = {}, onSwitchProfile = {}, hingeOverride = hinge,
                    )
                }
            }
        }
        compose.waitForIdle()
    }
    @Test fun `vertical separating hinge leaves a glyph rail and two readable panes`() {
        hinge = LedgerHinge(420.dp, 421.dp, false)
        render(Destination.ACTIVITY)
        compose.onNodeWithTag(VAULT_RAIL_TEST_TAG).assertWidthIsEqualTo(72.dp)
        compose.onNodeWithTag("vault-list-pane").assertWidthIsEqualTo(348.dp)
        compose.onNodeWithTag("vault-detail-pane").assertWidthIsEqualTo(420.dp)
        val left = compose.onNodeWithTag("vault-list-pane").fetchSemanticsNode().boundsInRoot
        val right = compose.onNodeWithTag("vault-detail-pane").fetchSemanticsNode().boundsInRoot
        assertTrue(left.right <= 420f && right.left >= 421f)
        compose.onNodeWithText("Select a transaction to see its details.").assertIsDisplayed()
    }
    @Test fun `both cover sizes use bottom navigation and one content pane`() {
        width = 411.dp
        render(Destination.BUDGET)
        compose.onNodeWithTag(VAULT_RAIL_TEST_TAG).assertDoesNotExist()
        compose.onNodeWithTag("vault-list-pane").assertWidthIsEqualTo(411.dp)
        compose.runOnIdle { width = 345.dp }
        compose.onNodeWithTag(VAULT_RAIL_TEST_TAG).assertDoesNotExist()
        compose.onNodeWithTag("vault-list-pane").assertWidthIsEqualTo(345.dp)
    }
    @Test fun `Activity search survives compact and expanded constraints`() {
        width = 411.dp
        render(Destination.ACTIVITY)
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Search activity"))
        compose.onNodeWithText("Search activity").performTextInput("retained query")
        compose.runOnIdle { width = 841.dp }
        compose.onNodeWithText("retained query").fetchSemanticsNode()
        compose.runOnIdle { width = 345.dp }
        compose.onNodeWithText("retained query").fetchSemanticsNode()
    }
    @Test fun `selected Activity detail starts read only and survives posture changes`() {
        width = 411.dp
        val merchant = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE).transactions.value.first().merchant
        render(Destination.ACTIVITY)
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription(merchant, substring = true))
        compose.onNode(hasContentDescription(merchant, substring = true) and hasClickAction()).performClick()
        compose.onNodeWithText("Edit").assertIsDisplayed()
        compose.onNodeWithText("Delete transaction").assertDoesNotExist()
        compose.runOnIdle { width = 841.dp; hinge = LedgerHinge(420.dp, 421.dp, false) }
        compose.onNodeWithText("Edit").assertIsDisplayed()
        compose.onNodeWithText("Select a transaction to see its details.").assertDoesNotExist()
        compose.runOnIdle { width = 345.dp; hinge = null }
        compose.onNodeWithText("Edit").assertIsDisplayed()
    }
    @Test fun `account name and custody survive cover inner cover posture changes`() {
        width = 411.dp
        render(Destination.BITCOIN)
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Add account"))
        compose.onNodeWithText("Add account").performClick()
        compose.onNodeWithText("Account name").performTextInput("Travel wallet")
        compose.onNodeWithText("Exchange").performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithText("Exchange").assertIsSelected()
        compose.runOnIdle { width = 841.dp; hinge = LedgerHinge(420.dp, 421.dp, false) }
        compose.onNodeWithText("Travel wallet").assertIsDisplayed()
        compose.onNodeWithText("Exchange").assertIsSelected()
        val verticalBounds = compose.onNodeWithTag("ledger-sheet-surface").fetchSemanticsNode().boundsInRoot
        assertTrue(verticalBounds.left >= 0f && verticalBounds.right <= 420f, "sheet bounds: $verticalBounds")
        compose.runOnIdle { hinge = LedgerHinge(470.dp, 475.dp, true) }
        val horizontalBounds = compose.onNodeWithTag("ledger-sheet-surface").fetchSemanticsNode().boundsInRoot
        assertTrue(horizontalBounds.top >= 0f && horizontalBounds.bottom <= 470f, "sheet bounds: $horizontalBounds")
        compose.runOnIdle { width = 345.dp; hinge = null }
        compose.onNodeWithText("Travel wallet").assertIsDisplayed()
        compose.onNodeWithText("Exchange").assertIsSelected()
        compose.runOnIdle { width = 841.dp; hinge = LedgerHinge(420.dp, 421.dp, false) }
        compose.runOnIdle {
            (org.robolectric.shadows.ShadowDialog.getLatestDialog() as androidx.activity.ComponentDialog)
                .onBackPressedDispatcher.onBackPressed()
        }
        compose.onNodeWithText("Travel wallet").assertDoesNotExist()
    }
}

class FoldStateTestApplication : VaultApplication() {
    override val deviceCapabilities = DeviceCapabilities(FamilyMember.VICTOR, DeviceCapability.entries.map { it.wire }.toSet())
}
