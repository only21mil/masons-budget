package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDecoration
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.DEVICE_ENTITY_DELETED_REASON
import com.sats21m.vogelvault.data.DEVICE_ENTITY_NOT_FOUND_REASON
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultSurface
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * One mutation session shared by Today and every Tasks route.
 *
 * The local-list callbacks are supplied per operation because Today and Tasks
 * have different projections of the same owner-scoped todo ledger. Transport
 * result handling, busy-row behavior and the delete/Undo boundary must not
 * differ between those projections.
 */
@Stable
internal class TodoWriteState(
    private val gateway: TodoMutationGateway?,
    private val scope: CoroutineScope,
    private val snackbar: SnackbarHostState,
    private val nowMillis: () -> Long,
    private val onWriteSucceeded: () -> Unit,
    private val onCredentialRejected: () -> String?,
    private val deletedMessage: (TodoItem) -> String,
    private val undoLabel: String,
) {
    var busyIds by mutableStateOf(emptySet<String>())
        private set

    private var pendingDeletion by mutableStateOf<PendingTodoDeletion?>(null)
    private var expiryJob: Job? = null
    private var restoreInFlightToken: String? = null
    private var restoredOperationToken: String? = null
    private val authoritativeRows = mutableMapOf<String, TodoItem>()

    val deletePending: Boolean
        get() = pendingDeletion != null

    /** Preserve the sealed transport outcome until credential recovery runs. */
    private fun <T> failureMessage(
        action: TodoWriteAction,
        result: ConvexResult<T>?,
    ): String? {
        if (result === ConvexResult.Unauthorized) {
            onCredentialRejected()?.let(::report)
        }
        return if (result == null) {
            todoWriteUnavailableMessage(action)
        } else {
            todoWriteFailureMessage(action, result)
        }
    }

    private fun report(message: String) {
        scope.launch { snackbar.showSnackbar(message = message) }
    }

    fun upsert(
        todo: TodoItem,
        baseUpdatedAtMs: Long?,
        action: TodoWriteAction = TodoWriteAction.UPDATE,
        onAccepted: (TodoItem) -> Unit,
    ) {
        if (todo.id in busyIds) return
        busyIds = busyIds + todo.id
        scope.launch {
            val result = gateway?.upsert(todo, baseUpdatedAtMs)
            val failure = failureMessage(action, result)
            if (failure == null) {
                onAccepted(todo)
                onWriteSucceeded()
            } else {
                report(failure)
            }
            busyIds = busyIds - todo.id
        }
    }

    /**
     * Remove immediately, but announce success and offer Undo only after Convex
     * accepts the deletion. A rejected write restores the newest row known from
     * authority, never an older captured snapshot over a newer refresh.
     */
    fun delete(
        todo: TodoItem,
        onRemoved: (TodoItem) -> Unit,
        onRestored: (TodoItem) -> Unit,
    ) {
        // Only one deletion may own the process-wide Undo surface. Without this
        // guard, deleting another row replaces the first pending record and
        // silently removes its rollback opportunity.
        if (todo.id in busyIds || pendingDeletion != null) return
        val operationToken = UUID.randomUUID().toString()
        val pending = PendingTodoDeletion(
            operationToken = operationToken,
            todo = todo,
            expiresAtMillis = Long.MAX_VALUE,
        )
        busyIds = busyIds + todo.id
        onRemoved(todo)
        snackbar.currentSnackbarData?.dismiss()
        pendingDeletion = pending
        restoredOperationToken = null
        expiryJob?.cancel()

        scope.launch {
            val result = gateway?.delete(todo)
            if (pendingDeletion?.operationToken != operationToken) {
                busyIds = busyIds - todo.id
                return@launch
            }
            when (result) {
                is ConvexResult.Ok -> {
                    onWriteSucceeded()
                    if (result.value.removed) {
                        val accepted = pending.copy(
                            expiresAtMillis = nowMillis() + TODO_UNDO_WINDOW_MILLIS,
                        )
                        pendingDeletion = accepted
                        expiryJob = launch {
                            delay(TODO_UNDO_WINDOW_MILLIS)
                            if (pendingDeletion?.operationToken == operationToken) {
                                snackbar.currentSnackbarData?.dismiss()
                                if (restoreInFlightToken != operationToken) {
                                    pendingDeletion = null
                                    restoredOperationToken = null
                                }
                            }
                        }
                        val feedback = snackbar.showSnackbar(
                            message = deletedMessage(todo),
                            actionLabel = undoLabel,
                            duration = SnackbarDuration.Indefinite,
                        )
                        if (
                            feedback == SnackbarResult.ActionPerformed &&
                            pendingDeletion?.operationToken == operationToken &&
                            accepted.canUndo(nowMillis())
                        ) {
                            restoreInFlightToken = operationToken
                            val restoreResult = gateway?.restore(todo)
                            if (pendingDeletion?.operationToken == operationToken) {
                                when (restoreResult) {
                                    is ConvexResult.Ok -> {
                                        restoredOperationToken = operationToken
                                        onRestored(todo.copy(updatedAtMs = restoreResult.value.updatedAtMs))
                                        onWriteSucceeded()
                                    }
                                    else -> failureMessage(TodoWriteAction.RESTORE, restoreResult)?.let(::report)
                                }
                            }
                            restoreInFlightToken = null
                            val remaining = accepted.expiresAtMillis - nowMillis()
                            if (remaining > 0) delay(remaining)
                        }
                        if (pendingDeletion?.operationToken == operationToken) {
                            pendingDeletion = null
                            restoredOperationToken = null
                        }
                    } else {
                        pendingDeletion = null
                        report("Task was already deleted")
                    }
                }
                else -> {
                    val failureReason = (result as? ConvexResult.Failed)?.reason
                    val alreadyGone =
                        failureReason == DEVICE_ENTITY_DELETED_REASON ||
                            failureReason == DEVICE_ENTITY_NOT_FOUND_REASON
                    if (!alreadyGone) {
                        val restore = newestTodo(todo, authoritativeRows[todo.id])
                        onRestored(restore)
                    }
                    pendingDeletion = null
                    restoredOperationToken = null
                    snackbar.currentSnackbarData?.dismiss()
                    val message = if (alreadyGone) {
                        "Task was already deleted"
                    } else {
                        failureMessage(TodoWriteAction.DELETE, result)
                    }
                    message?.let(::report)
                }
            }
            busyIds = busyIds - todo.id
        }
    }

    /** Record fresh authority while keeping the active optimistic tombstone. */
    fun filterIncoming(rows: List<TodoItem>): List<TodoItem> {
        rows.forEach { row ->
            val known = authoritativeRows[row.id]
            if (known == null || row.updatedAtMs >= known.updatedAtMs) authoritativeRows[row.id] = row
        }
        val pending = pendingDeletion
        val tombstonedId = pending?.todo?.id
            ?.takeUnless { restoredOperationToken == pending.operationToken }
        return rows.filterActiveTodoTombstone(tombstonedId)
    }

    fun close() {
        expiryJob?.cancel()
        snackbar.currentSnackbarData?.dismiss()
    }
}

