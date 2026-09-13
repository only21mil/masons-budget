package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TodoRowSwipeTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val controller = Robolectric.buildActivity(ComponentActivity::class.java)
    @Before fun start() { controller.get().setTheme(R.style.Theme_VogelVault); controller.setup() }
    @After fun stop() { controller.pause().stop().destroy() }

    @Test fun swipesInvokeTheExistingFlagAndDeleteActions() {
        val flags = mutableListOf<Boolean>()
        var deleted = 0
        val todo = newTodo("Pay bill", FamilyMember.VICTOR, "2026-09-13", java.time.Instant.parse("2026-09-13T12:00:00Z"), "swipe-test")
        var record by mutableStateOf(todo)
        controller.get().setContent { VogelVaultTheme {
            val snapshot = record
            TodoRow(snapshot, FamilyMember.VICTOR, enabled = true,
                onToggleDone = {}, onToggleFlag = {
                    record = snapshot.withFlag(!snapshot.flagged, java.time.Instant.now())
                    flags += record.flagged
                }, onEdit = {}, onDelete = { deleted++ })
        } }
        val row = compose.onNodeWithContentDescription(controller.get().getString(R.string.todo_edit_named, todo.title))
        row.performTouchInput { swipeRight() }
        compose.waitForIdle()
        assertEquals(listOf(true), flags)
        assertEquals(0, deleted)
        row.performTouchInput { swipeRight() }
        compose.waitForIdle()
        assertEquals(listOf(true, false), flags)
        row.performTouchInput { swipeLeft() }
        compose.waitForIdle()
        assertEquals(1, deleted)
        // The source row stays until the existing write owner accepts and removes it.
        row.assertExists()
    }
}
