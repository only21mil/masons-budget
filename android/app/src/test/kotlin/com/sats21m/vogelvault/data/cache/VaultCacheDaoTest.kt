package com.sats21m.vogelvault.data.cache

import android.app.Application
import androidx.room.Room
import com.sats21m.vogelvault.domain.FamilyMember
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
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class VaultCacheDaoTest {
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
    fun `incomplete refresh keeps the active last-known-good generation`() =
        runBlocking {
            val key = CacheQueryKeys.transactions(viewer = "victor", month = "2026-07")
            val first =
                dao.replaceTransactions(
                    queryKey = key,
                    rows = listOf(transaction("old", Long.MIN_VALUE)),
                    fetchedAtMs = 100L,
                    expectedRowCount = 1L,
                )

            val incomplete =
                dao.replaceTransactions(
                    queryKey = key,
                    rows = listOf(transaction("partial", Long.MAX_VALUE)),
                    fetchedAtMs = 200L,
                    expectedRowCount = 2L,
                )

            assertTrue(first.activated)
            assertFalse(incomplete.activated)
            assertEquals("row_count_mismatch", incomplete.completeness)
            assertEquals(listOf("old"), dao.observeTransactions(key).first().map { it.transactionId })
            assertEquals(first.generation, dao.observeActiveSnapshot(key).first()?.generation)
            assertEquals(
                Long.MIN_VALUE,
                dao
                    .observeTransactions(key)
                    .first()
                    .single()
                    .amountCents,
            )
        }

    @Test
    fun `complete refresh atomically activates and retains two good generations`() =
        runBlocking {
            val key = CacheQueryKeys.transactions(viewer = "mason")
            dao.replaceTransactions(key, listOf(transaction("one", 1L)), 100L)
            dao.replaceTransactions(key, listOf(transaction("partial", 2L)), 150L, receivedComplete = false)
            dao.replaceTransactions(key, listOf(transaction("two", 2L)), 200L)
            val newest = dao.replaceTransactions(key, listOf(transaction("three", 3L)), 300L)

            assertEquals(listOf("three"), dao.observeTransactions(key).first().map { it.transactionId })
            assertEquals(newest.generation, dao.observeActiveSnapshot(key).first()?.generation)

            val snapshots = dao.snapshots(key)
            assertEquals(3, snapshots.size, "keep two complete generations and the latest incomplete attempt")
            assertEquals(2, snapshots.count { it.isComplete })
            assertEquals(1, snapshots.count { !it.isComplete })
            assertEquals(1, snapshots.count { it.isActive })
        }

    @Test
    fun `failed row insert rolls back without disturbing the active generation`() =
        runBlocking {
            val key = CacheQueryKeys.transactions(viewer = "victor")
            val good = dao.replaceTransactions(key, listOf(transaction("good", 1L)), 100L)

            val failed =
                runCatching {
                    dao.replaceTransactions(
                        queryKey = key,
                        rows = listOf(transaction("duplicate", 2L), transaction("duplicate", 3L)),
                        fetchedAtMs = 200L,
                    )
                }

            assertTrue(failed.isFailure)
            assertEquals(good.generation, dao.observeActiveSnapshot(key).first()?.generation)
            assertEquals(listOf("good"), dao.observeTransactions(key).first().map { it.transactionId })
            assertEquals(1, dao.snapshots(key).size, "the failed generation must roll back completely")
        }

    @Test
    fun `unauthorized refresh marks active snapshot stale and hides its rows`() =
        runBlocking {
            val key = CacheQueryKeys.transactions(viewer = "victor")
            val good = dao.replaceTransactions(key, listOf(transaction("good", 1L)), 100L)

            assertEquals(1, dao.markUnauthorized(key, rejectedAtMs = 200L))
            assertTrue(dao.observeTransactions(key).first().isEmpty())
            assertEquals(null, dao.observeActiveSnapshot(key).first())

            val snapshot = dao.snapshots(key).single()
            assertEquals(good.generation, snapshot.generation)
            assertTrue(snapshot.isActive)
            assertTrue(snapshot.isComplete)
            assertEquals(SnapshotAuthorization.UNAUTHORIZED, snapshot.authorization)
            assertEquals(SnapshotFreshness.STALE_AUTH, snapshot.freshness)
            assertEquals(200L, snapshot.invalidatedAtMs)
        }

    @Test
    fun `strict owner converter refuses an unknown cached owner`() {
        val error =
            assertFailsWith<IllegalArgumentException> {
                CacheTypeConverters().familyMemberFromKey("vitor")
            }

        assertTrue(error.message.orEmpty().contains("Unknown cached owner"))
    }

    @Test
    fun `btc account composite key keeps same account name for different owners`() =
        runBlocking {
            val key = CacheQueryKeys.btcAccounts(viewer = "victor", scope = "visible")
            dao.replaceBtcAccounts(
                queryKey = key,
                rows =
                    listOf(
                        account(owner = FamilyMember.VICTOR, sats = Long.MAX_VALUE),
                        account(owner = FamilyMember.MASON, sats = 21_000_000L),
                    ),
                fetchedAtMs = 500L,
                expectedRowCount = 2L,
            )

            val cached = dao.observeBtcAccounts(key).first()
            assertEquals(2, cached.size)
            assertEquals(listOf(FamilyMember.MASON, FamilyMember.VICTOR), cached.map { it.owner })
            assertEquals(Long.MAX_VALUE, cached.single { it.owner == FamilyMember.VICTOR }.sats)
        }

    private fun transaction(
        id: String,
        amountCents: Long,
    ) = TransactionCacheRow(
        sourceFile = "transactions",
        transactionId = id,
        owner = FamilyMember.VICTOR,
        date = "2026-07-26",
        month = "2026-07",
        merchant = "Fixture",
        amountCents = amountCents,
        category = "Other",
        updatedAtMs = 1L,
    )

    private fun account(
        owner: FamilyMember,
        sats: Long,
    ) = BtcAccountCacheRow(
        owner = owner,
        accountKey = "strike",
        label = "Strike",
        custody = "exchange",
        sats = sats,
        fiatCents = 0L,
        asOf = "2026-07-26T00:00:00Z",
        schemaVersion = 1L,
        sourceFile = if (owner == FamilyMember.MASON) "son-balances" else "btc-balance-snapshot",
        updatedAtMs = 1L,
    )
}
