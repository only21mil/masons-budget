package com.sats21m.vogelvault

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.Destination
import com.sats21m.vogelvault.ui.ScreenHost
import com.sats21m.vogelvault.ui.VaultUiState
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
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TaskDestinationVisibilityTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>

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
    fun `child TASKS destination receives no adult-owned todos`() {
        val base = Fixtures.envelope(FamilyMember.MASON, Freshness.LIVE)
        val todos = listOf(
            TodoItem(
                id = "adult-private",
                title = "Adult private task",
                owner = FamilyMember.VICTOR,
            ),
            TodoItem(
                id = "mason-visible",
                title = "Mason task",
                owner = FamilyMember.MASON,
            ),
        )
        val state = VaultUiState(
            activeProfile = FamilyMember.MASON,
            destination = Destination.TASKS,
            data = base.copy(
                todos = base.todos.copy(
                    status = Freshness.LIVE,
                    value = todos,
                ),
            ),
        )
        val receivedTodos = AtomicReference<List<TodoItem>>()

        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 411.dp, height = 640.dp)) {
                        ScreenHost(
                            destination = Destination.TASKS,
                            state = state,
                            taskListsContent = { _, destinationTodos ->
                                receivedTodos.set(destinationTodos)
                            },
                        )
                    }
                }
            }
        }
        compose.waitForIdle()

        assertEquals(
            listOf("mason-visible"),
            receivedTodos.get().map(TodoItem::id),
            "ScreenHost handed adult-owned todos across the child TASKS boundary",
        )
    }
}
