package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.material3.Text
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.ReadBootstrapStatus
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultSpace
import kotlinx.coroutines.launch

/**
 * Presence-only bootstrap UI. No token, code, or response body enters Compose state
 * or semantics; the only retained values are non-secret status enums and booleans.
 */
@Composable
internal fun ReadBootstrapConfiguration(
    remoteReadReady: Boolean,
    onConnected: (BootstrapAccess) -> Unit,
    modifier: Modifier = Modifier,
    allowReset: Boolean = false,
    enrollment: BootstrapEnrollment? = null,
    profile: FamilyMember = FamilyMember.VICTOR,
    onSaveReadToken: ((String) -> Unit)? = null,
    authenticate: (suspend () -> Boolean)? = null,
) {
    val context = LocalContext.current
    val application = context.applicationContext as? VaultApplication
    val activeEnrollment = remember(application, enrollment) {
        enrollment ?: application?.let(::ReadOnlyBootstrapEnrollment)
    }
    val available = remember(activeEnrollment) {
        activeEnrollment?.isBundledEnrollmentAvailable() == true
    }
    var access by remember(activeEnrollment, profile) {
        mutableStateOf(
            if (remoteReadReady) {
                activeEnrollment?.currentAccess(profile) ?: BootstrapAccess.NONE
            } else {
                BootstrapAccess.NONE
            },
        )
    }
    LaunchedEffect(remoteReadReady, activeEnrollment, profile) {
        access =
            if (remoteReadReady) {
                activeEnrollment?.currentAccess(profile) ?: BootstrapAccess.NONE
            } else {
                BootstrapAccess.NONE
            }
    }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<ReadBootstrapStatus?>(null) }
    var resetFailed by remember { mutableStateOf(false) }
    var confirmReset by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    var recoveryAuthorized by remember { mutableStateOf(false) }
    var recoveryToken by remember { mutableStateOf("") }
    val authorize: suspend () -> Boolean = authenticate ?: { authenticateConnectionChange(context) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                recoveryToken = ""
                recoveryAuthorized = false
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
    ) {
        Text(
            text = stringResource(access.messageResource()),
        )

        if (access in setOf(BootstrapAccess.NONE, BootstrapAccess.OTHER_PROFILE) && available && activeEnrollment != null) {
            VaultButton(
                label = stringResource(
                    if (busy) R.string.read_bootstrap_connecting else R.string.read_bootstrap_connect,
                ),
                enabled = !busy,
                onClick = {
                    if (busy) return@VaultButton
                    busy = true
                    status = null
                    resetFailed = false
                    scope.launch {
                        val result = activeEnrollment.connect(profile)
                        busy = false
                        status = result.status
                        access = result.access
                        if (
                            result.status == ReadBootstrapStatus.CONNECTED &&
                            result.access != BootstrapAccess.NONE
                        ) {
                            onConnected(result.access)
                        }
                    }
                },
            )
        } else if (access == BootstrapAccess.NONE && !available) {
            Text(stringResource(R.string.read_bootstrap_unavailable))
        }

        status?.takeUnless { it == ReadBootstrapStatus.CONNECTED }?.let { failure ->
            Text(
                text = stringResource(failure.messageResource()),
                color = LocalLedgerTheme.current.colors.loss,
            )
        }

        if (access != BootstrapAccess.NONE && allowReset && profile.isAdult && activeEnrollment != null) {
            if (!confirmReset) {
                OutlinedButton(
                    enabled = !busy,
                    onClick = { confirmReset = true },
                ) {
                    Text(stringResource(R.string.read_bootstrap_reset))
                }
            } else {
                Text(
                    stringResource(R.string.read_bootstrap_reset_warning),
                    color = LocalLedgerTheme.current.colors.loss,
                )
                VaultButton(
                    label = stringResource(R.string.read_bootstrap_reset_confirm),
                    enabled = !busy,
                    onClick = {
                        busy = true
                        scope.launch {
                            if (authorize()) {
                                val remaining = runCatching { activeEnrollment.reset() }.getOrNull()
                                resetFailed = remaining == null
                                if (remaining != null) access = remaining
                            }
                            busy = false
                            confirmReset = false
                            status = null
                        }
                    },
                )
                OutlinedButton(onClick = { confirmReset = false }) {
                    Text(stringResource(R.string.write_cancel))
                }
            }
        }
        if (allowReset && profile.isAdult && activeEnrollment != null && access != BootstrapAccess.NONE) {
            OutlinedButton(enabled = !busy, onClick = {
                busy = true
                scope.launch {
                    if (authorize()) {
                        resetFailed = !runCatching { activeEnrollment.unpair() }.getOrDefault(false)
                        if (!resetFailed) access = BootstrapAccess.NONE
                    }
                    busy = false
                }
            }) { Text(stringResource(R.string.read_bootstrap_unpair)) }
            Text(stringResource(R.string.read_bootstrap_unpair_warning))
        }
        if (profile.isAdult && onSaveReadToken != null) {
            if (!recoveryAuthorized) {
                OutlinedButton(enabled = !busy, onClick = {
                    scope.launch { recoveryAuthorized = authorize() }
                }) { Text(stringResource(R.string.read_bootstrap_recovery)) }
            } else {
                OutlinedTextField(
                    value = recoveryToken,
                    onValueChange = { recoveryToken = it },
                    label = { Text(stringResource(R.string.read_bootstrap_read_token)) },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                VaultButton(label = stringResource(R.string.read_bootstrap_save_read), enabled = recoveryToken.isNotBlank(), onClick = {
                    onSaveReadToken(recoveryToken)
                    recoveryToken = ""
                    recoveryAuthorized = false
                })
                OutlinedButton(onClick = { recoveryToken = ""; recoveryAuthorized = false }) {
                    Text(stringResource(R.string.write_cancel))
                }
            }
        }
        if (resetFailed) {
            Text(
                stringResource(R.string.read_bootstrap_reset_failed),
                color = LocalLedgerTheme.current.colors.loss,
            )
        }
    }
}

