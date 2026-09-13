package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performScrollToKey
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.domain.BillPayBudgetEffect
import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertEquals
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [34],
    application = BudgetDrilldownTestApplication::class,
)
class BudgetCategoryDrilldownComposeTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>
    private val model = VaultViewModel(clock = { Fixtures.NOW_MILLIS })

    @Before
    fun startHost() {
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
        compose.runOnUiThread { model.navigate(Destination.BUDGET) }
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 411.dp, height = 900.dp)) {
                        val state by model.state.collectAsState()
                        ScreenHost(
                            destination = state.destination,
                            state = state,
                            displayUnit = DisplayUnit.USD,
                        )
                    }
                }
            }
        }
        settle()
    }

    @After
    fun stopHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `income month navigation survives unavailable budget actuals`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val income = listOf(
            com.sats21m.vogelvault.domain.IncomeEntry("aug", "2026-08-31", "2026-08", 10000L, "August payroll", null, FamilyMember.VICTOR),
            com.sats21m.vogelvault.domain.IncomeEntry("sep", "2026-09-13", "2026-09", 20000L, "September payroll", null, FamilyMember.VICTOR),
            com.sats21m.vogelvault.domain.IncomeEntry("future", "2026-09-30", "2026-09", 40000L, "Future payroll", null, FamilyMember.VICTOR),
        )
        render(VaultUiState(activeProfile = FamilyMember.RACHEL, destination = Destination.BUDGET,
            now = java.time.Instant.parse("2026-09-13T12:00:00Z").toEpochMilli(),
            data = fixture.copy(
                budget = fixture.budget.copy(value = fixture.budget.value!!.copy(month = "2026-09")),
                income = fixture.income.copy(value = income),
                btcBillPays = fixture.btcBillPays.copy(status = Freshness.ERROR),
            )))
        compose.onNodeWithContentDescription("Month to date, $200.00").fetchSemanticsNode()
        compose.onNodeWithContentDescription("Year to date, $300.00").fetchSemanticsNode()
        contentList().performScrollToKey("budget-income:row:victor:future")
        compose.onNodeWithText("Future payroll", useUnmergedTree = true).fetchSemanticsNode()
        contentList().performScrollToNode(hasContentDescription("Aug 2026 budget month"))
        compose.onNodeWithContentDescription("Aug 2026 budget month").performClick()
        settle()
        compose.onNodeWithContentDescription("Aug 2026 budget month").assertIsSelected()
        compose.onNodeWithContentDescription("Month to date, $100.00").fetchSemanticsNode()
        compose.onNodeWithContentDescription("Year to date, $100.00").fetchSemanticsNode()
        contentList().performScrollToNode(hasText(activityController.get().getString(R.string.convex_read_error_title)))
        compose.onNodeWithText(activityController.get().getString(R.string.convex_read_error_title)).fetchSemanticsNode()
    }

    @Test
    fun `Bitcoin shows visible transfers and their network fee`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val transfer = com.sats21m.vogelvault.domain.BtcTransfer(
            "move-1", FamilyMember.VICTOR, "2026-07-26", "source-account", "destination-account", 1000L, 5L,
        )
        render(VaultUiState(activeProfile = FamilyMember.VICTOR, destination = Destination.BITCOIN,
            data = fixture.copy(btcTransfers = com.sats21m.vogelvault.domain.Slice(Freshness.LIVE,
                listOf(transfer), 1L, "test transfers"))))
        contentList().performScrollToKey("bitcoin-transfers:row:victor:move-1")
        compose.onNodeWithText("source-account → destination-account", useUnmergedTree = true).fetchSemanticsNode()
        compose.onNodeWithText("2026-07-26 · FEE 5 SATS", useUnmergedTree = true).fetchSemanticsNode()
    }

    @Test
    fun `Maddox no budget state identifies the adults who can create it`() {
        render(VaultUiState(activeProfile = FamilyMember.MADDOX, destination = Destination.BUDGET,
            data = Fixtures.envelope(FamilyMember.MADDOX, Freshness.LIVE)))
        contentList().performScrollToNode(hasText("Victor or Rachel can create Maddox's budget."))
        compose.onNodeWithText("Victor or Rachel can create Maddox's budget.").fetchSemanticsNode()
    }

    @Test
    fun `TalkBack reaches category and transaction rows as named buttons`() {
        val categoryLabel = "View Groceries transactions for 2026-07"
        contentList().performScrollToKey("budget-categories:row:Groceries")
        val category = compose.onNodeWithContentDescription(categoryLabel)
        assertNamedButton(categoryLabel)
        category.performClick()
        settle()

        val transactionLabel =
            "Edit Neighborhood Market transaction from 2026-07-26, owned by Victor"
        contentList().performScrollToKey("budget-category-transactions:row:victor\u0000tx-0001")
        assertNamedButton(transactionLabel)
    }

    @Test
    fun `profile switch clears the open drilldown and transaction editor`() {
        contentList().performScrollToKey("budget-categories:row:Groceries")
        compose.onNodeWithContentDescription("View Groceries transactions for 2026-07")
            .performClick()
        settle()
        contentList().performScrollToKey("budget-category-transactions:row:victor\u0000tx-0001")
        compose.onNodeWithContentDescription(
            "Edit Neighborhood Market transaction from 2026-07-26, owned by Victor",
        ).performClick()
        settle()
        compose.onNodeWithText("Edit").performClick()
        settle()
        assertEquals(1, nodesWithText("Transaction detail"))

        compose.runOnUiThread { model.switchProfile(FamilyMember.MASON) }
        settle()

        assertEquals(0, nodesWithText("Transaction detail"))
        assertEquals(0, nodesWithText("Back to categories"))
    }

    @Test
    fun `older Budget selection does not change Dashboard MTD`() {
        contentList().performScrollToNode(hasContentDescription("Jun 2026 budget month"))
        compose.onNodeWithContentDescription("Jun 2026 budget month").performClick()
        settle()
        compose.onNodeWithContentDescription("Jun 2026 budget month").assertIsSelected()

        compose.runOnUiThread { model.navigate(Destination.DASHBOARD) }
        settle()

        contentList().performScrollToNode(hasContentDescription("Spend, \$611.17"))
        compose.onNodeWithContentDescription("Spend, \$611.17").fetchSemanticsNode()
        compose.onNodeWithContentDescription("Income, \$4,960.00").fetchSemanticsNode()
    }

    @Test
    fun `Budget income editor exposes the atomic Bitcoin buy action`() {
        render(model.state.value, quickAddRequested = true)
        settle()
        compose.onNodeWithText("Income", useUnmergedTree = true).performClick()
        settle()

        compose.onNodeWithText("Amount").performTextInput("100.00")
        compose.onNodeWithText("Next").performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithText("Payment, date, note and Bitcoin").performScrollTo()
            .performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithText("Add as Bitcoin buy").fetchSemanticsNode()
    }

    @Test
    fun `category drilldown includes scoped budget-category bill pays`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val billPay = billPay(
            id = "budget-bill-pay",
            date = "2026-07-20",
            category = "Groceries",
            effect = BillPayBudgetEffect.BUDGET_CATEGORY,
        )
        render(
            VaultUiState(
                activeProfile = FamilyMember.VICTOR,
                destination = Destination.BUDGET,
                data = fixture.copy(
                    btcBillPays = fixture.btcBillPays.copy(value = listOf(billPay)),
                ),
            ),
        )

        contentList().performScrollToKey("budget-categories:row:Groceries")
        compose.onNodeWithContentDescription("View Groceries transactions for 2026-07").performClick()
        settle()

        contentList().performScrollToKey("budget-category-bill-pays:row:budget-bill-pay")
        compose.onNodeWithText("budget-bill-pay", useUnmergedTree = true).fetchSemanticsNode()
    }

    @Test
    fun `category drilldown owns the budget editor for the live current month`() {
        render(
            VaultUiState(
                activeProfile = FamilyMember.VICTOR,
                destination = Destination.BUDGET,
                data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE),
            ),
        )
        val edit = activityController.get().getString(R.string.budget_category_edit_action)
        contentList().performScrollToKey("budget-categories:row:Groceries")
        assertEquals(0, nodesWithText(edit))

        compose.onNodeWithContentDescription("View Groceries transactions for 2026-07").performClick()
        settle()

        contentList().performScrollToNode(hasText(edit))
        compose.onNodeWithText(edit).assertHasClickAction()
        contentList().performScrollToNode(hasContentDescription("Remaining,", substring = true))
        compose.onNodeWithContentDescription("Remaining, \$705.82, OF \$900.00 planned").fetchSemanticsNode()
    }

    @Test
    fun `category drilldown refuses partial transactions when bill-pay projection fails`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val billPay = billPay(
            id = "budget-bill-pay",
            date = "2026-07-20",
            category = "Groceries",
            effect = BillPayBudgetEffect.BUDGET_CATEGORY,
        )
        val available = fixture.copy(
            btcBillPays = fixture.btcBillPays.copy(value = listOf(billPay)),
        )
        val unavailable = available.copy(
            btcBillPays = available.btcBillPays.copy(
                status = Freshness.ERROR,
                value = emptyList(),
            ),
        )
        lateinit var replaceState: (VaultUiState) -> Unit

        compose.runOnUiThread {
            activityController.get().setContent {
                var state by remember {
                    mutableStateOf(
                        VaultUiState(
                            activeProfile = FamilyMember.VICTOR,
                            destination = Destination.BUDGET,
                            data = available,
                        ),
                    )
                }
                replaceState = { state = it }
                VogelVaultTheme {
                    Box(Modifier.size(width = 411.dp, height = 900.dp)) {
                        ScreenHost(
                            destination = Destination.BUDGET,
                            state = state,
                            displayUnit = DisplayUnit.USD,
                        )
                    }
                }
            }
        }
        settle()

        contentList().performScrollToKey("budget-categories:row:Groceries")
        compose.onNodeWithContentDescription("View Groceries transactions for 2026-07").performClick()
        settle()

        compose.runOnUiThread {
            replaceState(
                VaultUiState(
                    activeProfile = FamilyMember.VICTOR,
                    destination = Destination.BUDGET,
                    data = unavailable,
                ),
            )
        }
        settle()

        compose.onNodeWithText(activityController.get().getString(R.string.convex_read_error_title))
            .fetchSemanticsNode()
        assertEquals(0, nodesWithText("Neighborhood Market"))
    }

    private fun render(state: VaultUiState, quickAddRequested: Boolean = false) {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 411.dp, height = 900.dp)) {
                        ScreenHost(
                            destination = state.destination,
                            quickAddRequested = quickAddRequested,
                            state = state,
                            displayUnit = DisplayUnit.USD,
                        )
                    }
                }
            }
        }
        settle()
    }

    private fun billPay(
        id: String,
        date: String,
        category: String,
        effect: BillPayBudgetEffect,
    ) = BtcBillPay(
        id = id,
        date = date,
        merchant = id,
        category = category,
        budgetEffect = effect,
        amountUsdCents = 2_000L,
        btcSpentSats = 1_000L,
        btcPriceCents = 200_000L,
        feeUsdCents = 0L,
        platform = "river_bitcoin_bill_pay",
        note = null,
        owner = FamilyMember.VICTOR,
    )

    private fun assertNamedButton(contentDescription: String) {
        val config =
            compose.onNodeWithContentDescription(contentDescription)
                .fetchSemanticsNode()
                .config
        assertEquals(Role.Button, config[SemanticsProperties.Role])
        assertEquals(contentDescription, config[SemanticsActions.OnClick].label)
    }

    private fun nodesWithText(text: String): Int =
        compose.onAllNodesWithText(text).fetchSemanticsNodes().size

    // The unit chips above the list scroll too; the ledger column is the other scroll node.
    private fun contentList() =
        compose.onAllNodes(hasScrollAction() and hasTestTag(BITCOIN_UNIT_TOGGLE_TEST_TAG).not())[0]

    private fun settle() {
        repeat(3) {
            compose.waitForIdle()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }
}

class BudgetDrilldownTestApplication : VaultApplication() {
    override val deviceCapabilities = com.sats21m.vogelvault.data.DeviceCapabilities(
        FamilyMember.VICTOR, com.sats21m.vogelvault.data.DeviceCapability.entries.map { it.wire }.toSet(),
    )
}
