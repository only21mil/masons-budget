package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.TransactionDraftIdStore
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.ConvexSyncTokenSource
import com.sats21m.vogelvault.data.HttpPoster
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.testToken
import com.sats21m.vogelvault.domain.CategorySpend
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.IncomeEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class VaultWriteEditorsTest {
    @Test
    fun `budget edit accepts only the exact budget document month`() {
        val current = seed(displayedMonth = "2026-07")
        val earlier = seed(displayedMonth = "2026-06")
        val future = seed(displayedMonth = "2026-08")

        val valid = assertIs<WriteDraftResult.Valid<BudgetCategoryWriteRequest>>(
            budgetCategoryWriteRequest(current, "975.01"),
        )
        assertEquals("2026-07", valid.request.month)
        assertEquals(97_501L, valid.request.budgetCents)
        assertEquals("cart", valid.request.icon)
        assertIs<WriteDraftResult.Invalid>(budgetCategoryWriteRequest(earlier, "975.01"))
        assertIs<WriteDraftResult.Invalid>(budgetCategoryWriteRequest(future, "975.01"))
    }

    @Test
    fun `budget amount rejects hidden rounding`() {
        assertIs<WriteDraftResult.Invalid>(
            budgetCategoryWriteRequest(seed(displayedMonth = "2026-07"), "975.001"),
        )
    }

    @Test
    fun `btc entry preserves independently entered sats price and fiat`() {
        val result = assertIs<WriteDraftResult.Valid<BtcBuyWriteRequest>>(
            btcBuyWriteRequest(
                owner = FamilyMember.MASON,
                id = "android-test",
                date = "2026-07-29",
                source = "Strike",
                sats = "123456",
                priceUsd = "117000.25",
                purchaseUsd = "121.99",
            ),
        )

        assertEquals(123_456L, result.request.sats)
        assertEquals(11_700_025L, result.request.priceUsdCents)
        assertEquals(12_199L, result.request.usdCents)
        assertEquals(0L, result.request.feeUsdCents)
    }

    @Test
    fun `standalone Bitcoin buy sends an explicit exact fee and rejects a negative fee`() {
        val store = TransactionDraftIdStore()
        val poster = BuyPoster(accepted())
        val client = buyClient(poster)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

        try {
            val id = store.currentId(adultBuyScope)
            runBlocking {
                saveBuy(
                    scope = scope,
                    store = store,
                    client = client,
                    id = id,
                    feeUsdCents = 25L,
                ).join()
            }

            assertEquals("GQAAAAAAAAA=", wireBuyFee(poster.bodies.single()))
            assertFailsWith<IllegalArgumentException> {
                buyRequest(id = "negative-fee", feeUsdCents = -1L)
            }
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `btc entry rejects fractional sats and overprecise fiat`() {
        assertIs<WriteDraftResult.Invalid>(
            btcBuyWriteRequest(
                FamilyMember.VICTOR,
                "fractional-sats",
                "2026-07-29",
                "River",
                "1.5",
                "117000.25",
                "10.00",
            ),
        )
        assertIs<WriteDraftResult.Invalid>(
            btcBuyWriteRequest(
                FamilyMember.VICTOR,
                "rounded-fiat",
                "2026-07-29",
                "River",
                "1000",
                "117000.251",
                "10.00",
            ),
        )
    }

    @Test
    fun `adult income buy canonicalizes Rachel to the Victor household owner`() {
        val result = assertIs<WriteDraftResult.Valid<BtcBuyFromIncomeWriteRequest>>(
            btcBuyFromIncomeWriteRequest(
                viewer = FamilyMember.RACHEL,
                id = "income-buy-1",
                income = incomeEntry(),
                source = "River",
                sats = "100000",
                priceUsd = "65000.00",
                buyNote = "paycheck DCA",
            ),
        )

        assertEquals(FamilyMember.VICTOR, result.request.owner)
        assertEquals(FamilyMember.RACHEL, result.request.profile)
        assertEquals("income-buy-1", result.request.buy.id)
        assertEquals("income-buy-1", result.request.linkedIncome.id)
        assertEquals(FamilyMember.VICTOR, result.request.buy.owner)
        assertEquals(FamilyMember.VICTOR, result.request.linkedIncome.owner)
        assertEquals(result.request.buy.date, result.request.linkedIncome.date)
        assertEquals(result.request.buy.usdCents, result.request.linkedIncome.amountCents)
        assertEquals("Payroll", result.request.linkedIncome.source)
        assertEquals("paycheck DCA", result.request.buy.note)
    }

    @Test
    fun `income buy rejects child viewers and cannot create a sat income transaction`() {
        assertIs<WriteDraftResult.Invalid>(
            btcBuyFromIncomeWriteRequest(
                viewer = FamilyMember.MASON,
                id = "child-buy",
                income = incomeEntry(owner = FamilyMember.MASON),
                source = "River",
                sats = "100000",
                priceUsd = "65000.00",
            ),
        )
        val result = assertIs<WriteDraftResult.Valid<BtcBuyFromIncomeWriteRequest>>(
            btcBuyFromIncomeWriteRequest(
                viewer = FamilyMember.VICTOR,
                id = "income-buy-2",
                income = incomeEntry(),
                source = "River",
                sats = "100000",
                priceUsd = "65000.00",
            ),
        )
        assertEquals(100_000L, result.request.buy.sats)
    }

    @Test
    fun `income buy save sends one atomic device mutation and rotates only after acceptance`() = runBlocking {
        val store = TransactionDraftIdStore()
        val poster = BuyPoster(accepted())
        val gateway = BtcBuyIncomeMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(
                    ConvexConfig(deploymentUrl = "https://income-buy-device-test.convex.cloud"),
                ),
                credentialSource = ConvexDeviceCredentialSource {
                    ConvexDeviceCredential("test-device", "t".repeat(43))
                },
                http = poster,
            ),
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        try {
            val incomeScope = btcBuyDraftIdScope(
                surface = BtcBuyWriteSurface.INCOME_LINKED,
                profile = FamilyMember.RACHEL,
            )
            val id = store.currentId(incomeScope)
            val request = assertIs<WriteDraftResult.Valid<BtcBuyFromIncomeWriteRequest>>(
                btcBuyFromIncomeWriteRequest(
                    viewer = FamilyMember.RACHEL,
                    id = id,
                    income = incomeEntry(),
                    source = "River",
                    sats = "100000",
                    priceUsd = "65000.00",
                ),
            ).request

            launchBtcBuyFromIncomeSave(
                scope = scope,
                request = request,
                gateway = gateway,
                buyDraftIds = store,
                onResult = {},
            ).join()

            assertEquals(1, poster.bodies.size)
            val wire = Json.parseToJsonElement(poster.bodies.single()).jsonObject
            assertEquals("tables:upsertBtcBuyFromDevice", wire["path"]!!.jsonPrimitive.content)
            val args = wire["args"]!!.jsonObject
            assertEquals("bitcoin-buys", args["sourceFile"]!!.jsonPrimitive.content)
            assertEquals("victor", args["owner"]!!.jsonPrimitive.content)
            assertEquals(
                args["buy"]!!.jsonObject["id"]!!.jsonPrimitive.content,
                args["linkedIncome"]!!.jsonObject["id"]!!.jsonPrimitive.content,
            )
            assertEquals(
                args["buy"]!!.jsonObject["date"]!!.jsonPrimitive.content,
                args["linkedIncome"]!!.jsonObject["date"]!!.jsonPrimitive.content,
            )
            assertNotEquals(id, store.currentId(incomeScope))
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `standalone and income linked bitcoin buys do not share a same-file lease`() {
        val store = TransactionDraftIdStore()
        val standaloneScope = btcBuyDraftIdScope(
            surface = BtcBuyWriteSurface.STANDALONE,
            profile = FamilyMember.VICTOR,
        )
        val incomeLinkedScope = btcBuyDraftIdScope(
            surface = BtcBuyWriteSurface.INCOME_LINKED,
            profile = FamilyMember.VICTOR,
        )
        val standaloneId = store.currentId(standaloneScope)
        val incomeLinkedId = store.currentId(incomeLinkedScope)

        assertNotEquals(
            standaloneId,
            incomeLinkedId,
            "standalone and income-linked buys need independent retry leases",
        )
    }

    @Test
    fun `bitcoin buy leases distinguish Victor Rachel and Maddox profiles`() {
        val store = TransactionDraftIdStore()
        val ids = listOf(
            FamilyMember.VICTOR,
            FamilyMember.RACHEL,
            FamilyMember.MADDOX,
        ).map { profile ->
            store.currentId(
                btcBuyDraftIdScope(
                    surface = BtcBuyWriteSurface.STANDALONE,
                    profile = profile,
                ),
            )
        }

        assertEquals(
            3,
            ids.toSet().size,
            "profile retry leases must not collide even when profiles share a data file",
        )
    }

    private fun incomeEntry(owner: FamilyMember = FamilyMember.VICTOR) =
        IncomeEntry(
            id = "paycheck-1",
            date = "2026-08-01",
            month = "2026-08",
            amountCents = 650_000L,
            sourceName = "Payroll",
            note = "August paycheck",
            owner = owner,
        )

    private fun seed(displayedMonth: String) =
        BudgetCategoryEditorSeed(
            viewer = FamilyMember.RACHEL,
            displayedMonth = displayedMonth,
            budgetDocumentMonth = "2026-07",
            category = CategorySpend("Groceries", 90_000L, 50_000L, icon = "cart"),
        )

    /**
     * The blocker the revision review caught: the buy store handed out an id
     * but nothing ever released it, so every later buy reused the first id
     * forever. This drives launchBtcBuySave — the exact function the sheet
     * calls — through two CONFIRMED buys and requires distinct ids on the wire.
     */
    @Test
    fun `each confirmed bitcoin buy uses a fresh draft id`() {
        val store = TransactionDraftIdStore()
        val poster = BuyPoster(accepted())
        val client = buyClient(poster)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

        try {
            val firstId = store.currentId(adultBuyScope)
            runBlocking { saveBuy(scope, store, client, firstId).join() }
            val secondId = store.currentId(adultBuyScope)
            runBlocking { saveBuy(scope, store, client, secondId).join() }

            assertNotEquals(
                firstId,
                secondId,
                "a confirmed buy must release its id so the next buy is a new row",
            )
            assertEquals(2, poster.bodies.size)
            assertEquals(firstId, wireBuyId(poster.bodies[0]))
            assertEquals(secondId, wireBuyId(poster.bodies[1]))
        } finally {
            scope.cancel()
        }
    }

    /**
     * The inverse guarantee, which the rotation must not break: a rejected or
     * ambiguous buy KEEPS its id so the retry supersedes the same row instead
     * of crediting River a second time.
     */
    @Test
    fun `a rejected bitcoin buy keeps its draft id for the retry`() {
        val store = TransactionDraftIdStore()
        val poster = BuyPoster(HttpTextResponse(500, ""))
        val client = buyClient(poster)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

        try {
            val firstId = store.currentId(adultBuyScope)
            runBlocking { saveBuy(scope, store, client, firstId).join() }

            assertEquals(
                firstId,
                store.currentId(adultBuyScope),
                "a non-accepted buy must retain its id so the retry cannot duplicate",
            )
        } finally {
            scope.cancel()
        }
    }

    /**
     * The race the revision review caught: rotation used to clear whichever id
     * was current rather than the one that was accepted.
     *
     * Two overlapping requests can carry the SAME id (dismiss, reopen, retry
     * before the first returns) and Convex accepts both idempotently. If the
     * second, delayed acceptance blindly cleared the store, it would discard
     * the id the user's NEXT operation had already taken — and the operation
     * after that would mint a third id and duplicate the row.
     */
    @Test
    fun `a late duplicate acceptance cannot clear the next operation id`() {
        val store = TransactionDraftIdStore()
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

        try {
            val sharedId = store.currentId(adultBuyScope)

            // Request A: accepted immediately, releasing the shared id.
            runBlocking {
                saveBuy(scope, store, buyClient(BuyPoster(accepted())), sharedId).join()
            }

            // The user starts the NEXT legitimate operation and takes a new id.
            val nextId = store.currentId(adultBuyScope)
            assertNotEquals(sharedId, nextId)

            // Request B: the overlapping retry of the SAME id, whose accepted
            // response only arrives now — after nextId was handed out.
            val gatedPoster = object : HttpPoster {
                override suspend fun postJson(url: String, body: String): HttpTextResponse {
                    gate.await()
                    return accepted()
                }
            }
            val late = saveBuy(scope, store, buyClient(gatedPoster), sharedId)
            gate.complete(Unit)
            runBlocking { late.join() }

            assertEquals(
                nextId,
                store.currentId(adultBuyScope),
                "a late acceptance of a superseded id must not clear the id the next operation already holds",
            )
        } finally {
            scope.cancel()
        }
    }

    /**
     * The cross-profile collision the scope-aware lease closes: the lease is
     * keyed by the server's natural scope (the wire sourceFile), never shared
     * process-globally across profiles.
     *
     * Without scoping: an adult buy X commits but its response is lost, the
     * store retains X, a Mason sheet reuses X under `mason-bitcoin-buys`
     * (which Convex legitimately accepts as a NEW row), the acceptance clears
     * the shared lease, and the adult retry mints Y — inserting a second adult
     * buy and crediting River twice.
     */
    @Test
    fun `a mason acceptance of an equal id cannot release the adult scope lease`() {
        val store = TransactionDraftIdStore()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

        try {
            // The adult buy takes X; its outcome is ambiguous (response lost),
            // so the adult scope keeps X leased for the retry.
            val adultId = store.currentId(adultBuyScope)
            runBlocking {
                saveBuy(scope, store, buyClient(BuyPoster(HttpTextResponse(500, ""))), adultId).join()
            }

            // A Mason sheet opening now must acquire under Mason's own scope
            // and must NOT be handed the adult's pending X.
            val masonId = store.currentId(masonBuyScope)
            assertNotEquals(
                adultId,
                masonId,
                "a mason sheet must never acquire another scope's pending id",
            )

            // Even if an id equal to X is accepted under Mason's sourceFile,
            // that acceptance belongs to Mason's scope and must leave the
            // adult lease untouched.
            val masonPoster = BuyPoster(accepted())
            runBlocking {
                saveBuy(
                    scope,
                    store,
                    buyClient(masonPoster),
                    adultId,
                    owner = FamilyMember.MASON,
                ).join()
            }
            assertEquals("mason-bitcoin-buys", wireBuySourceFile(masonPoster.bodies.single()))

            assertEquals(
                adultId,
                store.currentId(adultBuyScope),
                "the adult retry must reuse X so it supersedes the ambiguous row " +
                    "instead of inserting a duplicate adult buy and crediting River twice",
            )
            assertEquals(
                masonId,
                store.currentId(masonBuyScope),
                "mason's own pending id must also survive an acceptance that is not his pending id",
            )
        } finally {
            scope.cancel()
        }
    }

    private val adultBuyScope = btcBuyDraftIdScope(
        surface = BtcBuyWriteSurface.STANDALONE,
        profile = FamilyMember.VICTOR,
    )
    private val masonBuyScope = btcBuyDraftIdScope(
        surface = BtcBuyWriteSurface.STANDALONE,
        profile = FamilyMember.MASON,
    )

    private fun saveBuy(
        scope: CoroutineScope,
        store: TransactionDraftIdStore,
        client: ConvexMutationClient,
        id: String,
        owner: FamilyMember = FamilyMember.VICTOR,
        feeUsdCents: Long = 0L,
    ) = launchBtcBuySave(
        scope = scope,
        request = buyRequest(id = id, owner = owner, feeUsdCents = feeUsdCents),
        client = client,
        buyDraftIds = store,
        onResult = {},
    )

    private fun buyRequest(
        id: String,
        owner: FamilyMember = FamilyMember.VICTOR,
        feeUsdCents: Long = 0L,
    ) = BtcBuyWriteRequest(
        id = id,
        owner = owner,
        date = "2026-08-01",
        source = "River",
        sats = 100_000L,
        priceUsdCents = 6_500_000L,
        usdCents = 6_500L,
        feeUsdCents = feeUsdCents,
    )

    private fun buyClient(poster: HttpPoster) = ConvexMutationClient(
        configSource = MutableConvexConfigSource(
            ConvexConfig(deploymentUrl = "https://buy-rotation-test.convex.cloud"),
        ),
        syncTokenSource = ConvexSyncTokenSource { testToken() },
        http = poster,
    )

    private fun accepted() = HttpTextResponse(
        200,
        """{"status":"success","value":{"ok":true}}""",
    )

    private fun wireBuyId(body: String): String =
        Json.parseToJsonElement(body).jsonObject["args"]!!.jsonObject["buy"]!!
            .jsonObject["id"]!!.jsonPrimitive.content

    private fun wireBuySourceFile(body: String): String =
        Json.parseToJsonElement(body).jsonObject["args"]!!
            .jsonObject["sourceFile"]!!.jsonPrimitive.content

    private fun wireBuyFee(body: String): String =
        Json.parseToJsonElement(body).jsonObject["args"]!!.jsonObject["buy"]!!
            .jsonObject["feeUsdCents"]!!.jsonObject["\$integer"]!!.jsonPrimitive.content

    private class BuyPoster(private val response: HttpTextResponse) : HttpPoster {
        val bodies = mutableListOf<String>()

        override suspend fun postJson(url: String, body: String): HttpTextResponse {
            bodies += body
            return response
        }
    }

}
