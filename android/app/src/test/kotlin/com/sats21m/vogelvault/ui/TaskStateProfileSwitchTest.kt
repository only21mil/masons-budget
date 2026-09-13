package com.sats21m.vogelvault.ui

import android.content.Context
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertEquals
import kotlin.test.assertTrue
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

/**
 * Profile switching against the production task composables.
 *
 * These tests deliberately enter names before calling the real
 * [VaultViewModel.switchProfile]. A helper-level test cannot see a missing
 * Compose remember key, which is the privacy boundary guarded here.
 */
@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [34],
    application = ProfileScopedTaskStateApplication::class,
)
class TaskStateProfileSwitchTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>
    private val model = VaultViewModel()
    private val context: Context
        get() = ApplicationProvider.getApplicationContext()

    @Before
    fun startComposeHost() {
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun stopComposeHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `Today draft is discarded by a real profile switch`() {
        navigateTo(Destination.TODAY)
        showScreenHost()

        val victorDraft = "Victor private appointment"
        compose.onNode(
            hasSetTextAction() and hasText(context.getString(R.string.todo_new_task)),
        ).performTextInput(victorDraft)
        settle()
        assertEquals(1, nodesWithText(victorDraft), "The production Today field did not accept text.")

        switchTo(FamilyMember.RACHEL)

        assertEquals(FamilyMember.RACHEL, model.state.value.activeProfile)
        assertEquals(
            0,
            nodesWithText(victorDraft),
            "Victor's Today draft remained visible after switching to Rachel.",
        )
    }

    @Test
    fun `profile switch disables task controls until explicit reprovisioning`() {
        navigateTo(Destination.TODAY)
        showScreenHost()

        switchTo(FamilyMember.RACHEL)

        compose.onNode(hasScrollToIndexAction())
            .performScrollToNode(hasText(context.getString(R.string.todo_new_task)))
        compose.onNode(
            hasText(context.getString(R.string.todo_new_task)),
        ).assertIsNotEnabled()
        compose.onNodeWithText(context.getString(R.string.todo_write_access_title))
            .fetchSemanticsNode()
        compose.onNodeWithText(context.getString(R.string.todo_write_access_detail))
            .fetchSemanticsNode()
        assertEquals(
            0,
            nodesWithText("Paired-device credential"),
            "The blocked screen exposed the retired raw task-credential field.",
        )
    }

    @Test
    fun `Tasks sheet and its title are discarded by a real profile switch`() {
        navigateTo(Destination.TASKS)
        showScreenHost()

        compose.onNodeWithText(context.getString(R.string.tasks_add))
            .performScrollTo()
            .performClick()
        settle()

        val victorTask = "Victor private tax task"
        compose.onNode(
            hasSetTextAction() and hasText(context.getString(R.string.tasks_task_title)),
        ).performTextInput(victorTask)
        settle()
        assertEquals(1, nodesWithText(victorTask), "The production Add Task sheet did not accept text.")

        switchTo(FamilyMember.RACHEL)

        assertEquals(FamilyMember.RACHEL, model.state.value.activeProfile)
        assertEquals(
            0,
            nodesWithText(victorTask),
            "Victor's task title remained visible after switching to Rachel.",
        )
        assertEquals(
            0,
            nodesWithText(context.getString(R.string.tasks_add_title)),
            "Victor's open Add Task sheet remained open after switching to Rachel.",
        )
    }

    @Test
    fun `Add Task fields reset when their production owner changes`() {
        showAddTaskSheet()

        val victorTask = "Victor private filing"
        val victorProject = "Victor private project"
        compose.onNode(
            hasSetTextAction() and hasText(context.getString(R.string.tasks_task_title)),
        ).performTextInput(victorTask)
        compose.onNode(
            hasSetTextAction() and hasText(context.getString(R.string.tasks_project)),
        ).performTextInput(victorProject)
        settle()

        switchTo(FamilyMember.RACHEL)

        assertEquals(0, nodesWithText(victorTask), "The previous owner's task title crossed profiles.")
        assertEquals(0, nodesWithText(victorProject), "The previous owner's project crossed profiles.")
    }

    @Test
    fun `Activity query and filter are discarded by a real profile switch`() {
        navigateTo(Destination.ACTIVITY)
        showScreenHost()

        val privateQuery = "Victor private merchant query"
        compose.onNode(hasSetTextAction() and hasText("Search activity"))
            .performTextInput(privateQuery)
        val income = compose.onNodeWithContentDescription("Income activity filter")
        income.performClick()
        settle()
        income.assertIsSelected().assertHasClickAction()
        val incomeConfig = income.fetchSemanticsNode().config
        assertEquals("Selected", incomeConfig[SemanticsProperties.StateDescription])
        assertEquals("Filter activity by Income", incomeConfig[SemanticsActions.OnClick].label)
        val density = activityController.get().resources.displayMetrics.density
        assertTrue(income.fetchSemanticsNode().boundsInRoot.height >= 48f * density)
        val group = compose.onNodeWithTag(ACTIVITY_FILTER_GROUP_TEST_TAG).fetchSemanticsNode().config
        assertTrue(group.contains(SemanticsProperties.SelectableGroup))

        switchTo(FamilyMember.RACHEL)

        assertEquals(
            0,
            nodesWithText(privateQuery),
            "Victor's Activity query remained visible after switching to Rachel.",
        )
        compose.onNodeWithContentDescription("All activity filter").assertIsSelected()
    }

    private fun showScreenHost() {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 411.dp, height = 900.dp)) {
                        val state by model.state.collectAsState()
                        ScreenHost(destination = state.destination, state = state)
                    }
                }
            }
        }
        settle()
    }

    private fun showAddTaskSheet() {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    val state by model.state.collectAsState()
                    AddTaskSheet(
                        owner = state.activeProfile,
                        onDismiss = {},
                        onSaved = {},
                        // This case asserts profile-switch state clearing, not the
                        // ledger refresh; RefreshAfterWriteSurfaceTest owns that.
                        onWriteSucceeded = {},
                        onCredentialRejected = { null },
                    )
                }
            }
        }
        settle()
    }

    private fun navigateTo(destination: Destination) {
        compose.runOnUiThread { model.navigate(destination) }
    }

    private fun switchTo(profile: FamilyMember) {
        compose.runOnUiThread { model.switchProfile(profile) }
        settle()
    }

    private fun nodesWithText(text: String): Int =
        compose.onAllNodesWithText(text).fetchSemanticsNodes().size

    private fun settle() {
        repeat(3) {
            compose.waitForIdle()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }
}

class ProfileScopedTaskStateApplication : VaultApplication() {
    override fun hasTodoWriteCredential(): Boolean = true
    override fun hasTodoWriteCredential(profile: FamilyMember): Boolean =
        profile == FamilyMember.VICTOR
}
