package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
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
@Config(sdk = [34])
class NavigationBackTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var controller: ActivityController<ComponentActivity>
    private var destination by mutableStateOf(Destination.HOME)
    @Before fun start() {
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
    }
    @After fun stop() { controller.pause().stop().destroy() }
    private fun render(initial: Destination, longTasks: Boolean = false) {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val data = if (longTasks) fixture.copy(todos = fixture.todos.copy(value = (1..40).map {
            com.sats21m.vogelvault.domain.TodoItem(id = "task-$it", title = "Task $it",
                owner = FamilyMember.VICTOR, due = "2026-07-26")
        })) else fixture
        destination = initial
        controller.get().setContent {
            LedgerTheme {
                Box(Modifier.size(411.dp, 891.dp)) {
                    VaultApp(
                        state = VaultUiState(activeProfile = FamilyMember.VICTOR, destination = destination,
                            data = data),
                        onNavigate = { destination = it }, onSwitchProfile = {},
                    )
                }
            }
        }
        compose.waitForIdle()
    }
    private fun back() {
        compose.runOnIdle { controller.get().onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
    }
    @Test fun `home Budget link replaces a previous month selection`() {
        render(Destination.BUDGET)
        compose.onNodeWithContentDescription("Jun 2026 budget month").performClick().assertIsSelected()
        compose.onNode(hasText("Home") and hasClickAction()).performClick()
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Budget") and hasClickAction())
        // The home link is inside the scrolling content, unlike the primary tab.
        compose.onNode(hasText("Budget") and hasClickAction() and androidx.compose.ui.test.hasAnyAncestor(hasScrollToIndexAction())).performClick()
        compose.onNodeWithContentDescription("Jul 2026 budget month").assertIsSelected()
        back()
        assertEquals(Destination.HOME, destination)
    }
    @Test fun `tasks hub survives smart list detail and Back`() {
        render(Destination.TASKS, longTasks = true)
        compose.onNode(hasText("Inbox") and hasClickAction()).performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("All task lists").fetchSemanticsNode()
        back()
        assertEquals(Destination.TASKS, destination)
        compose.onNode(hasText("Inbox") and hasClickAction()).assertExists()
        compose.onNodeWithText("All task lists").assertDoesNotExist()
    }
    @Test fun `Bitcoin drilldown returns to the originating Bitcoin screen`() {
        render(Destination.BITCOIN)
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Buys · See all"))
        compose.onNodeWithText("Buys · See all").performClick()
        compose.waitForIdle()
        assertEquals(Destination.BTC_BUYS, destination)
        back()
        assertEquals(Destination.BITCOIN, destination)
        compose.onNodeWithText("Buys · See all").fetchSemanticsNode()
    }
    @Test fun `gear menu Family Back walks both levels to Home`() {
        render(Destination.HOME)
        compose.onNodeWithTag(VAULT_GEAR_MENU_TEST_TAG).performClick()
        compose.onNodeWithText("Settings").performClick()
        compose.waitForIdle()
        assertEquals(Destination.SETTINGS, destination)
        back()
        assertEquals(Destination.HOME, destination)
        compose.onNodeWithTag(VAULT_GEAR_MENU_TEST_TAG).performClick()
        compose.onNodeWithText("Family").performClick()
        compose.waitForIdle()
        assertEquals(Destination.FAMILY, destination)
        back()
        assertEquals(Destination.HOME, destination)
    }
    @Test fun `selected task list consumes Back before leaving Tasks`() {
        render(Destination.TASKS)
        compose.onNode(hasText("Inbox") and hasClickAction()).performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("All task lists").fetchSemanticsNode()
        back()
        assertEquals(Destination.TASKS, destination)
        compose.onNodeWithText("All task lists").assertDoesNotExist()
    }
}
