package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultBlack
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultLine
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultSurface
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun TodoScreen(
    todos: List<TodoItem>,
    viewer: FamilyMember,
    nowMillis: Long,
    hasWriteAccess: () -> Boolean,
    saveWriteCredential: (String) -> Boolean,
    upsert: suspend (TodoItem) -> Boolean,
    delete: suspend (String) -> Boolean,
    modifier: Modifier = Modifier,
) {
    val today = remember(nowMillis) {
        Instant.ofEpochMilli(nowMillis).atZone(ZoneId.systemDefault()).toLocalDate().toString()
    }
    var localTodos by remember(viewer) { mutableStateOf(todosForToday(todos, viewer, today)) }
    var writeReady by remember { mutableStateOf(hasWriteAccess()) }
    var draft by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<TodoItem?>(null) }
    var editTitle by remember { mutableStateOf("") }
    var busyIds by remember { mutableStateOf(emptySet<String>()) }
    var pendingDeletion by remember { mutableStateOf<PendingTodoDeletion?>(null) }
    var expiryJob by remember { mutableStateOf<Job?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val writeFailedMessage = stringResource(R.string.todo_write_failed)
    val undoLabel = stringResource(R.string.todo_undo)

    LaunchedEffect(todos, viewer, today) {
        localTodos = todosForToday(todos, viewer, today)
    }

    fun reportFailure() {
        scope.launch { snackbar.showSnackbar(message = writeFailedMessage) }
    }

    fun mutate(todo: TodoItem, action: suspend () -> Boolean) {
        if (todo.id in busyIds) return
        busyIds = busyIds + todo.id
        scope.launch {
            if (action()) {
                localTodos = (localTodos.filterNot { it.id == todo.id } + todo)
                    .sortedWith(compareBy<TodoItem> { it.done }.thenByDescending { it.flagged }.thenBy { it.title })
            } else {
                reportFailure()
            }
            busyIds = busyIds - todo.id
        }
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = VaultBlack,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        LazyColumn(
            Modifier.padding(padding).fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(VaultSpace.md),
            verticalArrangement = Arrangement.spacedBy(VaultSpace.md),
        ) {
            item {
                Column {
                    Text("Today", style = MaterialTheme.typography.headlineMedium, color = VaultCream)
                    Text(
                        stringResource(R.string.todo_today_subtitle),
                        style = MaterialTheme.typography.bodySmall,
                        color = VaultTextDim,
                    )
                }
            }

            if (!writeReady) {
                item {
                    TodoWriteCredentialCard { token ->
                        val saved = saveWriteCredential(token)
                        writeReady = saved && hasWriteAccess()
                        saved
                    }
                }
            }

            item {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(VaultSurface)
                        .padding(VaultSpace.sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        modifier = Modifier.weight(1f),
                        label = { Text(stringResource(R.string.todo_new_task)) },
                        singleLine = true,
                        enabled = writeReady,
                    )
                    Spacer(Modifier.width(VaultSpace.sm))
                    IconButton(
                        enabled = writeReady && draft.isNotBlank(),
                        onClick = {
                            val todo = newTodo(
                                title = draft,
                                owner = viewer,
                                today = today,
                                now = Instant.now(),
                            )
                            draft = ""
                            mutate(todo) { upsert(todo) }
                        },
                    ) {
                        Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.todo_add))
                    }
                }
            }

            if (localTodos.isEmpty()) {
                item {
                    Text(
                        stringResource(R.string.todo_empty),
                        color = VaultTextDim,
                        modifier = Modifier.padding(VaultSpace.md),
                    )
                }
            } else {
                items(localTodos, key = TodoItem::id) { todo ->
                    TodoRow(
                        todo = todo,
                        enabled = writeReady && todo.id !in busyIds,
                        onToggleDone = {
                            val changed = todo.withCompletion(!todo.done, Instant.now())
                            mutate(changed) { upsert(changed) }
                        },
                        onToggleFlag = {
                            val changed = todo.withFlag(!todo.flagged, Instant.now())
                            mutate(changed) { upsert(changed) }
                        },
                        onEdit = {
                            editing = todo
                            editTitle = todo.title
                        },
                        onDelete = {
                            if (todo.id in busyIds) return@TodoRow
                            val pending = PendingTodoDeletion(
                                todo,
                                System.currentTimeMillis() + TODO_UNDO_WINDOW_MILLIS,
                            )
                            busyIds = busyIds + todo.id
                            localTodos = localTodos.filterNot { it.id == todo.id }
                            snackbar.currentSnackbarData?.dismiss()
                            pendingDeletion = pending
                            expiryJob?.cancel()
                            scope.launch {
                                val feedback = async {
                                    snackbar.showSnackbar(
                                        message = context.getString(R.string.todo_deleted, todo.title),
                                        actionLabel = undoLabel,
                                        duration = SnackbarDuration.Indefinite,
                                    )
                                }
                                expiryJob = launch {
                                    delay(TODO_UNDO_WINDOW_MILLIS)
                                    if (pendingDeletion?.todo?.id == todo.id) {
                                        pendingDeletion = null
                                        snackbar.currentSnackbarData?.dismiss()
                                    }
                                }
                                if (!delete(todo.id)) {
                                    localTodos = (localTodos + todo).distinctBy(TodoItem::id)
                                    pendingDeletion = null
                                    expiryJob?.cancel()
                                    snackbar.currentSnackbarData?.dismiss()
                                    feedback.await()
                                    reportFailure()
                                } else {
                                    val result = feedback.await()
                                    if (
                                        result == SnackbarResult.ActionPerformed &&
                                        pendingDeletion?.todo?.id == todo.id &&
                                        pending.canUndo(System.currentTimeMillis())
                                    ) {
                                        expiryJob?.cancel()
                                        if (upsert(todo)) {
                                            localTodos = (localTodos + todo)
                                                .distinctBy(TodoItem::id)
                                                .sortedWith(compareBy<TodoItem> { it.done }.thenBy { it.title })
                                        } else {
                                            reportFailure()
                                        }
                                        pendingDeletion = null
                                    }
                                }
                                busyIds = busyIds - todo.id
                            }
                        },
                    )
                }
            }
        }
    }

    editing?.let { todo ->
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text(stringResource(R.string.todo_edit)) },
            text = {
                OutlinedTextField(
                    value = editTitle,
                    onValueChange = { editTitle = it },
                    singleLine = true,
                    label = { Text(stringResource(R.string.todo_title)) },
                )
            },
            confirmButton = {
                Button(
                    enabled = editTitle.isNotBlank(),
                    onClick = {
                        val changed = todo.withTitle(editTitle, Instant.now())
                        editing = null
                        mutate(changed) { upsert(changed) }
                    },
                ) { Text(stringResource(R.string.todo_save)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { editing = null }) {
                    Text(stringResource(R.string.todo_cancel))
                }
            },
        )
    }
}

