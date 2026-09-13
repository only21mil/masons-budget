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
import com.sats21m.vogelvault.data.BtcAccountInput
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexResult
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
    accounts: List<BtcAccount>,
    balanceAsOf: String?,
    onDismiss: () -> Unit,
    onWriteSucceeded: () -> Unit,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    var label by rememberSaveable(viewer) { mutableStateOf("") }
    var custodyWire by rememberSaveable(viewer) { mutableStateOf(Custody.SELF_CUSTODY.key) }
    var working by remember { mutableStateOf(false) }
    var failure by rememberSaveable { mutableStateOf<String?>(null) }
    val leaseScope = "bitcoin-account:${viewer.ledgerOwner.key}"
    var pendingKey by rememberSaveable(viewer) { mutableStateOf<String?>(null) }
    val validation = accountNameError(label, accounts, pendingKey)
    ModalBottomSheet(onDismissRequest = { if (!working) onDismiss() }) {
        Column(Modifier.fillMaxWidth().padding(VaultSpace.md), verticalArrangement = Arrangement.spacedBy(VaultSpace.sm)) {
            Text("Add Bitcoin account")
            if (!viewer.isAdult) {
                Text("Only the household profiles can add Bitcoin accounts.")
                return@Column
            }
            if (WriteAccessNotice(viewer, DeviceCapability.BITCOIN)) return@Column
            LedgerTextField(value = label, onValueChange = { label = it }, label = "Account name", placeholder = "Coldcard, River, Phoenix", enabled = !working)
            Custody.entries.forEach { custody ->
                TextButton(onClick = { custodyWire = custody.key }, enabled = !working) {
                    Text(if (custodyWire == custody.key) "✓ ${custody.label}" else custody.label)
                }
            }
            Text("Starts at 0 sats. Buys, bill pays, and transfers change the balance.")
            validation?.let { Text(it) }
            failure?.let { Text(it) }
            VaultButton(label = if (working) "Saving…" else "Save", enabled = !working && validation == null, onClick = {
                val app = application ?: return@VaultButton
                val accountKey = app.transactionDraftIds.currentId(leaseScope) { newAccountKey(label, viewer.ledgerOwner) }
                pendingKey = accountKey
                val account = BtcAccountInput(accountKey, viewer.ledgerOwner, label.trim(),
                    Custody.entries.first { it.key == custodyWire }, 0L, 0L, accountAsOf(balanceAsOf))
                working = true
                app.applicationScope.launch {
                    val result = app.deviceMutationClient.mutate(ConvexMutation.UpsertBtcAccountFromDevice(account))
                    working = false
                    failure = convexWriteFailureMessage("Account not saved", result)
                    if (result is ConvexResult.Ok) {
                        if (app.transactionDraftIds.rotateAfterAcceptance(leaseScope, accountKey)) {
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
    return "$slug-${owner.ledgerOwner.key}-${UUID.randomUUID().toString().replace("-", "").take(6)}"
}

internal fun accountAsOf(loadedAsOf: String?, today: LocalDate = LocalDate.now()): String =
    loadedAsOf ?: "${today}T00:00:00.000Z"
