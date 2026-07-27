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
    fun `authorized snapshot becomes current unauthorized hides it and authorized recovery replaces it`() =
        runBlocking {
            var now = 100L
            val remote = FakeRows()
            val source = CachedRowDataSource(remote, dao) { now }
            val viewer = FamilyMember.VICTOR
            val key = CacheQueryKeys.transactions(viewer.key)

            remote.transactions =
                ConvexResult.Ok(
                    RowSnapshot(
                        rows = listOf(transaction("authorized", Long.MIN_VALUE)),
                        complete = true,
                    ),
                )
            source.refresh(viewer)

            val current =
                source.observe(viewer).first {
                    it.data.transactions.status == Freshness.LIVE
                }
            assertFalse(current.staleAuthorization)
            assertEquals(listOf("authorized"), current.data.transactions.value.map { it.id })
            assertEquals(Long.MIN_VALUE, current.data.transactions.value.single().amount)
            assertEquals(listOf("authorized"), dao.observeTransactions(key).first().map { it.transactionId })

            now = 200L
            remote.unauthorized = true
            source.refresh(viewer)

            val rejected =
                source.observe(viewer).first {
                    it.staleAuthorization
                }
            assertEquals(Freshness.STALE, rejected.data.transactions.status)
            assertTrue(rejected.data.transactions.value.isEmpty())
            assertTrue(dao.observeTransactions(key).first().isEmpty())
            assertEquals(null, dao.observeActiveSnapshot(key).first())
            assertEquals(
                SnapshotAuthorization.UNAUTHORIZED,
                dao.snapshots(key).single().authorization,
            )

            now = 300L
            remote.unauthorized = false
            remote.transactions =
                ConvexResult.Ok(
                    RowSnapshot(
                        rows = listOf(transaction("recovered", Long.MAX_VALUE)),
                        complete = true,
                    ),
                )
            source.refresh(viewer)

            val recovered =
                source.observe(viewer).first {
                    it.data.transactions.status == Freshness.LIVE &&
                        it.data.transactions.value.singleOrNull()?.id == "recovered"
                }
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
    var transactions: ConvexResult<RowSnapshot<Transaction>> = ConvexResult.Ok(RowSnapshot(emptyList(), true))

    override suspend fun listTransactions(
        viewer: FamilyMember,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<Transaction>> = if (unauthorized) ConvexResult.Unauthorized else transactions

    override suspend fun listTodos(
        viewer: FamilyMember,
        done: Boolean?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<TodoItem>> =
        if (unauthorized) ConvexResult.Unauthorized else ConvexResult.Ok(RowSnapshot(emptyList(), true))

    override suspend fun listBtcBuys(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBuy>> =
        if (unauthorized) ConvexResult.Unauthorized else ConvexResult.Ok(RowSnapshot(emptyList(), true))

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
