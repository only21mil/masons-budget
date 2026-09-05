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
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
    private val model = VaultViewModel()

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
        assertEquals(1, nodesWithText("Transaction detail"))

        compose.runOnUiThread { model.switchProfile(FamilyMember.MASON) }
        settle()

        assertEquals(0, nodesWithText("Transaction detail"))
        assertEquals(0, nodesWithText("Back to categories"))
    }

    @Test
    fun `older Budget selection does not change Dashboard MTD`() {
        compose.onNodeWithContentDescription("Jun 2026 budget month").performClick()
        settle()
        compose.onNodeWithContentDescription("Jun 2026 budget month").assertIsSelected()

        compose.runOnUiThread { model.navigate(Destination.DASHBOARD) }
        settle()

        compose.onNodeWithContentDescription("Spend, \$611.17").fetchSemanticsNode()
        compose.onNodeWithContentDescription("Income, \$4,960.00").fetchSemanticsNode()
    }

    @Test
    fun `Budget income editor exposes the atomic Bitcoin buy action`() {
        compose.onNodeWithText("+ Add").performClick()
        settle()
        compose.onNodeWithText("Income").performClick()
        settle()

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

        compose.onNodeWithText(edit).assertHasClickAction()
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

        compose.onNodeWithText("Convex row data unavailable").fetchSemanticsNode()
        assertEquals(0, nodesWithText("Neighborhood Market"))
    }

    private fun render(state: VaultUiState) {
        compose.runOnUiThread {
            activityController.get().setContent {
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

    private fun contentList() = compose.onAllNodes(hasScrollAction())[0]

    private fun settle() {
        repeat(3) {
            compose.waitForIdle()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }
}

class BudgetDrilldownTestApplication : VaultApplication()
