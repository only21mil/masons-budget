package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
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
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultWarning
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
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    val activeEnrollment = remember(application, enrollment) {
        enrollment ?: application?.let(::ReadOnlyBootstrapEnrollment)
    }
    val available = remember(activeEnrollment) {
        activeEnrollment?.isBundledEnrollmentAvailable() == true
    }
    var access by remember(activeEnrollment) {
        mutableStateOf(
            if (remoteReadReady) {
                activeEnrollment?.currentAccess() ?: BootstrapAccess.NONE
            } else {
                BootstrapAccess.NONE
            },
        )
    }
    LaunchedEffect(remoteReadReady, activeEnrollment) {
        access =
            if (remoteReadReady) {
                activeEnrollment?.currentAccess() ?: BootstrapAccess.NONE
            } else {
                BootstrapAccess.NONE
            }
    }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<ReadBootstrapStatus?>(null) }
    var resetFailed by remember { mutableStateOf(false) }
    var confirmReset by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
    ) {
        Text(
            text = stringResource(access.messageResource()),
        )

        if (access == BootstrapAccess.NONE && available && activeEnrollment != null) {
            VaultButton(
                enabled = !busy,
                onClick = {
                    if (busy) return@VaultButton
                    busy = true
                    status = null
                    resetFailed = false
                    scope.launch {
                        val result = activeEnrollment.connect()
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
            ) {
                Text(
                    stringResource(
                        if (busy) R.string.read_bootstrap_connecting else R.string.read_bootstrap_connect,
                    ),
                )
            }
        } else if (access == BootstrapAccess.NONE && !available) {
            Text(stringResource(R.string.read_bootstrap_unavailable))
        }

        status?.takeUnless { it == ReadBootstrapStatus.CONNECTED }?.let { failure ->
            Text(
                text = stringResource(failure.messageResource()),
                color = VaultWarning,
            )
        }

        if (access != BootstrapAccess.NONE && allowReset && activeEnrollment != null) {
            if (!confirmReset) {
                OutlinedButton(
                    enabled = !busy,
                    onClick = { confirmReset = true },
                ) {
                    Text(stringResource(R.string.read_bootstrap_reset))
                }
            } else {
                Text(stringResource(R.string.read_bootstrap_reset_warning), color = VaultWarning)
                VaultButton(
                    enabled = !busy,
                    onClick = {
                        val remaining = runCatching { activeEnrollment.reset() }.getOrNull()
                        resetFailed = remaining == null
                        if (remaining != null) access = remaining
                        confirmReset = false
                        status = null
                    },
                ) {
                    Text(stringResource(R.string.read_bootstrap_reset_confirm))
                }
                OutlinedButton(onClick = { confirmReset = false }) {
                    Text(stringResource(R.string.write_cancel))
                }
            }
        }
        if (resetFailed) {
            Text(stringResource(R.string.read_bootstrap_reset_failed), color = VaultWarning)
        }
    }
}

private fun BootstrapAccess.messageResource(): Int = when (this) {
    BootstrapAccess.NONE -> R.string.read_bootstrap_unconfigured
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
