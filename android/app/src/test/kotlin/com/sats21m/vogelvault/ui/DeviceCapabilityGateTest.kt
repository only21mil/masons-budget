package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.DeviceCapabilities
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TaskOnlyApplication::class)
class DeviceCapabilityGateTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test
    fun `task-only phone explains refused buy before showing editable fields`() {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        try {
            controller.get().setContent {
                VogelVaultTheme {
                    BtcBuyEntrySheet(FamilyMember.RACHEL, onDismiss = {}, onWriteSucceeded = {})
                }
            }
            compose.onNodeWithText("This phone has read-only access to Bitcoin records.").assertExists()
            compose.onNodeWithText("Save").assertDoesNotExist()
            compose.onNodeWithText("Close").assertExists()
        } finally {
            controller.pause().stop().destroy()
        }
    }
}

internal class TaskOnlyApplication : VaultApplication() {
    override val deviceCapabilities: DeviceCapabilities
        get() = DeviceCapabilities(FamilyMember.RACHEL, DeviceCapabilities.legacy)
}
