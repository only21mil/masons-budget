package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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
    fun `settings and today save through the same verified application accessor`() {
        showSettings()
        compose.onNodeWithText("Convex sync token").performTextInput("settings-token")
        compose.onNodeWithText("Save write credential").performClick()
        settle()

        application.forgetCredential()
        showToday()
        compose.onNodeWithText("Sync credential").performScrollTo().performTextInput("today-token")
        compose.onNodeWithText("Save write access").performScrollTo().performClick()
        settle()

        assertEquals(
            2,
            application.verifiedSaveCalls,
            "Settings and Today must both cross VaultApplication.saveConvexWriteCredential",
        )
    }

    @Test
    fun `settings removes through the application accessor`() {
        application.markCredentialStored()
        showSettings()

        compose.onNodeWithText("Remove stored sync token").performClick()
        settle()

        assertEquals(1, application.verifiedRemovalCalls)
        assertEquals(false, application.hasConvexWriteCredential())
    }

    @Test
    fun `settings surfaces distinct verified save failures without echoing their detail`() {
        val failures =
            listOf(
                IOException("storage-secret-detail") to
                    "Encrypted storage refused the credential, so nothing was saved",
                IllegalStateException("readback-secret-detail") to
                    "The credential was written but could not be read back",
                RuntimeException("unexpected-secret-detail") to
                    "The credential was not saved (RuntimeException)",
            )

        failures.forEachIndexed { index, (failure, expectedMessage) ->
            application.nextSaveFailure = failure
            showSettings()
            compose.onNodeWithText("Convex sync token").performTextInput("token-$index")
            compose.onNodeWithText("Save write credential").performClick()
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

    private fun showToday() {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    TodoScreen(
                        state = VaultUiState.of(FamilyMember.VICTOR, Destination.TODAY),
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

    override fun saveConvexWriteCredential(token: String): Result<Unit> {
        verifiedSaveCalls += 1
        val failure = nextSaveFailure
        if (failure != null) return Result.failure(failure)
        credentialPresent = true
        return Result.success(Unit)
    }

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
