package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
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
                    TodoScreen(
                        state = VaultUiState(
                            activeProfile = FamilyMember.VICTOR,
                            destination = Destination.TASKS,
                            data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE),
                        ),
                        onWriteSucceeded = { refreshes++ },
                    )
                }
            }
        }
        settle()
    }

    @After fun tearDown() { controller.pause().stop().destroy() }

    @Test fun `failed create retains draft and permits retry`() {
        submit()
        answer(HttpTextResponse(500, "failed"))
        field().assertTextEquals("Retain failed task")
        compose.onNodeWithText("Task not added (http 500)").assertExists()
        // Invoke the enabled control directly while the snackbar overlays the small test window.
        add().assertIsEnabled().performSemanticsAction(SemanticsActions.OnClick) { it() }
        settle()
        assertEquals(2, application.poster.requestCount)
        assertEquals(0, refreshes)
    }

    @Test fun `failed create preserves edits made while pending`() {
        submit()
        field().performTextReplacement("Next task")
        answer(HttpTextResponse(500, "failed"))
        field().assertTextEquals("Next task")
        add().assertIsEnabled()
        assertEquals(0, refreshes)
    }

    @Test fun `server refusal retains draft`() {
        submit()
        answer(HttpTextResponse(200, """{"status":"error","errorMessage":"refused"}"""))
        field().assertTextEquals("Retain failed task")
        add().assertIsEnabled()
        assertEquals(0, refreshes)
    }

    @Test fun `accepted create clears unchanged draft only after response`() {
        submit()
        field().assertTextEquals("Retain failed task")
        succeed()
        field().assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        add().assertIsNotEnabled()
        assertEquals(1, refreshes)
    }

    @Test fun `pending create blocks duplicate taps but preserves later typing`() {
        submit()
        field().performTextReplacement("Next task")
        add().assertIsNotEnabled().performClick()
        assertEquals(1, application.poster.requestCount)
        succeed()
        field().assertTextEquals("Next task")
        add().assertIsEnabled()
        assertEquals(1, application.poster.requestCount)
    }

    @Test fun `editing away and back while pending remains a new draft`() {
        submit()
        field().performTextReplacement("Replacement")
        field().performTextReplacement("Retain failed task")
        succeed()
        field().assertTextEquals("Retain failed task")
        add().assertIsEnabled()
    }

    private fun submit() {
        field().performTextInput("Retain failed task")
        add().performClick()
        settle()
        assertEquals(1, application.poster.requestCount)
    }
    private fun field() = compose.onNode(hasSetTextAction())
    private fun add() = compose.onNodeWithContentDescription("Add task")
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
