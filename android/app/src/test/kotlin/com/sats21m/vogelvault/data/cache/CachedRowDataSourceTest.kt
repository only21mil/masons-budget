package com.sats21m.vogelvault.data.cache

import android.app.Application
import androidx.room.Room
import com.sats21m.vogelvault.data.BtcBillPayRow
import com.sats21m.vogelvault.data.BtcBalanceDocumentRow
import com.sats21m.vogelvault.data.BtcSnapshotMetadataRow
import com.sats21m.vogelvault.data.BudgetDocumentSnapshot
import com.sats21m.vogelvault.data.BudgetQueryScope
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.RecordingPoster
import com.sats21m.vogelvault.data.RowCounts
import com.sats21m.vogelvault.data.IncomeRow
import com.sats21m.vogelvault.data.RowQueryRepository
import com.sats21m.vogelvault.data.RowQueryRepositories
import com.sats21m.vogelvault.data.RowSnapshot
import com.sats21m.vogelvault.data.RowVisibilityScope
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.FiatValuation
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CachedRowDataSourceTest {
    private lateinit var database: VaultDatabase
    private lateinit var dao: VaultCacheDao

    @BeforeTest
    fun setUp() {
        val context: Application = RuntimeEnvironment.getApplication()
        database =
            Room
                .inMemoryDatabaseBuilder(context, VaultDatabase::class.java)
                .allowMainThreadQueries()
                .build()
        dao = database.cacheDao()
    }

    @AfterTest
    fun tearDown() {
        database.close()
    }

    @Test
    fun `live read populates Room and remains the current UI source`() =
        runBlocking {
            val remote =
                FakeRows().apply {
                    transactions =
                        ConvexResult.Ok(
                            RowSnapshot(
                                rows = listOf(transaction("authorized", Long.MIN_VALUE)),
                                complete = true,
                            ),
                        )
                }
            val source = CachedRowDataSource(remote, dao, clock = { 100L })
            val viewer = FamilyMember.VICTOR
            val key = CacheQueryKeys.transactions(viewer.key)

            val loaded = source.load(viewer)

            assertFalse(loaded.unauthorized)
            assertEquals(Freshness.LIVE, loaded.data.transactions.status)
            assertEquals(listOf("authorized"), loaded.data.transactions.value.map { it.id })
            assertEquals(Long.MIN_VALUE, loaded.data.transactions.value.single().amount)
            assertEquals(listOf("authorized"), dao.observeTransactions(key).first().map { it.transactionId })
            assertTrue(dao.observeActiveSnapshot(key).first() != null)
        }

    @Test
    fun `Bitcoin buy fee survives remote cache and cached domain mapping`() =
        runBlocking {
            val buy = BtcBuy(
                id = "fee-buy",
                date = "2026-08-25",
                source = "River",
                sats = 100_000L,
                priceUsdCents = 6_500_000L,
                usdCents = 6_500L,
                owner = FamilyMember.VICTOR,
                feeUsdCents = 25L,
            )
            val remote = FakeRows().apply {
                buys = ConvexResult.Ok(RowSnapshot(listOf(buy), true))
            }
            val source = CachedRowDataSource(remote, dao, clock = { 123L })

            source.load(FamilyMember.VICTOR)

            val key = CacheQueryKeys.btcBuys("victor", "visible")
            assertEquals(25L, dao.observeBtcBuys(key).first().single().feeUsdCents)
            val cached = source.observe(FamilyMember.VICTOR).first {
                it.data.btcBuys.value.singleOrNull()?.id == buy.id
            }
            assertEquals(25L, cached.data.btcBuys.value.single().feeUsdCents)
        }

    @Test
    fun `buy cache rows stamp the server revision the way transaction rows do`() =
        runBlocking {
            val buy = BtcBuy(
                id = "revision-buy",
                date = "2026-08-25",
                source = "River",
                sats = 100_000L,
                priceUsdCents = 6_500_000L,
                usdCents = 6_500L,
                owner = FamilyMember.VICTOR,
                updatedAtMs = 1_777_777_777_777L,
            )
            val remote = FakeRows().apply {
                buys = ConvexResult.Ok(RowSnapshot(listOf(buy), true))
            }
            val source = CachedRowDataSource(remote, dao, clock = { 123L })

            source.load(FamilyMember.VICTOR)

            val key = CacheQueryKeys.btcBuys("victor", "visible")
            assertEquals(
                1_777_777_777_777L,
                dao.observeBtcBuys(key).first().single().updatedAtMs,
                "the cached buy must carry the row's server revision, not the fetch clock",
            )
        }

    @Test
    fun `todo cache preserves exact owner revision and mutation fields`() =
        runBlocking {
            val todo = TodoItem(
                id = "mason-task",
                title = "Finish report",
                done = true,
                project = "School",
                area = "Classes",
                due = "2026-08-25",
                flagged = true,
                owner = FamilyMember.MASON,
                lane = "sats",
                notes = "Keep this private",
                priority = 3L,
                createdAt = "2026-08-24T00:00:00.000Z",
                updatedAt = "2026-08-25T00:00:00.000Z",
                completedAt = "2026-08-25T00:00:00.000Z",
                updatedAtMs = 1_800_000_000_000L,
            )
            val remote = FakeRows().apply {
                todos = ConvexResult.Ok(RowSnapshot(listOf(todo), true))
            }
            val source = CachedRowDataSource(remote, dao, clock = { 1_900_000_000_000L })

            source.load(FamilyMember.MASON)

            val key = CacheQueryKeys.todos("mason")
            val entity = dao.observeTodos(key).first().single()
            assertEquals("todos", entity.sourceFile)
            assertEquals(todo.updatedAtMs, entity.updatedAtMs)
            assertEquals(todo.notes, entity.notes)
            val cached = source.observe(FamilyMember.MASON).first {
                it.data.todos.value.singleOrNull()?.id == todo.id
            }.data.todos.value.single()
            assertEquals(todo, cached)
        }

    @Test
    fun `Bitcoin posting fields and remote revision survive the Room cache`() =
        runBlocking {
            val revision = 1_777_777_777_777L
            val remote =
                FakeRows().apply {
                    transactions =
                        ConvexResult.Ok(
                            RowSnapshot(
                                rows = listOf(
                                    transaction(
                                        id = "btc-income",
                                        amount = 8_000L,
                                        category = "Income",
                                        amountSats = 123_456L,
                                        bitcoinAccountKey = "river-wallet",
                                        updatedAtMs = revision,
                                    ),
                                ),
                                complete = true,
                            ),
                        )
                }
            val source = CachedRowDataSource(remote, dao, clock = { 100L })
            val key = CacheQueryKeys.transactions(FamilyMember.VICTOR.key)

            val loaded = source.load(FamilyMember.VICTOR)
            val transaction = loaded.data.transactions.value.single()
            val cached = dao.observeTransactions(key).first().single()

            assertEquals(123_456L, transaction.amountSats)
            assertEquals("river-wallet", transaction.bitcoinAccountKey)
            assertEquals(revision, transaction.updatedAtMs)
            assertEquals(123_456L, cached.amountSats)
            assertEquals("river-wallet", cached.bitcoinAccountKey)
            assertEquals(revision, cached.updatedAtMs)
        }

    @Test
    fun `unauthorized read invalidates current observers and hides the cached snapshot`() =
        runBlocking {
            var now = 100L
            val remote = FakeRows()
            val manualConfig =
                ConvexConfig(
                    deploymentUrl = "https://example.convex.cloud",
                    readToken = "manual-test-token",
                    remoteReadEnabled = true,
                )
            val rejectionCount = AtomicInteger()
            val rejectedConfig = AtomicReference<ConvexConfig>()
            val source =
                CachedRowDataSource(
                    remote = remote,
                    dao = dao,
                    clock = { now },
                    configSource = MutableConvexConfigSource(manualConfig),
                    onUnauthorized = {
                        rejectionCount.incrementAndGet()
                        rejectedConfig.set(it)
                        false
                    },
                )
            val viewer = FamilyMember.VICTOR
            val key = CacheQueryKeys.transactions(viewer.key)
            remote.transactions = ConvexResult.Ok(RowSnapshot(listOf(transaction("old", 1L)), true))
            source.load(viewer)

            now = 200L
            remote.unauthorized = true
            val loaded = source.load(viewer)

            val rejected =
                source.observe(viewer).first {
                    it.staleAuthorization
                }
            assertTrue(loaded.unauthorized)
            assertEquals(Freshness.STALE, rejected.data.transactions.status)
            assertTrue(rejected.data.transactions.value.isEmpty())
            assertTrue(dao.observeTransactions(key).first().isEmpty())
            assertEquals(null, dao.observeActiveSnapshot(key).first())
            assertEquals(
                SnapshotAuthorization.UNAUTHORIZED,
                dao.snapshots(key).single().authorization,
            )
            assertEquals(1, rejectionCount.get())
            assertEquals(manualConfig, rejectedConfig.get())
        }

    @Test
    fun `usable replacement configuration is retried once after token rejection`() =
        runBlocking {
            val remote = FakeRows().apply { unauthorized = true }
            val manualConfig =
                ConvexConfig(
                    deploymentUrl = "https://example.convex.cloud",
                    readToken = "manual-test-token",
                    remoteReadEnabled = true,
                )
            val replacementConfig =
                ConvexConfig(
                    deploymentUrl = "https://example.convex.cloud",
                    readToken = "replacement-test-token",
                    remoteReadEnabled = true,
                )
            val configSource = MutableConvexConfigSource(manualConfig)
            val rejectionCount = AtomicInteger()
            val source =
                CachedRowDataSource(
                    remote = remote,
                    dao = dao,
                    configSource = configSource,
                    onUnauthorized = {
                        rejectionCount.incrementAndGet()
                        configSource.update(replacementConfig)
                        remote.unauthorized = false
                        true
                    },
                )

            val loaded = source.load(FamilyMember.VICTOR)

            assertFalse(loaded.unauthorized)
            assertEquals(1, rejectionCount.get())
            assertEquals(replacementConfig, configSource.current())
        }

    @Test
    fun `replacement installed by concurrent finance read still retries rows`() =
        runBlocking {
            val remote = FakeRows().apply { unauthorized = true }
            val rejected =
                ConvexConfig(
                    deploymentUrl = "https://example.convex.cloud",
                    readToken = "manual-test-token",
                    remoteReadEnabled = true,
                )
            val replacementConfig =
                ConvexConfig(
                    deploymentUrl = "https://example.convex.cloud",
                    readToken = "replacement-test-token",
                    remoteReadEnabled = true,
                )
            val configSource = MutableConvexConfigSource(rejected)
            val source =
                CachedRowDataSource(
                    remote = remote,
                    dao = dao,
                    configSource = configSource,
                    onUnauthorized = {
                        // Mirrors finance winning the shared compare-and-clear lock.
                        configSource.update(replacementConfig)
                        remote.unauthorized = false
                        false
                    },
                )

            val loaded = source.load(FamilyMember.VICTOR)

            assertFalse(loaded.unauthorized)
            assertEquals(Freshness.LIVE, loaded.data.transactions.status)
            assertEquals(replacementConfig, configSource.current())
        }

    @Test
    fun `bare http 401 reports unauthorized and invokes credential rejection`() =
        runBlocking {
            val rejectionCount = AtomicInteger()
            val config =
                ConvexConfig(
                    deploymentUrl = "https://example.convex.cloud",
                    readToken = "manual-test-token",
                    remoteReadEnabled = true,
                )
            val configSource = MutableConvexConfigSource(config)
            // A proxy-generated 401 is ambiguous, but treating it as transport can
            // preserve a genuinely rejected token forever. Prefer the recoverable
            // failure: report Unauthorized and let credential self-healing run.
            val remote =
                RowQueryRepositories.convex(
                    configSource = configSource,
                    http = RecordingPoster(HttpTextResponse(401, "")),
                )
            val source =
                CachedRowDataSource(
                    remote = remote,
                    dao = dao,
                    configSource = configSource,
                    onUnauthorized = {
                        rejectionCount.incrementAndGet()
                        false
                    },
                )

            val loaded = source.load(FamilyMember.VICTOR)

            assertTrue(loaded.unauthorized)
            assertEquals(1, rejectionCount.get())
        }

    @Test
    fun `offline read serves the authorized Room snapshot clearly marked stale`() =
        runBlocking {
            val remote = FakeRows()
            val source = CachedRowDataSource(remote, dao, clock = { 100L })
            val viewer = FamilyMember.VICTOR
            remote.transactions = ConvexResult.Ok(RowSnapshot(listOf(transaction("cached", 42L)), true))
            source.load(viewer)

            remote.offline = true
            val loaded = source.load(viewer)
            val cached =
                source.observe(viewer).first {
                    it.data.transactions.value.singleOrNull()?.id == "cached"
                }

            assertEquals(Freshness.ERROR, loaded.data.transactions.status)
            assertFalse(loaded.unauthorized)
            assertFalse(cached.staleAuthorization)
            assertEquals(Freshness.STALE, cached.data.transactions.status)
            assertTrue(cached.data.transactions.source.contains("cached"))
        }

    @Test
    fun `offline BTC cache preserves unavailable and explicit zero valuation`() =
        runBlocking {
            val viewer = FamilyMember.VICTOR
            val remote =
                FakeRows().apply {
                    accounts =
                        ConvexResult.Ok(
                            RowSnapshot(
                                listOf(
                                    BtcAccount(
                                        "cold",
                                        "Cold",
                                        Custody.SELF_CUSTODY,
                                        541_782_856L,
                                        0L,
                                        viewer,
                                    ),
                                    BtcAccount(
                                        "tiny",
                                        "Tiny",
                                        Custody.SELF_CUSTODY,
                                        1L,
                                        0L,
                                        viewer,
                                        FiatValuation(
                                            cents = 0L,
                                            priceCents = 6_000_000L,
                                            quotedAt = "2026-07-29T12:00:00Z",
                                            source = "fixture quote",
                                            confidence = "verified",
                                        ),
                                    ),
                                ),
                                true,
                            ),
                        )
                }
            val source = CachedRowDataSource(remote, dao, clock = { 100L })
            source.load(viewer)
            remote.offline = true

            val cached =
                source.observe(viewer).first {
                    it.data.btcAccounts.value.size == 2
                }.data.btcAccounts.value.associateBy { it.key }

            assertNull(cached.getValue("cold").fiatValuation)
            val tiny = assertNotNull(cached.getValue("tiny").fiatValuation)
            assertEquals(0L, tiny.cents)
            assertEquals("fixture quote", tiny.source)
            assertEquals("verified", tiny.confidence)
        }

    @Test
    fun `current disk cache does not serve old projected spend sign after reopen`() =
        runBlocking {
            val context: Application = RuntimeEnvironment.getApplication()
            val databaseName = "spend-sign-upgrade-test.db"
            context.deleteDatabase(databaseName)
            val remote =
                FakeRows().apply {
                    transactions =
                        ConvexResult.Ok(
                            RowSnapshot(
                                rows =
                                    listOf(
                                        transaction("old-convention", 3_750L).copy(
                                            spendAmount = -3_750L,
                                        ),
                                    ),
                                complete = true,
                            ),
                        )
                }

            val oldDatabase =
                Room
                    .databaseBuilder(context, VaultDatabase::class.java, databaseName)
                    .build()
            try {
                CachedRowDataSource(remote, oldDatabase.cacheDao(), clock = { 100L })
                    .load(FamilyMember.VICTOR)

                val columns =
                    oldDatabase.openHelper.readableDatabase
                        .query("PRAGMA table_info(`cached_transactions`)")
                        .use { cursor ->
                            buildSet {
                                val nameIndex = cursor.getColumnIndexOrThrow("name")
                                while (cursor.moveToNext()) {
                                    add(cursor.getString(nameIndex))
                                }
                            }
                        }
                assertEquals(5, oldDatabase.openHelper.readableDatabase.version)
                assertTrue("amount_cents" in columns)
                assertTrue("amount_sats" in columns)
                assertFalse("spend_amount" in columns)
                assertFalse("display_spend_amount" in columns)
            } finally {
                oldDatabase.close()
            }

            val reopenedDatabase =
                Room
                    .databaseBuilder(context, VaultDatabase::class.java, databaseName)
                    .build()
            try {
                val cached =
                    CachedRowDataSource(remote, reopenedDatabase.cacheDao())
                        .observe(FamilyMember.VICTOR)
                        .first {
                            it.data.transactions.value.singleOrNull()?.id == "old-convention"
                        }
                val transaction = cached.data.transactions.value.single()

                assertEquals(5, reopenedDatabase.openHelper.readableDatabase.version)
                assertEquals(3_750L, transaction.amount)
                assertEquals(3_750L, transaction.spendAmount)
                assertEquals(3_750L, transaction.displaySpendAmount)
                assertFalse(transaction.hasOppositeSpendSign)
            } finally {
                reopenedDatabase.close()
                context.deleteDatabase(databaseName)
            }
        }

    @Test
    fun `later authorized read recovers from an unauthorized generation`() =
        runBlocking {
            var now = 100L
            val remote = FakeRows()
            val source = CachedRowDataSource(remote, dao, clock = { now })
            val viewer = FamilyMember.VICTOR
            val key = CacheQueryKeys.transactions(viewer.key)
            remote.transactions = ConvexResult.Ok(RowSnapshot(listOf(transaction("old", 1L)), true))
            source.load(viewer)
            remote.unauthorized = true
            source.load(viewer)

            now = 300L
            remote.unauthorized = false
            remote.transactions =
                ConvexResult.Ok(
                    RowSnapshot(
                        rows = listOf(transaction("recovered", Long.MAX_VALUE)),
                        complete = true,
                    ),
                )
            val loaded = source.load(viewer)

            val recovered =
                source.observe(viewer).first {
                    it.data.transactions.status == Freshness.STALE &&
                        it.data.transactions.value.singleOrNull()?.id == "recovered"
                }
            assertFalse(loaded.unauthorized)
            assertEquals(Freshness.LIVE, loaded.data.transactions.status)
            assertFalse(recovered.staleAuthorization)
            assertEquals(Long.MAX_VALUE, recovered.data.transactions.value.single().amount)
            assertEquals(listOf("recovered"), dao.observeTransactions(key).first().map { it.transactionId })
        }

    private fun transaction(
        id: String,
        amount: Long,
        category: String = "Home",
        amountSats: Long? = null,
        bitcoinAccountKey: String? = null,
        updatedAtMs: Long = 0L,
    ) = Transaction(
        id = id,
        date = "2026-07-27",
        merchant = "Test",
        amount = amount,
        category = category,
        owner = FamilyMember.VICTOR,
        amountSats = amountSats,
        bitcoinAccountKey = bitcoinAccountKey,
        updatedAtMs = updatedAtMs,
    )
}

