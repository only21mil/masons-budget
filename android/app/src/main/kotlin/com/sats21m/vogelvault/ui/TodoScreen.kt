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
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
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

/**
 * The normaliser fills `project` with "Inbox" for an unfiled todo rather than
 * leaving it unset, so this screen treats that value as "not filed". See
 * DOMAIN_ADOPTION.md in this app's package root; the Linux client's Tasks page
 * carries the identical rule.
 */
private const val UNFILED_TODO_PROJECT = "Inbox"

/** Where a todo is filed: its project, else its area, else nowhere. */
internal fun filing(todo: TodoItem): String? =
    todo.project
        ?.trim()
        ?.takeIf { it.isNotEmpty() && !it.equals(UNFILED_TODO_PROJECT, ignoreCase = true) }
        ?: todo.area?.trim()?.takeIf(String::isNotEmpty)

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
    onWriteSucceeded: () -> Unit,
    modifier: Modifier = Modifier,
    /**
     * Wall clock behind the undo window, injectable exactly as VaultViewModel's
     * is. Robolectric's virtual clock does not reach System.currentTimeMillis in
     * app code, so without this seam the slow-server case could only be tested
     * by sleeping for six real seconds.
     */
    nowMillis: () -> Long = System::currentTimeMillis,
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
        mutableStateOf(application?.hasTodoWriteCredential() == true)
    }
    var draft by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<TodoItem?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val context = LocalContext.current
    val writes = rememberTodoWriteState(
        gateway = gateway,
        activeProfile = viewer,
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

    LaunchedEffect(todos, viewer, today) {
        localTodos = todosForToday(writes.filterIncoming(todos), viewer, today)
    }

    fun mutate(
        todo: TodoItem,
        action: TodoWriteAction,
        baseUpdatedAtMs: Long?,
    ) {
        writes.upsert(todo, baseUpdatedAtMs, action) {
            localTodos = (localTodos.filterNot { it.id == todo.id } + todo).sortedWith(TODO_ORDER)
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
                        app.saveTodoWriteCredential(token).fold(
                            onSuccess = {
                                credentialStored = true
                                null
                            },
                            onFailure = { credentialSaveFailureMessage(it).resolve(context) },
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
                            mutate(todo, TodoWriteAction.ADD, null)
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
                        viewer = viewer,
                        enabled = credentialStored && todo.id !in writes.busyIds,
                        deleteEnabled = credentialStored &&
                            todo.id !in writes.busyIds &&
                            !writes.deletePending,
                        deleteDisabledReason = if (writes.deletePending) {
                            stringResource(R.string.todo_delete_pending_named, todo.title)
                        } else {
                            null
                        },
                        onToggleDone = {
                            mutate(
                                todo.withCompletion(!todo.done, Instant.now()),
                                TodoWriteAction.UPDATE,
                                todo.updatedAtMs,
                            )
                        },
                        onToggleFlag = {
                            mutate(
                                todo.withFlag(!todo.flagged, Instant.now()),
                                TodoWriteAction.UPDATE,
                                todo.updatedAtMs,
                            )
                        },
                        onEdit = {
                            editing = todo
                        },
                        onDelete = {
                            writes.delete(
                                todo = todo,
                                onRemoved = { removed ->
                                    localTodos = localTodos.filterNot { it.id == removed.id }
                                },
                                onRestored = { restored ->
                                    localTodos = (localTodos + restored)
                                        .distinctBy(TodoItem::id)
                                        .sortedWith(TODO_ORDER)
                                },
                            )
                        },
                    )
                }
            }
        }
    }

    editing?.let { todo ->
        TodoEditDialog(
            todo = todo,
            writeEnabled = credentialStored,
            busy = todo.id in writes.busyIds,
            onDismiss = { editing = null },
            onSave = { changed ->
                writes.upsert(changed, todo.updatedAtMs, TodoWriteAction.UPDATE) { accepted ->
                    localTodos = (localTodos.filterNot { it.id == accepted.id } + accepted)
                        .sortedWith(TODO_ORDER)
                    editing = null
                }
            },
        )
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
internal fun TodoWriteCredentialCard(save: (String) -> String?) {
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
        VaultButton(
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
