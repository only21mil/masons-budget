package com.sats21m.vogelvault

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.AddTaskDraft
import com.sats21m.vogelvault.ui.prepareTask
import com.sats21m.vogelvault.ui.toMutationJson
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonPrimitive

class AddTaskSheetTest {
    @Test
    fun `prepared task keeps canonical owner and all supplied fields`() {
        val task = prepareTask(
            AddTaskDraft(
                title = "  Book dentist  ",
                project = "Health",
                area = "Family",
                due = "2026-08-03",
                flagged = true,
                owner = FamilyMember.MASON,
            ),
            id = "android-task-1",
            now = Instant.parse("2026-07-31T12:00:00Z"),
        ).getOrThrow()
        val payload = task.toMutationJson()

        assertEquals("android-task-1", task.id)
        assertEquals("Book dentist", task.title)
        assertEquals(FamilyMember.MASON, task.owner)
        assertEquals("Health", task.project)
        assertEquals("Family", task.area)
        assertEquals("2026-08-03", task.due)
        assertTrue(task.flagged)
        assertFalse(task.done)
        assertEquals("Book dentist", payload["text"]?.jsonPrimitive?.content)
        assertEquals("2026-08-03", payload["due_date"]?.jsonPrimitive?.content)
        assertEquals("android-app", payload["sync_source"]?.jsonPrimitive?.content)
    }

    @Test
    fun `prepared task canonicalizes device timestamps to fixed milliseconds`() {
        val task = prepareTask(
            AddTaskDraft("Pay bill", "", "", "", false, FamilyMember.VICTOR),
            id = "android-task-precision",
            now = Instant.parse("2026-08-01T12:03:02.123456789Z"),
        ).getOrThrow()

        assertEquals("2026-08-01T12:03:02.123Z", task.createdAt)
        assertEquals("2026-08-01T12:03:02.123Z", task.updatedAt)
    }

    @Test
    fun `optional filing fields are omitted instead of inventing adult data`() {
        val task = prepareTask(
            AddTaskDraft(
                title = "Homework",
                project = " ",
                area = "",
                due = "",
                flagged = false,
                owner = FamilyMember.MADDOX,
            ),
            id = "android-task-2",
        ).getOrThrow()

        assertEquals(FamilyMember.MADDOX, task.owner)
        assertEquals(null, task.project)
        assertEquals(null, task.area)
        assertEquals(null, task.due)
    }

    @Test
    fun `invalid title and date are rejected before mutation`() {
        val invalidTitle = prepareTask(
            AddTaskDraft("", "", "", "", false, FamilyMember.VICTOR),
        )
        val invalidDate = prepareTask(
            AddTaskDraft("Pay bill", "", "", "08/03/2026", false, FamilyMember.VICTOR),
        )

        assertTrue(invalidTitle.isFailure)
        assertEquals("Enter a task title", invalidTitle.exceptionOrNull()?.message)
        assertTrue(invalidDate.isFailure)
        assertEquals("Enter the due date as YYYY-MM-DD", invalidDate.exceptionOrNull()?.message)
    }
}
