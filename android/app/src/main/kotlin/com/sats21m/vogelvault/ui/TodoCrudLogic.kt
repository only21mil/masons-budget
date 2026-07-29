package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.visibleTo
import java.time.Instant
import java.util.UUID

internal const val TODO_UNDO_WINDOW_MILLIS = 6_000L

internal data class PendingTodoDeletion(
    val todo: TodoItem,
    val expiresAtMillis: Long,
) {
    fun canUndo(nowMillis: Long): Boolean = nowMillis < expiresAtMillis
}

internal fun todosForToday(
    todos: List<TodoItem>,
    viewer: FamilyMember,
    today: String,
): List<TodoItem> =
    todos.visibleTo(viewer)
        .filter { todo -> todo.due?.let { it <= today } == true }
        .sortedWith(compareBy<TodoItem> { it.done }.thenByDescending { it.flagged }.thenBy { it.title })

internal fun newTodo(
    title: String,
    owner: FamilyMember,
    today: String,
    now: Instant,
    id: String = UUID.randomUUID().toString(),
): TodoItem {
    val trimmed = title.trim()
    require(trimmed.isNotEmpty()) { "todo title must not be blank" }
    val stamp = now.toString()
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
        completedAt = if (done) now.toString() else null,
        updatedAt = now.toString(),
        updatedAtMs = now.toEpochMilli(),
    )

internal fun TodoItem.withFlag(flagged: Boolean, now: Instant): TodoItem =
    copy(flagged = flagged, updatedAt = now.toString(), updatedAtMs = now.toEpochMilli())

internal fun TodoItem.withTitle(title: String, now: Instant): TodoItem {
    val trimmed = title.trim()
    require(trimmed.isNotEmpty()) { "todo title must not be blank" }
    return copy(title = trimmed, updatedAt = now.toString(), updatedAtMs = now.toEpochMilli())
}
