package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.todosFor
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID

internal const val TODO_UNDO_WINDOW_MILLIS = 6_000L

private val todoTimestampFormatter =
    DateTimeFormatterBuilder().appendInstant(3).toFormatter()

internal fun Instant.toTodoTimestamp(): String = todoTimestampFormatter.format(this)

internal data class PendingTodoDeletion(
    val operationToken: String,
    val todo: TodoItem,
    val expiresAtMillis: Long,
) {
    fun canUndo(nowMillis: Long): Boolean = nowMillis < expiresAtMillis
}

internal fun List<TodoItem>.filterActiveTodoTombstone(todoId: String?): List<TodoItem> =
    if (todoId == null) this else filterNot { it.id == todoId }

internal fun newestTodo(captured: TodoItem, authoritative: TodoItem?): TodoItem =
    authoritative?.takeIf { it.updatedAtMs >= captured.updatedAtMs } ?: captured

/**
 * One order for the list, shared by the initial read and every optimistic edit.
 *
 * Two comparators would let a row jump position purely because it was the one
 * just touched, which reads as data loss.
 */
internal val TODO_ORDER: Comparator<TodoItem> =
    compareBy<TodoItem> { it.done }.thenByDescending { it.flagged }.thenBy { it.title }

/**
 * Everything due today or earlier, completed included.
 *
 * Deliberately wider than [todosDueToday], which the read-only surfaces use:
 * this screen has to show a completed task so it can be reopened.
 */
internal fun todosForToday(
    todos: List<TodoItem>,
    viewer: FamilyMember,
    today: String,
): List<TodoItem> =
    todos.todosFor(viewer)
        .filter { todo -> todo.due?.let { it <= today } == true }
        .sortedWith(TODO_ORDER)

internal fun newTodo(
    title: String,
    owner: FamilyMember,
    today: String,
    now: Instant,
    id: String = UUID.randomUUID().toString(),
): TodoItem {
    val trimmed = title.trim()
    require(trimmed.isNotEmpty()) { "todo title must not be blank" }
    val stamp = now.toTodoTimestamp()
    return TodoItem(
        id = id,
        title = trimmed,
        due = today,
        owner = owner,
        lane = "sats",
        priority = 0L,
        createdAt = stamp,
        updatedAt = stamp,
        updatedAtMs = now.toEpochMilli(),
    )
}

internal fun TodoItem.withCompletion(done: Boolean, now: Instant): TodoItem =
    copy(
        done = done,
        completedAt = if (done) now.toTodoTimestamp() else null,
        updatedAt = now.toTodoTimestamp(),
        updatedAtMs = now.toEpochMilli(),
    )

internal fun TodoItem.withFlag(flagged: Boolean, now: Instant): TodoItem =
    copy(
        flagged = flagged,
        updatedAt = now.toTodoTimestamp(),
        updatedAtMs = now.toEpochMilli(),
    )

internal fun TodoItem.withTitle(title: String, now: Instant): TodoItem {
    val trimmed = title.trim()
    require(trimmed.isNotEmpty()) { "todo title must not be blank" }
    return copy(
        title = trimmed,
        updatedAt = now.toTodoTimestamp(),
        updatedAtMs = now.toEpochMilli(),
    )
}