@Composable
internal fun rememberTodoWriteState(
    gateway: TodoMutationGateway?,
    snackbar: SnackbarHostState,
    onWriteSucceeded: () -> Unit,
    onCredentialRejected: () -> String?,
    nowMillis: () -> Long,
): TodoWriteState {
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    val currentRefresh = rememberUpdatedState(onWriteSucceeded)
    val currentCredentialRejected = rememberUpdatedState(onCredentialRejected)
    val currentClock = rememberUpdatedState(nowMillis)
    val undoLabel = stringResource(R.string.todo_undo)
    val state = remember(gateway, scope, snackbar, context, undoLabel) {
        TodoWriteState(
            gateway = gateway,
            scope = scope,
            snackbar = snackbar,
            nowMillis = { currentClock.value() },
            onWriteSucceeded = { currentRefresh.value() },
            onCredentialRejected = { currentCredentialRejected.value() },
            deletedMessage = { context.getString(R.string.todo_deleted, it.title) },
            undoLabel = undoLabel,
        )
    }
    DisposableEffect(state) {
        onDispose(state::close)
    }
    return state
}

@Composable
internal fun TodoEditDialog(
    todo: TodoItem,
    writeEnabled: Boolean,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (TodoItem) -> Unit,
) {
    var title by remember(todo.owner, todo.id) { mutableStateOf(todo.title) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.todo_edit)) },
        text = {
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                enabled = !busy,
                singleLine = true,
                label = { Text(stringResource(R.string.todo_title)) },
            )
        },
        confirmButton = {
            VaultButton(
                enabled = writeEnabled && !busy && title.isNotBlank(),
                onClick = { onSave(todo.withTitle(title, Instant.now())) },
            ) {
                Text(stringResource(R.string.todo_save))
            }
        },
        dismissButton = {
            OutlinedButton(
                enabled = !busy,
                onClick = onDismiss,
            ) {
                Text(stringResource(R.string.todo_cancel))
            }
        },
    )
}

/**
 * An editable todo row with four distinct TalkBack actions.
 *
 * The row itself edits, while completion remains a separate leading control.
 * Flag and delete remain explicit trailing actions; the row's edit description
 * makes the full-width edit target discoverable to TalkBack and switch access.
 */
@Composable
internal fun TodoRow(
    todo: TodoItem,
    viewer: FamilyMember,
    enabled: Boolean,
    deleteEnabled: Boolean = enabled,
    deleteDisabledReason: String? = null,
    onToggleDone: () -> Unit,
    onToggleFlag: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    val editDescription = stringResource(R.string.todo_edit_named, todo.title)
    val todoStateDescription = stringResource(
        when {
            todo.done && todo.flagged -> R.string.todo_state_completed_flagged
            todo.done -> R.string.todo_state_completed
            todo.flagged -> R.string.todo_state_open_flagged
            else -> R.string.todo_state_open
        },
    )
    Row(
        Modifier
            .fillMaxWidth()
            .background(VaultSurface)
            .semantics {
                contentDescription = editDescription
                stateDescription = todoStateDescription
            }
            .clickable(enabled = enabled, role = Role.Button, onClick = onEdit)
            .padding(horizontal = VaultSpace.sm, vertical = VaultSpace.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(enabled = enabled, onClick = onToggleDone) {
            Icon(
                if (todo.done) Icons.Filled.CheckCircle else Icons.Outlined.RadioButtonUnchecked,
                contentDescription = stringResource(
                    if (todo.done) {
                        R.string.todo_mark_open_named
                    } else {
                        R.string.todo_mark_complete_named
                    },
                    todo.title,
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
            listOfNotNull(
                filing(todo),
                todo.due,
                todo.owner.displayName.takeIf { todo.owner != viewer },
            )
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
                    if (todo.flagged) R.string.todo_remove_flag_named else R.string.todo_add_flag_named,
                    todo.title,
                ),
                tint = if (todo.flagged) VaultAccent else VaultTextDim,
            )
        }
        IconButton(enabled = deleteEnabled, onClick = onDelete) {
            Icon(
                Icons.Filled.Delete,
                contentDescription = deleteDisabledReason
                    ?: stringResource(R.string.todo_delete_named, todo.title),
            )
        }
    }
}
