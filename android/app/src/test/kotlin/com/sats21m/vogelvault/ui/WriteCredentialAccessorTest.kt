package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import java.io.IOException
import kotlin.test.assertEquals
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
@Config(
    sdk = [34],
    application = RecordingWriteCredentialApplication::class,
)
class WriteCredentialAccessorTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>
    private lateinit var application: RecordingWriteCredentialApplication

    @Before
    fun startComposeHost() {
        application = RuntimeEnvironment.getApplication() as RecordingWriteCredentialApplication
        application.reset()
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun stopComposeHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `today never accepts a raw client-bound task credential`() {
        showSettings()
        compose.onNodeWithText("Sync credential").performTextInput("settings-token")
        compose.onNodeWithText("Save securely").performClick()
        settle()

        application.forgetCredential()
        showToday()
        settle()

        assertEquals(1, application.verifiedSaveCalls)
        assertEquals(
            0,
            compose.onAllNodesWithText("Paired-device credential").fetchSemanticsNodes().size,
        )
        compose.onNodeWithText(
            "This phone can change tasks for one paired profile. " +
                "Ask an adult to connect this profile in Settings.",
        ).performScrollTo().fetchSemanticsNode()
    }

    @Test
    fun `settings destination includes credential panel wired to application accessor`() {
        showSettingsDestination()
        compose
            .onNode(hasScrollToIndexAction())
            .performScrollToNode(hasText("Sync credential"))
        compose
            .onNodeWithText("Sync credential")
            .performTextInput("settings-destination-token")
        compose.onNodeWithText("Save securely").performScrollTo().performClick()
        settle()

        assertEquals(
            1,
            application.verifiedSaveCalls,
            "The Settings destination did not cross VaultApplication.saveConvexWriteCredential",
        )
        compose
            .onNodeWithText(
                "A sync credential for transaction, budget, and Bitcoin writes is stored securely on this device. " +
                    "Todo writes use a separate paired-device credential.",
            )
            .performScrollTo()
            .fetchSemanticsNode()
        assertEquals(
            0,
            compose
                .onAllNodesWithText("settings-destination-token")
                .fetchSemanticsNodes()
                .size,
            "The credential value reached rendered UI after Save",
        )
    }

    @Test
    fun `settings removes through the application accessor`() {
        application.markCredentialStored()
        showSettings()

        compose.onNodeWithText("Remove").performClick()
        settle()

        assertEquals(1, application.verifiedRemovalCalls)
        assertEquals(false, application.hasConvexWriteCredential())
    }

    @Test
    fun `settings surfaces distinct verified save failures without echoing their detail`() {
        val failures =
            listOf(
                IOException("storage-secret-detail") to
                    "The sync token could not be stored securely. Writes remain unconfigured.",
                IllegalStateException("readback-secret-detail") to
                    "The credential was written but could not be read back.",
                RuntimeException("unexpected-secret-detail") to
                    "The credential was not saved (RuntimeException).",
            )

        failures.forEachIndexed { index, (failure, expectedMessage) ->
            application.nextSaveFailure = failure
            showSettings()
            compose.onNodeWithText("Sync credential").performTextInput("token-$index")
            compose.onNodeWithText("Save securely").performClick()
            settle()

            compose.onNodeWithText(expectedMessage).fetchSemanticsNode()
            assertEquals(
                0,
                compose.onAllNodesWithText(failure.message.orEmpty()).fetchSemanticsNodes().size,
                "exception detail reached the Settings UI",
            )
        }
    }

    private fun showSettings() {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    SyncTokenConfiguration()
                }
            }
        }
        settle()
    }

    private fun showSettingsDestination() {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    ScreenHost(
                        destination = Destination.SETTINGS,
                        state = VaultUiState.of(FamilyMember.VICTOR, Destination.SETTINGS),
                    )
                }
            }
        }
        settle()
    }

    private fun showToday() {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    TodoScreen(
                        state = VaultUiState.of(FamilyMember.VICTOR, Destination.TASKS),
                        onWriteSucceeded = {},
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

class RecordingWriteCredentialApplication : VaultApplication() {
    var verifiedSaveCalls: Int = 0
        private set
    var verifiedRemovalCalls: Int = 0
        private set
    var nextSaveFailure: Throwable? = null
    private var credentialPresent: Boolean = false

    override fun hasConvexWriteCredential(): Boolean = credentialPresent
    override fun hasTodoWriteCredential(): Boolean = credentialPresent
    override fun hasTodoWriteCredential(profile: FamilyMember): Boolean = credentialPresent

    override fun saveConvexWriteCredential(token: String): Result<Unit> {
        verifiedSaveCalls += 1
        val failure = nextSaveFailure
        if (failure != null) return Result.failure(failure)
        credentialPresent = true
        return Result.success(Unit)
    }

    override fun removeTodoWriteCredential(): Result<Unit> =
        removeConvexWriteCredential()

    override fun removeConvexWriteCredential(): Result<Unit> {
        verifiedRemovalCalls += 1
        credentialPresent = false
        return Result.success(Unit)
    }

    fun markCredentialStored() {
        credentialPresent = true
    }

    fun forgetCredential() {
        credentialPresent = false
    }

    fun reset() {
        verifiedSaveCalls = 0
        verifiedRemovalCalls = 0
        nextSaveFailure = null
        credentialPresent = false
    }
}
