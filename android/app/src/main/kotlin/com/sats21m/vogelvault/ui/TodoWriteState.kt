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
import androidx.compose.material3.Button
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
import com.sats21m.vogelvault.data.ConvexValue
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
    private val onCredentialRejected: () -> Unit,
    private val deletedMessage: (TodoItem) -> String,
    private val undoLabel: String,
) {
    var busyIds by mutableStateOf(emptySet<String>())
        private set

    private var pendingDeletion by mutableStateOf<PendingTodoDeletion?>(null)
    private var expiryJob: Job? = null

    val deletePending: Boolean
        get() = pendingDeletion != null

    private suspend fun write(
        call: suspend (TodoMutationGateway) -> ConvexResult<ConvexValue>,
    ): ConvexResult<ConvexValue>? = gateway?.let { call(it) }

    /** Preserve the sealed transport outcome until credential recovery runs. */
    private fun failureMessage(
        action: TodoWriteAction,
        result: ConvexResult<ConvexValue>?,
    ): String? {
        if (result === ConvexResult.Unauthorized) onCredentialRejected()
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
        action: TodoWriteAction = TodoWriteAction.UPDATE,
        onAccepted: (TodoItem) -> Unit,
    ) {
        if (todo.id in busyIds) return
        busyIds = busyIds + todo.id
        scope.launch {
            val result = write { it.upsert(todo) }
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
     * accepts the deletion. A rejected write restores the exact untouched row.
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
        val pending = PendingTodoDeletion(
            todo = todo,
            expiresAtMillis = nowMillis() + TODO_UNDO_WINDOW_MILLIS,
        )
        busyIds = busyIds + todo.id
        onRemoved(todo)
        snackbar.currentSnackbarData?.dismiss()
        pendingDeletion = pending
        expiryJob?.cancel()

        scope.launch {
            // The window starts at the user's delete action, not when the
            // network happens to answer.
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
                        val result = write { it.delete(todo.id) }
                        failureMessage(TodoWriteAction.DELETE, result)
                            .also { failure ->
                                if (failure == null) onWriteSucceeded()
                            }
                    },
                    deletedMessage = deletedMessage(todo),
                    showDeleted = { message ->
                        if (
                            pendingDeletion?.todo?.id == todo.id &&
                            pending.canUndo(nowMillis())
                        ) {
                            snackbar.showSnackbar(
                                message = message,
                                actionLabel = undoLabel,
                                duration = SnackbarDuration.Indefinite,
                            )
                        } else {
                            snackbar.showSnackbar(
                                message = message,
                                duration = SnackbarDuration.Short,
                            )
                        }
                    },
                )
            ) {
                is TodoDeleteFeedback.Failed -> {
                    onRestored(todo)
                    pendingDeletion = null
                    expiryJob?.cancel()
                    snackbar.currentSnackbarData?.dismiss()
                    report(feedback.message)
                }

                is TodoDeleteFeedback.Deleted -> {
                    if (
                        feedback.snackbarResult == SnackbarResult.ActionPerformed &&
                        pendingDeletion?.todo?.id == todo.id &&
                        pending.canUndo(nowMillis())
                    ) {
                        expiryJob?.cancel()
                        val restoreResult = write { it.upsert(todo) }
                        val restoreFailure = failureMessage(TodoWriteAction.RESTORE, restoreResult)
                        if (restoreFailure == null) {
                            onRestored(todo)
                            onWriteSucceeded()
                        } else {
                            report(restoreFailure)
                        }
                        pendingDeletion = null
                    }
                }
            }
            busyIds = busyIds - todo.id
        }
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
    onCredentialRejected: () -> Unit,
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
    onDismiss: () -> Unit,
    onSave: (TodoItem) -> Unit,
) {
    var title by remember(todo.owner, todo.id) { mutableStateOf(todo.title) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.todo_edit)) },
        text = {
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                singleLine = true,
                label = { Text(stringResource(R.string.todo_title)) },
            )
        },
        confirmButton = {
            Button(
                enabled = title.isNotBlank(),
                onClick = {
                    onDismiss()
                    onSave(todo.withTitle(title, Instant.now()))
                },
            ) {
                Text(stringResource(R.string.todo_save))
            }
        },
        dismissButton = {
            OutlinedButton(onClick = onDismiss) {
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
