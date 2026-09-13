package com.sats21m.vogelvault.ui

import android.os.Build
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine

/** One callback for the activity's shared BiometricViewModel, across every purpose. */
internal class VaultAuthenticationCoordinator(
    private val lockController: VaultLockController,
    private val onProfileApproved: (FamilyMember?) -> Unit,
    private val onProfileRefused: () -> Unit,
    private val publishLockState: () -> Unit,
    private val authenticationError: () -> String,
    private val showConnectionPrompt: () -> Unit,
    private val cancelPrompt: () -> Unit,
) {
    private var connection: CancellableContinuation<Boolean>? = null

    val callback = object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            if (!lockController.snapshot().isAuthenticating) return
            val pending = connection
            connection = null
            if (pending != null) {
                // A disposed connection screen cannot authorize its abandoned operation.
                if (pending.isActive) {
                    lockController.authenticationSucceeded()
                    publishLockState()
                    pending.resume(true)
                } else {
                    lockController.authenticationErrored(authenticationError(), allowReturnGrace = false)
                    publishLockState()
                }
            } else {
                onProfileApproved(lockController.authenticationSucceeded())
                publishLockState()
            }
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            authenticationFailed()
        }
    }

    suspend fun authenticateConnectionChange(): Boolean {
        if (!lockController.beginConnectionChange()) return false
        publishLockState()
        return suspendCancellableCoroutine { continuation ->
            connection = continuation
            // Keep ownership until the system's terminal callback. Otherwise a late
            // cancellation callback could consume the next unlock/profile request.
            continuation.invokeOnCancellation { cancelPrompt() }
            if (continuation.isActive) {
                try {
                    showConnectionPrompt()
                } catch (_: RuntimeException) {
                    authenticationFailed()
                }
            } else {
                authenticationFailed()
            }
        }
    }

    private fun authenticationFailed() {
        if (!lockController.snapshot().isAuthenticating) return
        val pending = connection
        connection = null
        lockController.authenticationErrored(authenticationError(), allowReturnGrace = pending?.isActive != false)
        if (pending == null) onProfileRefused()
        publishLockState()
        if (pending?.isActive == true) pending.resume(false)
    }
}

/** The pinned biometric library rejects STRONG | DEVICE_CREDENTIAL on API 29. */
@Suppress("DEPRECATION")
internal fun deviceAuthenticationPromptInfo(
    title: String,
    subtitle: String,
): BiometricPrompt.PromptInfo {
    val builder = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title)
        .setSubtitle(subtitle)
        .setConfirmationRequired(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        builder.setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
    } else {
        builder.setDeviceCredentialAllowed(true)
    }
    return builder.build()
}
