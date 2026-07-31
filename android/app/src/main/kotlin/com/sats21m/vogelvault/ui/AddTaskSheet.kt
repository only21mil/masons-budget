package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultSpace
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import kotlinx.coroutines.launch

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

    val stamp = now.toString()
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AddTaskSheet(
    owner: FamilyMember,
    onDismiss: () -> Unit,
    onSaved: (String) -> Unit,
    onWriteSucceeded: () -> Unit,
    onCredentialRejected: () -> Unit,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    val gateway = remember(application) { application?.todoMutationGateway }
    val scope = rememberCoroutineScope()

    var title by rememberSaveable(owner) { mutableStateOf("") }
    var project by rememberSaveable(owner) { mutableStateOf("") }
    var area by rememberSaveable(owner) { mutableStateOf("") }
    var due by rememberSaveable(owner) { mutableStateOf("") }
    var flagged by rememberSaveable(owner) { mutableStateOf(false) }
    var saving by rememberSaveable(owner) { mutableStateOf(false) }
    var credentialRejected by rememberSaveable(owner) { mutableStateOf(false) }
    var message by rememberSaveable(owner) { mutableStateOf<String?>(null) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(VaultSpace.lg),
            verticalArrangement = Arrangement.spacedBy(VaultSpace.md),
        ) {
            Text(stringResource(R.string.tasks_add_title))
            OutlinedTextField(
                value = title,
                onValueChange = {
                    title = it
                    message = null
                },
                label = { Text(stringResource(R.string.tasks_task_title)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = project,
                onValueChange = { project = it },
                label = { Text(stringResource(R.string.tasks_project)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = area,
                onValueChange = { area = it },
                label = { Text(stringResource(R.string.tasks_area)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = due,
                onValueChange = { due = it },
                label = { Text(stringResource(R.string.tasks_due_date)) },
                supportingText = { Text(stringResource(R.string.tasks_due_date_hint)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = flagged, onCheckedChange = { flagged = it })
                Text(stringResource(R.string.tasks_flag_task))
            }
            message?.let { Text(it, color = VaultNegative) }
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
                Button(
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
                        ).getOrElse {
                            message = it.message ?: "Task is invalid"
                            return@Button
                        }
                        val client = gateway
                        if (client == null) {
                            message = todoWriteUnavailableMessage(TodoWriteAction.ADD)
                            return@Button
                        }
                        saving = true
                        scope.launch {
                            val result = client.upsert(task)
                            saving = false
                            if (result === ConvexResult.Unauthorized) {
                                credentialRejected = true
                                onCredentialRejected()
                            }
                            val failure = todoWriteFailureMessage(TodoWriteAction.ADD, result)
                            if (failure == null) {
                                onWriteSucceeded()
                                onSaved(taskTitle)
                            } else {
                                message = failure
                            }
                        }
                    },
                    enabled = !saving && !credentialRejected,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        stringResource(
                            if (saving) R.string.tasks_saving else R.string.tasks_save,
                        ),
                    )
                }
            }
            Spacer(Modifier.height(VaultSpace.lg))
        }
    }
}
