package com.sats21m.vogelvault

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.TaskListModel
import com.sats21m.vogelvault.ui.TaskSmartList
import com.sats21m.vogelvault.ui.tasksFor
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TaskListLogicTest {
    private val today = LocalDate.parse("2026-07-29")

    private val todos = listOf(
        todo("adult-inbox", "Unfiled adult", owner = FamilyMember.VICTOR, project = "Inbox"),
        todo("rachel-overdue", "Overdue", owner = FamilyMember.RACHEL, due = "2026-07-28"),
        todo("mason-today", "Mason today", owner = FamilyMember.MASON, due = "2026-07-29"),
        todo("maddox-upcoming", "Maddox upcoming", owner = FamilyMember.MADDOX, due = "2026-07-31"),
        todo("adult-week-edge", "Week edge", owner = FamilyMember.VICTOR, due = "2026-08-05"),
        todo("adult-later", "Later", owner = FamilyMember.VICTOR, due = "2026-08-06"),
        todo("adult-someday", "Someday", owner = FamilyMember.VICTOR),
        todo("adult-flag", "Flagged", owner = FamilyMember.VICTOR, flagged = true),
        todo("done-flag", "Done flagged", owner = FamilyMember.VICTOR, flagged = true, done = true),
        todo("victor-trip", "Victor trip", owner = FamilyMember.VICTOR, project = "Trip"),
        todo("rachel-trip", "Rachel trip", owner = FamilyMember.RACHEL, project = "Trip"),
        todo("mason-trip", "Mason trip", owner = FamilyMember.MASON, project = "Trip"),
        todo("home-area", "Home area", owner = FamilyMember.RACHEL, area = " Home "),
    )

    @Test
    fun `every smart list uses exact active-profile ownership`() {
        val rachel = TaskListModel.build(todos, FamilyMember.RACHEL, today)
        assertEquals(
            setOf("rachel-overdue", "rachel-trip", "home-area"),
            rachel.visibleTasks.map { it.id }.toSet(),
        )
        assertFalse(rachel.visibleTasks.any { it.id == "adult-inbox" })
        assertFalse(rachel.visibleTasks.any { it.id == "mason-today" })

        val mason = TaskListModel.build(todos, FamilyMember.MASON, today)
        assertEquals(setOf("mason-today", "mason-trip"), mason.visibleTasks.map { it.id }.toSet())
        assertFalse(mason.visibleTasks.any { it.owner.isAdult })
    }

    @Test
    fun `smart lists match Apple date flag and canonical Inbox rules`() {
        val model = TaskListModel.build(todos, FamilyMember.VICTOR, today)

        assertEquals(
            setOf(
                "adult-inbox",
                "adult-week-edge",
                "adult-later",
                "adult-someday",
                "adult-flag",
            ),
            model.tasksFor(TaskSmartList.INBOX).map { it.id }.toSet(),
        )
        assertEquals(
            emptySet(),
            model.tasksFor(TaskSmartList.TODAY).map { it.id }.toSet(),
        )
        assertEquals(
            setOf("adult-week-edge", "adult-later"),
            model.tasksFor(TaskSmartList.UPCOMING).map { it.id }.toSet(),
        )
        assertEquals(listOf("adult-flag"), model.tasksFor(TaskSmartList.FLAGGED).map { it.id })
    }

    @Test
    fun `hub time buckets do not overlap and the seven day boundary is this week`() {
        val model = TaskListModel.build(todos, FamilyMember.VICTOR, today)

        assertEquals(emptySet(), model.today.map { it.id }.toSet())
        assertEquals(setOf("adult-week-edge"), model.thisWeek.map { it.id }.toSet())
        assertEquals(
            setOf(
                "adult-inbox",
                "adult-later",
                "adult-someday",
                "adult-flag",
                "victor-trip",
            ),
            model.longTerm.map { it.id }.toSet(),
        )
    }

    @Test
    fun `project and area groups are normalized stable and owner scoped`() {
        val model = TaskListModel.build(todos, FamilyMember.VICTOR, today)

        assertFalse(model.projects.any { it.name.equals("Inbox", ignoreCase = true) })
        assertEquals(
            listOf("victor|Trip"),
            model.projects.map { it.key },
        )
        assertEquals(emptyList(), model.areas.map { it.key })
        assertTrue(model.projects.all { it.openCount == 1 })

        val rachel = TaskListModel.build(todos, FamilyMember.RACHEL, today)
        assertEquals(listOf("rachel|Trip"), rachel.projects.map { it.key })
        assertEquals(listOf("rachel|Home"), rachel.areas.map { it.key })
    }

    private fun todo(
        id: String,
        title: String,
        owner: FamilyMember,
        done: Boolean = false,
        project: String? = null,
        area: String? = null,
        due: String? = null,
        flagged: Boolean = false,
    ) = TodoItem(
        id = id,
        title = title,
        done = done,
        project = project,
        area = area,
        due = due,
        flagged = flagged,
        owner = owner,
    )
}
