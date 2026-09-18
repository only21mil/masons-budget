package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.assertEquals
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
@Config(sdk = [34], application = GatedTodoWriteApplication::class)
class TodoQuickTaskDraftTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var controller: ActivityController<ComponentActivity>
    private lateinit var application: GatedTodoWriteApplication
    private var refreshes = 0

    @Before fun setUp() {
        application = RuntimeEnvironment.getApplication() as GatedTodoWriteApplication
        application.poster.reset()
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        compose.runOnUiThread {
            controller.get().setContent {
                VogelVaultTheme {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        TaskListsScreen(
                            state = VaultUiState(
                                activeProfile = FamilyMember.VICTOR,
                                destination = Destination.TASKS,
                                data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE),
                            ),
                            todos = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE).todos.value,
                            onWriteSucceeded = { refreshes++ },
                        )
                    }
                }
            }
        }
        settle()
        compose.onNodeWithText("Add task").performScrollTo().performClick()
        settle()
    }

    @After fun tearDown() { controller.pause().stop().destroy() }

    @Test fun `failed create retains draft and permits retry`() {
        submit()
        answer(HttpTextResponse(500, "failed"))
        field().assertTextEquals("Task title", "Retain failed task")
        compose.onNodeWithText("Task not added (http 500)").assertExists()
        // Match the sheet tests: invoke the enabled control through its semantics.
        add().assertIsEnabled().performSemanticsAction(SemanticsActions.OnClick) { it() }
        settle()
        assertEquals(2, application.poster.requestCount)
        assertEquals(0, refreshes)
    }

    @Test fun `failed create preserves edits made while pending`() {
        submit()
        field().performTextReplacement("Next task")
        answer(HttpTextResponse(500, "failed"))
        field().assertTextEquals("Task title", "Next task")
        add().assertIsEnabled()
        assertEquals(0, refreshes)
    }

    @Test fun `server refusal retains draft`() {
        submit()
        answer(HttpTextResponse(200, """{"status":"error","errorMessage":"refused"}"""))
        field().assertTextEquals("Task title", "Retain failed task")
        add().assertIsEnabled()
        assertEquals(0, refreshes)
    }

    @Test fun `accepted create dismisses the Tasks sheet only after response`() {
        submit()
        field().assertTextEquals("Task title", "Retain failed task")
        succeed()
        field().assertDoesNotExist()
        add().assertDoesNotExist()
        assertEquals(1, refreshes)
    }

    @Test fun `pending create blocks duplicate taps while the title remains editable`() {
        submit()
        field().performTextReplacement("Next task")
        compose.onNodeWithText("Saving…").assertIsNotEnabled().performClick()
        assertEquals(1, application.poster.requestCount)
        succeed()
        field().assertDoesNotExist()
        assertEquals(1, refreshes)
        assertEquals(1, application.poster.requestCount)
    }

    private fun submit() {
        field().performTextInput("Retain failed task")
        add().performSemanticsAction(SemanticsActions.OnClick) { it() }
        settle()
        assertEquals(1, application.poster.requestCount)
    }
    private fun field() = compose.onNode(hasSetTextAction() and hasText("Task title"))
    private fun add() = compose.onNode(hasText("Save task") and hasClickAction())
    private fun answer(response: HttpTextResponse) {
        application.poster.answer(response)
        settle()
    }
    private fun succeed() {
        val body = Json.parseToJsonElement(application.poster.lastBody!!).jsonObject
        val id = body.getValue("args").jsonObject.getValue("todo").jsonObject.getValue("id").jsonPrimitive.content
        answer(HttpTextResponse(200, """{"status":"success","value":{"ok":true,"entityId":"$id","outcome":"inserted"}}"""))
    }
    private fun settle() {
        shadowOf(Looper.getMainLooper()).idle()
        compose.waitForIdle()
    }
}
