package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp", application = QuickAddApplication::class)
class QuickAddComposeTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun `Next follows amount validity and revalidates on click`() {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        try {
            controller.get().setContent {
                VogelVaultTheme { AddTransactionSheet(VaultUiState(), {}) }
            }
            val next = compose.onNodeWithText("Next")
            val amount = compose.onNodeWithTag("quick-add-amount")
            next.assertIsNotEnabled()
            // Invoke the handler directly to check its independent validation guard.
            next.performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.onNodeWithText("Enter an amount").assertExists()
            amount.assertExists()
            for (invalid in listOf("0", "-1", "nope", "1.2.3", "0.001", "92233720368547758.08")) {
                amount.performTextReplacement(invalid)
                next.assertIsNotEnabled()
            }
            for (valid in listOf("0.01", "12.34")) {
                amount.performTextReplacement(valid)
                next.assertIsEnabled()
                amount.performTextReplacement("")
                next.assertIsNotEnabled()
            }
            amount.performTextReplacement("12.34")
            next.assertIsEnabled().performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.onNodeWithText(controller.get().getString(R.string.add_transaction_merchant)).assertExists()
            compose.onNodeWithText("Back").performSemanticsAction(SemanticsActions.OnClick) { it() }
            next.assertIsEnabled()
            amount.performTextReplacement("")
            next.assertIsNotEnabled()
            assertEquals(0, (controller.get().application as QuickAddApplication).requests.get())
        } finally { controller.pause().stop().destroy() }
    }

    @Test fun `three actions open advance and save with typing and no disclosure required`() {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        try {
            val state = mutableStateOf(VaultUiState(destination = Destination.TASKS))
            controller.get().setContent {
                VogelVaultTheme { VaultApp(state.value, {}, {}) }
            }
            // Every destination exposes the same shell action, including those with early returns.
            for (destination in Destination.entries) {
                compose.runOnIdle { state.value = state.value.copy(destination = destination) }
                compose.onNodeWithTag("quick-add-fab").assertIsDisplayed()
            }
            compose.onNodeWithTag("quick-add-fab").performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.onNodeWithTag("quick-add-amount").performTextInput("12.34")
            compose.onNodeWithText("Next").performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.onNodeWithText(controller.get().getString(R.string.add_transaction_merchant)).performTextInput("Local shop")
            compose.onNodeWithTag(PAYMENT_SOURCE_SELECTOR_TEST_TAG).assertDoesNotExist()
            compose.onNodeWithText(controller.get().getString(R.string.add_transaction_save)).assertIsEnabled()
                .performSemanticsAction(SemanticsActions.OnClick) { it() }
            // A local refusing transport proves Save reaches the write path and keeps the draft.
            val application = controller.get().application as QuickAddApplication
            compose.waitUntil(5_000) { application.requests.get() == 1 }
            compose.onNodeWithText("Transaction was not saved: the credential is missing or was rejected.").assertExists()
            compose.onNodeWithText("Local shop").assertExists()
        } finally { controller.pause().stop().destroy() }
    }

    @Test fun `defaults persist only within the canonical household`() {
        val context = org.robolectric.RuntimeEnvironment.getApplication()
        val victor = QuickAddDefaults(context, FamilyMember.VICTOR)
        val rachel = QuickAddDefaults(context, FamilyMember.RACHEL)
        val mason = QuickAddDefaults(context, FamilyMember.MASON)
        val maddox = QuickAddDefaults(context, FamilyMember.MADDOX)
        victor.accept("Groceries", PaymentSource.DEFAULT)
        mason.accept("Games", PaymentSource.DEFAULT)
        assertEquals("Groceries", rachel.category())
        assertEquals("Games", mason.category())
        assertEquals("", maddox.category())
    }
}

internal class QuickAddApplication : com.sats21m.vogelvault.VaultApplication() {
    val requests = java.util.concurrent.atomic.AtomicInteger()
    override val deviceCapabilities = com.sats21m.vogelvault.data.DeviceCapabilities(
        FamilyMember.VICTOR, setOf(com.sats21m.vogelvault.data.DeviceCapability.TRANSACTIONS.wire),
    )
    override val transactionDeviceMutationGateway by lazy {
        TransactionDeviceMutationGateway(com.sats21m.vogelvault.data.ConvexDeviceMutationClient(
            configSource = com.sats21m.vogelvault.data.MutableConvexConfigSource(
                com.sats21m.vogelvault.data.ConvexConfig(deploymentUrl = "https://quick-add-test.convex.cloud")),
            credentialSource = com.sats21m.vogelvault.data.ConvexDeviceCredentialSource {
                com.sats21m.vogelvault.data.ConvexDeviceCredential("test-device", "t".repeat(43))
            },
            http = object : com.sats21m.vogelvault.data.HttpPoster {
                override suspend fun postJson(url: String, body: String): com.sats21m.vogelvault.data.HttpTextResponse {
                    requests.incrementAndGet()
                    return com.sats21m.vogelvault.data.HttpTextResponse(401, "")
                }
            },
        ))
    }
}
