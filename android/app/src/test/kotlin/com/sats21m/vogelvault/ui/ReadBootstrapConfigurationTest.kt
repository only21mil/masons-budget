package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.key
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.ReadBootstrapStatus
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertEquals
import kotlinx.coroutines.CompletableDeferred
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = RecordingReadBootstrapApplication::class)
class ReadBootstrapConfigurationTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var controller: ActivityController<ComponentActivity>
    private lateinit var application: RecordingReadBootstrapApplication
    private var connectedCalls = 0
    private var connectedAccess: BootstrapAccess? = null
    private var contentKey = 0

    @Before
    fun start() {
        application = RuntimeEnvironment.getApplication() as RecordingReadBootstrapApplication
        application.reset()
        connectedCalls = 0
        connectedAccess = null
        contentKey = 0
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
    }

    @After
    fun stop() {
        controller.pause().stop().destroy()
    }

    @Test
    fun `connect exposes no editable or secret-bearing semantics and reports presence only`() {
        val bundleSecret = "android-read-abcdefghijklmnop.${"p".repeat(43)}"
        val responseSecret = "r".repeat(43)
        show()

        assertEquals(0, compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().size)
        compose.onNodeWithText("Connect securely").performClick()
        settle()

        assertEquals(1, application.connectCalls)
        assertEquals(1, connectedCalls)
        compose.onNodeWithText("Connected for household data. Todo changes are not enabled.")
            .fetchSemanticsNode()
        assertEquals(BootstrapAccess.READ_ONLY, connectedAccess)
        assertEquals(0, compose.onAllNodesWithText(bundleSecret).fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithText(responseSecret).fetchSemanticsNodes().size)
    }

    @Test
    fun `empty bundle is inert while an existing stored configuration remains connected`() {
        application.available = false
        show()
        compose.onNodeWithText(
            "This build has no approved secure connection available. Install a newly approved build and try again.",
        ).fetchSemanticsNode()
        assertEquals(0, compose.onAllNodesWithText("Connect securely").fetchSemanticsNodes().size)
        assertEquals(0, application.connectCalls)

        application.stored = true
        show()
        compose.onNodeWithText("Connected for household data. Todo changes are not enabled.")
            .fetchSemanticsNode()
        assertEquals(0, application.connectCalls)
    }

    @Test
    fun `replay and transport failures are redacted and retryable`() {
        val cases = listOf(
            ReadBootstrapStatus.ALREADY_CLAIMED to
                "This build’s secure connection was already used. Install a newly approved build.",
            ReadBootstrapStatus.NETWORK_ERROR to
                "Could not reach the household service. Check the network and retry.",
            ReadBootstrapStatus.INVALID_RESPONSE to
                "The household service returned an invalid setup response. Update the app or report the problem.",
        )
        cases.forEach { (status, message) ->
            application.next = status
            show()
            compose.onNodeWithText("Connect securely").performClick()
            settle()

            compose.onNodeWithText(message).fetchSemanticsNode()
            compose.onNodeWithText("Connect securely").fetchSemanticsNode()
        }
        assertEquals(cases.size, application.connectCalls)
        assertEquals(0, connectedCalls)
    }

    @Test
    fun `busy state disables replay and reset is presence only`() {
        application.pending = CompletableDeferred()
        show(allowReset = true)
        compose.onNodeWithText("Connect securely").performClick()
        settle()
        compose.onNodeWithText("Connecting…").assertIsNotEnabled()
        assertEquals(1, application.connectCalls)

        application.pending?.complete(ReadBootstrapStatus.CONNECTED)
        settle()
        compose.onNodeWithText("Reset secure connection").performClick()
        settle()
        compose.onNodeWithText(
            "Resetting removes this installation’s access. Reconnecting requires a newly approved build.",
        ).fetchSemanticsNode()
        assertEquals(0, application.removeCalls)
        compose.onNodeWithText("Confirm reset").performClick()
        settle()
        assertEquals(1, application.removeCalls)
        compose.onNodeWithText("This installation is not connected to household data.")
            .fetchSemanticsNode()
    }

    @Test
    fun `combined enrollment reports todo write only from durable capability state`() {
        val enrollment = RecordingEnrollment(
            next = BootstrapConnectionResult(
                status = ReadBootstrapStatus.CONNECTED,
                access = BootstrapAccess.READ_AND_TODO_WRITE,
            ),
        )
        show(enrollment = enrollment)

        compose.onNodeWithText("Connect securely").performClick()
        settle()

        compose.onNodeWithText("Connected for household data and todo changes.")
            .fetchSemanticsNode()
        assertEquals(BootstrapAccess.READ_AND_TODO_WRITE, connectedAccess)
    }

    @Test
    fun `connected status without durable access does not claim todo access`() {
        val enrollment = RecordingEnrollment(
            next = BootstrapConnectionResult(
                status = ReadBootstrapStatus.CONNECTED,
                access = BootstrapAccess.NONE,
            ),
        )
        show(enrollment = enrollment)

        compose.onNodeWithText("Connect securely").performClick()
        settle()

        compose.onNodeWithText("This installation is not connected to household data.")
            .fetchSemanticsNode()
        assertEquals(null, connectedAccess)
        assertEquals(0, connectedCalls)
        assertEquals(0, compose.onAllNodesWithText("todo changes", substring = true).fetchSemanticsNodes().size)
    }

    private fun show(
        allowReset: Boolean = false,
        enrollment: BootstrapEnrollment? = null,
    ) {
        contentKey += 1
        controller.get().setContent {
            VogelVaultTheme {
                key(contentKey) {
                    ReadBootstrapConfiguration(
                        onConnected = {
                            connectedCalls += 1
                            connectedAccess = it
                        },
                        allowReset = allowReset,
                        enrollment = enrollment,
                    )
                }
            }
        }
        settle()
    }

    private fun settle() {
        shadowOf(Looper.getMainLooper()).idle()
        compose.waitForIdle()
    }
}

private class RecordingEnrollment(
    private val next: BootstrapConnectionResult,
) : BootstrapEnrollment {
    private var access = BootstrapAccess.NONE

    override fun isBundledEnrollmentAvailable(): Boolean = true

    override fun currentAccess(): BootstrapAccess = access

    override suspend fun connect(): BootstrapConnectionResult {
        access = next.access
        return next
    }

    override fun reset(): BootstrapAccess {
        access = BootstrapAccess.NONE
        return access
    }
}

class RecordingReadBootstrapApplication : VaultApplication() {
    var available = true
    var stored = false
    internal var next = ReadBootstrapStatus.CONNECTED
    internal var pending: CompletableDeferred<ReadBootstrapStatus>? = null
    var connectCalls = 0
    var removeCalls = 0

    override fun hasBundledReadBootstrap(): Boolean = available

    override fun hasStoredConvexCredential(): Boolean = stored

    override suspend fun connectBundledReadBootstrap(): ReadBootstrapStatus {
        connectCalls += 1
        val result = pending?.await() ?: next
        if (result == ReadBootstrapStatus.CONNECTED) stored = true
        return result
    }

    override fun removeStoredConvexCredential(): Boolean {
        removeCalls += 1
        stored = false
        return true
    }

    fun reset() {
        available = true
        stored = false
        next = ReadBootstrapStatus.CONNECTED
        pending = null
        connectCalls = 0
        removeCalls = 0
    }
}
