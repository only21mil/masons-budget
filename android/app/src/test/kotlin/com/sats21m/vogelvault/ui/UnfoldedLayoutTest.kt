package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.TodoItem
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
import java.time.ZoneId
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The unfolded two-pane contract.
 *
 * Rail, capped content column, and the 296dp sidebar on Dashboard and Budget
 * only. Rendered at the Pixel Fold inner width; the folded case renders the same
 * shell in a 411dp box so both postures are proven by the same tree.
 */
@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [34],
    qualifiers = "w852dp-h883dp-normal-long-notround-any-390dpi-keyshidden-nonav",
)
class UnfoldedLayoutTest {

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
    fun `sidebar appears on Dashboard and Budget when unfolded`() {
        SIDEBAR_DESTINATIONS.forEach { destination ->
            render(VaultUiState.of(FamilyMember.VICTOR, destination), width = 852.dp)

            compose.onNodeWithTag(LEDGER_SIDEBAR_TEST_TAG).assertIsDisplayed()
            compose.onNode(
                hasContentDescription("Recent activity") and hasAnyAncestor(hasTestTag(LEDGER_SIDEBAR_TEST_TAG)),
            ).assertIsDisplayed()
            compose.onNode(
                hasContentDescription("Today") and hasAnyAncestor(hasTestTag(LEDGER_SIDEBAR_TEST_TAG)),
            ).assertIsDisplayed()
        }
    }

    @Test
    fun `sidebar is absent on every other destination when unfolded`() {
        Destination.entries.filterNot { it in SIDEBAR_DESTINATIONS }.forEach { destination ->
            render(VaultUiState.of(FamilyMember.VICTOR, destination), width = 852.dp)

            compose.onNodeWithTag(LEDGER_SIDEBAR_TEST_TAG).assertDoesNotExist()
        }
    }

    @Test
    fun `sidebar is absent when folded`() {
        SIDEBAR_DESTINATIONS.forEach { destination ->
            render(VaultUiState.of(FamilyMember.VICTOR, destination), width = 411.dp)

            compose.onNodeWithTag(LEDGER_SIDEBAR_TEST_TAG).assertDoesNotExist()
            compose.onNodeWithTag(VAULT_RAIL_TEST_TAG).assertDoesNotExist()
        }
    }

    @Test
    fun `sidebar lists the seven most recent visible rows and today's tasks`() {
        val base = VaultUiState.of(FamilyMember.VICTOR, Destination.DASHBOARD)
        val today = sidebarLocalDay(base.now, ZoneId.systemDefault())
        val state = base.copy(
            data = base.data.copy(
                todos = base.data.todos.copy(
                    status = Freshness.LIVE,
                    value = listOf(
                        TodoItem("due-today", "Pay the water bill", due = today, owner = FamilyMember.VICTOR),
                        TodoItem("overdue", "Renew passport", due = "2020-01-01", owner = FamilyMember.VICTOR),
                        TodoItem("later", "Not yet", due = "2999-12-31", owner = FamilyMember.VICTOR),
                        TodoItem("mason", "Mason private", due = today, owner = FamilyMember.MASON),
                    ),
                ),
            ),
        )
        val activity = sidebarRecentActivity(state)
        assertEquals(SIDEBAR_RECENT_ACTIVITY_LIMIT, activity.size)
        assertTrue(activity.zipWithNext().all { (a, b) -> a.date >= b.date }, "sidebar rows are newest first")
        assertEquals(listOf("Pay the water bill", "Renew passport"), sidebarTodaysTasks(state).map { it.title })

        render(state, width = 852.dp)

        val inSidebar = hasAnyAncestor(hasTestTag(LEDGER_SIDEBAR_TEST_TAG))
        activity.forEach { transaction ->
            compose.onNode(hasContentDescription(transaction.merchant, substring = true) and inSidebar)
                .assertIsDisplayed()
        }
        compose.onNode(hasContentDescription("Pay the water bill, $SIDEBAR_TASK_TAG_TODAY") and inSidebar).assertIsDisplayed()
        compose.onNode(hasContentDescription("Renew passport, $SIDEBAR_TASK_TAG_OVERDUE") and inSidebar).assertIsDisplayed()
        compose.onNode(hasContentDescription("Not yet", substring = true) and inSidebar).assertDoesNotExist()
        compose.onNode(hasContentDescription("Mason private", substring = true) and inSidebar).assertDoesNotExist()
    }

    @Test
    fun `rail exposes seven primary items with More selected for overflow`() {
        render(VaultUiState.of(FamilyMember.VICTOR, Destination.ACTIVITY), width = 852.dp)

        compose.onAllNodes(isSelectable() and hasAnyAncestor(hasTestTag(VAULT_RAIL_TEST_TAG)))
            .assertCountEquals(RAIL_ITEM_COUNT)
        compose.onNodeWithTag(VAULT_RAIL_TEST_TAG).assertWidthIsEqualTo(RAIL_WIDTH_DP.dp)
    }

    @Test
    fun `content column is capped without a sidebar and never wider with one`() {
        render(VaultUiState.of(FamilyMember.VICTOR, Destination.ACTIVITY), width = 852.dp)
        compose.onNodeWithTag(VAULT_SCREEN_CONTENT_TEST_TAG)
            .assertWidthIsEqualTo(UNFOLDED_CONTENT_MAX_WIDTH_DP.dp)

        render(VaultUiState.of(FamilyMember.VICTOR, Destination.DASHBOARD), width = 852.dp)
        val node = compose.onNodeWithTag(VAULT_SCREEN_CONTENT_TEST_TAG).fetchSemanticsNode()
        val widthDp = node.size.width / node.layoutInfo.density.density
        assertTrue(widthDp <= UNFOLDED_CONTENT_MAX_WIDTH_DP, "content beside the sidebar was ${widthDp}dp")

        render(VaultUiState.of(FamilyMember.VICTOR, Destination.ACTIVITY), width = 411.dp)
        compose.onNodeWithTag(VAULT_SCREEN_CONTENT_TEST_TAG).assertWidthIsEqualTo(411.dp)
    }

    private fun render(state: VaultUiState, width: Dp) {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = width, height = 720.dp)) {
                        VaultApp(
                            state = state,
                            onNavigate = {},
                            onSwitchProfile = {},
                        )
                    }
                }
            }
        }
        compose.waitForIdle()
    }
}
