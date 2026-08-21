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
import com.sats21m.vogelvault.data.TransactionKind
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import java.io.File
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
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class PaymentSourceTest {
    @Test
    fun `catalog matches the fixture ordered wire label route and classification contract`() {
        val fixtureSources = paymentSourceFixture()["sources"]!!.jsonArray
        assertEquals(
            fixtureSources.map { source ->
                source.jsonObject.let {
                    listOf(
                        it["wire"]!!.jsonPrimitive.content,
                        it["label"]!!.jsonPrimitive.content,
                        it["route"]!!.jsonPrimitive.content,
                        it["classification"]!!.jsonPrimitive.content,
                    )
                }
            },
            PaymentSource.entries.map { source ->
                listOf(
                    source.wire,
                    source.label,
                    if (source.route == PaymentSourceRoute.BILL_PAY) "btc_bill_pay" else "transaction",
                    when (source.route) {
                        PaymentSourceRoute.BILL_PAY -> "bill_pay"
                        PaymentSourceRoute.BITCOIN_TRANSACTION -> "bitcoin_native"
                        PaymentSourceRoute.CARD_TRANSACTION -> "fiat_card"
                    },
                )
            },
        )
        PaymentSource.entries.forEach { source ->
            assertEquals(source, PaymentSource.fromWireOrNull(source.wire))
        }
        assertNull(PaymentSource.fromWireOrNull("lightning"))
        assertNull(PaymentSource.fromWireOrNull("on_chain"))
        assertEquals(PaymentSource.DEFAULT, PaymentSource.fromWireOrDefault("lightning"))
        assertEquals(PaymentSource.DEFAULT, PaymentSource.fromWireOrDefault("on_chain"))
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

        PaymentSource.entries.forEach { source ->
            assertTrue(first.select(source), source.name)
            assertEquals(source.wire, first.storedWire(), source.name)
            assertEquals(source, PaymentSourceStore(preferences).current(), source.name)
            assertFalse(preferences.all.values.any { it == source.label }, source.name)
        }
    }

    @Test
    fun `card transaction omits bitcoin posting fields and carries the canonical source wire`() {
        val prepared = preparePaymentTransaction(
            source = PaymentSource.AVEN,
            amount = "12.34",
            unit = DisplayUnit.USD,
            bitcoinAccountKey = "must-not-leak",
        )

        assertEquals("aven", prepared.input.card)
        assertNull(prepared.input.amountSats)
        assertNull(prepared.input.bitcoinAccountKey)
    }

    @Test
    fun `every transaction payment source sends its canonical wire instead of its display label`() {
        PaymentSource.entries.filterNot { it.route == PaymentSourceRoute.BILL_PAY }.forEach { source ->
            val isBitcoin = source.isBitcoinTransaction
            val prepared = preparePaymentTransaction(
                source = source,
                amount = if (isBitcoin) "21000" else "12.34",
                unit = if (isBitcoin) DisplayUnit.SATS else DisplayUnit.USD,
                bitcoinAccountKey = if (isBitcoin) "${source.name.lowercase()}-wallet" else "stale-key",
            )

            assertEquals(source, PaymentSource.fromWireOrNull(source.wire), source.name)
            assertEquals(source.wire, prepared.input.toJson()["card"]!!.jsonPrimitive.content, source.name)
            assertFalse(prepared.input.toJson()["card"]!!.jsonPrimitive.content == source.label, source.name)
        }
    }

    @Test
    fun `retired source wires cannot fall through the legacy bridge as Coinbase Card`() {
        listOf("lightning", "on_chain", "on-chain").forEach { retiredWire ->
            val result = prepareTransaction(
                AddTransactionDraft(
                    type = AddTransactionType.SPEND,
                    merchant = "Retired Bitcoin row",
                    category = "Other",
                    amount = "12.34",
                    inputUnit = DisplayUnit.USD,
                    card = retiredWire,
                    date = LocalDate.parse("2026-08-01"),
                    owner = FamilyMember.VICTOR,
                ),
                btcPriceCents = BTC_PRICE_CENTS,
            )

            assertTrue(result.isFailure, retiredWire)
            assertEquals(
                "Retired payment source $retiredWire cannot create a new transaction",
                result.exceptionOrNull()?.message,
                retiredWire,
            )
        }
    }

    @Test
    fun `bitcoin transaction carries positive exact sats and the selected account key`() {
        val prepared = preparePaymentTransaction(
            source = PaymentSource.ZEUS_LIGHTNING,
            amount = "21000",
            unit = DisplayUnit.SATS,
            bitcoinAccountKey = "lightning-wallet",
        )

        assertEquals("zeus_lightning", prepared.input.card)
        assertEquals(21_000L, prepared.input.amountSats)
        assertEquals("lightning-wallet", prepared.input.bitcoinAccountKey)
        assertTrue(requireNotNull(prepared.input.amountSats) > 0L)
    }

    @Test
    fun `every Bitcoin source preserves exact posting fields for spend and Income`() {
        val bitcoinSources = PaymentSource.entries.filter(PaymentSource::isBitcoinTransaction)

        bitcoinSources.forEach { source ->
            listOf(AddTransactionType.SPEND, AddTransactionType.INCOME).forEach { type ->
                val accountKey = "${source.wire}-wallet"
                val prepared = preparePaymentTransaction(
                    source = source,
                    amount = "21000",
                    unit = DisplayUnit.SATS,
                    bitcoinAccountKey = accountKey,
                    type = type,
                )

                assertEquals(source.wire, prepared.input.card, "$source $type")
                assertEquals(21_000L, prepared.input.amountSats, "$source $type")
                assertEquals(accountKey, prepared.input.bitcoinAccountKey, "$source $type")
                assertEquals(
                    if (type == AddTransactionType.INCOME) TransactionKind.CREDIT else TransactionKind.SPEND,
                    prepared.input.kind,
                    "$source $type",
                )
                assertEquals(
                    if (type == AddTransactionType.INCOME) "Income" else "Other",
                    prepared.input.category,
                    "$source $type",
                )
            }
        }
    }

    @Test
    fun `device transaction gateway sends the device route and exact transaction shape`() = runBlocking {
        val row = preparePaymentTransaction(
            source = PaymentSource.ZEUS_ON_CHAIN,
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
        assertEquals("zeus_on_chain", transaction["card"]!!.jsonPrimitive.content)
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
        type: AddTransactionType = AddTransactionType.SPEND,
    ): PreparedTransaction =
        prepareTransaction(
            AddTransactionDraft(
                type = type,
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

        fun paymentSourceFixture() = Json.parseToJsonElement(paymentSourceFixtureFile().readText()).jsonObject

        fun paymentSourceFixtureFile(): File {
            var directory: File? = File(checkNotNull(System.getProperty("user.dir")))
            while (directory != null) {
                val candidate = File(directory, "shared/domain/fixtures/payment-source-cases.json")
                if (candidate.isFile) return candidate
                directory = directory.parentFile
            }
            error("Could not locate shared/domain/fixtures/payment-source-cases.json")
        }
    }
}
