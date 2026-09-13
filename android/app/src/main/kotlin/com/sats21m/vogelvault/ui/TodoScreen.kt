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
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import com.sats21m.vogelvault.ui.components.LedgerTextField
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
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.components.Kpi
import com.sats21m.vogelvault.ui.components.KpiStrip
import com.sats21m.vogelvault.ui.components.LedgerGlyphs
import com.sats21m.vogelvault.ui.components.StateBlock
import com.sats21m.vogelvault.ui.components.ledgerColor
import com.sats21m.vogelvault.ui.components.ledgerRowReveal
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultBlack
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultSurface
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.rememberLedgerHaptics
import java.time.Instant
import java.time.ZoneId

/**
 * The normaliser fills `project` with "Inbox" for an unfiled todo rather than
 * leaving it unset, so this screen treats that value as "not filed". See
 * DOMAIN_ADOPTION.md in this app's package root; the Linux client's Tasks page
 * carries the identical rule.
 */
private const val UNFILED_TODO_PROJECT = "Inbox"

/** A refreshed revision keeps the same arrival; a missing revision disables it. */
internal fun todayRowRevealKey(updatedAt: Long?): String? = updatedAt?.let { "today" }

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
    listState: LazyListState = rememberLazyListState(),
) {
    val ledgerTokens = LocalLedgerTheme.current
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
    val moneyOut = remember(state.activeProfile, state.now, state.data.transactions, state.data.btcBillPays) {
        moneyOutToday(state)
    }
    var credentialStored by remember(application, viewer) {
        mutableStateOf(application?.hasTodoWriteCredential(viewer) == true)
    }
    var draft by remember { mutableStateOf("") }
    var draftRevision by remember { mutableStateOf(0L) }
    var pendingAddId by remember(viewer) { mutableStateOf<String?>(null) }
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

    val canAdd = credentialStored && draft.isNotBlank() && pendingAddId !in writes.busyIds

    LaunchedEffect(todos, viewer, today) {
        localTodos = todosForToday(writes.filterIncoming(todos), viewer, today)
    }

    val haptics = rememberLedgerHaptics()
    fun mutate(
        todo: TodoItem,
        action: TodoWriteAction,
        baseUpdatedAtMs: Long?,
        onAccepted: () -> Unit = {},
    ) {
        writes.upsert(todo, baseUpdatedAtMs, action) {
            localTodos = (localTodos.filterNot { it.id == todo.id } + todo).sortedWith(TODO_ORDER)
            onAccepted()
        }
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = ledgerTokens.colors.background,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        LazyColumn(
            Modifier.padding(padding).fillMaxSize(),
            state = listState,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(ledgerTokens.density.screenGutter),
            verticalArrangement = Arrangement.spacedBy(ledgerTokens.density.sectionTopSpace),
        ) {
            item {
                Column {
                    Text("Today", style = ledgerTokens.type.screenTitle, color = ledgerTokens.colors.foreground)
                    Text(
                        stringResource(R.string.todo_today_subtitle),
                        style = ledgerTokens.type.screenSubtitle,
                        color = ledgerTokens.colors.foregroundSecondary,
                    )
                }
            }

            item {
                KpiStrip(
                    listOf(
                        Kpi(
                            "Money out",
                            moneyOut?.let { Money.formatUsd(it.totalCents) } ?: "—",
                            hint = moneyOut?.let { "${it.sourceIds.size} ledger rows" },
                            tone = com.sats21m.vogelvault.ui.theme.VaultNegative,
                        ),
                        Kpi(
                            "Completed tasks",
                            localTodos.count(TodoItem::done).toString(),
                            hint = "Completed items stay reopenable",
                        ),
                    ),
                )
            }

            if (!credentialStored) {
                item {
                    TodoWriteReprovisionCard()
                }
            }

            item {
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    LedgerTextField(
                        value = draft,
                        onValueChange = {
                            draft = it
                            draftRevision++
                        },
                        modifier = Modifier.weight(1f),
                        placeholder = stringResource(R.string.todo_new_task),
                        prefixGlyph = LedgerGlyphs.Calendar,
                        prefixTint = ledgerTokens.colors.gain,
                        enabled = credentialStored,
                    )
                    Spacer(Modifier.width(VaultSpace.sm))
                    IconButton(
                        enabled = canAdd,
                        onClick = {
                            if (pendingAddId in writes.busyIds) return@IconButton
                            val submittedRevision = draftRevision
                            val todo = newTodo(
                                title = draft,
                                owner = viewer,
                                today = today,
                                now = Instant.now(),
                            )
                            pendingAddId = todo.id
                            mutate(todo, TodoWriteAction.ADD, null) {
                                // An accepted save must not erase typing made while it was pending.
                                if (draftRevision == submittedRevision) draft = ""
                                pendingAddId = null
                                haptics.confirm()
                            }
                        },
                    ) {
                        Icon(
                            LedgerGlyphs.Plus,
                            contentDescription = stringResource(R.string.todo_add),
                            tint = if (canAdd) {
                                ledgerTokens.colors.bitcoin
                            } else {
                                ledgerTokens.colors.foregroundTertiary
                            },
                        )
                    }
                }
            }

            // Demo, stale, loading and failed reads all say so, exactly as the
            // read-only surfaces do. EMPTY is left to the emptiness message below.
            // LOADING is left to the suppressed branch below so the skeleton shows once.
            if (
                slice.status != Freshness.LIVE &&
                slice.status != Freshness.EMPTY &&
                slice.status != Freshness.LOADING
            ) {
                item { StateBlock(slice.status, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() }) }
            }

            // Suppressed figures mean the read itself is not trustworthy. Editing
            // rows derived from it would write a guess back to the household, so the
            // state is named instead of the list being drawn.
            if (slice.suppressFigures) {
                item { StateBlock(slice.status, action = { com.sats21m.vogelvault.ui.components.StateBlockRetry() }) }
            } else if (localTodos.isEmpty()) {
                item {
                    Text(
                        stringResource(R.string.todo_empty),
                        color = ledgerColor(VaultTextDim),
                        modifier = Modifier.padding(VaultSpace.md),
                    )
                }
            } else {
                itemsIndexed(localTodos, key = { _, todo -> todo.id }) { index, todo ->
                    Box(Modifier.ledgerRowReveal(index, todayRowRevealKey(slice.updatedAt))) {
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
                                val changed = todo.withCompletion(!todo.done, Instant.now())
                                mutate(changed, TodoWriteAction.UPDATE, todo.updatedAtMs) {
                                    haptics.toggle(changed.done)
                                }
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
                    haptics.confirm()
                    editing = null
                }
            },
        )
    }
}

/** Directs task reprovisioning through the backend-attested bootstrap flow. */
@Composable
internal fun TodoWriteReprovisionCard() {
    Column(
        Modifier
            .fillMaxWidth()
            .background(ledgerColor(VaultSurface))
            .padding(VaultSpace.md),
        verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
    ) {
        Text(stringResource(R.string.todo_write_access_title), color = ledgerColor(VaultCream))
        Text(
            stringResource(R.string.todo_write_access_detail),
            style = MaterialTheme.typography.bodySmall,
            color = ledgerColor(VaultTextDim),
        )
    }
}
