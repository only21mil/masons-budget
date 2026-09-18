package com.sats21m.vogelvault

import android.app.KeyguardManager
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.toArgb
import androidx.core.content.getSystemService
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.fragment.app.FragmentActivity
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.notifications.BudgetNotificationController
import com.sats21m.vogelvault.ui.ConnectionAuthenticationHost
import com.sats21m.vogelvault.ui.LedgerUiPreferences
import com.sats21m.vogelvault.ui.LedgerUiSettings
import com.sats21m.vogelvault.ui.OnboardingView
import com.sats21m.vogelvault.ui.ProfileSwitchAuthenticationGate
import com.sats21m.vogelvault.ui.ProfileSwitchRefusal
import com.sats21m.vogelvault.ui.VaultApp
import com.sats21m.vogelvault.ui.VaultAuthenticationCoordinator
import com.sats21m.vogelvault.ui.VaultLockController
import com.sats21m.vogelvault.ui.VaultLockSnapshot
import com.sats21m.vogelvault.ui.VaultLockedScreen
import com.sats21m.vogelvault.ui.VaultViewModel
import com.sats21m.vogelvault.ui.deviceAuthenticationPromptInfo
import com.sats21m.vogelvault.ui.purgeExportedCsvFiles
import com.sats21m.vogelvault.ui.requiresOnboarding
import com.sats21m.vogelvault.ui.refreshMarketQuotesPeriodically
import com.sats21m.vogelvault.ui.theme.LedgerPalettes
import com.sats21m.vogelvault.ui.theme.LedgerTheme
import com.sats21m.vogelvault.ui.theme.LedgerTreatment
import kotlinx.coroutines.launch

internal data class LedgerSystemBarAppearance(
    val background: Int,
    val useDarkIcons: Boolean,
)

internal fun ledgerSystemBarAppearance(treatment: LedgerTreatment): LedgerSystemBarAppearance =
    when (treatment) {
        LedgerTreatment.TERMINAL_DARK -> LedgerSystemBarAppearance(
            background = LedgerPalettes.TerminalDark.background.toArgb(),
            useDarkIcons = false,
        )
        LedgerTreatment.DAYLIGHT_LIGHT -> LedgerSystemBarAppearance(
            background = LedgerPalettes.DaylightLight.background.toArgb(),
            useDarkIcons = true,
        )
    }

