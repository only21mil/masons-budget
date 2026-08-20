package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
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
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
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
        compose.onNodeWithText("Add").performClick()
        settle()
        compose.onNodeWithText("Income").performClick()
        settle()

        compose.onNodeWithText("Add as Bitcoin buy").fetchSemanticsNode()
    }

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
