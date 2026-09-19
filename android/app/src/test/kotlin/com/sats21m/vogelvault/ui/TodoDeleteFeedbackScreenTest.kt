package com.sats21m.vogelvault.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.HttpPoster
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.channels.Channel
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

/** Delete and undo feedback through Tasks with a controlled transport. */
@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [34],
    application = GatedTodoWriteApplication::class,
)
class TodoDeleteFeedbackScreenTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>
    private lateinit var application: GatedTodoWriteApplication
    private var refreshCount: Int = 0
    private var displayedTodos by mutableStateOf(listOf<TodoItem>())

    /**
     * The screen's undo clock, controlled here rather than read from the host.
     * Robolectric's virtual clock never reaches System.currentTimeMillis in app
     * code, so the alternative was a six-second sleep.
     */
    private var screenNowMillis: Long = 1_800_000_000_000L

    private val todo = TodoItem(
        id = "todo-delete-feedback",
        title = "Pay electric bill",
        // Earlier than the fixture clock, so the Today filter keeps it whatever
        // the host time zone is.
        due = "2026-07-01",
        owner = FamilyMember.VICTOR,
    )

    private val deletedAnnouncement: String
        get() = application.getString(R.string.todo_deleted, todo.title)

    private val undoLabel: String
        get() = application.getString(R.string.todo_undo)

    @Before
    fun startComposeHost() {
        application = RuntimeEnvironment.getApplication() as GatedTodoWriteApplication
        application.poster.reset()
        refreshCount = 0
        displayedTodos = listOf(todo)
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun stopComposeHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `TaskListsScreen announces no deletion while the delete is still in flight`() {
        showTasks()
        deleteTheTodo()

        assertTrue(
            application.poster.requestCount > 0,
            "the Delete control never reached the write transport",
        )
        assertEquals(
            0,
            nodesWithText(deletedAnnouncement),
            "TaskListsScreen published \"$deletedAnnouncement\" before the delete result arrived",
        )
        assertEquals(
            0,
            nodesWithText(undoLabel),
            "TaskListsScreen offered Undo for a delete the server has not accepted yet",
        )
        assertEquals(0, refreshCount, "an in-flight delete refreshed rows before Convex accepted it")

        application.poster.answer(HttpTextResponse(500, ""))
        settle()

        assertEquals(
            1,
            nodesWithText("Task not deleted (http 500)"),
            "a rejected delete must name its cause",
        )
        assertEquals(
            0,
            nodesWithText(deletedAnnouncement),
            "a rejected delete published the success announcement anyway",
        )
        assertEquals(
            1,
            nodesWithText(todo.title),
            "a rejected delete must put the row back",
        )
        assertEquals(0, refreshCount, "a rejected delete refreshed authoritative rows")
    }

    @Test
    fun `failed delete restores a newer authoritative row received while in flight`() {
        showTasks()
        deleteTheTodo()
        val newer = todo.copy(
            title = "Pay electric bill after rate update",
            updatedAtMs = todo.updatedAtMs + 1,
        )

        publishTodos(listOf(newer))
        assertEquals(0, nodesWithText(newer.title), "the optimistic tombstone leaked the refreshed row")
        application.poster.answer(HttpTextResponse(500, ""))
        settle()

        assertEquals(1, nodesWithText(newer.title), "rollback ignored the authoritative refreshed row")
        assertEquals(0, nodesWithText(todo.title), "rollback resurrected the captured pre-delete row")
    }

    @Test
    fun `a slow successful delete starts a full undo window at acceptance`() {
        showTasks()
        deleteTheTodo()

        // The server is slower than six seconds. That time must not consume the
        // post-acceptance Undo session.
        screenNowMillis += TODO_UNDO_WINDOW_MILLIS + 1_000

        application.poster.answer(deleteSuccess())
        settle()

        assertEquals(
            1,
            nodesWithText(deletedAnnouncement),
            "a slow but successful delete announced nothing at all",
        )
        assertEquals(
            1,
            nodesWithText(undoLabel),
            "network latency consumed the post-acceptance Undo window",
        )
        assertEquals(
            0,
            nodesWithText(todo.title),
            "a successful delete put the row back",
        )
        assertEquals(1, refreshCount, "an accepted delete did not refresh authoritative rows")
    }

    @Test
    fun `a successful undo uses the safe restore route and refreshes both writes`() {
        showTasks()
        deleteTheTodo()

        application.poster.answer(deleteSuccess())
        settle()
        assertEquals(1, refreshCount, "the accepted delete did not refresh")

        compose.onNodeWithText(undoLabel).performClick()
        settle()
        assertEquals(2, application.poster.requestCount)
        application.poster.answer(restoreSuccess())
        settle()
        assertEquals(2, refreshCount)
        assertEquals(1, nodesWithText(todo.title))

        screenNowMillis += TODO_UNDO_WINDOW_MILLIS + 1
        compose.mainClock.advanceTimeBy(TODO_UNDO_WINDOW_MILLIS + 1)
        settle()
        compose.onNodeWithContentDescription(
            application.getString(R.string.todo_mark_complete_named, todo.title),
        ).performScrollTo().performClick()
        settle()
        assertTrue(
            checkNotNull(application.poster.lastBody).contains("\"baseUpdatedAtMs\":1800000000001"),
            "the restored row discarded the server receipt revision",
        )
    }

    private fun deleteTheTodo() {
        val actions = compose.onNodeWithContentDescription(application.getString(R.string.todo_edit_named, todo.title)).performScrollTo()
            .fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsActions.CustomActions]
        compose.runOnIdle {
            actions.single { it.label == application.getString(R.string.todo_delete_named, todo.title) }.action()
        }
        settle()
    }

    private fun nodesWithText(text: String): Int =
        compose.onAllNodesWithText(text).fetchSemanticsNodes().size

    private fun deleteSuccess(): HttpTextResponse = HttpTextResponse(
        200,
        """{"status":"success","value":{"ok":true,"entityId":"${todo.id}","removed":true}}""",
    )

    private fun restoreSuccess(): HttpTextResponse = HttpTextResponse(
        200,
        """{"status":"success","value":{"ok":true,"entityId":"${todo.id}","updatedAtMs":1800000000001}}""",
    )

    private fun showTasks() {
        val base = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        compose.runOnUiThread {
            activityController.get().setContent {
                val state = VaultUiState(
                    activeProfile = FamilyMember.VICTOR,
                    destination = Destination.TASKS,
                    data = base.copy(
                        todos = base.todos.copy(status = Freshness.LIVE, value = displayedTodos),
                    ),
                )
                VogelVaultTheme {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        TaskListsScreen(
                            state = state,
                            todos = state.data.todos.value,
                            onWriteSucceeded = { refreshCount++ },
                            nowMillis = { screenNowMillis },
                        )
                    }
                }
            }
        }
        settle()
        compose.onNodeWithText(todo.title).performScrollTo()
        assertEquals(1, nodesWithText(todo.title), "the todo under test never rendered")
    }

    private fun publishTodos(todos: List<TodoItem>) {
        compose.runOnUiThread { displayedTodos = todos }
        settle()
    }

    private fun settle() {
        shadowOf(Looper.getMainLooper()).idle()
        compose.waitForIdle()
    }
}

