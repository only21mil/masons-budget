package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.components.HorizontalHairline
import com.sats21m.vogelvault.ui.components.StateBlock
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultSurface
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import com.sats21m.vogelvault.ui.theme.VaultTextMuted
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
) {
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
    val model = remember(todos, state.activeProfile, date) {
        TaskListModel.build(todos, state.activeProfile, date)
    }

    var routeName by rememberSaveable { mutableStateOf(TaskListRoute.HUB.name) }
    var selectedKind by rememberSaveable { mutableStateOf(TaskSmartList.TODAY.name) }
    var selectedOwner by rememberSaveable { mutableStateOf(FamilyMember.VICTOR.key) }
    var selectedName by rememberSaveable { mutableStateOf("") }
    var addingTask by rememberSaveable { mutableStateOf(false) }
    var writeNotice by rememberSaveable { mutableStateOf<String?>(null) }
    val route = TaskListRoute.entries.firstOrNull { it.name == routeName } ?: TaskListRoute.HUB

    if (addingTask) {
        AddTaskSheet(
            owner = state.activeProfile,
            onDismiss = { addingTask = false },
            onSaved = { title ->
                writeNotice = "Task added: $title"
                addingTask = false
            },
            onWriteSucceeded = onWriteSucceeded,
        )
    }

    Column(verticalArrangement = Arrangement.spacedBy(VaultSpace.md)) {
        Button(onClick = { addingTask = true }) {
            Text(stringResource(R.string.tasks_add))
        }
        writeNotice?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = VaultAccent)
        }

    when (route) {
        TaskListRoute.HUB ->
            TaskHub(
                model = model,
                viewer = state.activeProfile,
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
            val kind = TaskSmartList.entries.firstOrNull { it.name == selectedKind } ?: TaskSmartList.TODAY
            TaskDetailList(
                title = kind.title(),
                tasks = model.tasksFor(kind),
                viewer = state.activeProfile,
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
                onBack = { routeName = TaskListRoute.HUB.name },
            )
        }
    }
    }
}

@Composable
private fun TaskHub(
    model: TaskListModel,
    viewer: FamilyMember,
    onSmartList: (TaskSmartList) -> Unit,
    onProject: (TaskGroup) -> Unit,
    onArea: (TaskGroup) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(VaultSpace.md)) {
        SmartListGrid(model, onSmartList)
        TaskSection(stringResource(R.string.tasks_today), model.today, viewer)
        TaskSection(stringResource(R.string.tasks_this_week), model.thisWeek, viewer)
        TaskSection(stringResource(R.string.tasks_long_term), model.longTerm, viewer)
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
    Column(
        modifier
            .background(VaultSurface, RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(VaultSpace.md),
        verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
    ) {
        Icon(kind.icon(), contentDescription = null, tint = VaultAccent)
        Text(kind.title(), style = MaterialTheme.typography.titleSmall, color = VaultTextMuted)
        Text(count.toString(), style = MaterialTheme.typography.headlineMedium, color = VaultCream)
    }
}

@Composable
private fun TaskSection(
    title: String,
    tasks: List<TodoItem>,
    viewer: FamilyMember,
) {
    if (tasks.isEmpty()) return
    TaskPanel(title) {
        tasks.forEachIndexed { index, task ->
            if (index > 0) HorizontalHairline()
            TaskReadOnlyRow(task, viewer)
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
    TaskPanel(title) {
        if (groups.isEmpty()) {
            Text(
                emptyText,
                style = MaterialTheme.typography.bodySmall,
                color = VaultTextMuted,
                modifier = Modifier.padding(VaultSpace.md),
            )
        } else {
            groups.forEachIndexed { index, group ->
                if (index > 0) HorizontalHairline()
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(role = Role.Button) { onSelect(group) }
                        .padding(VaultSpace.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(group.name, style = MaterialTheme.typography.bodyMedium, color = VaultCream)
                        if (group.owner != viewer) {
                            Text(
                                group.owner.displayName,
                                style = MaterialTheme.typography.labelSmall,
                                color = VaultTextDim,
                            )
                        }
                    }
                    Text(
                        group.openCount.toString(),
                        style = MaterialTheme.typography.labelSmall,
                        color = VaultTextMuted,
                    )
                    Icon(
                        Icons.Filled.ChevronRight,
                        contentDescription = stringResource(R.string.tasks_open_group, group.name),
                        tint = VaultTextDim,
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
    onBack: () -> Unit,
) {
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
                tint = VaultAccent,
            )
            Text(stringResource(R.string.tasks_all_lists), color = VaultAccent)
        }
        HorizontalHairline()
        if (tasks.isEmpty()) {
            Text(
                stringResource(R.string.tasks_nothing_here),
                style = MaterialTheme.typography.bodySmall,
                color = VaultTextMuted,
                modifier = Modifier.padding(VaultSpace.md),
            )
        } else {
            tasks.forEachIndexed { index, task ->
                if (index > 0) HorizontalHairline()
                TaskReadOnlyRow(task, viewer)
            }
        }
    }
}

@Composable
private fun TaskReadOnlyRow(
    task: TodoItem,
    viewer: FamilyMember,
) {
    Row(
        Modifier.fillMaxWidth().padding(VaultSpace.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(VaultSpace.md),
    ) {
        Text(if (task.done) "✓" else "○", color = if (task.done) VaultTextDim else VaultAccent)
        Column(Modifier.weight(1f)) {
            Text(
                task.title,
                style = MaterialTheme.typography.bodyMedium,
                color = if (task.done) VaultTextDim else VaultCream,
            )
            val filing = task.project
                ?.trim()
                ?.takeIf { it.isNotEmpty() && !it.equals("Inbox", ignoreCase = true) }
                ?: task.area?.trim()?.takeIf(String::isNotEmpty)
            val details = listOfNotNull(
                filing,
                task.due,
                task.owner.displayName.takeIf { task.owner != viewer },
            )
            if (details.isNotEmpty()) {
                Text(
                    details.joinToString(" · "),
                    style = MaterialTheme.typography.labelSmall,
                    color = VaultTextMuted,
                )
            }
        }
        if (task.flagged) {
            Icon(
                Icons.Filled.Flag,
                contentDescription = stringResource(R.string.tasks_flagged),
                tint = VaultAccent,
            )
        }
    }
}

@Composable
private fun TaskPanel(
    title: String,
    content: @Composable () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(VaultSurface, RoundedCornerShape(8.dp)),
    ) {
        Text(
            title,
            style = MaterialTheme.typography.titleSmall,
            color = VaultCream,
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
