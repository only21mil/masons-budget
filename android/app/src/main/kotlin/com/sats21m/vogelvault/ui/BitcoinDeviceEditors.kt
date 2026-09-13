package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.BitcoinDeleteKind
import com.sats21m.vogelvault.data.PendingBtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Slice
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.ConvexFailure
import com.sats21m.vogelvault.data.ConvexServerRejection
import com.sats21m.vogelvault.data.DeviceCapabilities
import com.sats21m.vogelvault.data.DeviceCapability
import com.sats21m.vogelvault.data.convexWriteFailureMessage
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.components.LedgerTextField
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.domain.BtcAccount
import java.time.LocalDate
import java.util.UUID
import kotlinx.coroutines.launch

/** Sheet-level defense when access changes after a navigation button was rendered. */
@Composable
internal fun WriteAccessNotice(viewer: FamilyMember, capability: DeviceCapability): Boolean {
    val application = LocalContext.current.applicationContext as? VaultApplication
    val reason = (application?.deviceCapabilities ?: DeviceCapabilities()).unavailableReason(viewer, capability)
    if (reason != null) Text(reason)
    return reason != null
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WriteAccessBlockedSheet(viewer: FamilyMember, capability: DeviceCapability, onDismiss: () -> Unit): Boolean {
    val application = LocalContext.current.applicationContext as? VaultApplication
    val reason = (application?.deviceCapabilities ?: DeviceCapabilities()).unavailableReason(viewer, capability)
    if (reason != null) ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(VaultSpace.md)) {
            Text(reason)
            TextButton(onClick = onDismiss) { Text("Close") }
        }
    }
    return reason != null
}