/**
 * A transport that answers only when this test says so.
 *
 * Holding the response open is the whole point: it is the only way to observe
 * what the screen shows during the window between the tap and the server's
 * answer, which is where optimistic feedback hides.
 */
class GatedPoster : HttpPoster {
    private val answers = Channel<HttpTextResponse>(Channel.UNLIMITED)

    @Volatile
    var requestCount: Int = 0
        private set

    @Volatile
    var lastBody: String? = null
        private set

    override suspend fun postJson(url: String, body: String): HttpTextResponse {
        requestCount += 1
        lastBody = body
        return answers.receive()
    }

    fun answer(response: HttpTextResponse) {
        check(answers.trySend(response).isSuccess)
    }

    fun reset() {
        requestCount = 0
        lastBody = null
        while (answers.tryReceive().isSuccess) {
            // Clear any unconsumed answer if Robolectric reuses this application.
        }
    }
}

/** A real gateway and a real mutation client over a transport the test gates. */
class GatedTodoWriteApplication : VaultApplication() {
    val poster = GatedPoster()

    override fun hasTodoWriteCredential(): Boolean = true
    override fun hasTodoWriteCredential(profile: FamilyMember): Boolean = true

    override val todoMutationGateway: TodoMutationGateway by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        TodoMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(
                    ConvexConfig(deploymentUrl = "https://gated-todo-test.convex.cloud"),
                ),
                // Invented per run, so no string here can be mistaken for a real one.
                credentialSource = ConvexDeviceCredentialSource {
                    ConvexDeviceCredential(
                        "test-device",
                        "t".repeat(43),
                        FamilyMember.VICTOR,
                    )
                },
                http = poster,
            ),
        )
    }
}
