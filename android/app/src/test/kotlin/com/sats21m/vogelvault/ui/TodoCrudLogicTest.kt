package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonPrimitive

class TodoCrudLogicTest {
    private val now = Instant.parse("2026-07-29T16:00:00Z")

    @Test
    fun `children see only their own due todos while adults see the household`() {
        val todos = FamilyMember.entries.map { owner ->
            todo(id = owner.key, owner = owner)
        }

        assertEquals(listOf("mason"), todosForToday(todos, FamilyMember.MASON, "2026-07-29").map { it.id })
        assertEquals(listOf("maddox"), todosForToday(todos, FamilyMember.MADDOX, "2026-07-29").map { it.id })
        assertEquals(
            FamilyMember.entries.map { it.key }.sorted(),
            todosForToday(todos, FamilyMember.RACHEL, "2026-07-29").map { it.id }.sorted(),
        )
    }

    @Test
    fun `new child todo keeps that child as canonical owner`() {
        val created = newTodo(
            title = "  Stack sats  ",
            owner = FamilyMember.MASON,
            today = "2026-07-29",
            now = now,
            id = "android-test",
        )

        assertEquals("Stack sats", created.title)
        assertEquals(FamilyMember.MASON, created.owner)
        assertEquals("mason", created.toMutationJson()["owner"]?.jsonPrimitive?.content)
    }

    @Test
    fun `toggle and edit payloads preserve every production metadata field`() {
        val original = todo(
            notes = "Do not lose me",
            priority = 3L,
            lane = "personal",
            createdAt = "2026-07-01T00:00:00Z",
        )

        val changed = original.withFlag(true, now).withTitle("Renamed", now).withCompletion(true, now)
        val json = changed.toMutationJson()

        assertEquals("Do not lose me", json["notes"]?.jsonPrimitive?.content)
        assertEquals("3", json["priority"]?.jsonPrimitive?.content)
        assertEquals("personal", json["category"]?.jsonPrimitive?.content)
        assertEquals("2026-07-01T00:00:00Z", json["createdAt"]?.jsonPrimitive?.content)
        assertEquals("completed", json["status"]?.jsonPrimitive?.content)
        assertEquals("Renamed", json["title"]?.jsonPrimitive?.content)
    }

    @Test
    fun `delete undo expires at exactly the Apple six second boundary`() {
        val pending = PendingTodoDeletion(todo(), expiresAtMillis = 7_000L)

        assertTrue(pending.canUndo(6_999L))
        assertFalse(pending.canUndo(7_000L))
        assertEquals(6_000L, TODO_UNDO_WINDOW_MILLIS)
    }

    private fun todo(
        id: String = "todo-1",
        owner: FamilyMember = FamilyMember.VICTOR,
        notes: String? = null,
        priority: Long? = null,
        lane: String? = null,
        createdAt: String? = null,
    ) = TodoItem(
        id = id,
        title = id,
        due = "2026-07-29",
        owner = owner,
        notes = notes,
        priority = priority,
        lane = lane,
        createdAt = createdAt,
    )
}
