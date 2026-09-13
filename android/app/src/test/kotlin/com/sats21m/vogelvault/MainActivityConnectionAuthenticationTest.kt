package com.sats21m.vogelvault

import android.app.KeyguardManager
import android.content.ContextWrapper
import android.os.Build
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.biometric.BiometricViewModel
import androidx.lifecycle.ViewModelProvider
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.ProfileSwitchAuthenticationGate
import com.sats21m.vogelvault.ui.profileSwitchRequest
import com.sats21m.vogelvault.ui.VaultAuthenticationCoordinator
import com.sats21m.vogelvault.ui.VaultLockController
import com.sats21m.vogelvault.ui.authenticateConnectionChange
import com.sats21m.vogelvault.ui.deviceAuthenticationPromptInfo
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

/** Uses the real activity and AndroidX's registered callback, without device biometrics. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 34], application = MainActivityReadinessTestApplication::class)
class MainActivityConnectionAuthenticationTest {
    private lateinit var activityController: ActivityController<MainActivity>
    private lateinit var activity: MainActivity
    private lateinit var lock: VaultLockController

    @Before
    fun createActivity() {
        activityController = Robolectric.buildActivity(MainActivity::class.java).setup()
        activity = activityController.get()
        shadowOf(activity.getSystemService(KeyguardManager::class.java)).setIsDeviceSecure(true)
        lock = activity.privateField("lockController")
        activity.privateMethod("requestAppUnlock")
        registeredCallback().onAuthenticationSucceeded(successResult())
        assertTrue(lock.snapshot().isUnlocked)
    }

    @After
    fun destroyActivity() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `connection success keeps the activity callback for later unlock and profile switch`() = runBlocking {
        val callback = registeredCallback()
        val connection = async(start = CoroutineStart.UNDISPATCHED) {
            authenticateConnectionChange(ContextWrapper(activity))
        }
        assertSame(callback, registeredCallback())
        assertTrue(lock.snapshot().isAuthenticating)
        assertFalse(connection.isCompleted)
        registeredCallback().onAuthenticationSucceeded(successResult())
        assertTrue(connection.await())
        assertFalse(lock.snapshot().isAuthenticating)

        assertLaterUnlockAndProfileSwitch()
    }

    @Test
    fun `connection cancellation keeps later authentication results deliverable`() = runBlocking {
        val callback = registeredCallback()
        val connection = async(start = CoroutineStart.UNDISPATCHED) {
            authenticateConnectionChange(ContextWrapper(activity))
        }
        registeredCallback().onAuthenticationError(BiometricPrompt.ERROR_USER_CANCELED, "Cancelled")
        assertFalse(connection.await())
        assertSame(callback, registeredCallback())
        assertLaterUnlockAndProfileSwitch()
    }

    @Test
    fun `disposed connection retains ownership until cancellation callback`() = runBlocking {
        val connection = async(start = CoroutineStart.UNDISPATCHED) {
            authenticateConnectionChange(ContextWrapper(activity))
        }
        connection.cancel()
        assertFalse(lock.beginProfileSwitch(FamilyMember.VICTOR, FamilyMember.MASON))
        registeredCallback().onAuthenticationError(BiometricPrompt.ERROR_CANCELED, "Cancelled")
        assertLaterUnlockAndProfileSwitch()
    }

    @Test
    fun `device credential activity may stop host without losing connection request`() = runBlocking {
        val connection = async(start = CoroutineStart.UNDISPATCHED) {
            authenticateConnectionChange(ContextWrapper(activity))
        }
        activityController.pause().stop()
        assertTrue(lock.snapshot().isAuthenticating)
        assertFalse(connection.isCompleted)
        activityController.start().resume()
        registeredCallback().onAuthenticationSucceeded(successResult())
        assertTrue(connection.await())
        assertTrue(lock.snapshot().isUnlocked)
    }

    @Test
    fun `late success for disposed connection cannot reopen a backgrounded vault`() = runBlocking {
        val connection = async(start = CoroutineStart.UNDISPATCHED) {
            authenticateConnectionChange(ContextWrapper(activity))
        }
        lock.backgrounded()
        connection.cancel()
        registeredCallback().onAuthenticationSucceeded(successResult())
        assertFalse(lock.snapshot().isUnlocked)
        assertFalse(lock.snapshot().isAuthenticating)
        assertTrue(connection.isCancelled)
        assertLaterUnlockAndProfileSwitch()
    }

    @Test
    fun `prompt construction failure refuses the connection and releases authentication`() = runBlocking {
        val coordinator = VaultAuthenticationCoordinator(
            lockController = lock,
            onProfileApproved = {},
            onProfileRefused = { error("No profile request should be refused") },
            publishLockState = {},
            authenticationError = { "Authentication unavailable" },
            showConnectionPrompt = { throw IllegalArgumentException("Unsupported authenticators") },
            cancelPrompt = {},
        )
        assertFalse(coordinator.authenticateConnectionChange())
        assertFalse(lock.snapshot().isAuthenticating)
        assertLaterUnlockAndProfileSwitch()
    }

    @Suppress("DEPRECATION")
    @Test
    fun `prompt builder uses a supported device credential route on each API`() {
        val info = deviceAuthenticationPromptInfo("Confirm connection change", "Authenticate with this device to continue")
        if (Build.VERSION.SDK_INT == 29) {
            assertEquals(0, info.allowedAuthenticators)
            assertTrue(info.isDeviceCredentialAllowed)
        } else {
            assertEquals(BIOMETRIC_STRONG or DEVICE_CREDENTIAL, info.allowedAuthenticators)
        }
    }

    private fun assertLaterUnlockAndProfileSwitch() {
        lock.backgrounded()
        assertFalse(lock.snapshot().isUnlocked)
        activity.privateMethod("requestAppUnlock")
        assertTrue(lock.snapshot().isAuthenticating)
        registeredCallback().onAuthenticationSucceeded(successResult())
        assertTrue(lock.snapshot().isUnlocked)
        assertFalse(lock.snapshot().isAuthenticating)
        // Exercise the real profile gate as well as the lock callback's target delivery.
        var approved = false
        val gate = activity.privateField<Lazy<ProfileSwitchAuthenticationGate>>("profileSwitchGate\$delegate").value
        gate.authenticate(checkNotNull(profileSwitchRequest(FamilyMember.VICTOR, FamilyMember.MASON) {
            approved = true
        }))
        assertFalse(approved)
        assertTrue(lock.snapshot().isAuthenticating)
        registeredCallback().onAuthenticationSucceeded(successResult())
        assertTrue(approved)
        assertFalse(lock.snapshot().isAuthenticating)
    }

    private fun registeredCallback(): BiometricPrompt.AuthenticationCallback {
        val model = ViewModelProvider(activity)[BiometricViewModel::class.java]
        val method = BiometricViewModel::class.java.getDeclaredMethod("getClientCallback")
        method.isAccessible = true
        return method.invoke(model) as BiometricPrompt.AuthenticationCallback
    }

    private fun successResult(): BiometricPrompt.AuthenticationResult {
        val constructor = BiometricPrompt.AuthenticationResult::class.java.getDeclaredConstructor(
            BiometricPrompt.CryptoObject::class.java,
            Int::class.javaPrimitiveType,
        )
        constructor.isAccessible = true
        return constructor.newInstance(null, BiometricPrompt.AUTHENTICATION_RESULT_TYPE_BIOMETRIC)
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> MainActivity.privateField(name: String): T =
        MainActivity::class.java.getDeclaredField(name).let { field ->
            field.isAccessible = true
            field.get(this) as T
        }

    private fun MainActivity.privateMethod(name: String) {
        MainActivity::class.java.getDeclaredMethod(name).also { it.isAccessible = true }.invoke(this)
    }
}
