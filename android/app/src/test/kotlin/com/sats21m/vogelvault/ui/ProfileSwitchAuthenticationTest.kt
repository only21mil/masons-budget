package com.sats21m.vogelvault.ui

import android.content.Context
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The profile switch, driven through the production shell.
 *
 * These tests select a profile in the real [VaultApp] and assert against the real
 * [VaultViewModel], with the real [ProfileSwitchAuthenticationGate] receiving the
 * request — the same objects, wired the same way, as [com.sats21m.vogelvault.MainActivity].
 * Only the system prompt and the device's enrolment state are stood in for, since
 * neither exists in a unit test.
 *
 * They exist because the biometric gate shipped severed: the machinery was all
 * present and `promptInfo(forProfileSwitch = true)` was verified to exist, while
 * nothing connected a profile selection to it. Tests that drove
 * [profileSwitchRequest] directly stayed green through all of it, which is why
 * every assertion below goes through the shell instead.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ProfileSwitchAuthenticationTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>

    private val model = VaultViewModel()
    private val lock = VaultLockController()
    private val refusal = mutableStateOf<ProfileSwitchRefusal?>(null)
    private var authenticationAvailable = true
    private var promptsShown = 0
    private lateinit var gate: ProfileSwitchAuthenticationGate

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before
    fun openTheVault() {
        // The vault is unlocked, as it must be before any profile switch.
        assertTrue(lock.beginAppUnlock())
        assertNull(lock.authenticationSucceeded())

        gate = ProfileSwitchAuthenticationGate(
            authenticationAvailable = { authenticationAvailable },
            beginAuthentication = lock::beginProfileSwitch,
            showPrompt = { promptsShown++ },
            onRefusalChanged = { cause -> refusal.value = cause },
        )

        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun closeTheShell() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `a selected profile reaches the prompt and is applied only once it succeeds`() {
        renderShell()

        chooseProfile(FamilyMember.MASON)

        assertEquals(
            1,
            promptsShown,
            "Selecting a profile did not reach the authentication prompt.",
        )
        assertEquals(
            FamilyMember.VICTOR,
            model.state.value.activeProfile,
            "The profile changed before authentication succeeded.",
        )
        assertProfileShown(FamilyMember.VICTOR)

        promptSucceeds()

        assertEquals(
            FamilyMember.MASON,
            model.state.value.activeProfile,
            "A successful authentication did not apply the switch.",
        )
        assertProfileShown(FamilyMember.MASON)
        assertNoRefusalShown()
    }

    @Test
    fun `a shell with no authentication receiver refuses the switch and names the defect`() {
        // Exactly what shipped: the shell composed without a receiver, so the
        // request had nowhere to go. It must now refuse out loud instead.
        renderShell(wired = false)

        chooseProfile(FamilyMember.MASON)

        assertEquals(0, promptsShown, "An unwired shell reached the prompt.")
        assertEquals(
            FamilyMember.VICTOR,
            model.state.value.activeProfile,
            "An unwired shell switched profile without any authentication.",
        )
        assertRefusalShown(ProfileSwitchRefusal.SHELL_NOT_CONNECTED)
    }

    @Test
    fun `a cancelled prompt leaves the profile alone and names the cause`() {
        renderShell()

        chooseProfile(FamilyMember.MASON)
        promptCancelled()

        assertEquals(
            FamilyMember.VICTOR,
            model.state.value.activeProfile,
            "A cancelled authentication still opened another profile.",
        )
        assertProfileShown(FamilyMember.VICTOR)
        assertRefusalShown(ProfileSwitchRefusal.AUTHENTICATION_INCOMPLETE)
    }

    @Test
    fun `a device that cannot authenticate cannot switch profiles`() {
        authenticationAvailable = false
        renderShell()

        chooseProfile(FamilyMember.MASON)

        assertEquals(
            0,
            promptsShown,
            "A prompt was shown on a device that cannot authenticate.",
        )
        assertEquals(
            FamilyMember.VICTOR,
            model.state.value.activeProfile,
            "An unenrolled device fell back to allowing the switch.",
        )
        assertRefusalShown(ProfileSwitchRefusal.AUTHENTICATION_UNAVAILABLE)
    }

    @Test
    fun `child exit waits for device authentication and never offers a sibling`() {
        model.switchProfile(FamilyMember.MASON)
        renderShell()
        chooseProfile(FamilyMember.VICTOR)
        assertEquals(1, promptsShown)
        assertEquals(FamilyMember.MASON, model.state.value.activeProfile)
        promptSucceeds()
        assertEquals(FamilyMember.VICTOR, model.state.value.activeProfile)
    }

    @Test
    fun `cancelled child exit stays on the child profile`() {
        model.switchProfile(FamilyMember.MASON)
        renderShell()
        chooseProfile(FamilyMember.RACHEL)
        promptCancelled()
        assertEquals(FamilyMember.MASON, model.state.value.activeProfile)
        assertRefusalShown(ProfileSwitchRefusal.AUTHENTICATION_INCOMPLETE)
    }

    @Test
    fun `child exit on an unenrolled device is refused`() {
        model.switchProfile(FamilyMember.MADDOX)
        authenticationAvailable = false
        renderShell()
        chooseProfile(FamilyMember.VICTOR)
        assertEquals(0, promptsShown)
        assertEquals(FamilyMember.MADDOX, model.state.value.activeProfile)
        assertRefusalShown(ProfileSwitchRefusal.AUTHENTICATION_UNAVAILABLE)
    }

    @Test
    fun `adult household switch skips the prompt even without enrolled credentials`() {
        authenticationAvailable = false
        renderShell()
        chooseProfile(FamilyMember.RACHEL)
        assertEquals(0, promptsShown)
        assertEquals(FamilyMember.RACHEL, model.state.value.activeProfile)
    }

    @Test
    fun `Family screen hosts the same authenticated profile switcher`() {
        model.navigate(Destination.FAMILY)
        renderShell()
        compose.onAllNodesWithContentDescription(context.getString(R.string.profile_switcher_open))[1].performClick()
        compose.onNode(
            hasText(FamilyMember.MASON.displayName) and hasClickAction() and hasAnyAncestor(isPopup()),
        ).performClick()
        compose.waitForIdle()
        assertEquals(1, promptsShown)
        assertEquals(FamilyMember.VICTOR, model.state.value.activeProfile)
        promptSucceeds()
        assertEquals(FamilyMember.MASON, model.state.value.activeProfile)
    }

    /**
     * The two refusals the shell cannot produce on its own.
     *
     * [ProfileSwitchAuthenticationGate] is the production receiver — the tests
     * above drive this exact instance through the shell — and these are its
     * remaining fail-closed paths.
     */
    @Test
    fun `the gate refuses a switch while another authentication owns the prompt`() {
        val busyLock = VaultLockController()
        assertTrue(busyLock.beginAppUnlock())
        val busyGate = ProfileSwitchAuthenticationGate(
            authenticationAvailable = { true },
            beginAuthentication = busyLock::beginProfileSwitch,
            showPrompt = { promptsShown++ },
            onRefusalChanged = { cause -> refusal.value = cause },
        )
        var switched: FamilyMember? = null

        busyGate.authenticate(
            requireNotNull(
                profileSwitchRequest(
                    current = FamilyMember.VICTOR,
                    target = FamilyMember.MASON,
                    onAuthorized = { switched = FamilyMember.MASON },
                ),
            ),
        )

        assertNull(switched, "A switch was applied while the app unlock held the prompt.")
        assertEquals(0, promptsShown, "A second prompt was requested.")
        assertEquals(ProfileSwitchRefusal.ALREADY_AUTHENTICATING, refusal.value)
    }

    @Test
    fun `the gate refuses a request that claims no authentication is needed`() {
        var switched: FamilyMember? = null
        gate.authenticate(
            ProfileSwitchRequest(
                current = FamilyMember.VICTOR,
                target = FamilyMember.MASON,
                requiresAuthentication = false,
                onAuthorized = { switched = FamilyMember.MASON },
            ),
        )

        assertNull(switched, "An unauthenticated switch was applied.")
        assertEquals(0, promptsShown, "A request that skipped authentication reached the prompt.")
        assertEquals(ProfileSwitchRefusal.AUTHENTICATION_NOT_REQUIRED, refusal.value)
    }

    @Test
    fun `the gate refuses to apply a profile it did not ask for`() {
        var switched: FamilyMember? = null
        gate.authenticate(
            requireNotNull(
                profileSwitchRequest(
                    current = FamilyMember.VICTOR,
                    target = FamilyMember.MASON,
                    onAuthorized = { switched = FamilyMember.MASON },
                ),
            ),
        )
        assertEquals(1, promptsShown)

        gate.authenticationApproved(FamilyMember.RACHEL)

        assertNull(switched, "The gate applied a profile the user never selected.")
        assertEquals(ProfileSwitchRefusal.AUTHENTICATION_INCOMPLETE, refusal.value)
    }

    private fun renderShell(wired: Boolean = true) {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 411.dp, height = 900.dp)) {
                        val state by model.state.collectAsState()
                        VaultApp(
                            state = state,
                            onNavigate = model::navigate,
                            onSwitchProfile = model::switchAuthorizedProfile,
                            onRequestProfileSwitchAuthentication =
                                if (wired) gate::authenticate else null,
                            profileSwitchRefusal = refusal.value,
                        )
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    private fun chooseProfile(target: FamilyMember) {
        compose.onNodeWithContentDescription(context.getString(R.string.profile_switcher_open))
            .performClick()
        compose.waitForIdle()
        compose.onNode(
            hasText(target.displayName) and hasClickAction() and hasAnyAncestor(isPopup()),
        ).performClick()
        compose.waitForIdle()
    }

    /** What MainActivity's `onAuthenticationSucceeded` does, with the prompt stood in for. */
    private fun promptSucceeds() {
        compose.runOnUiThread { gate.authenticationApproved(lock.authenticationSucceeded()) }
        compose.waitForIdle()
    }

    /** What MainActivity's `onAuthenticationError` does. */
    private fun promptCancelled() {
        compose.runOnUiThread {
            lock.authenticationErrored(context.getString(R.string.vault_auth_error))
            gate.authenticationRefused()
        }
        compose.waitForIdle()
    }

    /** Reads the switcher control itself, not any name that happens to be on screen. */
    private fun assertProfileShown(member: FamilyMember) {
        compose.onNodeWithContentDescription(context.getString(R.string.profile_switcher_open))
            .assertTextContains(member.displayName)
    }

    private fun assertRefusalShown(cause: ProfileSwitchRefusal) {
        assertTrue(
            compose.onAllNodesWithText(context.getString(cause.titleRes))
                .fetchSemanticsNodes().isNotEmpty(),
            "The refusal title for ${cause.name} was not shown.",
        )
        compose.onNodeWithText(context.getString(cause.titleRes)).performClick()
        assertTrue(
            compose.onAllNodesWithText(context.getString(cause.detailRes))
                .fetchSemanticsNodes().isNotEmpty(),
            "The refusal detail for ${cause.name} was not shown.",
        )
    }

    private fun assertNoRefusalShown() {
        ProfileSwitchRefusal.entries.forEach { cause ->
            assertTrue(
                compose.onAllNodesWithText(context.getString(cause.titleRes))
                    .fetchSemanticsNodes().isEmpty(),
                "A completed switch still showed the ${cause.name} refusal.",
            )
        }
    }
}
