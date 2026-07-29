package com.sats21m.vogelvault

import android.os.Bundle
import android.os.Build
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.fragment.app.FragmentActivity
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.OnboardingView
import com.sats21m.vogelvault.ui.VaultApp
import com.sats21m.vogelvault.ui.VaultLockController
import com.sats21m.vogelvault.ui.VaultLockSnapshot
import com.sats21m.vogelvault.ui.VaultLockedScreen
import com.sats21m.vogelvault.ui.VaultViewModel
import com.sats21m.vogelvault.ui.requiresOnboarding
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme

class MainActivity : FragmentActivity() {
    private val lockController = VaultLockController()
    private val lockState = mutableStateOf(VaultLockSnapshot())
    private lateinit var biometricPrompt: BiometricPrompt
    private lateinit var model: VaultViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as VaultApplication
        model = ViewModelProvider(this, app.viewModelFactory)[VaultViewModel::class.java]
        biometricPrompt =
            BiometricPrompt(
                this,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(
                        result: BiometricPrompt.AuthenticationResult,
                    ) {
                        super.onAuthenticationSucceeded(result)
                        lockController.authenticationSucceeded()?.let(model::switchProfile)
                        publishLockState()
                    }

                    override fun onAuthenticationError(
                        errorCode: Int,
                        errString: CharSequence,
                    ) {
                        super.onAuthenticationError(errorCode, errString)
                        lockController.authenticationErrored(getString(R.string.vault_auth_error))
                        publishLockState()
                    }
                },
            )
        val displayPreferences =
            getSharedPreferences(DISPLAY_PREFERENCES, MODE_PRIVATE)
        setContent {
            VogelVaultTheme {
                val state by model.state.collectAsStateWithLifecycle()
                val currentLockState by lockState
                var displayUnit by remember {
                    mutableStateOf(
                        DisplayUnit.fromStorageKey(
                            displayPreferences.getString(DISPLAY_UNIT_KEY, null),
                        ),
                    )
                }
                var onboardingRequired by remember {
                    mutableStateOf(requiresOnboarding(app.convexConfigSource.current().readiness))
                }

                when {
                    !currentLockState.isUnlocked ->
                        VaultLockedScreen(
                            state = currentLockState,
                            onUnlock = ::requestAppUnlock,
                        )

                    onboardingRequired ->
                        OnboardingView(
                            configurationError = state.remoteConfigurationError,
                            onConfigure = { readToken ->
                                model.enableRemoteRows(readToken)
                                onboardingRequired =
                                    requiresOnboarding(app.convexConfigSource.current().readiness)
                            },
                        )

                    else ->
                        VaultApp(
                            state = state,
                            onNavigate = model::navigate,
                            onSwitchProfile = { target ->
                                requestProfileSwitch(state.activeProfile, target)
                            },
                            onEnableRemoteRows = model::enableRemoteRows,
                            displayUnit = displayUnit,
                            onDisplayUnitChange = { next ->
                                displayUnit = next
                                displayPreferences.edit()
                                    .putString(DISPLAY_UNIT_KEY, next.storageKey)
                                    .apply()
                            },
                        )
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        requestAppUnlock()
    }

    override fun onStop() {
        lockController.backgrounded()
        publishLockState()
        super.onStop()
    }

    private fun requestAppUnlock() {
        if (!::biometricPrompt.isInitialized || !lockController.beginAppUnlock()) return
        publishLockState()
        biometricPrompt.authenticate(promptInfo(forProfileSwitch = false))
    }

    private fun requestProfileSwitch(
        current: FamilyMember,
        target: FamilyMember,
    ) {
        if (target == current) {
            // The shell currently uses this same callback to refresh the active
            // profile. Refreshing does not cross a visibility boundary.
            model.switchProfile(target)
            return
        }
        if (target !in current.allowedSwitchTargets) return
        if (!lockController.beginProfileSwitch(current, target)) return
        publishLockState()
        biometricPrompt.authenticate(promptInfo(forProfileSwitch = true))
    }

    @Suppress("DEPRECATION")
    private fun promptInfo(forProfileSwitch: Boolean): BiometricPrompt.PromptInfo {
        val builder =
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(
                    getString(
                        if (forProfileSwitch) {
                            R.string.vault_profile_prompt_title
                        } else {
                            R.string.vault_auth_prompt_title
                        },
                    ),
                )
                .setSubtitle(
                    getString(
                        if (forProfileSwitch) {
                            R.string.vault_profile_prompt_subtitle
                        } else {
                            R.string.vault_auth_prompt_subtitle
                        },
                    ),
                )
                .setConfirmationRequired(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
        } else {
            // BIOMETRIC_STRONG | DEVICE_CREDENTIAL is not supported on API 29.
            // This compatibility path still requires device-owner authentication.
            builder.setDeviceCredentialAllowed(true)
        }
        return builder.build()
    }

    private fun publishLockState() {
        lockState.value = lockController.snapshot()
    }

    private companion object {
        const val DISPLAY_PREFERENCES = "display_preferences"
        const val DISPLAY_UNIT_KEY = "display_unit"
    }
}
