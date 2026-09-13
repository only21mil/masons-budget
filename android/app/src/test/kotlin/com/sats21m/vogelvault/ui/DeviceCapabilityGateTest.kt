package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.DeviceCapabilities
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
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
    fun `task-only phone sees transaction refusal from the fixed entry point`() {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        try {
            controller.get().setContent {
                VogelVaultTheme {
                    VaultApp(VaultUiState(destination = Destination.ACTIVITY,
                        activeProfile = FamilyMember.RACHEL,
                        data = Fixtures.envelope(FamilyMember.RACHEL, Freshness.LIVE),
                    ), {}, {})
                }
            }
            compose.onNodeWithTag("quick-add-fab").performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.onNodeWithText("This phone has read-only access to transactions.").assertExists()
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test
    fun `task-only phone disables pinned transaction save and preserves back`() {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        try {
            QuickAddDefaults(controller.get(), FamilyMember.RACHEL).selectSource(PaymentSource.DEFAULT)
            controller.get().setContent {
                VogelVaultTheme {
                    AddTransactionSheet(VaultUiState(
                        activeProfile = FamilyMember.RACHEL,
                        data = Fixtures.envelope(FamilyMember.RACHEL, Freshness.LIVE),
                    ), onDismiss = {})
                }
            }
            compose.onNodeWithText("This phone has read-only access to transactions.").assertExists()
            compose.onNodeWithTag("quick-add-amount").performTextInput("1")
            compose.onNodeWithText("Next").performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.onNodeWithText(controller.get().getString(R.string.add_transaction_save)).assertIsNotEnabled()
            compose.onNodeWithText(controller.get().getString(R.string.add_transaction_merchant)).assertExists()
            compose.onNodeWithText("Back").assertExists()
        } finally {
            controller.pause().stop().destroy()
        }
    }

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
