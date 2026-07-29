package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexMutationClient
import com.sats21m.vogelvault.data.ConvexSyncTokenSource
import com.sats21m.vogelvault.data.HttpPoster
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
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

/**
 * Delete feedback as the user actually meets it: through TodoScreen, driving the
 * real Delete control, against a transport this test holds open.
 *
 * The isolated helper test next door cannot see the defect it names. Reverting
 * TodoScreen to the optimistic version it was written to guard leaves that test
 * green, because the helper is still correct — the call site was the bug. So
 * these two cases press the screen's own snackbar sequencing, and both were
 * observed failing against the production lines they guard.
 */
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
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun stopComposeHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `TodoScreen announces no deletion while the delete is still in flight`() {
        showToday()
        deleteTheTodo()

        assertTrue(
            application.poster.requestCount > 0,
            "the Delete control never reached the write transport",
        )
        assertEquals(
            0,
            nodesWithText(deletedAnnouncement),
            "TodoScreen published \"$deletedAnnouncement\" before the delete result arrived",
        )
        assertEquals(
            0,
            nodesWithText(undoLabel),
            "TodoScreen offered Undo for a delete the server has not accepted yet",
        )

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
    }

    @Test
    fun `a successful delete still confirms after the undo window has closed`() {
        showToday()
        deleteTheTodo()

        // The server is slower than the six-second undo window: the answer below
        // arrives after the window has closed.
        screenNowMillis += TODO_UNDO_WINDOW_MILLIS + 1_000

        application.poster.answer(HttpTextResponse(200, """{"status":"success","value":"deleted"}"""))
        settle()

        assertEquals(
            1,
            nodesWithText(deletedAnnouncement),
            "a slow but successful delete announced nothing at all",
        )
        assertEquals(
            0,
            nodesWithText(undoLabel),
            "an expired undo window still offered Undo",
        )
        assertEquals(
            0,
            nodesWithText(todo.title),
            "a successful delete put the row back",
        )
    }

    private fun deleteTheTodo() {
        compose
            .onNodeWithContentDescription(application.getString(R.string.todo_delete))
            .performScrollTo()
            .performClick()
        settle()
    }

    private fun nodesWithText(text: String): Int =
        compose.onAllNodesWithText(text).fetchSemanticsNodes().size

    private fun showToday() {
        val base = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val state = VaultUiState(
            activeProfile = FamilyMember.VICTOR,
            destination = Destination.TODAY,
            data = base.copy(
                todos = base.todos.copy(status = Freshness.LIVE, value = listOf(todo)),
            ),
        )
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    TodoScreen(state = state, nowMillis = { screenNowMillis })
                }
            }
        }
        settle()
        assertEquals(1, nodesWithText(todo.title), "the todo under test never rendered")
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
    private val answered = CompletableDeferred<HttpTextResponse>()

    @Volatile
    var requestCount: Int = 0
        private set

    override suspend fun postJson(url: String, body: String): HttpTextResponse {
        requestCount += 1
        return answered.await()
    }

    fun answer(response: HttpTextResponse) {
        answered.complete(response)
    }
}

/** A real gateway and a real mutation client over a transport the test gates. */
class GatedTodoWriteApplication : VaultApplication() {
    val poster = GatedPoster()

    override fun hasConvexWriteCredential(): Boolean = true

    override val todoMutationGateway: TodoMutationGateway by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        TodoMutationGateway(
            ConvexMutationClient(
                configSource = MutableConvexConfigSource(
                    ConvexConfig(deploymentUrl = "https://gated-todo-test.convex.cloud"),
                ),
                // Invented per run, so no string here can be mistaken for a real one.
                syncTokenSource = ConvexSyncTokenSource { "vv-test-" + UUID.randomUUID() },
                http = poster,
            ),
        )
    }
}
