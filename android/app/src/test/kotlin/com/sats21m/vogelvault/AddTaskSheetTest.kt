package com.sats21m.vogelvault

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.AddTaskDraft
import com.sats21m.vogelvault.ui.prepareTask
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
        ).getOrThrow()

        assertEquals("android-task-1", task["id"]?.jsonPrimitive?.content)
        assertEquals("Book dentist", task["title"]?.jsonPrimitive?.content)
        assertEquals("mason", task["owner"]?.jsonPrimitive?.content)
        assertEquals("Health", task["project"]?.jsonPrimitive?.content)
        assertEquals("Family", task["area"]?.jsonPrimitive?.content)
        assertEquals("2026-08-03", task["dueDate"]?.jsonPrimitive?.content)
        assertTrue(task["flagged"]?.jsonPrimitive?.content?.toBooleanStrict() == true)
        assertFalse(task["done"]?.jsonPrimitive?.content?.toBooleanStrict() == true)
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

        assertEquals("maddox", task["owner"]?.jsonPrimitive?.content)
        assertFalse("project" in task)
        assertFalse("area" in task)
        assertFalse("dueDate" in task)
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
