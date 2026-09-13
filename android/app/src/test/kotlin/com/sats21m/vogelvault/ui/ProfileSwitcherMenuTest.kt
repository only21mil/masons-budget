package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ProfileSwitcherMenuTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun `Mason menu hides Settings and keeps adult switch authenticated`() = checkMenu(FamilyMember.MASON)
    @Test fun `Maddox menu hides Settings and keeps adult switch authenticated`() = checkMenu(FamilyMember.MADDOX)
    @Test fun `adult menu opens the available Settings destination`() = checkMenu(FamilyMember.VICTOR)

    private fun checkMenu(member: FamilyMember) {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        var openedSettings = false
        var request: ProfileSwitchRequest? = null
        var switched: FamilyMember? = null
        try {
            controller.get().setContent {
                VogelVaultTheme {
                    ProfileSwitcher(member, onAuthenticationRequired = { request = it },
                        onAuthorizedSwitch = { switched = it }, onSettings = { openedSettings = true })
                }
            }
            compose.onNodeWithText(member.displayName).performClick()
            if (member.isAdult) {
                compose.onNodeWithText("Settings").performClick()
                assertTrue(openedSettings)
            } else {
                compose.onNodeWithText("Settings").assertDoesNotExist()
                compose.onNodeWithText(FamilyMember.VICTOR.displayName).performClick()
                assertTrue(requireNotNull(request).requiresAuthentication)
                assertNull(switched)
                assertFalse(openedSettings)
            }
        } finally {
            controller.pause().stop().destroy()
        }
    }
}
