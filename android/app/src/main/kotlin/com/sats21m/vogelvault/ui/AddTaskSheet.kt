package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import com.sats21m.vogelvault.ui.components.LedgerTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.sats21m.vogelvault.DraftIdWriteOutcome
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.TransactionDraftIdStore
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.draftIdWriteOutcome
import com.sats21m.vogelvault.onServerAccepted
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.rememberLedgerHaptics
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Shown when the server accepted a task but the lease could not be retired. */
internal const val acceptedTaskLeaseResetFailure =
    "Convex accepted this task, but this device could not retire its draft id. " +
        "Do not submit another task until local storage is repaired."

internal data class AddTaskDraft(
    val title: String,
    val project: String,
    val area: String,
    val due: String,
    val flagged: Boolean,
    val owner: FamilyMember,
)

internal fun prepareTask(
    draft: AddTaskDraft,
    id: String = "android-${UUID.randomUUID()}",
    now: Instant = Instant.now(),
): Result<TodoItem> = runCatching {
    val title = draft.title.trim()
    require(title.isNotEmpty()) { "Enter a task title" }
    require(id.isNotBlank()) { "Task id is missing" }

    val due = draft.due.trim()
    if (due.isNotEmpty()) {
        runCatching { LocalDate.parse(due) }
            .getOrElse { throw IllegalArgumentException("Enter the due date as YYYY-MM-DD") }
    }

    val stamp = now.toTodoTimestamp()
    TodoItem(
        id = id,
        title = title,
        project = draft.project.trim().takeIf(String::isNotEmpty),
        area = draft.area.trim().takeIf(String::isNotEmpty),
        due = due.takeIf(String::isNotEmpty),
        flagged = draft.flagged,
        owner = draft.owner,
        lane = "sats",
        priority = 0L,
        createdAt = stamp,
        updatedAt = stamp,
        updatedAtMs = now.toEpochMilli(),
    )
}

/** Lease scope for task creates: one pending id per profile. */
internal fun todoDraftIdScope(profile: FamilyMember): String = "todo-add:${profile.key}"

/**
 * Starts a task create on a process-owned scope, with the draft-id lease every
 * other write surface uses. The client-installed receipt path and the refresh
 * survive a dismissed sheet; only the sheet's stale UI callbacks are suppressed.
 */
