package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.RecordingPoster
import com.sats21m.vogelvault.data.testToken
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Transaction
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class TransactionDetailScreenTest {
    @Test
    fun `valid edit preserves identity owner source and exact signed cents`() {
        val poster = RecordingPoster(success())
        val actions = actions(poster)
        val transaction = transaction(owner = FamilyMember.MASON)

        val result =
            runBlocking {
                actions.save(
                    transaction,
                    TransactionDraft(
                        merchant = "  Corrected Market ",
                        category = "Groceries",
                        amount = "142.18",
                        method = "  Fold card ",
                        date = "2026-07-28",
                        note = "  corrected receipt ",
                    ),
                )
            }

        assertEquals(TransactionActionResult.Success, result)
        val body = Json.parseToJsonElement(poster.bodies.single()).jsonObject
        assertEquals("tables:upsertTransactionFromDevice", body["path"]?.jsonPrimitive?.content)
        assertEquals(
            "convex_encoded_json",
            body["format"]?.jsonPrimitive?.content,
        )
        val args = body["args"]!!.jsonObject
        assertEquals("mason-transactions", args["sourceFile"]?.jsonPrimitive?.content)
        val sent = args["transaction"]!!.jsonObject
        assertEquals(transaction.id, sent["id"]?.jsonPrimitive?.content)
        assertEquals("mason", sent["owner"]?.jsonPrimitive?.content)
        assertEquals("Corrected Market", sent["merchant"]?.jsonPrimitive?.content)
        assertEquals("Fold card", sent["card"]?.jsonPrimitive?.content)
        assertEquals("corrected receipt", sent["note"]?.jsonPrimitive?.content)
        assertEquals("spend", sent["kind"]?.jsonPrimitive?.content)
        assertEquals(
            "ijcAAAAAAAA=",
            sent["amountCents"]!!
                .jsonObject["\$integer"]
                ?.jsonPrimitive
                ?.content,
        )
        assertEquals(
            REVISION.toString(),
            args["baseUpdatedAtMs"]?.jsonPrimitive?.content,
        )
    }

    @Test
    fun `active Bitcoin edit forwards the stored posting fields unchanged`() {
        assertBitcoinEditPosting(
            card = "zeus_lightning",
            accountKey = "zeus-wallet",
        )
    }

    @Test
    fun `retired Bitcoin edit forwards the stored posting fields unchanged`() {
        assertBitcoinEditPosting(
            card = "lightning",
            accountKey = "legacy-lightning-wallet",
        )
    }

    @Test
    fun `unrecognised legacy card survives an edit byte for byte`() {
        val poster = RecordingPoster(success(owner = "victor"))
        val legacyCard = "  Fold card  "
        val original = transaction(card = legacyCard)

        val result = runBlocking {
            actions(poster).save(
                original,
                draft(method = legacyCard),
            )
        }

        assertEquals(TransactionActionResult.Success, result)
        val sent =
            Json.parseToJsonElement(poster.bodies.single()).jsonObject["args"]!!
                .jsonObject["transaction"]!!
                .jsonObject
        assertEquals(legacyCard, sent["card"]?.jsonPrimitive?.content)
    }

    @Test
    fun `editing a server row without a revision refuses instead of sending unfenced`() {
        val poster = RecordingPoster(success())
        val actions = actions(poster)

        val result =
            runBlocking {
                actions.save(
                    transaction(updatedAtMs = 0L),
                    draft(),
                )
            }

        val error = assertIs<TransactionActionResult.Error>(result)
        assertEquals(TRANSACTION_REVISION_REQUIRED_MESSAGE, error.message)
        assertTrue(poster.urls.isEmpty())
        assertTrue(poster.bodies.isEmpty())
    }

    @Test
    fun `editing a purchase negative is rejected visibly before network`() {
        val poster = RecordingPoster(success())
        val actions = actions(poster)

        val result =
            runBlocking {
                actions.save(
                    transaction(),
                    draft(amount = "-12.34"),
                )
            }

        val error = assertIs<TransactionActionResult.Error>(result)
        assertTrue(error.message.contains("purchases and income must have a positive amount"))
        assertTrue(poster.urls.isEmpty())
        assertTrue(poster.bodies.isEmpty())
    }

    @Test
    fun `delete sends irreversible scope explicitly for child row`() {
        val poster = RecordingPoster(success())
        val actions = actions(poster)

        val result = runBlocking { actions.delete(transaction(owner = FamilyMember.MASON)) }

        assertEquals(TransactionActionResult.Success, result)
        val body = Json.parseToJsonElement(poster.bodies.single()).jsonObject
        assertEquals("tables:deleteTransactionFromDevice", body["path"]?.jsonPrimitive?.content)
        val args = body["args"]!!.jsonObject
        assertEquals("activity-row", args["entityId"]?.jsonPrimitive?.content)
        assertEquals("mason", args["owner"]?.jsonPrimitive?.content)
        assertEquals("mason-transactions", args["sourceFile"]?.jsonPrimitive?.content)
        assertEquals(REVISION.toString(), args["baseUpdatedAtMs"]?.jsonPrimitive?.content)
    }

    @Test
    fun `server rejection remains visible and the editor can stay open`() {
        val poster =
            RecordingPoster(
                HttpTextResponse(
                    200,
                    """{"status":"error","errorData":"sign mismatch","errorMessage":"redacted"}""",
                ),
            )

        val result = runBlocking { actions(poster).save(transaction(), draft()) }

        val error = assertIs<TransactionActionResult.Error>(result)
        assertTrue(error.message.contains("Convex refused the change"))
    }

    @Test
    fun `amount parser never rounds money`() {
        assertEquals(14_218L, parseTransactionCents("$142.18"))
        assertEquals(-1L, parseTransactionCents("-0.01"))
        assertEquals(null, parseTransactionCents("1.001"))
        assertEquals(null, parseTransactionCents("NaN"))
        assertEquals("142.18", editableTransactionAmount(14_218L))
        assertEquals("-0.01", editableTransactionAmount(-1L))
    }

    private fun actions(poster: RecordingPoster) =
        ConvexTransactionActions(
            ConvexDeviceMutationClient(
                configSource =
                    MutableConvexConfigSource(
                        ConvexConfig(deploymentUrl = DEPLOYMENT),
                    ),
                credentialSource = ConvexDeviceCredentialSource { ConvexDeviceCredential("test-device", "t".repeat(43)) },
                http = poster,
            ),
        )

    private fun assertBitcoinEditPosting(
        card: String,
        accountKey: String,
    ) {
        val poster = RecordingPoster(success(owner = "victor"))
        val original =
            transaction(
                card = card,
                amountSats = 21_000L,
                bitcoinAccountKey = accountKey,
            )

        val result = runBlocking { actions(poster).save(original, draft(method = card)) }

        assertEquals(TransactionActionResult.Success, result)
        val sent =
            Json.parseToJsonElement(poster.bodies.single()).jsonObject["args"]!!
                .jsonObject["transaction"]!!
                .jsonObject
        assertEquals(card, sent["card"]?.jsonPrimitive?.content)
        assertEquals(
            "CFIAAAAAAAA=",
            sent["amountSats"]?.jsonObject?.get("\$integer")?.jsonPrimitive?.content,
        )
        assertEquals(accountKey, sent["bitcoinAccountKey"]?.jsonPrimitive?.content)
    }

    private fun transaction(
        owner: FamilyMember = FamilyMember.VICTOR,
        updatedAtMs: Long = REVISION,
        card: String = "Visa",
        amountSats: Long? = null,
        bitcoinAccountKey: String? = null,
    ) = Transaction(
        id = "activity-row",
        date = "2026-07-29",
        merchant = "Neighborhood Market",
        amount = 14_218L,
        category = "Groceries",
        card = card,
        note = "original",
        owner = owner,
        amountSats = amountSats,
        bitcoinAccountKey = bitcoinAccountKey,
        updatedAtMs = updatedAtMs,
    )

    private fun draft(
        amount: String = "142.18",
        method: String = "Visa",
    ) =
        TransactionDraft(
            merchant = "Neighborhood Market",
            category = "Groceries",
            amount = amount,
            method = method,
            date = "2026-07-29",
            note = "original",
        )

    private fun success(owner: String = "mason") =
        HttpTextResponse(
            200,
            """{"status":"success","value":{"txId":"activity-row","owner":"$owner","month":"2026-07","outcome":"updated","updatedAtMs":1777777777778}}""",
        )

    private companion object {
        const val DEPLOYMENT = "https://keen-elephant-452.convex.cloud"
        const val REVISION = 1_777_777_777_777L
    }
}
