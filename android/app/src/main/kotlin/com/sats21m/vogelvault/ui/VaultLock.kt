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
    data object ConnectionChange : VaultAuthenticationRequest

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
internal class VaultLockController(
    private val nowMillis: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private var isUnlocked = false
    private var activeRequest: VaultAuthenticationRequest? = null
    private var backgroundedDuringAuthentication = false
    private var error: String? = null
    private var externalLaunchAt: Long? = null
    private var returnDeadline: Long? = null

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

    fun beginConnectionChange(): Boolean {
        if (!isUnlocked || activeRequest != null) return false
        activeRequest = VaultAuthenticationRequest.ConnectionChange
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
        returnDeadline = null
        error = null
        return target
    }

    fun authenticationErrored(message: String, allowReturnGrace: Boolean = true) {
        val wasUnlock = activeRequest is VaultAuthenticationRequest.AppUnlock
        if (wasUnlock || (backgroundedDuringAuthentication && (!allowReturnGrace || !withinReturnGrace()))) {
            isUnlocked = false
        }
        activeRequest = null
        backgroundedDuringAuthentication = false
        error = message
    }

    /** Only a chooser launched by this activity can arm share-return grace. */
    fun externalActivityLaunched() {
        if (isUnlocked) externalLaunchAt = nowMillis()
    }

    fun externalActivityLaunchFailed() {
        externalLaunchAt = null
    }

    fun foregrounded() {
        externalLaunchAt = null
        if (returnDeadline != null && !withinReturnGrace() && activeRequest == null) {
            isUnlocked = false
        }
        if (activeRequest == null) returnDeadline = null
    }

    /** Active system authentication keeps its callback owner alive across a credential activity. */
    fun backgrounded() {
        val now = nowMillis()
        val launchedHere = externalLaunchAt?.let { now - it in 0 until RETURN_GRACE_MILLIS } == true
        externalLaunchAt = null
        if (activeRequest != null) {
            backgroundedDuringAuthentication = true
            returnDeadline = now + RETURN_GRACE_MILLIS
        } else if (launchedHere && isUnlocked) {
            returnDeadline = now + RETURN_GRACE_MILLIS
        } else {
            isUnlocked = false
            returnDeadline = null
            error = null
        }
    }

    private fun withinReturnGrace(): Boolean = returnDeadline?.let { nowMillis() < it } == true

    private companion object {
        const val RETURN_GRACE_MILLIS = 30_000L
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