private fun BootstrapAccess.messageResource(): Int = when (this) {
    BootstrapAccess.NONE -> R.string.read_bootstrap_unconfigured
    BootstrapAccess.OTHER_PROFILE -> R.string.read_bootstrap_other_profile
    BootstrapAccess.READ_ONLY -> R.string.read_bootstrap_connected_read_only
    BootstrapAccess.READ_AND_TODO_WRITE -> R.string.read_bootstrap_connected_full
}

private fun ReadBootstrapStatus.messageResource(): Int = when (this) {
    ReadBootstrapStatus.CONNECTED -> R.string.read_bootstrap_connected_read_only
    ReadBootstrapStatus.UNAVAILABLE -> R.string.read_bootstrap_unavailable
    ReadBootstrapStatus.INVALID_BUNDLE -> R.string.read_bootstrap_invalid_bundle
    ReadBootstrapStatus.ALREADY_CLAIMED -> R.string.read_bootstrap_already_claimed
    ReadBootstrapStatus.EXPIRED -> R.string.read_bootstrap_expired
    ReadBootstrapStatus.NOT_FOUND -> R.string.read_bootstrap_not_found
    ReadBootstrapStatus.PROOF_REJECTED -> R.string.read_bootstrap_proof_rejected
    ReadBootstrapStatus.SERVER_MISCONFIGURED -> R.string.read_bootstrap_server_misconfigured
    ReadBootstrapStatus.NETWORK_ERROR -> R.string.read_bootstrap_network_error
    ReadBootstrapStatus.INVALID_RESPONSE -> R.string.read_bootstrap_invalid_response
    ReadBootstrapStatus.STORAGE_ERROR -> R.string.read_bootstrap_storage_error
}
