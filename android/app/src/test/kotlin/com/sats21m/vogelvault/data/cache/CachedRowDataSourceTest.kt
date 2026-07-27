package com.sats21m.vogelvault.data.cache

import android.app.Application
import androidx.room.Room
import com.sats21m.vogelvault.data.BtcBillPayRow
import com.sats21m.vogelvault.data.BtcSnapshotMetadataRow
import com.sats21m.vogelvault.data.BudgetDocumentSnapshot
import com.sats21m.vogelvault.data.BudgetQueryScope
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.RowCounts
import com.sats21m.vogelvault.data.RowQueryRepository
import com.sats21m.vogelvault.data.RowSnapshot
import com.sats21m.vogelvault.data.RowVisibilityScope
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
            val source = CachedRowDataSource(remote, dao) { 100L }
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
    fun `unauthorized read invalidates current observers and hides the cached snapshot`() =
        runBlocking {
            var now = 100L
            val remote = FakeRows()
            val source = CachedRowDataSource(remote, dao) { now }
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
        }

    @Test
    fun `offline read serves the authorized Room snapshot clearly marked stale`() =
        runBlocking {
            val remote = FakeRows()
            val source = CachedRowDataSource(remote, dao) { 100L }
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
    fun `later authorized read recovers from an unauthorized generation`() =
        runBlocking {
            var now = 100L
            val remote = FakeRows()
            val source = CachedRowDataSource(remote, dao) { now }
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
    ) = Transaction(
        id = id,
        date = "2026-07-27",
        merchant = "Test",
        amount = amount,
        category = "Home",
        owner = FamilyMember.VICTOR,
    )
}

private class FakeRows : RowQueryRepository {
    var unauthorized = false
    var offline = false
    var transactions: ConvexResult<RowSnapshot<Transaction>> = ConvexResult.Ok(RowSnapshot(emptyList(), true))

    override suspend fun listTransactions(
        viewer: FamilyMember,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<Transaction>> =
        when {
            unauthorized -> ConvexResult.Unauthorized
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
            offline -> ConvexResult.Failed("transport failure")
            else -> ConvexResult.Ok(RowSnapshot(emptyList(), true))
        }

    override suspend fun listBtcBuys(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBuy>> =
        when {
            unauthorized -> ConvexResult.Unauthorized
            offline -> ConvexResult.Failed("transport failure")
            else -> ConvexResult.Ok(RowSnapshot(emptyList(), true))
        }

    override suspend fun listBtcBillPays(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBillPayRow>> = ConvexResult.Disabled

    override suspend fun listBtcAccounts(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcAccount>> =
        if (unauthorized) {
            ConvexResult.Unauthorized
        } else if (offline) {
            ConvexResult.Failed("transport failure")
        } else {
            ConvexResult.Ok(
                RowSnapshot(
                    listOf(BtcAccount("cold", "Cold", Custody.SELF_CUSTODY, 21L, 42L, viewer)),
                    true,
                ),
            )
        }

    override suspend fun getBudgetDocument(
        viewer: FamilyMember,
        scope: BudgetQueryScope,
    ): ConvexResult<BudgetDocumentSnapshot> = ConvexResult.Disabled

    override suspend fun getBtcSnapshotMetadata(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcSnapshotMetadataRow>> = ConvexResult.Disabled

    override suspend fun rowCounts(): ConvexResult<RowCounts> = ConvexResult.Disabled
}
