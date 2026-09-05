package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Today
import androidx.compose.material.icons.filled.Upcoming
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.components.HorizontalHairline
import com.sats21m.vogelvault.ui.components.StateBlock
import com.sats21m.vogelvault.ui.components.ledgerRowReveal
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.rememberLedgerHaptics
import java.time.Instant
import java.time.ZoneId

private enum class TaskListRoute {
    HUB,
    SMART,
    PROJECT,
    AREA,
}

@Composable
internal fun TaskListsScreen(
    state: VaultUiState,
    todos: List<TodoItem>,
    onWriteSucceeded: () -> Unit,
    zoneId: ZoneId = ZoneId.systemDefault(),
    nowMillis: () -> Long = System::currentTimeMillis,
) {
    // Disposing this subtree on a profile change cancels in-flight UI work and
    // removes drafts/snackbars before another family member's Tasks screen draws.
    key(state.activeProfile) {
        ProfileTaskListsScreen(
            state = state,
            todos = todos,
            onWriteSucceeded = onWriteSucceeded,
            zoneId = zoneId,
            nowMillis = nowMillis,
        )
    }
}

@Composable
private fun ProfileTaskListsScreen(
    state: VaultUiState,
    todos: List<TodoItem>,
    onWriteSucceeded: () -> Unit,
    zoneId: ZoneId,
    nowMillis: () -> Long,
) {
    val colors = LocalLedgerTheme.current.colors
    // ScreenHost has already scoped this handoff to the active profile.
    // TaskListModel deliberately checks again as defense in depth because the
    // model is also callable outside this composable.
    val slice = state.data.todos
    if (slice.suppressFigures) {
        TaskPanel(stringResource(R.string.tasks_title)) {
            StateBlock(slice.status)
        }
        return
    }

    val date = remember(state.now, zoneId) {
        Instant.ofEpochMilli(state.now).atZone(zoneId).toLocalDate()
    }
    var localTodos by remember { mutableStateOf(todos) }
    val model = remember(localTodos, state.activeProfile, date) {
        TaskListModel.build(localTodos, state.activeProfile, date)
    }

    val context = LocalContext.current
    val application = context.applicationContext as? VaultApplication
    val gateway = remember(application) { application?.todoMutationGateway }
    var credentialStored by remember(application, state.activeProfile) {
        mutableStateOf(application?.hasTodoWriteCredential(state.activeProfile) == true)
    }
    val snackbar = remember { SnackbarHostState() }
    val haptics = rememberLedgerHaptics()
    val writes = rememberTodoWriteState(
        gateway = gateway,
        activeProfile = state.activeProfile,
        snackbar = snackbar,
        onWriteSucceeded = onWriteSucceeded,
        onCredentialRejected = {
            credentialStored = false
            application?.removeTodoWriteCredential()?.exceptionOrNull()?.let {
                credentialRemovalFailureMessage(it).resolve(context)
            }
        },
        nowMillis = nowMillis,
    )
    LaunchedEffect(todos, writes) {
        localTodos = writes.filterIncoming(todos)
    }

    var routeName by rememberSaveable(state.activeProfile) {
        mutableStateOf(TaskListRoute.HUB.name)
    }
    var selectedKind by rememberSaveable(state.activeProfile) {
        mutableStateOf(TaskSmartList.TODAY.name)
    }
    var selectedOwner by rememberSaveable(state.activeProfile) {
        mutableStateOf(state.activeProfile.key)
    }
    var selectedName by rememberSaveable(state.activeProfile) { mutableStateOf("") }
    var addingTask by rememberSaveable(state.activeProfile) { mutableStateOf(false) }
    var writeNotice by rememberSaveable(state.activeProfile) {
        mutableStateOf<String?>(null)
    }
    var editing by remember { mutableStateOf<TodoItem?>(null) }
    val route = TaskListRoute.entries.firstOrNull { it.name == routeName } ?: TaskListRoute.HUB
    val actions = TaskRowActions(
        enabled = { credentialStored && it.id !in writes.busyIds },
        deletePending = writes.deletePending,
        revealKey = slice.updatedAt,
        onToggleDone = { todo ->
            writes.upsert(todo.withCompletion(!todo.done, Instant.now()), todo.updatedAtMs) { changed ->
                localTodos = localTodos.replaceTodo(changed)
                haptics.toggle(changed.done)
            }
        },
        onToggleFlag = { todo ->
            writes.upsert(todo.withFlag(!todo.flagged, Instant.now()), todo.updatedAtMs) { changed ->
                localTodos = localTodos.replaceTodo(changed)
            }
        },
        onEdit = { editing = it },
        onDelete = { todo ->
            writes.delete(
                todo = todo,
                onRemoved = { removed ->
                    localTodos = localTodos.filterNot { row -> row.id == removed.id }
                },
                onRestored = { restored -> localTodos = localTodos.replaceTodo(restored) },
            )
        },
    )

    if (addingTask) {
        AddTaskSheet(
            owner = state.activeProfile,
            onDismiss = { addingTask = false },
            onSaved = { title ->
                writeNotice = "Task added: $title"
                addingTask = false
            },
            onWriteSucceeded = onWriteSucceeded,
            onCredentialRejected = {
                credentialStored = false
                application?.removeTodoWriteCredential()?.exceptionOrNull()?.let {
                    credentialRemovalFailureMessage(it).resolve(context)
                }
            },
        )
    }

    editing?.let { todo ->
        TodoEditDialog(
            todo = todo,
            writeEnabled = credentialStored,
            busy = todo.id in writes.busyIds,
            onDismiss = { editing = null },
            onSave = { changed ->
                writes.upsert(changed, todo.updatedAtMs) { accepted ->
                    localTodos = localTodos.replaceTodo(accepted)
                    haptics.confirm()
                    editing = null
                }
            },
        )
    }

    if (snackbar.currentSnackbarData != null) {
        // ScreenHost owns the scrolling container, so a flow-positioned snackbar
        // could be off-screen when a lower task is changed. The window popup keeps
        // accepted/rejected write feedback and Undo reachable at the viewport edge.
        Popup(
            alignment = Alignment.BottomCenter,
            properties = PopupProperties(focusable = false),
        ) {
            SnackbarHost(
                hostState = snackbar,
                modifier = Modifier.padding(VaultSpace.md),
            )
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(VaultSpace.md)) {
        VaultButton(
            label = stringResource(R.string.tasks_add),
            onClick = { addingTask = true },
            enabled = credentialStored,
        )
        if (!credentialStored) {
            TodoWriteReprovisionCard()
        }
        writeNotice?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = colors.bitcoin)
        }

        when (route) {
            TaskListRoute.HUB ->
                TaskHub(
                    model = model,
                    viewer = state.activeProfile,
                    actions = actions,
                    onSmartList = {
                        selectedKind = it.name
                        routeName = TaskListRoute.SMART.name
                    },
                    onProject = {
                        selectedOwner = it.owner.key
                        selectedName = it.name
                        routeName = TaskListRoute.PROJECT.name
                    },
                    onArea = {
                        selectedOwner = it.owner.key
                        selectedName = it.name
                        routeName = TaskListRoute.AREA.name
                    },
                )

            TaskListRoute.SMART -> {
                val kind =
                    TaskSmartList.entries.firstOrNull { it.name == selectedKind }
                        ?: TaskSmartList.TODAY
                TaskDetailList(
                    title = kind.title(),
                    tasks = model.tasksFor(kind),
                    viewer = state.activeProfile,
                    actions = actions,
                    onBack = { routeName = TaskListRoute.HUB.name },
                )
            }

            TaskListRoute.PROJECT, TaskListRoute.AREA -> {
                val owner = FamilyMember.fromKeyOrNull(selectedOwner)
                val groups = if (route == TaskListRoute.PROJECT) model.projects else model.areas
                val group = groups.firstOrNull { it.owner == owner && it.name == selectedName }
                TaskDetailList(
                    title = selectedName,
                    tasks = group?.tasks.orEmpty(),
                    viewer = state.activeProfile,
                    actions = actions,
                    onBack = { routeName = TaskListRoute.HUB.name },
                )
            }
        }
    }
}