class MainActivity : FragmentActivity(), ConnectionAuthenticationHost {
    private val lockController = VaultLockController(SystemClock::elapsedRealtime)
    private val lockState = mutableStateOf(VaultLockSnapshot())
    private val profileSwitchRefusal = mutableStateOf<ProfileSwitchRefusal?>(null)
    private lateinit var authenticationCoordinator: VaultAuthenticationCoordinator
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
        // The whole activity surface carries household ledger amounts. FLAG_SECURE
        // blanks the app from screenshots, screen recordings, and the recents
        // thumbnail — the standard guard for finance apps, and the only one that
        // also covers the Onboarding and Settings screens during a locked-session
        // transition.
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
        // Sweep CSV exports a share could not clean up itself (process death
        // while a share target held the file open, or a share that never
        // returned). The next launch must not inherit the leftover plaintext.
        val vaultApp = application as VaultApplication
        vaultApp.applicationScope.launch {
            purgeExportedCsvFiles(applicationContext)
        }
        val ledgerUiPreferences = LedgerUiPreferences(applicationContext)
        val initialLedgerSettings = ledgerUiPreferences.current()
        applyLedgerSystemBars(
            initialLedgerSettings.treatment(systemDark = systemIsDark()),
        )
        val app = application as VaultApplication
        model = ViewModelProvider(this, app.viewModelFactory)[VaultViewModel::class.java]
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                refreshMarketQuotesPeriodically(refresh = model::refreshActiveProfile)
            }
        }
        authenticationCoordinator = VaultAuthenticationCoordinator(
            lockController = lockController,
            onProfileApproved = profileSwitchGate::authenticationApproved,
            onProfileRefused = profileSwitchGate::authenticationRefused,
            publishLockState = ::publishLockState,
            authenticationError = { getString(R.string.vault_auth_error) },
            showConnectionPrompt = {
                biometricPrompt.authenticate(
                    deviceAuthenticationPromptInfo(
                        title = "Confirm connection change",
                        subtitle = "Authenticate with this device to continue",
                    ),
                )
            },
            cancelPrompt = { biometricPrompt.cancelAuthentication() },
        )
        biometricPrompt = BiometricPrompt(this, authenticationCoordinator.callback)
        val displayPreferences =
            getSharedPreferences(DISPLAY_PREFERENCES, MODE_PRIVATE)
        budgetNotifications = BudgetNotificationController(this)
        setContent {
            var ledgerSettings by remember { mutableStateOf(initialLedgerSettings) }
            val ledgerTreatment = ledgerSettings.treatment(isSystemInDarkTheme())
            LaunchedEffect(ledgerTreatment) {
                applyLedgerSystemBars(ledgerTreatment)
            }
            LedgerTheme(
                treatment = ledgerTreatment,
                effectSettings = ledgerSettings.effectSettings,
                accessibility = ledgerSettings.accessibility,
            ) {
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
                            onConnected = { _ -> model.enableStoredRemoteRows() },
                            onSaveReadToken = model::enableRemoteRows,
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
                        // The process-owned acceptance signal outlives any one
                        // Activity: a write accepted while this screen was being
                        // recreated replays to THIS subscriber, so the current
                        // ViewModel refreshes instead of the disposed one.
                        // refreshActiveProfile is idempotent; the replay costs at
                        // most one reload per recreation.
                        val vaultApplication = application as? VaultApplication
                        LaunchedEffect(model, vaultApplication) {
                            vaultApplication?.acceptedWrites?.collect {
                                model.refreshActiveProfile()
                            }
                        }
                        VaultApp(
                            state = state,
                            onNavigate = model::navigate,
                            // The switcher authorizes adult household changes;
                            // all other changes first complete the system prompt.
                            // The ViewModel checks the permitted destinations again.
                            onSwitchProfile = model::switchAuthorizedProfile,
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
                            ledgerSettings = ledgerSettings,
                            onLedgerSettingsChange = { next ->
                                if (ledgerUiPreferences.save(next)) {
                                    ledgerSettings = next
                                }
                            },
                        )
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        lockController.foregrounded()
        publishLockState()
        requestAppUnlock()
    }

    override fun startActivityForResult(intent: Intent, requestCode: Int, options: Bundle?) {
        val isShare = intent.action == Intent.ACTION_CHOOSER &&
            intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)?.action in
            setOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)
        // AndroidX launches the Keyguard fallback through this activity. Derive
        // its action from the public factory; the platform action constant is hidden.
        val isCredential = lockController.snapshot().isAuthenticating && intent.action != null &&
            intent.action == getSystemService<KeyguardManager>()
                ?.createConfirmDeviceCredentialIntent(null, null)?.action
        val grantsReturnGrace = isShare || isCredential
        if (grantsReturnGrace) lockController.externalActivityLaunched()
        try {
            super.startActivityForResult(intent, requestCode, options)
        } catch (error: RuntimeException) {
            if (grantsReturnGrace) lockController.externalActivityLaunchFailed()
            throw error
        }
    }

    override fun onStop() {
        lockController.backgrounded()
        publishLockState()
        budgetNotifications.cancelVisibleAlerts()
        super.onStop()
    }

    private fun systemIsDark(): Boolean =
        resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES

    private fun applyLedgerSystemBars(treatment: LedgerTreatment) {
        val appearance = ledgerSystemBarAppearance(treatment)
        val style = if (appearance.useDarkIcons) {
            SystemBarStyle.light(appearance.background, appearance.background)
        } else {
            SystemBarStyle.dark(appearance.background)
        }
        enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
        window.isNavigationBarContrastEnforced = false
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

    override suspend fun authenticateConnectionChange(): Boolean {
        if (!::authenticationCoordinator.isInitialized || !deviceAuthenticationAvailable()) return false
        return authenticationCoordinator.authenticateConnectionChange()
    }

    private fun promptInfo(forProfileSwitch: Boolean): BiometricPrompt.PromptInfo =
        deviceAuthenticationPromptInfo(
            title = getString(
                if (forProfileSwitch) R.string.vault_profile_prompt_title else R.string.vault_auth_prompt_title,
            ),
            subtitle = getString(
                if (forProfileSwitch) R.string.vault_profile_prompt_subtitle else R.string.vault_auth_prompt_subtitle,
            ),
        )

    private fun publishLockState() {
        lockState.value = lockController.snapshot()
    }

    private companion object {
        const val DISPLAY_PREFERENCES = "display_preferences"
        const val DISPLAY_UNIT_KEY = "display_unit"
    }
}
