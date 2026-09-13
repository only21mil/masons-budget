package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.DeviceCapabilities
import com.sats21m.vogelvault.data.DeviceCapability
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TransactionsOnlyApplication::class)
class TransactionRouteCapabilityTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun `income keeps one source field and save with a transactions only pairing`() {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        try {
            QuickAddDefaults(controller.get(), FamilyMember.VICTOR).selectSource(PaymentSource.entries.first { it.isBitcoinTransaction })
            controller.get().setContent {
                VogelVaultTheme {
                    AddTransactionSheet(VaultUiState(activeProfile = FamilyMember.VICTOR,
                        data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)),
                        onDismiss = {}, initialType = AddTransactionType.INCOME)
                }
            }
            compose.onNodeWithTag("quick-add-amount").performTextInput("1")
            compose.onNodeWithText("Next").performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.onNodeWithText("Income source").assertExists()
            compose.onNodeWithText(controller.get().getString(R.string.add_transaction_merchant)).assertDoesNotExist()
            compose.onNodeWithText(controller.get().getString(R.string.add_transaction_save)).assertExists()
            compose.onNodeWithTag(PAYMENT_SOURCE_SELECTOR_TEST_TAG).assertDoesNotExist()
            compose.onNodeWithText("This phone has read-only access to Bitcoin records.").assertDoesNotExist()
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun `transactions only pairing can return to fiat after refused Bitcoin selection`() {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        try {
            QuickAddDefaults(controller.get(), FamilyMember.VICTOR).selectSource(PaymentSource.DEFAULT)
            controller.get().setContent {
                VogelVaultTheme {
                    AddTransactionSheet(VaultUiState(activeProfile = FamilyMember.VICTOR,
                        data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)), onDismiss = {})
                }
            }
            compose.onNodeWithTag("quick-add-amount").performTextInput("1")
            compose.onNodeWithText("Next").performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.onNodeWithText("Payment, date, note and Bitcoin").performScrollTo().performSemanticsAction(SemanticsActions.OnClick) { it() }
            for (bitcoin in PaymentSource.entries.filter { it.isBitcoinTransaction }) {
                compose.onNode(hasText(PaymentSource.DEFAULT.label) and hasClickAction()).performScrollTo().performSemanticsAction(SemanticsActions.OnClick) { it() }
                compose.onNodeWithText(bitcoin.label).performClick()
                compose.onNodeWithText("This phone has read-only access to Bitcoin records.").assertExists()
                compose.onNodeWithText(controller.get().getString(R.string.add_transaction_merchant)).assertExists()
                compose.onNodeWithText(controller.get().getString(R.string.add_transaction_save)).assertIsNotEnabled()
                compose.onNode(hasText(bitcoin.label) and hasClickAction()).performScrollTo().performSemanticsAction(SemanticsActions.OnClick) { it() }
                compose.onNodeWithText(PaymentSource.DEFAULT.label).performClick()
                compose.onNodeWithText("This phone has read-only access to Bitcoin records.").assertDoesNotExist()
                compose.onNodeWithText(controller.get().getString(R.string.add_transaction_merchant)).assertExists()
                compose.onNodeWithText(controller.get().getString(R.string.add_transaction_save)).assertIsEnabled()
            }
        } finally {
            controller.pause().stop().destroy()
        }
    }
}

internal class TransactionsOnlyApplication : VaultApplication() {
    override val deviceCapabilities: DeviceCapabilities
        get() = DeviceCapabilities(FamilyMember.RACHEL, setOf(DeviceCapability.TRANSACTIONS.wire))
}
