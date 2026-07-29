package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
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
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.ConvexValue
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.components.StateBlock
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultBlack
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultSurface
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The normaliser fills `project` with "Inbox" for an unfiled todo rather than
 * leaving it unset, so this screen treats that value as "not filed". See
 * DOMAIN_ADOPTION.md in this app's package root; the Linux client's Tasks page
 * carries the identical rule.
 */
private const val UNFILED_TODO_PROJECT = "Inbox"

/** Where a todo is filed: its project, else its area, else nowhere. */
private fun filing(todo: TodoItem): String? =
    todo.project?.takeIf { it != UNFILED_TODO_PROJECT } ?: todo.area

/**
 * Today: the one editable list in the app.
 *
 * The screen reaches the write transport itself, exactly as AddTransactionSheet
 * does, and no suspend write callback is threaded through MainActivity, VaultApp
 * or ScreenHost. Every failure names its own cause, because "nothing happened"
 * with no reason is indistinguishable from a broken feature.
 */
@Composable
internal fun TodoScreen(
    state: VaultUiState,
    modifier: Modifier = Modifier,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    // One process-scoped client, sharing the one encrypted credential store with
    // Settings and every other write surface.
    val gateway = remember(application) { application?.todoMutationGateway }

    val viewer = state.activeProfile
    val slice = state.data.todos
    val todos = slice.value
    val today = remember(state.now) {
        Instant.ofEpochMilli(state.now).atZone(ZoneId.systemDefault()).toLocalDate().toString()
    }
    var localTodos by remember(viewer) { mutableStateOf(todosForToday(todos, viewer, today)) }
    var credentialStored by remember(application) {
        mutableStateOf(application?.hasConvexWriteCredential() == true)
    }
    var draft by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<TodoItem?>(null) }
    var editTitle by remember { mutableStateOf("") }
    var busyIds by remember { mutableStateOf(emptySet<String>()) }
    var pendingDeletion by remember { mutableStateOf<PendingTodoDeletion?>(null) }
    var expiryJob by remember { mutableStateOf<Job?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val undoLabel = stringResource(R.string.todo_undo)

    LaunchedEffect(todos, viewer, today) {
        localTodos = todosForToday(todos, viewer, today)
    }

    fun report(message: String) {
        scope.launch { snackbar.showSnackbar(message = message) }
    }

    /** Runs one write and returns the sentence to show, or null on success. */
    suspend fun write(
        action: TodoWriteAction,
        call: suspend (TodoMutationGateway) -> ConvexResult<ConvexValue>,
    ): String? {
        val client = gateway ?: return todoWriteUnavailableMessage(action)
        return todoWriteFailureMessage(action, call(client))
    }

    fun mutate(
        todo: TodoItem,
        action: TodoWriteAction,
    ) {
        if (todo.id in busyIds) return
        busyIds = busyIds + todo.id
        scope.launch {
            val failure = write(action) { it.upsert(todo) }
            if (failure == null) {
                localTodos = (localTodos.filterNot { it.id == todo.id } + todo).sortedWith(TODO_ORDER)
            } else {
                report(failure)
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

            if (!credentialStored) {
                item {
                    TodoWriteCredentialCard { token ->
                        val app = application
                            ?: return@TodoWriteCredentialCard "This build cannot store a credential"
                        app.saveConvexWriteCredential(token).fold(
                            onSuccess = {
                                credentialStored = true
                                null
                            },
                            onFailure = ::credentialSaveFailureMessage,
                        )
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
                        enabled = credentialStored,
                    )
                    Spacer(Modifier.width(VaultSpace.sm))
                    IconButton(
                        enabled = credentialStored && draft.isNotBlank(),
                        onClick = {
                            val todo = newTodo(
                                title = draft,
                                owner = viewer,
                                today = today,
                                now = Instant.now(),
                            )
                            draft = ""
                            mutate(todo, TodoWriteAction.ADD)
                        },
                    ) {
                        Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.todo_add))
                    }
                }
            }

            // Demo, stale, loading and failed reads all say so, exactly as the
            // read-only surfaces do. EMPTY is left to the emptiness message below.
            if (slice.status != Freshness.LIVE && slice.status != Freshness.EMPTY) {
                item { StateBlock(slice.status) }
            }

            // Suppressed figures mean the read itself is not trustworthy. Editing
            // rows derived from it would write a guess back to the household, so the
            // state is named instead of the list being drawn.
            if (slice.suppressFigures) {
                item { StateBlock(slice.status) }
            } else if (localTodos.isEmpty()) {
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
                        enabled = credentialStored && todo.id !in busyIds,
                        onToggleDone = {
                            mutate(todo.withCompletion(!todo.done, Instant.now()), TodoWriteAction.UPDATE)
                        },
                        onToggleFlag = {
                            mutate(todo.withFlag(!todo.flagged, Instant.now()), TodoWriteAction.UPDATE)
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
                                // The six-second window starts at the deletion, not at
                                // whenever the server answers.
                                expiryJob = launch {
                                    delay(TODO_UNDO_WINDOW_MILLIS)
                                    if (pendingDeletion?.todo?.id == todo.id) {
                                        pendingDeletion = null
                                        snackbar.currentSnackbarData?.dismiss()
                                    }
                                }
                                when (
                                    val feedback = awaitTodoDeleteFeedback(
                                        delete = {
                                            write(TodoWriteAction.DELETE) { it.delete(todo.id) }
                                        },
                                        deletedMessage =
                                            context.getString(R.string.todo_deleted, todo.title),
                                        showDeleted = { message ->
                                            if (
                                                pendingDeletion?.todo?.id == todo.id &&
                                                pending.canUndo(System.currentTimeMillis())
                                            ) {
                                                snackbar.showSnackbar(
                                                    message = message,
                                                    actionLabel = undoLabel,
                                                    duration = SnackbarDuration.Indefinite,
                                                )
                                            } else {
                                                SnackbarResult.Dismissed
                                            }
                                        },
                                    )
                                ) {
                                    is TodoDeleteFeedback.Failed -> {
                                        localTodos = (localTodos + todo)
                                            .distinctBy(TodoItem::id)
                                            .sortedWith(TODO_ORDER)
                                        pendingDeletion = null
                                        expiryJob?.cancel()
                                        snackbar.currentSnackbarData?.dismiss()
                                        report(feedback.message)
                                    }

                                    is TodoDeleteFeedback.Deleted -> {
                                        if (
                                            feedback.snackbarResult == SnackbarResult.ActionPerformed &&
                                            pendingDeletion?.todo?.id == todo.id &&
                                            pending.canUndo(System.currentTimeMillis())
                                        ) {
                                            expiryJob?.cancel()
                                            val restoreFailure =
                                                write(TodoWriteAction.RESTORE) { it.upsert(todo) }
                                            if (restoreFailure == null) {
                                                localTodos = (localTodos + todo)
                                                    .distinctBy(TodoItem::id)
                                                    .sortedWith(TODO_ORDER)
                                            } else {
                                                report(restoreFailure)
                                            }
                                            pendingDeletion = null
                                        }
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
                        mutate(changed, TodoWriteAction.UPDATE)
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
            listOfNotNull(filing(todo), todo.due)
                .takeIf { it.isNotEmpty() }
                ?.let {
                    Text(
                        it.joinToString(" · "),
                        style = MaterialTheme.typography.labelSmall,
                        color = VaultTextDim,
                    )
                }
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

/**
 * One-time entry for the shared write credential.
 *
 * [save] returns null when the credential was stored, otherwise the reason it
 * was not. Settings owns the same credential; this card exists so a blocked
 * Today screen can be unblocked without hunting for that panel. The value is
 * never read back, never saved into instance state, and never shown again.
 */
@Composable
private fun TodoWriteCredentialCard(save: (String) -> String?) {
    var token by remember { mutableStateOf("") }
    var failure by remember { mutableStateOf<String?>(null) }
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
                failure = null
            },
            label = { Text(stringResource(R.string.todo_sync_token)) },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            enabled = token.isNotBlank(),
            onClick = {
                val problem = save(token)
                failure = problem
                if (problem == null) token = ""
            },
        ) {
            Text(stringResource(R.string.todo_save_access))
        }
        failure?.let {
            Text(it, color = VaultNegative, style = MaterialTheme.typography.bodySmall)
        }
    }
}
