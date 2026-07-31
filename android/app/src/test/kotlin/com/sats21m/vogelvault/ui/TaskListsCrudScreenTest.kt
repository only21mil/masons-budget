package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
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
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
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

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [34],
    application = TaskListsCrudApplication::class,
)
class TaskListsCrudScreenTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>
    private lateinit var application: TaskListsCrudApplication
    private var refreshCount = 0
    private var screenNowMillis = 1_800_000_000_000L
    private var displayedTasks by mutableStateOf(listOf<TodoItem>())

    private val todo = TodoItem(
        id = "task-lists-crud",
        title = "Renew family insurance",
        project = "Annual planning",
        area = "Household",
        due = "2026-08-02",
        flagged = true,
        owner = FamilyMember.VICTOR,
        lane = "personal",
        notes = "Keep this private note",
        priority = 3L,
        createdAt = "2026-07-01T12:00:00Z",
        updatedAt = "2026-07-29T12:00:00Z",
        updatedAtMs = 1_800_000_000_000L,
    )

    private val allLists: String
        get() = application.getString(R.string.tasks_all_lists)

    @Before
    fun startComposeHost() {
        application = RuntimeEnvironment.getApplication() as TaskListsCrudApplication
        application.poster.reset()
        application.resetCredential()
        refreshCount = 0
        displayedTasks = listOf(todo)
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
        showTasks()
    }

    @After
    fun stopComposeHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `hub smart project and area routes expose distinct accessible task actions`() {
        assertTaskActions(todo.title)

        compose.onNode(hasText(application.getString(R.string.tasks_upcoming)) and hasClickAction())
            .performScrollTo()
            .performClick()
        settle()
        compose.onNodeWithText(allLists).fetchSemanticsNode()
        assertTaskActions(todo.title)

        backToHub()
        openGroup(todo.project!!)
        compose.onNodeWithText(allLists).fetchSemanticsNode()
        assertTaskActions(todo.title)

        backToHub()
        openGroup(todo.area!!)
        compose.onNodeWithText(allLists).fetchSemanticsNode()
        assertTaskActions(todo.title)
    }

    @Test
    fun `full row edit preserves metadata disables the busy row and retains project route`() {
        openGroup(todo.project!!)
        val changedTitle = "Renew every insurance policy"

        compose.onNodeWithContentDescription(editDescription(todo.title))
            .performScrollTo()
            .performClick()
        settle()
        compose.onNodeWithText(application.getString(R.string.todo_title))
            .performTextReplacement(changedTitle)
        compose.onNode(hasText(application.getString(R.string.todo_save)) and hasClickAction())
            .performClick()
        settle()

        assertEquals(1, application.poster.requestCount, "edit did not reach the shared todo gateway")
        compose.onNodeWithText(changedTitle).assertIsNotEnabled()
        compose.onNodeWithText(application.getString(R.string.todo_save)).assertIsNotEnabled()
        compose.onNodeWithText(application.getString(R.string.todo_cancel)).assertIsNotEnabled()
        compose.onNodeWithContentDescription(markCompleteDescription(todo.title))
            .assertIsNotEnabled()
        assertEquals(0, refreshCount, "an in-flight edit refreshed authoritative rows")

        val body = assertNotNull(application.poster.lastBody)
        assertTrue(body.contains("\"notes\":\"Keep this private note\""), body)
        assertTrue(body.contains("\"priority\""), body)
        assertTrue(body.contains("\"lane\":\"personal\""), body)
        assertTrue(body.contains("\"baseUpdatedAtMs\":1800000000000"), body)
        assertTrue(body.contains("\"createdAt\":\"2026-07-01T12:00:00Z\""), body)

        application.poster.answer(success("updated"))
        settle()

        assertEquals(1, refreshCount)
        compose.onNodeWithText(allLists).fetchSemanticsNode()
        compose.onNodeWithText(changedTitle).fetchSemanticsNode()
        assertEquals(0, nodesWithText(application.getString(R.string.todo_edit)))
    }

    @Test
    fun `rejected edit keeps its typed title and can retry after an HTTP failure`() {
        val changedTitle = "Renew insurance without losing this draft"
        openEditorWithTitle(changedTitle)

        application.poster.answer(HttpTextResponse(500, "private server detail"))
        settle()

        assertEquals(0, refreshCount)
        compose.onNodeWithText("Change not saved (http 500)").fetchSemanticsNode()
        compose.onNodeWithText(changedTitle).assertIsEnabled()
        compose.onNodeWithText(application.getString(R.string.todo_save)).assertIsEnabled()
            .performClick()
        settle()

        assertEquals(2, application.poster.requestCount)
        val retriedBody = assertNotNull(application.poster.lastBody)
        assertTrue(retriedBody.contains("\"title\":\"$changedTitle\""), retriedBody)
        assertTrue(retriedBody.contains("\"baseUpdatedAtMs\":1800000000000"), retriedBody)

        application.poster.answer(success("updated"))
        settle()

        assertEquals(1, refreshCount)
        assertEquals(0, nodesWithText(application.getString(R.string.todo_edit)))
        compose.onNodeWithText(changedTitle).fetchSemanticsNode()
    }

    @Test
    fun `conflicted edit keeps its typed title and original revision fence`() {
        val changedTitle = "Keep conflicted insurance draft"
        openEditorWithTitle(changedTitle)

        application.poster.answer(
            HttpTextResponse(
                200,
                """{"status":"error","errorData":{"code":"ENTITY_CONFLICT","message":"private"}}""",
            ),
        )
        settle()

        assertEquals(0, refreshCount)
        compose.onNodeWithText("Change not saved (task changed on another device)")
            .fetchSemanticsNode()
        compose.onNodeWithText(changedTitle).assertIsEnabled()
        compose.onNodeWithText(application.getString(R.string.todo_save)).assertIsEnabled()
        val body = assertNotNull(application.poster.lastBody)
        assertTrue(body.contains("\"baseUpdatedAtMs\":1800000000000"), body)
    }

    @Test
    fun `completion is a distinct accepted mutation and retains the smart list route`() {
        compose.onNode(hasText(application.getString(R.string.tasks_upcoming)) and hasClickAction())
            .performScrollTo()
            .performClick()
        settle()

        compose.onNodeWithContentDescription(markCompleteDescription(todo.title))
            .performScrollTo()
            .performClick()
        settle()

        assertEquals(1, application.poster.requestCount)
        val body = assertNotNull(application.poster.lastBody)
        assertTrue(body.contains("\"done\":true"), body)
        assertTrue(body.contains("\"baseUpdatedAtMs\":1800000000000"), body)
        assertEquals(0, refreshCount)

        application.poster.answer(success("completed"))
        settle()

        assertEquals(1, refreshCount)
        assertEquals(0, nodesWithText(todo.title), "a completed task stayed in the open smart list")
        compose.onNodeWithText(allLists).fetchSemanticsNode()
    }

    @Test
    fun `delete announces success and restores only through safe undo`() {
        openGroup(todo.area!!)
        val deletedMessage = application.getString(R.string.todo_deleted, todo.title)

        deleteTodo(todo.title)

        assertEquals(1, application.poster.requestCount)
        assertEquals(0, nodesWithText(deletedMessage))
        assertEquals(0, nodesWithText(application.getString(R.string.todo_undo)))
        assertEquals(0, nodesWithText(todo.title), "the local delete was not reflected")
        assertEquals(0, refreshCount)

        application.poster.answer(HttpTextResponse(500, ""))
        settle()

        assertEquals(1, nodesWithText("Task not deleted (http 500)"))
        assertEquals(1, nodesWithText(todo.title), "a rejected delete did not restore the exact row")
        assertEquals(0, refreshCount)
        compose.onNodeWithText(allLists).fetchSemanticsNode()

        deleteTodo(todo.title)
        application.poster.answer(success("deleted"))
        settle()

        assertEquals(1, refreshCount)
        assertEquals(1, nodesWithText(deletedMessage))
        compose.onNodeWithText(application.getString(R.string.todo_undo)).performClick()
        settle()
        assertEquals(3, application.poster.requestCount)
        assertTrue(checkNotNull(application.poster.lastBody).contains("tables:restoreTodoFromDevice"))
        application.poster.answer(success("restored"))
        settle()
        assertEquals(2, refreshCount)
        assertEquals(1, nodesWithText(todo.title))
        compose.onNodeWithText(allLists).fetchSemanticsNode()

        screenNowMillis += TODO_UNDO_WINDOW_MILLIS + 1
        compose.mainClock.advanceTimeBy(TODO_UNDO_WINDOW_MILLIS + 1)
        settle()
        compose.onNodeWithContentDescription(markCompleteDescription(todo.title))
            .performScrollTo()
            .performClick()
        settle()
        assertTrue(
            checkNotNull(application.poster.lastBody).contains("\"baseUpdatedAtMs\":1800000000001"),
            "the restored task discarded the server receipt revision",
        )
    }

    @Test
    fun `failed delete restores a newer authoritative task received while in flight`() {
        val newer = todo.copy(
            title = "Renew family insurance with new quote",
            updatedAtMs = todo.updatedAtMs + 1,
        )
        deleteTodo(todo.title)

        publishTasks(listOf(newer))
        assertEquals(0, nodesWithText(newer.title), "the optimistic tombstone leaked the refreshed task")
        application.poster.answer(HttpTextResponse(500, ""))
        settle()

        assertEquals(1, nodesWithText(newer.title), "rollback ignored the authoritative refreshed task")
        assertEquals(0, nodesWithText(todo.title), "rollback resurrected the captured pre-delete task")
    }

    @Test
    fun `server missing delete stays locally deleted instead of resurrecting captured row`() {
        openGroup(todo.area!!)
        deleteTodo(todo.title)

        application.poster.answer(
            HttpTextResponse(
                200,
                """{"status":"error","errorData":{"code":"ENTITY_NOT_FOUND","message":"gone"}}""",
            ),
        )
        settle()

        assertEquals(0, nodesWithText(todo.title))
        assertEquals(1, nodesWithText("Task was already deleted"))
        assertEquals(0, refreshCount)
    }

    @Test
    fun `a second delete stays disabled until the first undo session closes`() {
        val second = todo.copy(
            id = "task-lists-second-delete",
            title = "Archive tax receipts",
            project = "Records",
            area = "Finance",
        )
        showTasks(listOf(todo, second))

        deleteTodo(todo.title)

        compose.onNodeWithContentDescription(
            application.getString(R.string.todo_delete_pending_named, second.title),
        ).assertIsNotEnabled()
        assertEquals(1, application.poster.requestCount, "a second delete displaced the first request")

        application.poster.answer(success("deleted"))
        settle()

        compose.onNodeWithContentDescription(
            application.getString(R.string.todo_delete_pending_named, second.title),
        ).assertIsNotEnabled()
        compose.onNodeWithText(application.getString(R.string.todo_undo)).performClick()
        settle()
        application.poster.answer(success("restored"))
        settle()
        compose.onNodeWithContentDescription(
            application.getString(R.string.todo_delete_pending_named, second.title),
        ).assertIsNotEnabled()
        compose.mainClock.advanceTimeBy(TODO_UNDO_WINDOW_MILLIS + 1)
        settle()

        compose.onNodeWithContentDescription(
            application.getString(R.string.todo_delete_named, second.title),
        ).assertIsEnabled()
        assertEquals(2, application.poster.requestCount)
    }

    @Test
    fun `add uses canonical gateway payload and rejected credentials disable recovery controls`() {
        compose.onNodeWithText(application.getString(R.string.tasks_add)).performClick()
        settle()
        compose.onNodeWithText(application.getString(R.string.tasks_task_title))
            .performTextInput("Schedule annual physical")
        compose.onNode(
            hasText(application.getString(R.string.tasks_save)) and hasClickAction(),
        ).assertIsEnabled().performScrollTo().performSemanticsAction(SemanticsActions.OnClick)
        settle()
        compose.waitUntil(timeoutMillis = 5_000L) { application.poster.requestCount > 0 }

        val body = assertNotNull(application.poster.lastBody)
        assertTrue(body.contains("\"title\":\"Schedule annual physical\""), body)
        assertTrue(body.contains("\"path\":\"tables:upsertTodoFromDevice\""), body)
        assertTrue(body.contains("\"owner\":\"victor\""), body)
        assertTrue(body.contains("\"sourceFile\":\"todos\""), body)
        assertFalse(body.contains("baseUpdatedAtMs"), body)

        application.poster.answer(
            HttpTextResponse(
                200,
                """{"status":"error","errorData":{"code":"DEVICE_UNAUTHORIZED","message":"rejected"}}""",
            ),
        )
        settle()

        assertEquals(1, application.credentialRemovalCalls)
        assertFalse(application.hasTodoWriteCredential())
        compose.onNodeWithText("Task not added: the paired-device credential is missing or was rejected")
            .fetchSemanticsNode()
        compose.onNodeWithText(application.getString(R.string.tasks_save)).assertIsNotEnabled()
        compose.onNodeWithText(application.getString(R.string.tasks_cancel)).performClick()
        settle()
        compose.onNodeWithText(application.getString(R.string.todo_write_access_title))
            .fetchSemanticsNode()
        compose.onNodeWithText(application.getString(R.string.tasks_add)).assertIsNotEnabled()
        compose.onNodeWithContentDescription(markCompleteDescription(todo.title))
            .assertIsNotEnabled()
    }

    @Test
    fun `structured unauthorized edit keeps its draft while clearing the credential`() {
        val changedTitle = "Keep title through credential recovery"
        openEditorWithTitle(changedTitle)

        application.poster.answer(
            HttpTextResponse(
                200,
                """{"status":"error","errorData":{"code":"DEVICE_UNAUTHORIZED","message":"rejected"}}""",
            ),
        )
        settle()

        assertEquals(1, application.credentialRemovalCalls)
        assertFalse(application.hasTodoWriteCredential())
        assertEquals(0, refreshCount)
        compose.onNodeWithText("Change not saved: the paired-device credential is missing or was rejected")
            .fetchSemanticsNode()
        compose.onNodeWithText(changedTitle).assertIsEnabled()
        compose.onNodeWithText(application.getString(R.string.todo_save)).assertIsNotEnabled()
        compose.onNodeWithText(application.getString(R.string.todo_cancel)).assertIsEnabled()
        compose.onNodeWithContentDescription(markCompleteDescription(todo.title))
            .assertIsNotEnabled()
        compose.onNodeWithText(application.getString(R.string.todo_write_access_title))
            .fetchSemanticsNode()
    }

    private fun assertTaskActions(title: String) {
        compose.onNodeWithContentDescription(editDescription(title))
            .performScrollTo()
            .fetchSemanticsNode()
        compose.onNodeWithContentDescription(markCompleteDescription(title))
            .performScrollTo()
            .fetchSemanticsNode()
        compose.onNodeWithContentDescription(
            application.getString(R.string.todo_remove_flag_named, title),
        ).performScrollTo().fetchSemanticsNode()
        compose.onNodeWithContentDescription(
            application.getString(R.string.todo_delete_named, title),
        ).performScrollTo().fetchSemanticsNode()
    }

    private fun openGroup(name: String) {
        compose.onNodeWithContentDescription(
            application.getString(R.string.tasks_open_group, name),
        ).performScrollTo().performClick()
        settle()
    }

    private fun backToHub() {
        compose.onNodeWithText(allLists).performScrollTo().performClick()
        settle()
    }

    private fun deleteTodo(title: String) {
        compose.onNodeWithContentDescription(
            application.getString(R.string.todo_delete_named, title),
        ).performScrollTo().performClick()
        settle()
    }

    private fun openEditorWithTitle(title: String) {
        compose.onNodeWithContentDescription(editDescription(todo.title))
            .performScrollTo()
            .performClick()
        settle()
        compose.onNodeWithText(application.getString(R.string.todo_title))
            .performTextReplacement(title)
        compose.onNode(hasText(application.getString(R.string.todo_save)) and hasClickAction())
            .performClick()
        settle()
        assertEquals(1, application.poster.requestCount)
    }

    private fun editDescription(title: String): String =
        application.getString(R.string.todo_edit_named, title)

    private fun markCompleteDescription(title: String): String =
        application.getString(R.string.todo_mark_complete_named, title)

    private fun nodesWithText(text: String): Int =
        compose.onAllNodesWithText(text).fetchSemanticsNodes().size

    private fun showTasks(tasks: List<TodoItem> = listOf(todo)) {
        displayedTasks = tasks
        val now = Instant.parse("2026-07-30T12:00:00Z").toEpochMilli()
        val base = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        compose.runOnUiThread {
            activityController.get().setContent {
                val currentTasks = displayedTasks
                val state = VaultUiState(
                    activeProfile = FamilyMember.VICTOR,
                    destination = Destination.TASKS,
                    data = base.copy(
                        todos = base.todos.copy(status = Freshness.LIVE, value = currentTasks),
                    ),
                    now = now,
                )
                VogelVaultTheme {
                    LazyColumn(Modifier.fillMaxSize()) {
                        item {
                            TaskListsScreen(
                                state = state,
                                todos = currentTasks,
                                onWriteSucceeded = { refreshCount++ },
                                zoneId = ZoneOffset.UTC,
                                nowMillis = { screenNowMillis },
                            )
                        }
                    }
                }
            }
        }
        settle()
    }

    private fun publishTasks(tasks: List<TodoItem>) {
        compose.runOnUiThread { displayedTasks = tasks }
        settle()
    }

    private fun settle() {
        repeat(3) {
            shadowOf(Looper.getMainLooper()).idle()
            compose.waitForIdle()
        }
    }

    private fun success(value: String): HttpTextResponse {
        val body = checkNotNull(application.poster.lastBody)
        val id = Regex("\\\"(?:entityId|id)\\\":\\\"([^\\\"]+)\\\"")
            .find(body)?.groupValues?.get(1) ?: error("request had no todo id")
        val result = when (value) {
            "deleted" -> """{"ok":true,"entityId":"$id","removed":true}"""
            "restored" -> """{"ok":true,"entityId":"$id","updatedAtMs":1800000000001}"""
            else -> """{"ok":true,"entityId":"$id","outcome":"updated"}"""
        }
        return HttpTextResponse(200, """{"status":"success","value":$result}""")
    }
}

class TaskListsCrudPoster : HttpPoster {
    private val answers = Channel<HttpTextResponse>(Channel.UNLIMITED)

    @Volatile
    var requestCount = 0
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
            // Robolectric can retain the Application between test methods.
        }
    }
}

class TaskListsCrudApplication : VaultApplication() {
    val poster = TaskListsCrudPoster()
    private var credentialPresent = true

    var credentialRemovalCalls = 0
        private set

    override fun hasTodoWriteCredential(): Boolean = credentialPresent

    override fun removeTodoWriteCredential(): Result<Unit> {
        credentialRemovalCalls += 1
        credentialPresent = false
        return Result.success(Unit)
    }

    fun resetCredential() {
        credentialPresent = true
        credentialRemovalCalls = 0
    }

    override val todoMutationGateway: TodoMutationGateway by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        TodoMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(
                    ConvexConfig(deploymentUrl = "https://task-lists-test.convex.cloud"),
                ),
                credentialSource = ConvexDeviceCredentialSource {
                    ConvexDeviceCredential("test-device", "t".repeat(43))
                },
                http = poster,
            ),
        )
    }
}