private class FakeRows : RowQueryRepository {
    var unauthorized = false
    var offline = false
    var failedReason: String? = null
    var transactions: ConvexResult<RowSnapshot<Transaction>> = ConvexResult.Ok(RowSnapshot(emptyList(), true))
    var todos: ConvexResult<RowSnapshot<TodoItem>> = ConvexResult.Ok(RowSnapshot(emptyList(), true))
    var buys: ConvexResult<RowSnapshot<BtcBuy>> = ConvexResult.Ok(RowSnapshot(emptyList(), true))
    var accounts: ConvexResult<RowSnapshot<BtcAccount>>? = null

    override suspend fun listTransactions(
        viewer: FamilyMember,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<Transaction>> =
        when {
            unauthorized -> ConvexResult.Unauthorized
            failedReason != null -> ConvexResult.Failed(requireNotNull(failedReason))
            offline -> ConvexResult.Failed("transport failure")
            else -> transactions
        }

    override suspend fun listTodos(
        viewer: FamilyMember,
        done: Boolean?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<TodoItem>> =
        when {
            unauthorized -> ConvexResult.Unauthorized
            failedReason != null -> ConvexResult.Failed(requireNotNull(failedReason))
            offline -> ConvexResult.Failed("transport failure")
            else -> todos
        }

    override suspend fun listIncome(
        viewer: FamilyMember,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<IncomeRow>> =
        when {
            unauthorized -> ConvexResult.Unauthorized
            failedReason != null -> ConvexResult.Failed(requireNotNull(failedReason))
            else -> ConvexResult.Disabled
        }

    override suspend fun listBtcBuys(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBuy>> =
        when {
            unauthorized -> ConvexResult.Unauthorized
            failedReason != null -> ConvexResult.Failed(requireNotNull(failedReason))
            offline -> ConvexResult.Failed("transport failure")
            else -> buys
        }

    override suspend fun listBtcBillPays(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBillPayRow>> =
        when {
            unauthorized -> ConvexResult.Unauthorized
            failedReason != null -> ConvexResult.Failed(requireNotNull(failedReason))
            else -> ConvexResult.Disabled
        }

    override suspend fun listBtcAccounts(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcAccount>> =
        if (unauthorized) {
            ConvexResult.Unauthorized
        } else if (failedReason != null) {
            ConvexResult.Failed(requireNotNull(failedReason))
        } else if (offline) {
            ConvexResult.Failed("transport failure")
        } else {
            accounts ?: ConvexResult.Ok(
                RowSnapshot(
                    listOf(BtcAccount("cold", "Cold", Custody.SELF_CUSTODY, 21L, 42L, viewer)),
                    true,
                ),
            )
        }

    override suspend fun getBudgetDocument(
        viewer: FamilyMember,
        scope: BudgetQueryScope,
    ): ConvexResult<BudgetDocumentSnapshot> =
        when {
            unauthorized -> ConvexResult.Unauthorized
            failedReason != null -> ConvexResult.Failed(requireNotNull(failedReason))
            else -> ConvexResult.Disabled
        }

    override suspend fun getBtcSnapshotMetadata(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcSnapshotMetadataRow>> =
        when {
            unauthorized -> ConvexResult.Unauthorized
            failedReason != null -> ConvexResult.Failed(requireNotNull(failedReason))
            else -> ConvexResult.Disabled
        }

    override suspend fun listBtcBalanceDocuments(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcBalanceDocumentRow>> =
        when {
            unauthorized -> ConvexResult.Unauthorized
            failedReason != null -> ConvexResult.Failed(requireNotNull(failedReason))
            else -> ConvexResult.Disabled
        }

    override suspend fun rowCounts(): ConvexResult<RowCounts> =
        when {
            unauthorized -> ConvexResult.Unauthorized
            failedReason != null -> ConvexResult.Failed(requireNotNull(failedReason))
            else -> ConvexResult.Disabled
        }
}
