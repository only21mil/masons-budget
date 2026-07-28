package com.sats21m.vogelvault.ui

import android.app.Application
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
import kotlin.test.assertNotSame
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
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
