package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.TransactionDraftIdStore
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.ConvexSyncTokenSource
import com.sats21m.vogelvault.data.HttpPoster
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.RecordingPoster
import com.sats21m.vogelvault.data.TransactionKind
import com.sats21m.vogelvault.data.TransactionRevisionStore
import com.sats21m.vogelvault.data.TransactionWriteOutcome
import com.sats21m.vogelvault.data.TransactionWriteReceipt
import com.sats21m.vogelvault.data.testToken
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import java.time.LocalDate
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class AddTransactionSheetTest {
    @Test
    fun `fiat purchase reaches the payload as positive integer cents`() {
        val prepared = prepare(
            amount = "142.18",
            unit = DisplayUnit.USD,
            owner = FamilyMember.VICTOR,
        )

        assertEquals(14_218L, prepared.input.amountCents)
        assertEquals(TransactionKind.SPEND, prepared.input.kind)
        assertEquals("transactions", prepared.sourceFile)
    }

    @Test
    fun `income preserves the server sign convention and legacy transfer fails closed`() {
        val income = prepare(
            amount = "21.00",
            unit = DisplayUnit.USD,
            type = AddTransactionType.INCOME,
            category = "Ignored",
        )
        assertEquals(2_100L, income.input.amountCents)
        assertEquals(TransactionKind.CREDIT, income.input.kind)
        assertEquals("Income", income.input.category)
        assertFails {
            prepare(
                amount = "21.00",
                unit = DisplayUnit.USD,
                type = AddTransactionType.TRANSFER,
                category = "",
            )
        }
    }

    @Test
    fun `btc and sats input convert through the integer cent price without doubles`() {
        val oneBtc = prepare("1.00000000", DisplayUnit.BTC)
        val halfPriceInSats = prepare("50,000,000", DisplayUnit.SATS)

        assertEquals(BTC_PRICE_CENTS, oneBtc.input.amountCents)
        assertEquals(100_000_000L, oneBtc.sats)
        assertEquals(BTC_PRICE_CENTS / 2L, halfPriceInSats.input.amountCents)
        assertEquals(50_000_000L, halfPriceInSats.sats)
    }

    @Test
    fun `switching the sheet input unit converts the entered value`() {
        assertEquals(
            "100000000",
            convertAmountForUnit("117000.00", DisplayUnit.USD, DisplayUnit.SATS, BTC_PRICE_CENTS),
        )
        assertEquals(
            "0.5",
            convertAmountForUnit("50000000", DisplayUnit.SATS, DisplayUnit.BTC, BTC_PRICE_CENTS),
        )
        assertEquals(
            "58500.00",
            convertAmountForUnit("0.5", DisplayUnit.BTC, DisplayUnit.USD, BTC_PRICE_CENTS),
        )
    }

    @Test
    fun `child transactions use the child source file and never the adult file`() {
        listOf(FamilyMember.MASON, FamilyMember.MADDOX).forEach { owner ->
            val prepared = prepare("1.00", DisplayUnit.USD, owner = owner)

            assertEquals("${owner.key}-transactions", prepared.sourceFile)
            assertEquals(owner, prepared.input.owner)
            assertTrue(prepared.sourceFile != "transactions")
        }
    }

    @Test
    fun `unsupported precision and unavailable conversion price fail closed`() {
        assertFails {
            prepare("1.001", DisplayUnit.USD)
        }
        assertFails {
            prepare("1.5", DisplayUnit.SATS)
        }
        assertFails {
            prepareTransaction(
                draft(amount = "100", unit = DisplayUnit.SATS),
                btcPriceCents = 0L,
                id = "test-id",
            ).getOrThrow()
        }
    }

    @Test
    fun `sub-cent bitcoin conversion is rejected rather than stored as zero`() {
        assertFails {
            prepare("1", DisplayUnit.SATS)
        }
    }

    @Test
    fun `disabled and not configured writes name different causes`() {
        val disabled = assertNotNull(transactionWriteFailureMessage(ConvexResult.Disabled))
        val notConfigured = assertNotNull(
            transactionWriteFailureMessage(ConvexResult.NotConfigured),
        )

        assertNotEquals(disabled, notConfigured)
        assertTrue(disabled.contains("switched off"))
        assertTrue(notConfigured.contains("deployment"))
        assertTrue(notConfigured.contains("token"))
    }

    @Test
    fun `brand new unsynced row saves without a fence and installs accepted revision`() {
        val revision = 1_888_888_888_889L
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"success","value":{"txId":"test-id","owner":"victor","month":"2026-07","outcome":"inserted","updatedAtMs":$revision}}""",
            ),
        )
        val client = ConvexMutationClient(
            configSource = MutableConvexConfigSource(
                ConvexConfig(deploymentUrl = DEPLOYMENT),
            ),
            syncTokenSource = ConvexSyncTokenSource { testToken() },
            http = poster,
        )

        val result = runBlocking {
            savePreparedTransaction(
                prepare("1.00", DisplayUnit.USD),
                client,
            )
        }

        val receipt = assertIs<ConvexResult.Ok<TransactionWriteReceipt>>(result).value
        assertEquals(TransactionWriteOutcome.INSERTED, receipt.outcome)
        assertEquals(revision, receipt.updatedAtMs)
        assertEquals(revision, client.acceptedTransactionRevision("transactions", "test-id"))
        val args = Json.parseToJsonElement(poster.bodies.single()).jsonObject["args"]!!.jsonObject
        assertTrue("baseUpdatedAtMs" !in args)
        assertEquals("test-id", args["transaction"]!!.jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `dismissed sheet keeps the accepted write visible and suppresses only UI`() = runBlocking {
        val requestStarted = CompletableDeferred<Unit>()
        val response = CompletableDeferred<HttpTextResponse>()
        val poster = object : HttpPoster {
            override suspend fun postJson(url: String, body: String): HttpTextResponse {
                requestStarted.complete(Unit)
                return response.await()
            }
        }
        val client = ConvexMutationClient(
            configSource = MutableConvexConfigSource(ConvexConfig(deploymentUrl = DEPLOYMENT)),
            syncTokenSource = ConvexSyncTokenSource { testToken() },
            http = poster,
        )
        val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transactionDraftIds = TransactionDraftIdStore()
        val uiActive = AtomicBoolean(true)
        var uiResultCount = 0
        var acceptedCount = 0

        try {
            val save = launchPreparedTransactionSave(
                scope = applicationScope,
                row = prepare("1.00", DisplayUnit.USD),
                client = client,
                transactionDraftIds = transactionDraftIds,
                isUiActive = uiActive::get,
                onAccepted = { acceptedCount++ },
                onUiResult = { uiResultCount++ },
            )
            requestStarted.await()

            uiActive.set(false)
            response.complete(
                HttpTextResponse(
                    200,
                    """{"status":"success","value":{"txId":"test-id","owner":"victor","month":"2026-07","outcome":"inserted","updatedAtMs":1888888888890}}""",
                ),
            )
            save.join()

            assertEquals(
                1,
                acceptedCount,
                "The acceptance signal must fire after dismissal — it drives the ledger " +
                    "refresh owned by the view model, so a committed write stays visible.",
            )
            assertEquals(0, uiResultCount)
            assertEquals(
                1_888_888_888_890L,
                client.acceptedTransactionRevision("transactions", "test-id"),
            )
        } finally {
            applicationScope.cancel()
        }
    }

    @Test
    fun `reopened sheet reuses the pending draft id until the server confirms`() = runBlocking {
        val transactionDraftIds = TransactionDraftIdStore()
        val firstId = transactionDraftIds.currentId(ADULT_TX_SCOPE)
        val poster = GatedTransactionPoster(requestCount = 1)
        val client = ConvexMutationClient(
            configSource = MutableConvexConfigSource(ConvexConfig(deploymentUrl = DEPLOYMENT)),
            syncTokenSource = ConvexSyncTokenSource { testToken() },
            http = poster,
        )
        val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        var rotatedBeforeAcceptedSignal = false

        try {
            val save = launchPreparedTransactionSave(
                scope = applicationScope,
                row = prepare("1.00", DisplayUnit.USD, id = firstId),
                client = client,
                transactionDraftIds = transactionDraftIds,
                isUiActive = { true },
                onAccepted = {
                    rotatedBeforeAcceptedSignal = transactionDraftIds.currentId(ADULT_TX_SCOPE) != firstId
                },
                onUiResult = {},
            )
            poster.requestStarted[0].await()

            val reopenedId = transactionDraftIds.currentId(ADULT_TX_SCOPE)
            assertEquals(firstId, reopenedId)

            poster.responses[0].complete(acceptedResponse(firstId, 1_888_888_888_891L))
            save.join()

            assertTrue(rotatedBeforeAcceptedSignal)
            assertNotEquals(firstId, transactionDraftIds.currentId(ADULT_TX_SCOPE))
        } finally {
            applicationScope.cancel()
        }
    }

    @Test
    fun `ambiguous first write then resubmit cannot double-create`() = runBlocking {
        val transactionDraftIds = TransactionDraftIdStore()
        val transactionRevisions = TransactionRevisionStore()
        val poster = GatedTransactionPoster(requestCount = 2)
        val client = ConvexMutationClient(
            configSource = MutableConvexConfigSource(ConvexConfig(deploymentUrl = DEPLOYMENT)),
            syncTokenSource = ConvexSyncTokenSource { testToken() },
            http = poster,
            transactionRevisions = transactionRevisions,
        )
        val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val firstId = transactionDraftIds.currentId(ADULT_TX_SCOPE)

        try {
            val firstSave = launchPreparedTransactionSave(
                scope = applicationScope,
                row = prepare("1.00", DisplayUnit.USD, id = firstId),
                client = client,
                transactionDraftIds = transactionDraftIds,
                isUiActive = { false },
                onAccepted = {},
                onUiResult = {},
            )
            poster.requestStarted[0].await()

            val reopenedId = transactionDraftIds.currentId(ADULT_TX_SCOPE)
            assertEquals(firstId, reopenedId)
            val secondSave = launchPreparedTransactionSave(
                scope = applicationScope,
                row = prepare("2.00", DisplayUnit.USD, id = reopenedId),
                client = client,
                transactionDraftIds = transactionDraftIds,
                isUiActive = { true },
                onAccepted = {},
                onUiResult = {},
            )
            poster.requestStarted[1].await()

            poster.responses[0].complete(acceptedResponse(firstId, 1_888_888_888_892L))
            firstSave.join()
            poster.responses[1].complete(
                acceptedResponse(
                    id = firstId,
                    revision = 1_888_888_888_893L,
                    outcome = "updated",
                ),
            )
            secondSave.join()

            assertEquals(listOf(firstId, firstId), poster.bodies.map(::transactionIdFromBody))
            assertEquals(1, transactionRevisions.entryCount())
            assertEquals(
                1_888_888_888_893L,
                transactionRevisions.revisionFor("transactions", firstId),
            )
        } finally {
            applicationScope.cancel()
        }
    }

    private fun prepare(
        amount: String,
        unit: DisplayUnit,
        owner: FamilyMember = FamilyMember.VICTOR,
        type: AddTransactionType = AddTransactionType.SPEND,
        category: String = "Groceries",
        id: String = "test-id",
    ) = prepareTransaction(
        draft(amount, unit, owner, type, category),
        btcPriceCents = BTC_PRICE_CENTS,
        id = id,
    ).getOrThrow()

    private fun draft(
        amount: String,
        unit: DisplayUnit,
        owner: FamilyMember = FamilyMember.VICTOR,
        type: AddTransactionType = AddTransactionType.SPEND,
        category: String = "Groceries",
    ) = AddTransactionDraft(
        type = type,
        merchant = "Neighborhood Market",
        category = category,
        amount = amount,
        inputUnit = unit,
        card = "Debit",
        date = LocalDate.parse("2026-07-29"),
        note = "Regression test",
        owner = owner,
    )

    private companion object {
        const val BTC_PRICE_CENTS = 11_700_000L
        const val DEPLOYMENT = "https://keen-elephant-452.convex.cloud"

        /** The wire sourceFile every VICTOR-owned row in these tests is sent under. */
        val ADULT_TX_SCOPE = FamilyMember.VICTOR.ledgerOwner.transactionsDataFileName
    }
}

private class GatedTransactionPoster(requestCount: Int) : HttpPoster {
    private val requestIndex = AtomicInteger(0)
    private val capturedBodies = arrayOfNulls<String>(requestCount)
    val requestStarted = List(requestCount) { CompletableDeferred<Unit>() }
    val responses = List(requestCount) { CompletableDeferred<HttpTextResponse>() }
    val bodies: List<String>
        get() = capturedBodies.map { checkNotNull(it) }

    override suspend fun postJson(url: String, body: String): HttpTextResponse {
        val index = requestIndex.getAndIncrement()
        check(index in capturedBodies.indices) { "Unexpected transaction request $index" }
        capturedBodies[index] = body
        requestStarted[index].complete(Unit)
        return responses[index].await()
    }
}

private fun acceptedResponse(
    id: String,
    revision: Long,
    outcome: String = "inserted",
) = HttpTextResponse(
    200,
    """{"status":"success","value":{"txId":"$id","owner":"victor","month":"2026-07","outcome":"$outcome","updatedAtMs":$revision}}""",
)

private fun transactionIdFromBody(body: String): String =
    Json.parseToJsonElement(body)
        .jsonObject["args"]!!
        .jsonObject["transaction"]!!
        .jsonObject["id"]!!
        .jsonPrimitive.content
