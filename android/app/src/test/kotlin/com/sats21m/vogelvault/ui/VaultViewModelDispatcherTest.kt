package com.sats21m.vogelvault.ui

import android.app.Application
import android.os.Looper
import androidx.room.Room
import com.sats21m.vogelvault.data.RowSnapshot
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.RowQueryRepository
import com.sats21m.vogelvault.data.cache.CachedRowDataSource
import com.sats21m.vogelvault.data.cache.VaultDatabase
import java.lang.reflect.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotSame
import kotlin.test.assertTrue
import com.sats21m.vogelvault.domain.Freshness
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class VaultViewModelDispatcherTest {
    @Test
    fun `remote decode load runs on the Default dispatcher`() {
        val mainThread = Thread.currentThread()
        val loadThread = AtomicReference<Thread>()
        val loadStarted = CountDownLatch(1)
        val remote =
            proxy<RowQueryRepository> { methodName ->
                if (methodName == "listTransactions") {
                    loadThread.set(Thread.currentThread())
                    loadStarted.countDown()
                }
                ConvexResult.Failed("dispatcher probe")
            }
        val context: Application = RuntimeEnvironment.getApplication()
        val database =
            Room
                .inMemoryDatabaseBuilder(context, VaultDatabase::class.java)
                .allowMainThreadQueries()
                .build()
        try {
            VaultViewModel(rowSource = CachedRowDataSource(remote, database.cacheDao()))

            assertTrue(loadStarted.await(5, TimeUnit.SECONDS), "source.load never started")
            val actual = requireNotNull(loadThread.get())
            assertNotSame(mainThread, actual, "source.load inherited the Main dispatcher")
            assertTrue(
                actual.name.startsWith("DefaultDispatcher-worker-"),
                "source.load ran on ${actual.name}, not Dispatchers.Default",
            )
        } finally {
            database.close()
        }
    }

    @Test
    fun `refresh reloads rows without resetting destination or selected month`() {
        // connectRows launches source.observe (which emits from Room) and
        // source.load (which runs on Dispatchers.Default) concurrently. Both
        // update _state asynchronously via MutableStateFlow.update, which is
        // thread-safe. The initial state is loadingModel(VICTOR) with all
        // slices at Freshness.LOADING. The observe emission and load completion
        // replace that with settled data (Freshness.ERROR from the failed
        // proxy, or Freshness.EMPTY from the empty Room cache).
        //
        // The race: the latch fires when listTransactions starts, but
        // source.load is still running. If we capture beforeRefresh before
        // the initial load's state update lands, the update arrives later
        // and changes model.state.value.data, failing the exact-equality
        // assertion.
        //
        // Fix: poll the StateFlow until the initial load settles (transactions
        // status leaves LOADING), then capture beforeRefresh against a
        // landed state. MutableStateFlow.value is readable from any thread,
        // so the poll sees background-thread updates without idle().
        val loadSignal = AtomicReference(CountDownLatch(1))
        val remote =
            proxy<RowQueryRepository> { methodName ->
                if (methodName == "listTransactions") loadSignal.get().countDown()
                ConvexResult.Failed("refresh state probe")
            }
        val context: Application = RuntimeEnvironment.getApplication()
        val database =
            Room
                .inMemoryDatabaseBuilder(context, VaultDatabase::class.java)
                .allowMainThreadQueries()
                .build()
        try {
            val model = VaultViewModel(rowSource = CachedRowDataSource(remote, database.cacheDao()))
            assertTrue(loadSignal.get().await(5, TimeUnit.SECONDS), "initial row load never started")

            // Poll until every row slice settles, not just transactions.
            // source.load calls multiple repository methods sequentially; the
            // latch fires on the first (listTransactions), but the remaining
            // slices (budget, btcAccounts, btcBuys, todos) may still be
            // LOADING. If any of them settles between the beforeRefresh
            // capture and the exact-equality assertion, the comparison fails.
            // The StateFlow is updated from Dispatchers.Default and Room's
            // executor; idle() cannot flush those because they are not
            // main-thread tasks. But MutableStateFlow.value reflects the
            // latest atomic write from any thread, so a read loop sees the
            // update as soon as it lands.
            val settleDeadline = System.nanoTime() + 5_000_000_000L
            while (model.state.value.data.run {
                listOf(transactions, budget, btcAccounts, btcBuys, todos)
            }.any { it.status == Freshness.LOADING }) {
                assertTrue(System.nanoTime() < settleDeadline, "initial load never settled")
                shadowOf(Looper.getMainLooper()).idle()
                Thread.sleep(10)
            }

            model.navigate(Destination.BUDGET)
            model.seedSelectedMonth("2026-06")
            val beforeRefresh = model.state.value
            val refreshLoad = CountDownLatch(1)
            loadSignal.set(refreshLoad)

            model.refreshActiveProfile()

            assertEquals(Destination.BUDGET, model.state.value.destination)
            assertEquals("2026-06", model.state.value.selectedMonth)
            assertEquals(
                beforeRefresh.data,
                model.state.value.data,
                "refresh replaced trustworthy rows with a loading projection",
            )
            assertTrue(refreshLoad.await(5, TimeUnit.SECONDS), "refresh never started a new row load")
            assertEquals(Destination.BUDGET, model.state.value.destination)
            assertEquals("2026-06", model.state.value.selectedMonth)
        } finally {
            database.close()
        }
    }

    @Test
    fun `Room emission during a blocked refresh preserves the live rows and freshness`() {
        val refreshStarted = CountDownLatch(1)
        val finishRefresh = CountDownLatch(1)
        val calls = java.util.concurrent.atomic.AtomicInteger()
        val transactions = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE).transactions.value
        val remote = proxy<RowQueryRepository> { name ->
            if (name == "listTransactions") {
                if (calls.incrementAndGet() > 1) {
                    refreshStarted.countDown()
                    assertTrue(finishRefresh.await(5, TimeUnit.SECONDS))
                }
                ConvexResult.Ok(RowSnapshot(transactions, true))
            } else ConvexResult.Failed("other slices unavailable")
        }
        val context: Application = RuntimeEnvironment.getApplication()
        val database = Room.inMemoryDatabaseBuilder(context, VaultDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val model = VaultViewModel(rowSource = CachedRowDataSource(remote, database.cacheDao()))
            val deadline = System.nanoTime() + 5_000_000_000L
            while (model.state.value.data.transactions.status != Freshness.LIVE) {
                assertTrue(System.nanoTime() < deadline, "initial live load did not settle")
                shadowOf(Looper.getMainLooper()).idle()
                Thread.sleep(10)
            }
            val before = model.state.value.data
            val cachedField = VaultViewModel::class.java.getDeclaredField("cachedModel").apply { isAccessible = true }
            val cachedBefore = cachedField.get(model)
            model.refreshActiveProfile()
            assertTrue(refreshStarted.await(5, TimeUnit.SECONDS))
            // Wait for the new Room collector, not just synchronous refresh setup.
            val emissionDeadline = System.nanoTime() + 5_000_000_000L
            while (cachedField.get(model) === cachedBefore) {
                assertTrue(System.nanoTime() < emissionDeadline, "Room did not emit after refresh")
                shadowOf(Looper.getMainLooper()).idle()
                Thread.sleep(10)
            }
            assertEquals(before, model.state.value.data)
            assertEquals(Freshness.LIVE, model.state.value.data.transactions.status)
        } finally {
            finishRefresh.countDown()
            shadowOf(Looper.getMainLooper()).idle()
            database.close()
        }
    }

    @Test
    fun `effective rejection blocks later remote refreshes`() {
        val loadStarted = CountDownLatch(1)
        val transactionReads = java.util.concurrent.atomic.AtomicInteger()
        val remote =
            proxy<RowQueryRepository> { methodName ->
                if (methodName == "listTransactions") {
                    transactionReads.incrementAndGet()
                    loadStarted.countDown()
                }
                ConvexResult.Failed("readiness probe")
            }
        val context: Application = RuntimeEnvironment.getApplication()
        val database =
            Room
                .inMemoryDatabaseBuilder(context, VaultDatabase::class.java)
                .allowMainThreadQueries()
                .build()
        try {
            val effectiveReadReady = MutableStateFlow(true)
            val model =
                VaultViewModel(
                    rowSource = CachedRowDataSource(remote, database.cacheDao()),
                    effectiveReadReady = effectiveReadReady,
                )
            assertTrue(loadStarted.await(5, TimeUnit.SECONDS), "initial row load never started")

            effectiveReadReady.value = false
            shadowOf(Looper.getMainLooper()).idle()
            val readsAfterRejection = transactionReads.get()

            model.refreshActiveProfile()
            shadowOf(Looper.getMainLooper()).idle()

            assertEquals(readsAfterRejection, transactionReads.get())
        } finally {
            database.close()
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun VaultViewModel.seedSelectedMonth(month: String) {
        val field = VaultViewModel::class.java.getDeclaredField("_state")
        field.isAccessible = true
        val mutableState = field.get(this) as MutableStateFlow<VaultUiState>
        mutableState.value = mutableState.value.copy(selectedMonth = month)
    }

    private inline fun <reified T> proxy(
        crossinline answer: (methodName: String) -> Any?,
    ): T =
        Proxy.newProxyInstance(
            T::class.java.classLoader,
            arrayOf(T::class.java),
        ) { proxy, method, arguments ->
            when (method.name) {
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                "toString" -> "${T::class.simpleName} dispatcher probe"
                else -> answer(method.name)
            }
        } as T
}
