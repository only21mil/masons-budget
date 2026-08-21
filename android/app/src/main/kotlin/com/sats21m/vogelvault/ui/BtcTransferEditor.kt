package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.onServerAccepted
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultWarning
import java.time.LocalDate
import java.util.UUID

internal const val BTC_TRANSFER_ACTION_TEST_TAG = "btc-transfer-action"
internal const val BTC_TRANSFER_SAVE_TEST_TAG = "btc-transfer-save"

@Composable
internal fun BtcTransferEntryAction(onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .testTag(BTC_TRANSFER_ACTION_TEST_TAG),
    ) {
        Text(stringResource(R.string.btc_transfer_add_action))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BtcTransferEntrySheet(
    viewer: FamilyMember,
    accounts: List<BtcAccount>,
    onDismiss: () -> Unit,
    onWriteSucceeded: () -> Unit,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    val gateway = remember(application) { application?.btcTransferMutationGateway }
    val transferDraftIds = application?.btcTransferDraftIds
    val writeScope = remember(application) { application?.applicationScope }
    val eligibleAccounts = remember(viewer, accounts) {
        accounts
            .asSequence()
            .filter { it.owner == viewer.ledgerOwner }
            .distinctBy { it.key }
            .toList()
    }
    val accountKeys = remember(eligibleAccounts) { eligibleAccounts.map(BtcAccount::key) }
    val transferId = remember(BTC_TRANSFER_SOURCE_FILE) {
        transferDraftIds?.currentId(BTC_TRANSFER_SOURCE_FILE) ?: "android-${UUID.randomUUID()}"
    }
    var date by rememberSaveable(viewer) { mutableStateOf(LocalDate.now().toString()) }
    var fromAccountKey by rememberSaveable(viewer, accountKeys) {
        mutableStateOf(accountKeys.firstOrNull().orEmpty())
    }
    var toAccountKey by rememberSaveable(viewer, accountKeys) {
        mutableStateOf(accountKeys.getOrNull(1) ?: accountKeys.firstOrNull().orEmpty())
    }
    var sats by rememberSaveable(viewer) { mutableStateOf("") }
    var feeSats by rememberSaveable(viewer) { mutableStateOf("") }
    var note by rememberSaveable(viewer) { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var submitting by remember { mutableStateOf(false) }

    ModalBottomSheet(
        onDismissRequest = { if (!submitting) onDismiss() },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(VaultSpace.md),
            verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
        ) {
            Text(
                stringResource(R.string.btc_transfer_editor_title),
                style = MaterialTheme.typography.titleLarge,
            )
            Text(stringResource(R.string.btc_transfer_editor_detail))
            TransferEditorField(
                value = date,
                onValueChange = { date = it },
                label = stringResource(R.string.btc_transfer_date_label),
            )
            if (eligibleAccounts.size < 2) {
                Text(
                    stringResource(R.string.btc_transfer_accounts_unavailable),
                    color = VaultWarning,
                )
            } else {
                BtcAccountPicker(
                    label = stringResource(R.string.btc_transfer_from_account_label),
                    selected = eligibleAccounts.firstOrNull { it.key == fromAccountKey },
                    accounts = eligibleAccounts,
                    onSelected = { fromAccountKey = it.key },
                )
                BtcAccountPicker(
                    label = stringResource(R.string.btc_transfer_to_account_label),
                    selected = eligibleAccounts.firstOrNull { it.key == toAccountKey },
                    accounts = eligibleAccounts,
                    onSelected = { toAccountKey = it.key },
                )
                TransferEditorField(
                    value = sats,
                    onValueChange = { sats = it },
                    label = stringResource(R.string.btc_transfer_sats_label),
                    keyboardType = KeyboardType.Number,
                )
                TransferEditorField(
                    value = feeSats,
                    onValueChange = { feeSats = it },
                    label = stringResource(R.string.btc_transfer_fee_label),
                    keyboardType = KeyboardType.Number,
                )
                TransferEditorField(
                    value = note,
                    onValueChange = { note = it },
                    label = stringResource(R.string.btc_transfer_note_label),
                )
            }
            message?.let { Text(it, color = VaultWarning) }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                TextButton(onClick = onDismiss, enabled = !submitting) {
                    Text(stringResource(R.string.write_cancel))
                }
                Button(
                    modifier = Modifier.testTag(BTC_TRANSFER_SAVE_TEST_TAG),
                    enabled = !submitting && eligibleAccounts.size >= 2,
                    onClick = {
                        val draft = btcTransferWriteRequest(
                            viewer = viewer,
                            stableTransferId = transferId,
                            date = date,
                            fromAccountKey = fromAccountKey,
                            toAccountKey = toAccountKey,
                            satsText = sats,
                            feeSatsText = feeSats,
                            note = note,
                            accounts = eligibleAccounts,
                        )
                        draft.fold(
                            onSuccess = { transfer ->
                                if (gateway == null || writeScope == null || transferDraftIds == null) {
                                    message = "Bitcoin transfer not saved: the app write client is unavailable."
                                } else {
                                    submitting = true
                                    launchBtcTransferSave(
                                        scope = writeScope,
                                        transfer = transfer,
                                        gateway = gateway,
                                        transferDraftIds = transferDraftIds,
                                    ) { result ->
                                        submitting = false
                                        val failure = btcTransferWriteFailureMessage(result)
                                        result.onServerAccepted(onWriteSucceeded)
                                        if (failure == null) {
                                            onDismiss()
                                        } else {
                                            message = failure
                                        }
                                    }
                                }
                            },
                            onFailure = { error ->
                                message = error.message ?: "Bitcoin transfer not saved: invalid input."
                            },
                        )
                    },
                ) {
                    Text(stringResource(R.string.write_save))
                }
            }
        }
    }
}

@Composable
private fun BtcAccountPicker(
    label: String,
    selected: BtcAccount?,
    accounts: List<BtcAccount>,
    onSelected: (BtcAccount) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium)
        Box {
            Button(
                onClick = { expanded = true },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    selected?.let { "${it.label} · ${Money.formatSats(it.sats)}" }
                        ?: stringResource(R.string.btc_transfer_select_account),
                )
            }
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
            ) {
                accounts.forEach { account ->
                    DropdownMenuItem(
                        text = {
                            Text("${account.label} · ${Money.formatSats(account.sats)}")
                        },
                        onClick = {
                            expanded = false
                            onSelected(account)
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun TransferEditorField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}