@Composable
internal fun BitcoinDeleteAction(
    viewer: FamilyMember,
    kind: BitcoinDeleteKind,
    entityId: String,
    owner: FamilyMember,
    updatedAtMs: Long,
    onWriteSucceeded: () -> Unit,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    val reason = (application?.deviceCapabilities ?: DeviceCapabilities())
        .unavailableReason(viewer, DeviceCapability.BITCOIN)
        ?: if (viewer.ledgerOwner != owner.ledgerOwner || (kind == BitcoinDeleteKind.BILL_PAY && !owner.isAdult)) "This Bitcoin record cannot be changed from this profile." else null
        ?: if (updatedAtMs <= 0L) "Refresh this record before deleting it." else null
    var confirming by rememberSaveable(entityId) { mutableStateOf(false) }
    var working by remember(entityId) { mutableStateOf(false) }
    var failure by rememberSaveable(entityId) { mutableStateOf<String?>(null) }
    Column {
        TextButton(onClick = { confirming = true }, enabled = reason == null && !working) { Text("Delete") }
        (failure ?: reason)?.let { Text(it) }
    }
    if (confirming) AlertDialog(
        onDismissRequest = { if (!working) confirming = false },
        title = { Text("Delete this Bitcoin record?") },
        text = { Text("The change will update the shared ledger and account balances.") },
        dismissButton = { TextButton(onClick = { confirming = false }, enabled = !working) { Text("Cancel") } },
        confirmButton = {
            TextButton(enabled = !working && reason == null, onClick = {
                val app = application ?: return@TextButton
                working = true
                app.applicationScope.launch {
                    val result = app.deviceMutationClient.mutate(
                        ConvexMutation.DeleteBitcoinFromDevice(kind, entityId, owner, updatedAtMs),
                    )
                    working = false
                    failure = convexWriteFailureMessage("Record not deleted", result)
                    if (result is ConvexResult.Ok) {
                        confirming = false
                        onWriteSucceeded()
                    }
                }
            }) { Text(if (working) "Deleting…" else "Delete") }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BtcAccountEntrySheet(
    viewer: FamilyMember,
    balance: Slice<BtcBalance?>,
    balanceReadOwner: FamilyMember?,
    onDismiss: () -> Unit,
    onWriteSucceeded: () -> Unit,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    var label by rememberSaveable(viewer) { mutableStateOf("") }
    var custodyWire by rememberSaveable(viewer) { mutableStateOf(Custody.SELF_CUSTODY.key) }
    var working by remember { mutableStateOf(false) }
    var failure by rememberSaveable { mutableStateOf<String?>(null) }
    var conflictedSnapshot by rememberSaveable(viewer) { mutableStateOf<String?>(null) }
    val restored = remember(viewer, application) { runCatching { application?.btcAccountDrafts?.current(viewer) } }
    var pending by remember(viewer) { mutableStateOf(restored.getOrNull()) }
    val snapshot = accountWriteSnapshot(viewer, balance, balanceReadOwner)
    val validation = if (pending != null) null else accountNameError(label, snapshot.getOrNull()?.accounts.orEmpty())
    val readFailure = if (pending != null) null else snapshot.exceptionOrNull()?.message
        ?: if (conflictedSnapshot != null && snapshot.getOrNull()?.identity == conflictedSnapshot) {
            "The balance changed. Close and refresh Bitcoin before trying again."
        } else null
    ModalBottomSheet(onDismissRequest = { if (!working) onDismiss() }) {
        Column(Modifier.fillMaxWidth().padding(VaultSpace.md), verticalArrangement = Arrangement.spacedBy(VaultSpace.sm)) {
            Text("Add Bitcoin account")
            if (!viewer.isAdult) {
                Text("Only the household profiles can add Bitcoin accounts.")
                return@Column
            }
            if (WriteAccessNotice(viewer, DeviceCapability.BITCOIN)) return@Column
            if (restored.isFailure || readFailure != null) {
                Text(readFailure ?: "The pending account request could not be read on this phone.")
                TextButton(onClick = onDismiss) { Text("Close") }
                return@Column
            }
            LedgerTextField(value = pending?.label ?: label, onValueChange = { label = it }, label = "Account name", placeholder = "Coldcard, River, Phoenix", enabled = !working && pending == null)
            Custody.entries.forEach { custody ->
                TextButton(onClick = { custodyWire = custody.key }, enabled = !working && pending == null) {
                    Text(if ((pending?.custodyKey ?: custodyWire) == custody.key) "✓ ${custody.label}" else custody.label)
                }
            }
            Text("Starts at 0 sats. Buys, bill pays, and transfers change the balance.")
            validation?.let { Text(it) }
            failure?.let { Text(it) }
            if (pending != null) Text("Retry sends the saved account request with its original balance revision.")
            VaultButton(label = if (working) "Saving…" else "Save", enabled = !working && validation == null, onClick = {
                val app = application ?: return@VaultButton
                val denial = app.deviceCapabilities.unavailableReason(viewer, DeviceCapability.BITCOIN)
                if (denial != null) { failure = denial; return@VaultButton }
                val request = runCatching {
                    pending ?: snapshot.getOrThrow().let { loaded ->
                        app.btcAccountDrafts.stage(viewer, PendingBtcAccount(
                            newAccountKey(label, viewer), viewer.ledgerOwner.key, label.trim(),
                            custodyWire, loaded.asOf, loaded.baseUpdatedAtMs,
                        ))
                    }
                }.getOrElse {
                    failure = "Account request could not be prepared. Close and refresh before trying again."
                    return@VaultButton
                }
                pending = request
                working = true
                app.applicationScope.launch {
                    val result = app.deviceMutationClient.mutate(request.mutation())
                    working = false
                    failure = convexWriteFailureMessage("Account not saved", result)
                    if ((accountRevisionRejected(result) || accountValidationRejected(result)) &&
                        app.btcAccountDrafts.release(viewer, request)) {
                        label = request.label
                        custodyWire = request.custodyKey
                        if (accountRevisionRejected(result)) {
                            conflictedSnapshot = "${request.baseUpdatedAtMs}:${request.asOf}"
                        }
                        pending = null
                    }
                    if (result is ConvexResult.Ok) {
                        if (app.btcAccountDrafts.release(viewer, request)) {
                            onWriteSucceeded()
                            onDismiss()
                        } else {
                            failure = "Account saved. Restart the app before adding another account."
                            onWriteSucceeded()
                        }
                    }
                }
            })
        }
    }
}

internal fun accountNameError(name: String, accounts: List<BtcAccount>, pendingKey: String? = null): String? = when {
    name.trim().isEmpty() -> "Enter an account name."
    accounts.any { it.key != pendingKey && it.label.trim().equals(name.trim(), ignoreCase = true) } ->
        "An account with this name already exists."
    else -> null
}

internal fun newAccountKey(name: String, owner: FamilyMember): String {
    val slug = name.trim().lowercase(java.util.Locale.ROOT).replace(Regex("[^a-z0-9]+"), "-").trim('-').ifEmpty { "account" }
    val suffix = "-${owner.ledgerOwner.key}-${UUID.randomUUID().toString().replace("-", "").take(6)}"
    // The server caps account identifiers at 256 characters. Keep the retry suffix intact.
    return "${slug.take(256 - suffix.length)}$suffix"
}

internal fun accountAsOf(loadedAsOf: String?, today: LocalDate = LocalDate.now()): String =
    loadedAsOf ?: "${today}T00:00:00.000Z"

internal data class BtcAccountWriteSnapshot(
    val asOf: String,
    val baseUpdatedAtMs: Long?,
    val accounts: List<BtcAccount>,
) {
    val identity: String get() = "$baseUpdatedAtMs:$asOf"
}

internal fun accountRevisionRejected(result: ConvexResult<*>): Boolean =
    (result as? ConvexResult.Failed)?.failure.let { failure ->
        failure is ConvexFailure.ServerRejected && failure.kind in setOf(
            ConvexServerRejection.TASK_CHANGED, ConvexServerRejection.REVISION_REQUIRED,
        )
    }

internal fun accountValidationRejected(result: ConvexResult<*>): Boolean =
    (result as? ConvexResult.Failed)?.failure ==
        ConvexFailure.ServerRejected(ConvexServerRejection.VALIDATION_REJECTED)

/** Only a complete successful empty read establishes that the create contract is safe. */
internal fun accountWriteSnapshot(
    viewer: FamilyMember,
    balance: Slice<BtcBalance?>,
    readOwner: FamilyMember?,
): Result<BtcAccountWriteSnapshot> = runCatching {
    require(viewer.isAdult) { "Only the household profiles can add Bitcoin accounts." }
    require(readOwner == viewer.ledgerOwner) { "Refresh the Bitcoin balance for this household before adding an account." }
    val document = balance.value
    if (balance.status == Freshness.EMPTY && document == null) {
        BtcAccountWriteSnapshot(accountAsOf(null), null, emptyList())
    } else {
        require(balance.status == Freshness.LIVE && document != null &&
            document.owner.ledgerOwner == viewer.ledgerOwner &&
            (document.updatedAtMs ?: 0L) > 0L && document.asOf.isNotBlank()) {
            "Refresh the Bitcoin balance before adding an account."
        }
        BtcAccountWriteSnapshot(document.asOf, document.updatedAtMs, document.accounts)
    }
}