@Composable
private fun TodoRow(
    todo: TodoItem,
    enabled: Boolean,
    onToggleDone: () -> Unit,
    onToggleFlag: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(VaultSurface)
            .padding(horizontal = VaultSpace.sm, vertical = VaultSpace.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(enabled = enabled, onClick = onToggleDone) {
            Icon(
                if (todo.done) Icons.Filled.CheckCircle else Icons.Outlined.RadioButtonUnchecked,
                contentDescription = stringResource(
                    if (todo.done) R.string.todo_mark_open else R.string.todo_mark_complete,
                ),
                tint = if (todo.done) VaultAccent else VaultTextDim,
            )
        }
        Column(Modifier.weight(1f)) {
            Text(
                todo.title,
                color = VaultCream,
                textDecoration = if (todo.done) TextDecoration.LineThrough else null,
            )
            todo.due?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = VaultTextDim) }
        }
        IconButton(enabled = enabled, onClick = onToggleFlag) {
            Icon(
                Icons.Filled.Flag,
                contentDescription = stringResource(
                    if (todo.flagged) R.string.todo_remove_flag else R.string.todo_add_flag,
                ),
                tint = if (todo.flagged) VaultAccent else VaultTextDim,
            )
        }
        IconButton(enabled = enabled, onClick = onEdit) {
            Icon(Icons.Filled.Edit, contentDescription = stringResource(R.string.todo_edit))
        }
        IconButton(enabled = enabled, onClick = onDelete) {
            Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.todo_delete))
        }
    }
}

@Composable
private fun TodoWriteCredentialCard(save: (String) -> Boolean) {
    var token by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .background(VaultSurface)
            .padding(VaultSpace.md),
        verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
    ) {
        Text(stringResource(R.string.todo_write_access_title), color = VaultCream)
        Text(
            stringResource(R.string.todo_write_access_detail),
            style = MaterialTheme.typography.bodySmall,
            color = VaultTextDim,
        )
        OutlinedTextField(
            value = token,
            onValueChange = {
                token = it
                failed = false
            },
            label = { Text(stringResource(R.string.todo_sync_token)) },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            enabled = token.isNotBlank(),
            onClick = {
                if (save(token)) token = "" else failed = true
            },
        ) {
            Text(stringResource(R.string.todo_save_access))
        }
        if (failed) {
            Text(stringResource(R.string.todo_write_access_failed), color = VaultLine)
        }
    }
}
