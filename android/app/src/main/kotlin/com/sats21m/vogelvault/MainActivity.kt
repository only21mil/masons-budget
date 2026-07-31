package com.sats21m.vogelvault

import android.app.KeyguardManager
import android.os.Bundle
import android.os.Build
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.getSystemService
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.fragment.app.FragmentActivity
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.notifications.BudgetNotificationController
import com.sats21m.vogelvault.ui.OnboardingView
import com.sats21m.vogelvault.ui.ProfileSwitchAuthenticationGate
import com.sats21m.vogelvault.ui.ProfileSwitchRefusal
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
    private val profileSwitchRefusal = mutableStateOf<ProfileSwitchRefusal?>(null)
    private lateinit var biometricPrompt: BiometricPrompt
    private lateinit var model: VaultViewModel
    private lateinit var budgetNotifications: BudgetNotificationController

    /**
     * The receiver of a profile-switch request.
     *
     * This connection is the whole feature: the prompt machinery below only runs
     * because the shell hands its request here. It shipped once with the shell
     * side defaulted to a no-op, so any profile could be selected — and nothing
     * ever reached the prompt.
     */
    private val profileSwitchGate by lazy {
        ProfileSwitchAuthenticationGate(
            authenticationAvailable = ::deviceAuthenticationAvailable,
            beginAuthentication = lockController::beginProfileSwitch,
            showPrompt = {
                publishLockState()
                biometricPrompt.authenticate(promptInfo(forProfileSwitch = true))
            },
            onRefusalChanged = { cause -> profileSwitchRefusal.value = cause },
        )
    }

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
                        // The controller releases the authenticated profile; the
                        // gate applies it, and only if it is the one the user
                        // asked for. An app unlock releases nothing.
                        profileSwitchGate.authenticationApproved(
                            lockController.authenticationSucceeded(),
                        )
                        publishLockState()
                    }

                    override fun onAuthenticationError(
                        errorCode: Int,
                        errString: CharSequence,
                    ) {
                        super.onAuthenticationError(errorCode, errString)
                        lockController.authenticationErrored(getString(R.string.vault_auth_error))
                        // A cancelled or failed prompt refuses the switch and says
                        // so. There is no fallback that applies it anyway.
                        profileSwitchGate.authenticationRefused()
                        publishLockState()
                    }
                },
            )
        val displayPreferences =
            getSharedPreferences(DISPLAY_PREFERENCES, MODE_PRIVATE)
        budgetNotifications = BudgetNotificationController(this)
        setContent {
            VogelVaultTheme {
                val state by model.state.collectAsStateWithLifecycle()
                val effectiveReadReady by app.effectiveReadReady.collectAsStateWithLifecycle()
                val currentLockState by lockState
                var displayUnit by remember {
                    mutableStateOf(
                        DisplayUnit.fromStorageKey(
                            displayPreferences.getString(DISPLAY_UNIT_KEY, null),
                        ),
                    )
                }
                when {
                    !currentLockState.isUnlocked ->
                        VaultLockedScreen(
                            state = currentLockState,
                            onUnlock = ::requestAppUnlock,
                        )

                    requiresOnboarding(effectiveReadReady) ->
                        OnboardingView(
                            configurationError = state.remoteConfigurationError,
                            remoteReadReady = effectiveReadReady,
                            onConnected = model::enableStoredRemoteRows,
                        )

                    else -> {
                        // Budget alerts are evaluated only behind the unlock and
                        // onboarding gates. A locked vault must not push the
                        // household's spending into the notification shade.
                        LaunchedEffect(
                            state.activeProfile,
                            state.data.budget,
                            state.data.transactions,
                            state.staleAuthorization,
                        ) {
                            budgetNotifications.evaluateAndNotify(state)
                        }
                        VaultApp(
                            state = state,
                            onNavigate = model::navigate,
                            // Applies a switch the gate has already authenticated,
                            // and doubles as the shell's refresh of the active
                            // profile. VaultViewModel.switchProfile still refuses a
                            // target this profile may not reach.
                            onSwitchProfile = model::switchProfile,
                            onRequestProfileSwitchAuthentication = profileSwitchGate::authenticate,
                            profileSwitchRefusal = profileSwitchRefusal.value,
                            onEnableRemoteRows = model::enableRemoteRows,
                            onRemoteRowsConnected = model::enableStoredRemoteRows,
                            // Every accepted write reaches this one authoritative
                            // row-refresh trigger without resetting profile-scoped
                            // navigation state as a real profile switch does.
                            onWriteSucceeded = model::refreshActiveProfile,
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
    }

    override fun onResume() {
        super.onResume()
        requestAppUnlock()
    }

    override fun onStop() {
        lockController.backgrounded()
        publishLockState()
        budgetNotifications.cancelVisibleAlerts()
        super.onStop()
    }

    private fun requestAppUnlock() {
        if (!::biometricPrompt.isInitialized || !lockController.beginAppUnlock()) return
        publishLockState()
        biometricPrompt.authenticate(promptInfo(forProfileSwitch = false))
    }

    /**
     * Whether this device can authenticate a profile switch at all.
     *
     * Checked before the prompt so an unenrolled device is told why the switch was
     * refused, rather than being shown a prompt that cannot succeed. A device with
     * no screen lock cannot switch profiles: there is deliberately no fallback
     * that lets the switch through, because that would open a child's ledger — or
     * the household's — to whoever is holding the phone.
     */
    private fun deviceAuthenticationAvailable(): Boolean {
        val manager = BiometricManager.from(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return manager.canAuthenticate(BIOMETRIC_STRONG or DEVICE_CREDENTIAL) ==
                BiometricManager.BIOMETRIC_SUCCESS
        }
        // On API 29 canAuthenticate cannot be asked about DEVICE_CREDENTIAL, while
        // the prompt itself still accepts one via setDeviceCredentialAllowed. A
        // secured keyguard is exactly what that path authenticates against.
        if (manager.canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS) {
            return true
        }
        return getSystemService<KeyguardManager>()?.isDeviceSecure == true
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