internal fun launchTaskCreateSave(
    scope: CoroutineScope,
    task: TodoItem,
    gateway: TodoMutationGateway,
    todoDraftIds: TransactionDraftIdStore,
    leaseScope: String,
    isUiActive: () -> Boolean,
    onWriteSucceeded: () -> Unit,
    onUiResult: (DraftIdWriteOutcome<TodoUpsertReceipt>) -> Unit,
): Job = scope.launch {
    val result = gateway.create(task.owner, task)
    val leaseReset =
        result !is ConvexResult.Ok || todoDraftIds.rotateAfterAcceptance(leaseScope, task.id)
    val outcome = draftIdWriteOutcome(result, leaseReset)
    outcome.onServerAccepted {
        // The refresh belongs to the screen's view model, which outlives this
        // sheet: an accepted task must stay visible after a mid-flight dismiss.
        onWriteSucceeded()
    }
    if (isUiActive()) {
        onUiResult(outcome)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AddTaskSheet(
    owner: FamilyMember,
    onDismiss: () -> Unit,
    onSaved: (String) -> Unit,
    onWriteSucceeded: () -> Unit,
    onCredentialRejected: () -> String?,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    val gateway = remember(application) { application?.todoMutationGateway }
    val fallbackTodoDraftIds = remember { TransactionDraftIdStore() }
    val todoDraftIds = application?.todoDraftIds ?: fallbackTodoDraftIds
    val saveScope = remember(application) { application?.applicationScope }
    val uiActive = remember { AtomicBoolean(true) }
    DisposableEffect(Unit) {
        uiActive.set(true)
        onDispose { uiActive.set(false) }
    }
    // One process-owned id survives dismissal and Activity recreation until
    // the device endpoint confirms acceptance, exactly like the transaction
    // sheet: an ambiguous retry addresses the same server row.
    val draftScope = todoDraftIdScope(owner)
    val draftTaskId = remember(draftScope, todoDraftIds) {
        todoDraftIds.currentId(draftScope)
    }

    var title by rememberSaveable(owner) { mutableStateOf("") }
    var project by rememberSaveable(owner) { mutableStateOf("") }
    var area by rememberSaveable(owner) { mutableStateOf("") }
    var due by rememberSaveable(owner) { mutableStateOf("") }
    var flagged by rememberSaveable(owner) { mutableStateOf(false) }
    var credentialRejected by rememberSaveable(owner) { mutableStateOf(false) }
    var message by rememberSaveable(owner) { mutableStateOf<String?>(null) }
    // Deliberately NOT rememberSaveable: a recreated sheet cannot reconnect to
    // the in-flight job. A fresh sheet reconnects to the same process-owned id
    // and safely retries instead.
    var saving by remember(owner) { mutableStateOf(false) }
    val haptics = rememberLedgerHaptics()
    fun refuse(reason: String) {
        message = reason
        haptics.reject()
    }

    LedgerSheet(
        title = stringResource(R.string.tasks_add_title),
        onDismissRequest = { if (!saving) onDismiss() },
        actions = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(VaultSpace.md),
            ) {
                TextButton(
                    onClick = onDismiss,
                    enabled = !saving,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringResource(R.string.tasks_cancel))
                }
                VaultButton(
                    label = stringResource(
                            if (saving) R.string.tasks_saving else R.string.tasks_save,
                        ),
                    onClick = {
                        val taskTitle = title.trim()
                        val task = prepareTask(
                            AddTaskDraft(
                                title = title,
                                project = project,
                                area = area,
                                due = due,
                                flagged = flagged,
                                owner = owner,
                            ),
                            id = draftTaskId,
                        ).getOrElse {
                            refuse(it.message ?: "Task is invalid")
                            return@VaultButton
                        }
                        val client = gateway
                        if (client == null) {
                            refuse(todoWriteUnavailableMessage(TodoWriteAction.ADD))
                            return@VaultButton
                        }
                        val writeScope = saveScope
                        if (writeScope == null) {
                            refuse(todoWriteUnavailableMessage(TodoWriteAction.ADD))
                            return@VaultButton
                        }
                        saving = true
                        launchTaskCreateSave(
                            scope = writeScope,
                            task = task,
                            gateway = client,
                            todoDraftIds = todoDraftIds,
                            leaseScope = draftScope,
                            isUiActive = uiActive::get,
                            onWriteSucceeded = onWriteSucceeded,
                        ) { outcome ->
                            saving = false
                            val recoveryFailure = if (outcome is DraftIdWriteOutcome.Rejected &&
                                outcome.result === ConvexResult.Unauthorized
                            ) {
                                credentialRejected = true
                                onCredentialRejected()
                            } else {
                                null
                            }
                            val failure = when (outcome) {
                                is DraftIdWriteOutcome.Accepted -> null
                                DraftIdWriteOutcome.AcceptedLeaseResetFailed ->
                                    acceptedTaskLeaseResetFailure
                                is DraftIdWriteOutcome.Rejected ->
                                    todoWriteFailureMessage(TodoWriteAction.ADD, outcome.result)
                            }
                            if (failure == null) {
                                haptics.confirm()
                                onSaved(taskTitle)
                            } else {
                                refuse(recoveryFailure ?: failure)
                            }
                        }
                    },
                    enabled = !saving && !credentialRejected,
                    modifier = Modifier.weight(1f),
                )
            }
        },
    ) {
        LedgerTextField(
            value = title,
            onValueChange = {
                title = it
                message = null
            },
            label = stringResource(R.string.tasks_task_title),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        LedgerTextField(
            value = project,
            onValueChange = { project = it },
            label = stringResource(R.string.tasks_project),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        LedgerTextField(
            value = area,
            onValueChange = { area = it },
            label = stringResource(R.string.tasks_area),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        LedgerDateField(
            value = due,
            optional = true,
            enabled = !saving,
            onValueChange = { due = it },
            label = stringResource(R.string.tasks_due_date),
            modifier = Modifier.fillMaxWidth(),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = flagged, onCheckedChange = { flagged = it })
            Text(stringResource(R.string.tasks_flag_task))
        }
        message?.let { Text(it, color = LocalLedgerTheme.current.colors.loss) }
    }
}
