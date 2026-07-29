package com.sats21m.vogelvault.ui.voice

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import android.os.Looper
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import java.time.LocalDate
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VoiceTransactionEntryTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>

    @Before
    fun startComposeHost() {
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun stopComposeHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `low confidence transcript is shown for correction and cannot auto save`() {
        val saveCalls = AtomicInteger()
        showDialog(saveCalls)

        compose.onNodeWithText("Transcript").performTextInput("spent some money")
        compose.onNodeWithText("Review").performClick()
        settle()

        compose
            .onNodeWithText(
                "Low-confidence parse — correct every uncertain field before saving.",
            ).fetchSemanticsNode()
        compose.onNodeWithText("Save reviewed transaction").performScrollTo().performClick()
        settle()
        compose.onNodeWithText("Enter a merchant before saving.").fetchSemanticsNode()
        assertEquals(0, saveCalls.get(), "low-confidence incomplete parse crossed the save boundary")
    }

    @Test
    fun `complete parse still waits for explicit reviewed save`() {
        val saveCalls = AtomicInteger()
        showDialog(saveCalls)

        compose.onNodeWithText("Transcript").performTextInput("$45 at Costco yesterday")
        compose.onNodeWithText("Review").performClick()
        settle()

        assertEquals(0, saveCalls.get(), "recognition or parsing wrote before confirmation")
        compose.onNodeWithText("Save reviewed transaction").performScrollTo().performClick()
        settle()
        assertEquals(1, saveCalls.get(), "explicit save did not cross the write boundary exactly once")
    }

    private fun showDialog(saveCalls: AtomicInteger) {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    VoiceTransactionEntryDialog(
                        activeProfile = FamilyMember.VICTOR,
                        onDismiss = {},
                        onSave = {
                            saveCalls.incrementAndGet()
                            VoiceTransactionSaveResult.Saved
                        },
                        today = LocalDate.of(2026, 4, 30),
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    private fun settle() {
        shadowOf(Looper.getMainLooper()).idle()
        compose.waitForIdle()
    }
}
