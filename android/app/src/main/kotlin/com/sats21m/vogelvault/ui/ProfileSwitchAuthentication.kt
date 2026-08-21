package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember

/**
 * Why a profile switch did not happen.
 *
 * One case per cause, each with its own user-visible message. A profile switch
 * that quietly does nothing is the defect this type exists to prevent: the shell
 * once shipped with the authentication receiver defaulted to a no-op, so
 * selecting a profile neither switched nor complained.
 */
enum class ProfileSwitchRefusal {
    /** The shell was composed without an authentication receiver. A wiring defect. */
    SHELL_NOT_CONNECTED,

    /** No enrolled biometric and no device credential to authenticate against. */
    AUTHENTICATION_UNAVAILABLE,

    /** The request arrived without an authentication requirement. Refused, not applied. */
    AUTHENTICATION_NOT_REQUIRED,

    /** Another authentication is already in flight, or the vault is not open. */
    ALREADY_AUTHENTICATING,

    /** The user cancelled, or the system prompt reported an error. */
    AUTHENTICATION_INCOMPLETE,
}

internal val ProfileSwitchRefusal.titleRes: Int
    get() = when (this) {
        ProfileSwitchRefusal.SHELL_NOT_CONNECTED ->
            R.string.profile_switch_not_connected_title
        ProfileSwitchRefusal.AUTHENTICATION_UNAVAILABLE ->
            R.string.profile_switch_unavailable_title
        ProfileSwitchRefusal.AUTHENTICATION_NOT_REQUIRED ->
            R.string.profile_switch_not_required_title
        ProfileSwitchRefusal.ALREADY_AUTHENTICATING ->
            R.string.profile_switch_already_authenticating_title
        ProfileSwitchRefusal.AUTHENTICATION_INCOMPLETE ->
            R.string.profile_switch_incomplete_title
    }

internal val ProfileSwitchRefusal.detailRes: Int
    get() = when (this) {
        ProfileSwitchRefusal.SHELL_NOT_CONNECTED ->
            R.string.profile_switch_not_connected_detail
        ProfileSwitchRefusal.AUTHENTICATION_UNAVAILABLE ->
            R.string.profile_switch_unavailable_detail
        ProfileSwitchRefusal.AUTHENTICATION_NOT_REQUIRED ->
            R.string.profile_switch_not_required_detail
        ProfileSwitchRefusal.ALREADY_AUTHENTICATING ->
            R.string.profile_switch_already_authenticating_detail
        ProfileSwitchRefusal.AUTHENTICATION_INCOMPLETE ->
            R.string.profile_switch_incomplete_detail
    }

/**
 * The receiver of a [ProfileSwitchRequest] — the biometric gate itself.
 *
 * Android-free on purpose, like [VaultLockController], so the decision that
 * matters can be driven from a test without a device prompt: every path either
 * launches the system prompt or refuses with a named cause. There is no path
 * that reaches [ProfileSwitchRequest.authorize] without the prompt reporting
 * success for that exact target, so a child profile cannot be opened — and an
 * adult profile cannot be opened from a child's — without device authentication.
 *
 * @param authenticationAvailable whether the device can authenticate at all.
 * @param beginAuthentication [VaultLockController.beginProfileSwitch]; false when
 * another authentication already owns the prompt.
 * @param showPrompt launches the system prompt for a profile switch.
 * @param onRefusalChanged the cause to show the user, or null while a switch is
 * genuinely in flight.
 */
internal class ProfileSwitchAuthenticationGate(
    private val authenticationAvailable: () -> Boolean,
    private val beginAuthentication: (FamilyMember, FamilyMember) -> Boolean,
    private val showPrompt: () -> Unit,
    private val onRefusalChanged: (ProfileSwitchRefusal?) -> Unit,
) {
    private var pending: ProfileSwitchRequest? = null

    fun authenticate(request: ProfileSwitchRequest) {
        onRefusalChanged(null)
        // FamilyMember.requiresAuthToSwitch says every switch is authenticated. A
        // request claiming otherwise is a policy regression, so it is refused
        // rather than treated as permission to skip the prompt.
        if (!request.requiresAuthentication) {
            refuse(ProfileSwitchRefusal.AUTHENTICATION_NOT_REQUIRED)
            return
        }
        if (!authenticationAvailable()) {
            refuse(ProfileSwitchRefusal.AUTHENTICATION_UNAVAILABLE)
            return
        }
        if (!beginAuthentication(request.current, request.target)) {
            refuse(ProfileSwitchRefusal.ALREADY_AUTHENTICATING)
            return
        }
        pending = request
        showPrompt()
    }

    /**
     * The prompt succeeded.
     *
     * @param approvedTarget the profile [VaultLockController.authenticationSucceeded]
     * released, or null when the completed authentication was an app unlock rather
     * than a switch.
     */
    fun authenticationApproved(approvedTarget: FamilyMember?) {
        val request = pending ?: return
        pending = null
        if (approvedTarget == null || approvedTarget != request.target) {
            // The controller released a different profile than the user asked for,
            // or none. Refuse rather than guess which one was authenticated.
            refuse(ProfileSwitchRefusal.AUTHENTICATION_INCOMPLETE)
            return
        }
        request.authorize()
    }

    /** The prompt was cancelled or failed. Nothing to do unless a switch was waiting. */
    fun authenticationRefused() {
        if (pending == null) return
        refuse(ProfileSwitchRefusal.AUTHENTICATION_INCOMPLETE)
    }

    private fun refuse(cause: ProfileSwitchRefusal) {
        pending = null
        onRefusalChanged(cause)
    }
}
