package com.sats21m.vogelvault.ui

import android.app.Application
import android.os.Looper
import androidx.room.Room
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
