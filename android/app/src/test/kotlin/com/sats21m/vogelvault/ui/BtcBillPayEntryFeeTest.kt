package com.sats21m.vogelvault.ui

import android.os.Bundle
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.AnnotatedString
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.DeviceCapabilities
import com.sats21m.vogelvault.data.HttpPoster
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.decodeConvexInt64OrNull
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
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
@Config(sdk = [34], application = BtcBillPayFeeApplication::class)
class BtcBillPayEntryFeeTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var controller: ActivityController<ComponentActivity>
    private lateinit var application: BtcBillPayFeeApplication
    private var dismissed = 0
    private var accepted = 0

    @Before fun setUp() {
        application = RuntimeEnvironment.getApplication() as BtcBillPayFeeApplication
        application.poster.bodies.clear()
        openSheet()
    }

    @After fun tearDown() { controller.pause().stop().destroy() }

    @Test fun `fresh fee is blank and Save refuses it without a mutation`() {
        assertFee("")
        compose.onNodeWithText("Enter exact fee").assertExists()
        fillReceipt()
        save()
        compose.onNodeWithText("Enter the fee River charged, or 0.").assertExists()
        assertFee("")
        assertEquals(0, application.poster.bodies.size)
        assertEquals(0, dismissed)
        assertEquals(0, accepted)
    }

    @Test fun `explicit zero survives saved state and reaches the payload on refused retries`() {
        verifyExplicitFee("0", 0L)
    }

    @Test fun `nonzero exact fee survives saved state and refused retry`() {
        verifyExplicitFee("12.34", 1234L)
    }

    private fun verifyExplicitFee(fee: String, cents: Long) {
        fillReceipt()
        compose.onNodeWithText("Fee (USD)").performTextReplacement(fee)
        val state = Bundle()
        compose.runOnUiThread { controller.saveInstanceState(state).pause().stop().destroy() }
        openSheet(state)
        assertFee(fee)
        save()
        awaitRequestCount(1)
        assertFee(fee)
        save()
        awaitRequestCount(2)
        assertFee(fee)
        val payloads = application.poster.bodies.map {
            Json.parseToJsonElement(it).jsonObject["args"]!!.jsonObject["billPay"]!!.jsonObject
        }
        assertEquals(cents, payloads.first()["feeUsdCents"]!!.decodeConvexInt64OrNull())
        assertEquals(payloads.first(), payloads.last())
        assertEquals(0, dismissed)
        assertEquals(0, accepted)
    }

    private fun openSheet(savedState: Bundle? = null) {
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        if (savedState == null) controller.setup() else controller.setup(savedState)
        controller.get().setContent {
            VogelVaultTheme {
                BtcBillPayEntrySheet(
                    owner = FamilyMember.VICTOR,
                    budgetCategories = listOf("Housing"),
                    onDismiss = { dismissed++ },
                    onWriteSucceeded = { accepted++ },
                )
            }
        }
        settle()
    }

    private fun fillReceipt() {
        compose.onNodeWithText("Merchant").performTextReplacement("Test utility")
        compose.onNodeWithText("Amount (USD)").performTextReplacement("12.00")
        compose.onNodeWithText("Sats spent").performTextReplacement("2000")
        compose.onNodeWithText("BTC price (USD)").performTextReplacement("600000.00")
    }

    private fun assertFee(value: String) {
        compose.onNodeWithText("Fee (USD)").assert(
            SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString(value)),
        )
    }

    private fun save() {
        // The pinned button can be covered by the keyboard in Robolectric's small window.
        compose.onNodeWithText("Save").performSemanticsAction(SemanticsActions.OnClick) { it() }
        settle()
    }

    private fun awaitRequestCount(count: Int) {
        compose.waitUntil(5_000) { application.poster.bodies.size == count }
        compose.waitUntil(5_000) {
            compose.onAllNodes(SemanticsMatcher.expectValue(
                SemanticsProperties.Text, listOf(AnnotatedString("Save")),
            )).fetchSemanticsNodes().isNotEmpty()
        }
        settle()
    }

    private fun settle() {
        repeat(3) {
            compose.waitForIdle()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }
}

internal class BtcBillPayFeePoster : HttpPoster {
    val bodies = CopyOnWriteArrayList<String>()
    override suspend fun postJson(url: String, body: String): HttpTextResponse {
        bodies.add(body)
        return HttpTextResponse(500, "")
    }
}

internal class BtcBillPayFeeApplication : VaultApplication() {
    val poster = BtcBillPayFeePoster()
    override val deviceCapabilities get() = DeviceCapabilities(FamilyMember.VICTOR, DeviceCapabilities.supported)
    override val btcBillPayMutationGateway by lazy {
        BtcBillPayMutationGateway(
            ConvexDeviceMutationClient(
                MutableConvexConfigSource(ConvexConfig(deploymentUrl = "https://bill-pay-fee-test.convex.cloud")),
                ConvexDeviceCredentialSource {
                    ConvexDeviceCredential("test-device", "t".repeat(43), FamilyMember.VICTOR, DeviceCapabilities.supported)
                },
                poster,
            ),
        )
    }
}
