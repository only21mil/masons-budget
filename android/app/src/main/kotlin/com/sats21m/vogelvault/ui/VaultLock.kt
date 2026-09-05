package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultSpace

internal sealed interface VaultAuthenticationRequest {
    data object AppUnlock : VaultAuthenticationRequest

    data class ProfileSwitch(val target: FamilyMember) : VaultAuthenticationRequest
}

internal data class VaultLockSnapshot(
    val isUnlocked: Boolean = false,
    val isAuthenticating: Boolean = false,
    val error: String? = null,
)

/**
 * Small, Android-free state machine around the system authentication prompt.
 *
 * Keeping the authorization decision outside the callback plumbing makes it
 * testable that a profile never changes before authentication succeeds.
 */
internal class VaultLockController {
    private var isUnlocked = false
    private var activeRequest: VaultAuthenticationRequest? = null
    private var backgroundedDuringAuthentication = false
    private var error: String? = null

    fun snapshot(): VaultLockSnapshot =
        VaultLockSnapshot(
            isUnlocked = isUnlocked,
            isAuthenticating = activeRequest != null,
            error = error,
        )

    fun beginAppUnlock(): Boolean {
        if (activeRequest != null || isUnlocked) return false
        activeRequest = VaultAuthenticationRequest.AppUnlock
        backgroundedDuringAuthentication = false
        error = null
        return true
    }

    fun beginProfileSwitch(
        current: FamilyMember,
        target: FamilyMember,
    ): Boolean {
        if (!isUnlocked || activeRequest != null || current == target) return false
        activeRequest = VaultAuthenticationRequest.ProfileSwitch(target)
        backgroundedDuringAuthentication = false
        error = null
        return true
    }

    /**
     * Returns the profile that may now be applied, if this was a switch request.
     */
    fun authenticationSucceeded(): FamilyMember? {
        val target = (activeRequest as? VaultAuthenticationRequest.ProfileSwitch)?.target
        isUnlocked = true
        activeRequest = null
        backgroundedDuringAuthentication = false
        error = null
        return target
    }

    fun authenticationErrored(message: String) {
        val wasUnlock = activeRequest is VaultAuthenticationRequest.AppUnlock
        if (wasUnlock || backgroundedDuringAuthentication) {
            isUnlocked = false
        }
        activeRequest = null
        backgroundedDuringAuthentication = false
        error = message
    }

    /**
     * Leaving the app always relocks it. A system credential activity may stop
     * this activity while its request is alive; in that case the result callback
     * decides whether the vault may reopen.
     */
    fun backgrounded() {
        if (activeRequest == null) {
            isUnlocked = false
            error = null
        } else {
            backgroundedDuringAuthentication = true
        }
    }
}

@Composable
internal fun VaultLockedScreen(
    state: VaultLockSnapshot,
    onUnlock: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalLedgerTheme.current.colors
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .background(colors.background)
                .padding(VaultSpace.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(VaultSpace.md, Alignment.CenterVertically),
    ) {
        Icon(
            imageVector = Icons.Filled.Lock,
            contentDescription = null,
            tint = colors.bitcoin,
        )
        Text(
            text = stringResource(R.string.vault_locked_title),
            style = MaterialTheme.typography.headlineSmall,
            color = colors.foreground,
        )
        Text(
            text = state.error ?: stringResource(R.string.vault_locked_detail),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.foregroundSecondary,
        )
        VaultButton(
            label = stringResource(
                if (state.isAuthenticating) R.string.vault_unlock_in_progress else R.string.vault_unlock_action,
            ),
            enabled = !state.isAuthenticating,
            onClick = onUnlock,
        )
    }
}
