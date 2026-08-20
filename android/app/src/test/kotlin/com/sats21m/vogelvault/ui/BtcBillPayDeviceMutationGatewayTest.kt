package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.RecordingPoster
import com.sats21m.vogelvault.domain.BillPayBudgetEffect
import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class BtcBillPayDeviceMutationGatewayTest {
    private val request = BtcBillPayWriteRequest(
        id = "android-bill-pay",
        owner = FamilyMember.RACHEL,
        date = "2026-08-20",
        merchant = "Mortgage",
        category = "Housing",
        budgetEffect = BillPayBudgetEffect.BUDGET_CATEGORY,
        amountUsdCents = 123_456L,
        btcSpentSats = 1_000_000L,
        btcPriceCents = 12_345_600L,
        feeUsdCents = 25L,
        note = "monthly payment",
        reference = "river-123",
    )

    @Test
    fun `bill pay writes through the device path with one exact payload`() = runBlocking {
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"success","value":{"ok":true,"entityId":"android-bill-pay","outcome":"inserted"}}""",
            ),
        )

        val result = gateway(poster).upsert(request, null)
        val wire = sent(poster)
        val args = wire["args"]!!.jsonObject
        val billPay = args["billPay"]!!.jsonObject

        assertEquals(1, poster.bodies.size)
        assertEquals("tables:upsertBtcBillPayFromDevice", wire["path"]!!.jsonPrimitive.content)
        assertEquals("victor", args["owner"]!!.jsonPrimitive.content)
        assertEquals("bitcoin-bill-pays", args["sourceFile"]!!.jsonPrimitive.content)
        assertEquals("test-device", args["deviceId"]!!.jsonPrimitive.content)
        assertEquals("t".repeat(43), args["deviceToken"]!!.jsonPrimitive.content)
        assertEquals("victor", billPay["owner"]!!.jsonPrimitive.content)
        assertEquals("budget_category", billPay["budgetEffect"]!!.jsonPrimitive.content)
        assertEquals("Housing", billPay["category"]!!.jsonPrimitive.content)
        assertEquals("river_bitcoin_bill_pay", billPay["platform"]!!.jsonPrimitive.content)
        assertEquals("monthly payment", billPay["note"]!!.jsonPrimitive.content)
        assertEquals("river-123", billPay["reference"]!!.jsonPrimitive.content)
        assertIs<ConvexResult.Ok<BtcBillPayUpsertReceipt>>(result)
        assertEquals(BtcBillPayUpsertOutcome.INSERTED, result.value.outcome)
    }

    @Test
    fun `new bill pay omits a revision while an edit sends the read revision`() = runBlocking {
        val insertPoster = RecordingPoster(success("inserted"))
        gateway(insertPoster).upsert(request, null)
        assertFalse(sent(insertPoster)["args"]!!.jsonObject.containsKey("baseUpdatedAtMs"))

        val updatePoster = RecordingPoster(success("updated"))
        gateway(updatePoster).upsert(request, 1_800_000_000_000L)
        assertEquals(
            "1800000000000",
            sent(updatePoster)["args"]!!.jsonObject["baseUpdatedAtMs"]!!.jsonPrimitive.content,
        )
    }

    @Test
    fun `malformed bill pay receipt is not accepted`() = runBlocking {
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"success","value":{"ok":true,"entityId":"other","outcome":"inserted"}}""",
            ),
        )

        assertEquals(ConvexResult.Failed("invalid write response"), gateway(poster).upsert(request, null))
    }

    private fun gateway(poster: RecordingPoster) = BtcBillPayMutationGateway(
        ConvexDeviceMutationClient(
            configSource = MutableConvexConfigSource(
                ConvexConfig(deploymentUrl = "https://bill-pay-device-test.convex.cloud"),
            ),
            credentialSource = ConvexDeviceCredentialSource {
                ConvexDeviceCredential("test-device", "t".repeat(43))
            },
            http = poster,
        ),
    )

    private fun sent(poster: RecordingPoster) =
        Json.parseToJsonElement(poster.bodies.single()).jsonObject

    private fun success(outcome: String) = HttpTextResponse(
        200,
        """{"status":"success","value":{"ok":true,"entityId":"android-bill-pay","outcome":"$outcome"}}""",
    )
}
