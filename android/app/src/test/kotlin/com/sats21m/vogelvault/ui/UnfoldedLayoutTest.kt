package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.performScrollTo
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
    private var hostOffset = 0.dp
    private var width by mutableStateOf(841.dp)
    private var safeInsets: WindowInsets = WindowInsets(0, 0, 0, 0)
    private var hinge by mutableStateOf<LedgerHinge?>(null)

    @Before fun start() {
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
    }
    @After fun stop() { controller.pause().stop().destroy() }
    private fun render(destination: Destination, longDetail: Boolean = false) {
        controller.get().setContent {
            LedgerTheme {
                Box(Modifier.padding(start = hostOffset).size(width, 945.dp)) {
                    VaultApp(
                        state = VaultUiState(activeProfile = FamilyMember.VICTOR, destination = destination,
                            data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE).let { fixture ->
                                fixture.copy(btcBalanceReadOwner = FamilyMember.VICTOR,
                                    transactions = fixture.transactions.copy(value = fixture.transactions.value.mapIndexed { index, transaction ->
                                        if (longDetail && index == 0) transaction.copy(note = (1..80).joinToString("\n") { "Detail line $it" }) else transaction
                                    }),
                                    btcBalance = fixture.btcBalance.copy(value = fixture.btcBalance.value?.copy(updatedAtMs = 1L)))
                            }),
                        onNavigate = {}, onSwitchProfile = {}, hingeOverride = hinge, safeDrawingInsets = safeInsets,
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
        val fab = compose.onNodeWithTag("quick-add-fab").fetchSemanticsNode().boundsInRoot
        assertTrue(fab.left >= left.left && fab.right <= left.right, "FAB stays in list pane: $fab")
        compose.onNodeWithText("Select a transaction to see its details.").assertIsDisplayed()
    }
    @Test fun `vertical hinge uses inset content origin and contains the far edge`() {
        safeInsets = WindowInsets(left = 24.dp, top = 0.dp, right = 16.dp, bottom = 0.dp)
        hinge = LedgerHinge(420.dp, 421.dp, false)
        render(Destination.ACTIVITY)
        val left = compose.onNodeWithTag("vault-list-pane").fetchSemanticsNode().boundsInRoot
        val right = compose.onNodeWithTag("vault-detail-pane").fetchSemanticsNode().boundsInRoot
        assertTrue(left.left >= 24f && left.right <= 420f, "list bounds: $left")
        assertTrue(right.left >= 421f && right.right <= 825f, "detail bounds: $right")
        compose.onNodeWithTag("vault-detail-pane").assertWidthIsEqualTo(404.dp)
    }

    @Test fun `vertical hinge also accounts for a host origin outside safe padding`() {
        hostOffset = 13.dp
        safeInsets = WindowInsets(left = 24.dp, top = 0.dp, right = 16.dp, bottom = 0.dp)
        hinge = LedgerHinge(420.dp, 421.dp, false)
        render(Destination.ACTIVITY)
        val left = compose.onNodeWithTag("vault-list-pane").fetchSemanticsNode().boundsInRoot
        val right = compose.onNodeWithTag("vault-detail-pane").fetchSemanticsNode().boundsInRoot
        assertTrue(left.left >= 37f && left.right <= 420f, "list bounds: $left")
        assertTrue(right.left >= 421f && right.right <= 838f, "detail bounds: $right")
        compose.onNodeWithTag("vault-detail-pane").assertWidthIsEqualTo(417.dp)
    }

    @Test fun `horizontal hinge uses the same inset origin for stacked panes`() {
        safeInsets = WindowInsets(left = 24.dp, top = 28.dp, right = 16.dp, bottom = 0.dp)
        hinge = LedgerHinge(470.dp, 475.dp, true)
        render(Destination.ACTIVITY)
        val upper = compose.onNodeWithTag("vault-list-pane").fetchSemanticsNode().boundsInRoot
        val lower = compose.onNodeWithTag("vault-detail-pane").fetchSemanticsNode().boundsInRoot
        assertTrue(upper.top >= 28f && upper.bottom <= 470f, "list bounds: $upper")
        assertTrue(lower.top >= 475f && lower.bottom <= 945f, "detail bounds: $lower")
        assertTrue(upper.left >= 24f && upper.right <= 825f && lower.left >= 24f && lower.right <= 825f)
        val fab = compose.onNodeWithTag("quick-add-fab").fetchSemanticsNode().boundsInRoot
        assertTrue(fab.top >= upper.top && fab.bottom <= upper.bottom, "FAB stays above hinge: $fab")
        assertTrue(fab.left >= upper.left && fab.right <= upper.right, "FAB stays within inset list width: $fab")
    }

    @Test fun `horizontal list tail stays above the quick add button`() {
        safeInsets = WindowInsets(left = 24.dp, top = 28.dp, right = 16.dp, bottom = 0.dp)
        hinge = LedgerHinge(470.dp, 475.dp, true)
        render(Destination.ACTIVITY)
        val merchant = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE).transactions.value.last().merchant
        val list = compose.onNode(hasScrollToIndexAction() and hasAnyAncestor(hasTestTag("vault-list-pane")))
        list.performScrollToNode(hasContentDescription(merchant, substring = true))
        val tail = compose.onNode(hasContentDescription(merchant, substring = true) and hasClickAction())
        tail.assertIsDisplayed()
        val fab = compose.onNodeWithTag("quick-add-fab").fetchSemanticsNode().boundsInRoot
        assertTrue(list.fetchSemanticsNode().boundsInRoot.bottom <= fab.top, "list viewport must clear FAB: $fab")
        assertTrue(tail.fetchSemanticsNode().boundsInRoot.bottom <= fab.top, "tail row must remain unobscured: $fab")
    }

    @Test fun `compact transaction detail tail stays above the quick add button`() {
        width = 345.dp
        render(Destination.ACTIVITY, longDetail = true)
        val merchant = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE).transactions.value.first().merchant
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription(merchant, substring = true))
        compose.onNode(hasContentDescription(merchant, substring = true) and hasClickAction()).performClick()
        val inDetail = hasAnyAncestor(hasTestTag("vault-detail-pane"))
        val detail = compose.onNode(hasScrollToIndexAction() and inDetail)
        detail.performScrollToNode(hasText("Victor"))
        val tail = compose.onNode(hasText("Victor") and inDetail)
        tail.assertIsDisplayed()
        val fab = compose.onNodeWithTag("quick-add-fab").fetchSemanticsNode().boundsInRoot
        assertTrue(detail.fetchSemanticsNode().boundsInRoot.bottom <= fab.top, "compact detail viewport must clear FAB: $fab")
        assertTrue(tail.fetchSemanticsNode().boundsInRoot.bottom <= fab.top, "compact detail tail must remain unobscured: $fab")
    }

    @Test fun `selecting a smart list replaces the previous task detail`() = taskParentReplacesDetail("Inbox")
    @Test fun `selecting a project replaces the previous task detail`() = taskParentReplacesDetail("Tax Prep")
    @Test fun `selecting an area replaces the previous task detail`() = taskParentReplacesDetail("Finance")

    private fun taskParentReplacesDetail(parent: String) {
        render(Destination.TASKS)
        val inList = hasAnyAncestor(hasTestTag("vault-list-pane"))
        val inDetail = hasAnyAncestor(hasTestTag("vault-detail-pane"))
        compose.onNode(hasContentDescription("Open Review insurance renewal") and hasClickAction() and inList)
            .performScrollTo().performClick()
        compose.onNode(hasText("Review insurance renewal") and inDetail).assertIsDisplayed()
        val parentRow = if (parent == "Inbox") hasText(parent) else hasContentDescription("Open $parent")
        compose.onNode(parentRow and hasClickAction() and inList).performScrollTo().performClick()
        if (parent == "Inbox") {
            compose.onNode(parentRow and hasClickAction() and inList).assertIsSelected()
            compose.runOnIdle { width = 345.dp }
            compose.runOnIdle { width = 841.dp }
            compose.onNode(parentRow and hasClickAction() and inList).assertIsSelected()
        }
        compose.onNode(hasText("Review insurance renewal") and inDetail).assertDoesNotExist()
        compose.onNode(hasText(parent) and inDetail and SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)).assertIsDisplayed()
    }

    @Test fun `selecting another Budget category replaces the previous transaction detail`() {
        render(Destination.BUDGET)
        val inList = hasAnyAncestor(hasTestTag("vault-list-pane"))
        val inDetail = hasAnyAncestor(hasTestTag("vault-detail-pane"))
        val category = hasContentDescription("View Groceries transactions for 2026-07")
        compose.onNode(hasScrollToIndexAction() and inList).performScrollToNode(category)
        compose.onNode(category and inList).assertIsNotSelected().performClick().assertIsSelected()
        compose.runOnIdle { width = 345.dp }
        compose.runOnIdle { width = 841.dp }
        compose.onNode(category and inList).assertIsSelected()
        val transaction = hasContentDescription("Neighborhood Market", substring = true) and hasClickAction()
        compose.onNode(hasScrollToIndexAction() and inDetail).performScrollToNode(transaction)
        compose.onNode(transaction and inDetail).performClick()
        compose.onNode(hasText("Edit") and inDetail).assertIsDisplayed()
        val next = hasContentDescription("View Dining transactions for 2026-07")
        compose.onNode(hasScrollToIndexAction() and inList).performScrollToNode(next)
        compose.onNode(next and inList).assertIsNotSelected().performClick().assertIsSelected()
        compose.onNode(hasText("Edit") and inDetail).assertDoesNotExist()
        val diningTransaction = hasContentDescription("Coffee Bar", substring = true) and hasClickAction()
        compose.onNode(hasScrollToIndexAction() and inDetail).performScrollToNode(diningTransaction)
        compose.onNode(diningTransaction and inDetail).assertIsDisplayed()
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
