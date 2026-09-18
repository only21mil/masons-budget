package com.sats21m.vogelvault.ui

import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.test.performTextReplacement
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import org.junit.Rule
import org.junit.Test
import org.junit.Before
import org.junit.After
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Robolectric
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp", application = QuickAddApplication::class)
class ProfileSheetRestorationTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var controller: ActivityController<ComponentActivity>
    private val contentRule = object : ComposeContentTestRule, ComposeTestRule by compose {
        override fun setContent(composable: @Composable () -> Unit) {
            controller.get().setContent(content = composable)
        }
    }

    @Before fun setup() {
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
    }

    @After fun tearDown() {
        controller.pause().stop().destroy()
    }

    @Test fun `saved kid sheet does not reopen when the process starts as Victor`() {
        assertSheetRestoration(FamilyMember.VICTOR)
    }

    @Test fun `same profile restores its open sheet and draft`() {
        assertSheetRestoration(FamilyMember.MASON)
    }

    private fun assertSheetRestoration(restoredProfile: FamilyMember) {
        val restoration = StateRestorationTester(contentRule)
        // Plain values deliberately change only when the saved composition is recreated.
        var profile = FamilyMember.MASON
        var requestAdd = true
        restoration.setContent {
            VogelVaultTheme {
                ScreenHost(
                    destination = Destination.HOME,
                    state = VaultUiState(activeProfile = profile),
                    quickAddRequested = requestAdd,
                    onQuickAddConsumed = { requestAdd = false },
                )
            }
        }
        compose.onNodeWithTag("quick-add-amount").performTextReplacement("12.34")
        compose.runOnIdle { profile = restoredProfile }
        restoration.emulateSavedInstanceStateRestore()
        if (restoredProfile == FamilyMember.MASON) {
            compose.onNodeWithTag("quick-add-amount").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("12.34")))
        } else {
            compose.onNodeWithTag("quick-add-amount").assertDoesNotExist()
        }
    }

    @Test fun `restoring an explicitly opened sheet for another profile clears its draft`() {
        val restoration = StateRestorationTester(contentRule)
        var profile = FamilyMember.MASON
        restoration.setContent {
            VogelVaultTheme { AddTransactionSheet(VaultUiState(activeProfile = profile), {}) }
        }
        compose.onNodeWithTag("quick-add-amount").performTextReplacement("12.34")
        compose.runOnIdle { profile = FamilyMember.VICTOR }
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithTag("quick-add-amount").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
    }
}
