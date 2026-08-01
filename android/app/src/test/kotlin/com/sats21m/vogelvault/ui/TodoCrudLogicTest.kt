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
    fun `device edits canonicalize timestamps to fixed milliseconds`() {
        val precise = Instant.parse("2026-08-01T12:03:02.123456789Z")
        val changed =
            todo()
                .withCompletion(true, precise)
                .withFlag(true, precise)
                .withTitle("Renamed", precise)

        assertEquals("2026-08-01T12:03:02.123Z", changed.completedAt)
        assertEquals("2026-08-01T12:03:02.123Z", changed.updatedAt)
        assertEquals(
            "2026-08-01T12:03:02.000Z",
            Instant.parse("2026-08-01T12:03:02Z").toTodoTimestamp(),
        )
    }

    @Test
    fun `one order serves the list, every edit and the undo restore`() {
        val open = todo(id = "b-open")
        val flagged = todo(id = "a-flagged").withFlag(true, now)
        val done = todo(id = "c-done").withCompletion(true, now)
        val shuffled = listOf(done, open, flagged)

        assertEquals(
            listOf("a-flagged", "b-open", "c-done"),
            shuffled.sortedWith(TODO_ORDER).map { it.id },
        )
        // The screen re-sorts an edited or restored row with this same comparator,
        // so nothing jumps position purely because it was the row just touched.
        assertEquals(
            todosForToday(shuffled, FamilyMember.VICTOR, "2026-07-29").map { it.id },
            shuffled.sortedWith(TODO_ORDER).map { it.id },
        )
    }

    @Test
    fun `delete undo expires at exactly the Apple six second boundary`() {
        val pending = PendingTodoDeletion("operation-1", todo(), expiresAtMillis = 7_000L)

        assertTrue(pending.canUndo(6_999L))
        assertFalse(pending.canUndo(7_000L))
        assertEquals(6_000L, TODO_UNDO_WINDOW_MILLIS)
    }

    @Test
    fun `active local tombstone filters refreshed upstream row`() {
        val deleted = todo().copy(id = "deleted", updatedAtMs = 10)
        val visible = todo().copy(id = "visible", updatedAtMs = 20)

        assertEquals(listOf(visible), listOf(deleted, visible).filterActiveTodoTombstone("deleted"))
        assertEquals(listOf(deleted, visible), listOf(deleted, visible).filterActiveTodoTombstone(null))
    }

    @Test
    fun `failed delete never restores captured stale row over newer authority`() {
        val captured = todo().copy(title = "captured", updatedAtMs = 10)
        val newer = captured.copy(title = "newer", updatedAtMs = 11)
        val older = captured.copy(title = "older", updatedAtMs = 9)

        assertEquals(newer, newestTodo(captured, newer))
        assertEquals(captured, newestTodo(captured, older))
        assertEquals(captured, newestTodo(captured, null))
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
