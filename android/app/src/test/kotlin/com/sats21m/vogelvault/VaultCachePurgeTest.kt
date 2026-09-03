package com.sats21m.vogelvault

import com.sats21m.vogelvault.data.cache.BtcBuyCacheRow
import com.sats21m.vogelvault.data.cache.TodoCacheRow
import com.sats21m.vogelvault.data.cache.TransactionCacheRow
import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

internal class PurgeRecordingApplication : VaultApplication() {
    var purgeLaunches = 0

    override fun launchLedgerCachePurge() {
        purgeLaunches++
    }
}

/**
 * The reset contract removes the household's data, not only the credentials
 * that could read it. These tests pin the two purge obligations: the plaintext
 * Room cache really empties, and the reset path actually triggers the purge.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = PurgeRecordingApplication::class)
class VaultCachePurgeTest {
    private val application: PurgeRecordingApplication
        get() = RuntimeEnvironment.getApplication() as PurgeRecordingApplication

    @Test
    fun `purge empties every cached ledger table`() = runBlocking {
        val app = application
        val dao = app.database.cacheDao()
        dao.replaceTransactions(
            queryKey = "transactions:victor",
            rows =
                listOf(
                    TransactionCacheRow(
                        sourceFile = "transactions",
                        transactionId = "tx-1",
                        owner = FamilyMember.VICTOR,
                        date = "2026-08-01",
                        month = "2026-08",
                        merchant = "Neighborhood Market",
                        amountCents = 1_418L,
                        category = "Groceries",
                        updatedAtMs = 1_800_000_000_000L,
                    ),
                ),
            fetchedAtMs = 10L,
            expectedRowCount = 1L,
            receivedComplete = true,
        )
        dao.replaceTodos(
            queryKey = "todos:victor",
            rows =
                listOf(
                    TodoCacheRow(
                        todoId = "todo-1",
                        owner = FamilyMember.VICTOR,
                        title = "Reconcile receipts",
                        done = false,
                        flagged = false,
                        updatedAtMs = 1_800_000_000_000L,
                        sourceFile = "todos",
                    ),
                ),
            fetchedAtMs = 10L,
            expectedRowCount = 1L,
            receivedComplete = true,
        )
        dao.replaceBtcBuys(
            queryKey = "btc-buys:victor",
            rows =
                listOf(
                    BtcBuyCacheRow(
                        sourceFile = "bitcoin-buys",
                        buyId = "buy-1",
                        owner = FamilyMember.VICTOR,
                        date = "2026-08-01",
                        month = "2026-08",
                        source = "Strike",
                        sats = 21_000L,
                        priceUsdCents = 11_700_000L,
                        usdCents = 2_457L,
                        updatedAtMs = 1_800_000_000_000L,
                    ),
                ),
            fetchedAtMs = 10L,
            expectedRowCount = 1L,
            receivedComplete = true,
        )

        app.purgeLedgerCache()

        assertTrue(dao.observeTransactions("transactions:victor").first().isEmpty())
        assertTrue(dao.observeTodos("todos:victor").first().isEmpty())
        assertTrue(dao.observeBtcBuys("btc-buys:victor").first().isEmpty())
        assertTrue(dao.snapshots("transactions:victor").isEmpty())
    }

    @Test
    fun `credential reset triggers the ledger cache purge`() {
        val app = application

        assertTrue(app.removeStoredConvexCredential())
        assertEquals(1, app.purgeLaunches)

        // Repeating reset on empty storage still succeeds and still purges:
        // leftover cache from a crashed prior session must not survive either.
        assertTrue(app.removeStoredConvexCredential())
        assertEquals(2, app.purgeLaunches)
    }
}
