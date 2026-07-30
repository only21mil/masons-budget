package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.isDueBy
import com.sats21m.vogelvault.domain.visibleTo
import java.time.LocalDate

/**
 * Task organization derived from the normalized todo domain model.
 *
 * The domain boundary deliberately turns wire-shape aliases into [TodoItem]
 * before this code runs. In particular, the canonical project value "Inbox"
 * means "not filed"; it must never become a user-created project group.
 */
internal enum class TaskSmartList {
    INBOX,
    TODAY,
    UPCOMING,
    FLAGGED,
}

internal data class TaskGroup(
    val owner: FamilyMember,
    val name: String,
    val openCount: Int,
    val tasks: List<TodoItem>,
) {
    val key: String = "${owner.key}|$name"
}

internal data class TaskListModel(
    val visibleTasks: List<TodoItem>,
    val smartLists: Map<TaskSmartList, List<TodoItem>>,
    val today: List<TodoItem>,
    val thisWeek: List<TodoItem>,
    val longTerm: List<TodoItem>,
    val projects: List<TaskGroup>,
    val areas: List<TaskGroup>,
) {
    companion object {
        fun build(
            todos: List<TodoItem>,
            viewer: FamilyMember,
            today: LocalDate,
        ): TaskListModel {
            // ScreenHost filters before TaskListsScreen receives rows. Keep this
            // second check deliberately: direct model callers must not become a
            // route around the family visibility contract.
            val visible = todos.visibleTo(viewer)
            val open = visible.filterNot(TodoItem::done)
            val weekFromToday = today.plusDays(7)

            val inbox = open.filter { it.normalizedProject() == null && it.normalizedArea() == null }
            val dueToday = open.filter { it.isDueBy(today.toString()) }
            val upcoming = open.filter { task ->
                task.dueDate()?.isAfter(today) == true
            }
            val flagged = open.filter(TodoItem::flagged)

            return TaskListModel(
                visibleTasks = visible,
                smartLists = mapOf(
                    TaskSmartList.INBOX to inbox.sortedForDisplay(),
                    TaskSmartList.TODAY to dueToday.sortedForDisplay(),
                    TaskSmartList.UPCOMING to upcoming.sortedForDisplay(),
                    TaskSmartList.FLAGGED to flagged.sortedForDisplay(),
                ),
                today = dueToday.sortedForDisplay(),
                thisWeek = open.filter { task ->
                    task.dueDate()?.let { it.isAfter(today) && !it.isAfter(weekFromToday) } == true
                }.sortedForDisplay(),
                longTerm = open.filter { task ->
                    task.dueDate()?.let { it.isAfter(weekFromToday) } ?: true
                }.sortedForDisplay(),
                projects = visible.groupsByOwnerAndName(TodoItem::normalizedProject),
                areas = visible.groupsByOwnerAndName(TodoItem::normalizedArea),
            )
        }
    }
}

internal fun TaskListModel.tasksFor(
    smartList: TaskSmartList,
): List<TodoItem> = smartLists[smartList].orEmpty()

private const val UNFILED_PROJECT = "Inbox"

private fun TodoItem.normalizedProject(): String? =
    project.normalizedName()?.takeUnless { it.equals(UNFILED_PROJECT, ignoreCase = true) }

private fun TodoItem.normalizedArea(): String? = area.normalizedName()

private fun String?.normalizedName(): String? = this?.trim()?.takeIf(String::isNotEmpty)

private fun TodoItem.dueDate(): LocalDate? =
    due?.let { runCatching { LocalDate.parse(it) }.getOrNull() }

private fun List<TodoItem>.groupsByOwnerAndName(
    nameOf: (TodoItem) -> String?,
): List<TaskGroup> =
    mapNotNull { task -> nameOf(task)?.let { name -> (task.owner to name) to task } }
        .groupBy(keySelector = { it.first }, valueTransform = { it.second })
        .map { (ownerAndName, tasks) ->
            TaskGroup(
                owner = ownerAndName.first,
                name = ownerAndName.second,
                openCount = tasks.count { !it.done },
                tasks = tasks.sortedWith(
                    compareBy<TodoItem> { it.done }
                        .thenBy { it.dueDate() ?: LocalDate.MAX }
                        .thenBy { it.title.lowercase() },
                ),
            )
        }
        .sortedWith(compareBy<TaskGroup> { it.name.lowercase() }.thenBy { it.owner.key })

private fun List<TodoItem>.sortedForDisplay(): List<TodoItem> =
    sortedWith(
        compareBy<TodoItem> { it.dueDate() ?: LocalDate.MAX }
            .thenByDescending(TodoItem::flagged)
            .thenBy { it.title.lowercase() },
    )
