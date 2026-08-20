package com.sats21m.vogelvault.ui

import android.app.Application
import android.content.Context
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.RecordingPoster
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import java.time.LocalDate
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class PaymentSourceTest {
    @Test
    fun `catalog keeps the closed wire and label contract`() {
        assertEquals(
            listOf(
                "river_bitcoin_bill_pay" to "River Bitcoin Bill Pay",
                "coinbase_card" to "Coinbase Card",
                "aven" to "Aven",
                "sofi_card" to "SoFi Card",
                "capital_one_vx" to "Capital One VX",
                "lightning" to "Lightning",
                "on_chain" to "On-chain",
            ),
            PaymentSource.entries.map { it.wire to it.label },
        )
        PaymentSource.entries.forEach { source ->
            assertEquals(source, PaymentSource.fromWire(source.wire))
        }
    }

    @Test
    fun `selection persists its wire and restores after store reconstruction`() {
        val context: Application = androidx.test.core.app.ApplicationProvider.getApplicationContext()
        val preferences = context.getSharedPreferences(
            "payment-source-${UUID.randomUUID()}",
            Context.MODE_PRIVATE,
        )
        val first = PaymentSourceStore(preferences)
        assertEquals(PaymentSource.COINBASE_CARD, first.current())

        assertTrue(first.select(PaymentSource.CAPITAL_ONE_VX))
        assertEquals(PaymentSource.CAPITAL_ONE_VX.wire, first.storedWire())
        assertEquals(
            PaymentSource.CAPITAL_ONE_VX,
            PaymentSourceStore(preferences).current(),
        )
        assertFalse(preferences.all.values.any { it == PaymentSource.CAPITAL_ONE_VX.label })
    }

    @Test
    fun `card transaction omits bitcoin posting fields and carries the stable card wire`() {
        val prepared = preparePaymentTransaction(
            source = PaymentSource.AVEN,
            amount = "12.34",
            unit = DisplayUnit.USD,
            bitcoinAccountKey = "must-not-leak",
        )

        assertEquals(PaymentSource.AVEN.wire, prepared.input.card)
        assertNull(prepared.input.amountSats)
        assertNull(prepared.input.bitcoinAccountKey)
    }

    @Test
    fun `bitcoin transaction carries positive exact sats and the selected account key`() {
        val prepared = preparePaymentTransaction(
            source = PaymentSource.LIGHTNING,
            amount = "21000",
            unit = DisplayUnit.SATS,
            bitcoinAccountKey = "lightning-wallet",
        )

        assertEquals(PaymentSource.LIGHTNING.wire, prepared.input.card)
        assertEquals(21_000L, prepared.input.amountSats)
        assertEquals("lightning-wallet", prepared.input.bitcoinAccountKey)
        assertTrue(requireNotNull(prepared.input.amountSats) > 0L)
    }

    @Test
    fun `device transaction gateway sends the device route and exact transaction shape`() = runBlocking {
        val row = preparePaymentTransaction(
            source = PaymentSource.ON_CHAIN,
            amount = "0.00021000",
            unit = DisplayUnit.BTC,
            bitcoinAccountKey = "coldcard",
        )
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"success","value":{"ok":true,"entityId":"${row.input.id}","outcome":"inserted"}}""",
            ),
        )
        val gateway = TransactionDeviceMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(
                    ConvexConfig(deploymentUrl = "https://payment-source-test.convex.cloud"),
                ),
                credentialSource = ConvexDeviceCredentialSource {
                    ConvexDeviceCredential("test-device", "t".repeat(43))
                },
                http = poster,
            ),
        )

        val result = gateway.upsert(row)
        assertIs<ConvexResult.Ok<DeviceTransactionWriteReceipt>>(result)
        val body = Json.parseToJsonElement(poster.bodies.single()).jsonObject
        assertEquals(
            "tables:upsertTransactionFromDevice",
            body["path"]!!.jsonPrimitive.content,
        )
        val args = body["args"]!!.jsonObject
        assertEquals("victor", args["owner"]!!.jsonPrimitive.content)
        assertEquals("transactions", args["sourceFile"]!!.jsonPrimitive.content)
        assertEquals("test-device", args["deviceId"]!!.jsonPrimitive.content)
        val transaction = args["transaction"]!!.jsonObject
        assertEquals(PaymentSource.ON_CHAIN.wire, transaction["card"]!!.jsonPrimitive.content)
        assertEquals("coldcard", transaction["bitcoinAccountKey"]!!.jsonPrimitive.content)
        assertTrue("amountSats" in transaction)
        assertFalse("baseUpdatedAtMs" in args)
    }

    @Test
    fun `river source produces a handoff instead of a prepared transaction`() {
        val handoff = prepareBillPayHandoff(
            AddTransactionDraft(
                type = AddTransactionType.SPEND,
                merchant = "Mortgage",
                category = "Bills",
                amount = "123.45",
                inputUnit = DisplayUnit.USD,
                paymentSource = PaymentSource.RIVER_BITCOIN_BILL_PAY,
                date = LocalDate.parse("2026-08-01"),
                note = "River reference",
                owner = FamilyMember.VICTOR,
            ),
        ).getOrThrow()

        assertEquals(PaymentSource.RIVER_BITCOIN_BILL_PAY.wire, handoff.sourceWire)
        assertEquals("Mortgage", handoff.merchant)
        assertEquals("123.45", handoff.amount)
        assertEquals(FamilyMember.VICTOR, handoff.owner)
    }

    private fun preparePaymentTransaction(
        source: PaymentSource,
        amount: String,
        unit: DisplayUnit,
        bitcoinAccountKey: String? = null,
    ): PreparedTransaction =
        prepareTransaction(
            AddTransactionDraft(
                type = AddTransactionType.SPEND,
                merchant = "Payment source test",
                category = "Other",
                amount = amount,
                inputUnit = unit,
                paymentSource = source,
                bitcoinAccountKey = bitcoinAccountKey,
                date = LocalDate.parse("2026-08-01"),
                note = "test",
                owner = FamilyMember.VICTOR,
            ),
            btcPriceCents = BTC_PRICE_CENTS,
            id = "payment-source-test",
            bitcoinAccounts = bitcoinAccountKey?.let { key ->
                listOf(
                    BtcAccount(
                        key = key,
                        label = key,
                        custody = Custody.SELF_CUSTODY,
                        sats = 100_000L,
                        fiatCents = 100L,
                        owner = FamilyMember.VICTOR,
                    ),
                )
            }.orEmpty(),
        ).getOrThrow()

    private companion object {
        const val BTC_PRICE_CENTS = 10_000_000L
    }
}