private data class TaskRowActions(
    val enabled: (TodoItem) -> Boolean,
    val deletePending: Boolean,
    /** Slice revision the rows came from; rows reveal when it changes. */
    val revealKey: Any?,
    val onToggleDone: (TodoItem) -> Unit,
    val onToggleFlag: (TodoItem) -> Unit,
    val onEdit: (TodoItem) -> Unit,
    val onDelete: (TodoItem) -> Unit,
)

private fun List<TodoItem>.replaceTodo(todo: TodoItem): List<TodoItem> =
    (filterNot { it.id == todo.id } + todo).sortedWith(TODO_ORDER)

@Composable
private fun TaskHub(
    model: TaskListModel,
    viewer: FamilyMember,
    actions: TaskRowActions,
    onSmartList: (TaskSmartList) -> Unit,
    onProject: (TaskGroup) -> Unit,
    onArea: (TaskGroup) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(VaultSpace.md)) {
        SmartListGrid(model, onSmartList)
        TaskSection(stringResource(R.string.tasks_today), model.today, viewer, actions)
        TaskSection(stringResource(R.string.tasks_this_week), model.thisWeek, viewer, actions)
        TaskSection(stringResource(R.string.tasks_long_term), model.longTerm, viewer, actions)
        TaskGroupSection(
            title = stringResource(R.string.tasks_projects),
            groups = model.projects,
            viewer = viewer,
            emptyText = stringResource(R.string.tasks_no_projects),
            onSelect = onProject,
        )
        TaskGroupSection(
            title = stringResource(R.string.tasks_areas),
            groups = model.areas,
            viewer = viewer,
            emptyText = stringResource(R.string.tasks_no_areas),
            onSelect = onArea,
        )
    }
}

@Composable
private fun SmartListGrid(
    model: TaskListModel,
    onSelect: (TaskSmartList) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(VaultSpace.sm)) {
        TaskSmartList.entries.chunked(2).forEach { row ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm),
            ) {
                row.forEach { kind ->
                    SmartListCard(
                        kind = kind,
                        count = model.tasksFor(kind).size,
                        onClick = { onSelect(kind) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun SmartListCard(
    kind: TaskSmartList,
    count: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalLedgerTheme.current.colors
    Column(
        modifier
            .background(colors.panel, RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(VaultSpace.md),
        verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
    ) {
        Icon(kind.icon(), contentDescription = null, tint = colors.bitcoin)
        Text(kind.title(), style = MaterialTheme.typography.titleSmall, color = colors.foregroundSecondary)
        Text(count.toString(), style = MaterialTheme.typography.headlineMedium, color = colors.foreground)
    }
}

@Composable
private fun TaskSection(
    title: String,
    tasks: List<TodoItem>,
    viewer: FamilyMember,
    actions: TaskRowActions,
) {
    if (tasks.isEmpty()) return
    TaskPanel(title) {
        tasks.forEachIndexed { index, task ->
            if (index > 0) HorizontalHairline()
            Box(Modifier.ledgerRowReveal(index, actions.revealKey?.let { "tasks-$title:$it" })) {
                TaskEditableRow(task, viewer, actions)
            }
        }
    }
}

@Composable
private fun TaskGroupSection(
    title: String,
    groups: List<TaskGroup>,
    viewer: FamilyMember,
    emptyText: String,
    onSelect: (TaskGroup) -> Unit,
) {
    val colors = LocalLedgerTheme.current.colors
    TaskPanel(title) {
        if (groups.isEmpty()) {
            Text(
                emptyText,
                style = MaterialTheme.typography.bodySmall,
                color = colors.foregroundSecondary,
                modifier = Modifier.padding(VaultSpace.md),
            )
        } else {
            groups.forEachIndexed { index, group ->
                if (index > 0) HorizontalHairline()
                val openDescription = stringResource(R.string.tasks_open_group, group.name)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .semantics { contentDescription = openDescription }
                        .clickable(role = Role.Button) { onSelect(group) }
                        .padding(VaultSpace.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(group.name, style = MaterialTheme.typography.bodyMedium, color = colors.foreground)
                        if (group.owner != viewer) {
                            Text(
                                group.owner.displayName,
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.foregroundTertiary,
                            )
                        }
                    }
                    Text(
                        group.openCount.toString(),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.foregroundSecondary,
                    )
                    Icon(
                        Icons.Filled.ChevronRight,
                        contentDescription = null,
                        tint = colors.foregroundSecondary,
                    )
                }
            }
        }
    }
}

@Composable
private fun TaskDetailList(
    title: String,
    tasks: List<TodoItem>,
    viewer: FamilyMember,
    actions: TaskRowActions,
    onBack: () -> Unit,
) {
    val colors = LocalLedgerTheme.current.colors
    TaskPanel(title) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClick = onBack)
                .padding(VaultSpace.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm),
        ) {
            Icon(
                Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = stringResource(R.string.tasks_back),
                tint = colors.bitcoin,
            )
            Text(stringResource(R.string.tasks_all_lists), color = colors.bitcoin)
        }
        HorizontalHairline()
        if (tasks.isEmpty()) {
            Text(
                stringResource(R.string.tasks_nothing_here),
                style = MaterialTheme.typography.bodySmall,
                color = colors.foregroundSecondary,
                modifier = Modifier.padding(VaultSpace.md),
            )
        } else {
            tasks.forEachIndexed { index, task ->
                if (index > 0) HorizontalHairline()
                Box(Modifier.ledgerRowReveal(index, actions.revealKey?.let { "tasks-$title:$it" })) {
                    TaskEditableRow(task, viewer, actions)
                }
            }
        }
    }
}

@Composable
private fun TaskEditableRow(
    task: TodoItem,
    viewer: FamilyMember,
    actions: TaskRowActions,
) {
    TodoRow(
        todo = task,
        viewer = viewer,
        enabled = actions.enabled(task),
        deleteEnabled = actions.enabled(task) && !actions.deletePending,
        deleteDisabledReason = if (actions.deletePending) {
            stringResource(R.string.todo_delete_pending_named, task.title)
        } else {
            null
        },
        onToggleDone = { actions.onToggleDone(task) },
        onToggleFlag = { actions.onToggleFlag(task) },
        onEdit = { actions.onEdit(task) },
        onDelete = { actions.onDelete(task) },
    )
}

@Composable
private fun TaskPanel(
    title: String,
    content: @Composable () -> Unit,
) {
    val colors = LocalLedgerTheme.current.colors
    Column(
        Modifier
            .fillMaxWidth()
            .background(colors.panel, RoundedCornerShape(8.dp)),
    ) {
        Text(
            title,
            style = MaterialTheme.typography.titleSmall,
            color = colors.foreground,
            modifier = Modifier
                .fillMaxWidth()
                .semantics { heading() }
                .padding(VaultSpace.md),
        )
        HorizontalHairline()
        content()
    }
}

@Composable
private fun TaskSmartList.title(): String = stringResource(
    when (this) {
        TaskSmartList.INBOX -> R.string.tasks_inbox
        TaskSmartList.TODAY -> R.string.tasks_today
        TaskSmartList.UPCOMING -> R.string.tasks_upcoming
        TaskSmartList.FLAGGED -> R.string.tasks_flagged
    },
)

private fun TaskSmartList.icon(): ImageVector = when (this) {
    TaskSmartList.INBOX -> Icons.Filled.Inbox
    TaskSmartList.TODAY -> Icons.Filled.Today
    TaskSmartList.UPCOMING -> Icons.Filled.Upcoming
    TaskSmartList.FLAGGED -> Icons.Filled.Flag
}
