package com.sats21m.vogelvault.ui

import android.os.Looper
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.FinanceDocumentSnapshot
import com.sats21m.vogelvault.data.FinanceReadSource
import com.sats21m.vogelvault.data.LoadedFinanceRead
import com.sats21m.vogelvault.data.MarketQuoteReadSnapshot
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteSnapshot
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlin.coroutines.Continuation
import kotlin.test.assertSame
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.FinanceAccount
import com.sats21m.vogelvault.domain.FinanceDocument
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class VaultViewModelFinanceTest {
    @Test
    fun `quote refresh preserves profile rows finance navigation and stale quote policy`() = runBlocking {
        val source = QuoteFinanceSource()
        val model = VaultViewModel(financeSource = source)
        shadowOf(Looper.getMainLooper()).idle()
        model.navigate(Destination.ACTIVITY)
        val before = model.state.value
        source.quoteResult = quoteResult(222L, MarketQuoteStatus.STALE)

        model.refreshMarketQuotes()

        val after = model.state.value
        assertEquals(1, source.financeReads)
        assertEquals(1, source.quoteReads)
        assertSame(before.data, after.data)
        assertSame(before.financeDocument, after.financeDocument)
        assertEquals(before.destination, after.destination)
        assertEquals(before.financeStatus, after.financeStatus)
        assertEquals((source.quoteResult as ConvexResult.Ok).value.snapshot, after.marketQuotes)
        assertEquals(Freshness.LIVE, after.marketQuoteStatus)
        assertEquals(MarketQuoteStatus.STALE, after.marketQuotes?.quotes?.first()?.status)
    }

    @Test
    fun `quote result from an old profile load cannot overwrite the new profile`() = runBlocking {
        val source = QuoteFinanceSource()
        val model = VaultViewModel(financeSource = source)
        shadowOf(Looper.getMainLooper()).idle()
        source.deferQuotes = true
        val refresh = launch(start = CoroutineStart.UNDISPATCHED) { model.refreshMarketQuotes() }
        model.switchProfile(FamilyMember.RACHEL)
        shadowOf(Looper.getMainLooper()).idle()
        val afterSwitch = model.state.value
        source.pendingQuote!!.resume(quoteResult(999L))
        refresh.join()
        assertEquals(FamilyMember.RACHEL, model.state.value.activeProfile)
        assertSame(afterSwitch.marketQuotes, model.state.value.marketQuotes)
    }

    @Test
    fun `older full finance read cannot replace a newer quote-only result`() = runBlocking {
        val source = QuoteFinanceSource(deferFinance = true)
        val model = VaultViewModel(financeSource = source)
        shadowOf(Looper.getMainLooper()).idle()
        model.refreshMarketQuotes()
        val latest = model.state.value.marketQuotes
        source.pendingFinance!!.resume(loadedFinance("older", FamilyMember.VICTOR).copy(quotes = quoteResult(1L)))
        shadowOf(Looper.getMainLooper()).idle()
        assertSame(latest, model.state.value.marketQuotes)
        assertEquals("older", model.state.value.financeDocument?.accounts?.single()?.key)
    }

    @Test
    fun `quote failures clear quotes while recovery preserves separate finance rejection`() = runBlocking {
        val source = QuoteFinanceSource(financeRejected = true)
        val model = VaultViewModel(financeSource = source)
        shadowOf(Looper.getMainLooper()).idle()
        source.quoteResult = ConvexResult.Unauthorized
        model.refreshMarketQuotes()
        assertEquals(null, model.state.value.marketQuotes)
        assertEquals(Freshness.ERROR, model.state.value.marketQuoteStatus)
        assertTrue(model.state.value.staleAuthorization)

        source.quoteResult = quoteResult(456L)
        model.refreshMarketQuotes()
        assertEquals(Freshness.LIVE, model.state.value.marketQuoteStatus)
        assertTrue(model.state.value.financeUnauthorized)
        assertTrue(model.state.value.staleAuthorization)
        assertEquals(1, model.state.value.financeReadDiagnostics.size)
        assertEquals(1, source.financeReads)
    }

    @Test
    fun `disabled reads do not refresh quotes`() = runBlocking {
        val source = QuoteFinanceSource()
        VaultViewModel(financeSource = source, remoteInitiallyEnabled = false).refreshMarketQuotes()
        assertEquals(0, source.quoteReads)
        assertEquals(0, source.financeReads)
    }

    @Test
    fun `late finance response from previous profile cannot replace current profile`() {
        val source = DelayedVictorFinanceSource()
        val model = VaultViewModel(financeSource = source, remoteInitiallyEnabled = true)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(source.victorStarted.await(5, TimeUnit.SECONDS), "Victor read never started")

        model.switchProfile(FamilyMember.RACHEL)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(source.rachelReturned.await(5, TimeUnit.SECONDS), "Rachel read never returned")
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("rachel-account", model.state.value.financeDocument?.accounts?.single()?.key)

        source.releaseVictor.countDown()
        assertTrue(source.victorReturned.await(5, TimeUnit.SECONDS), "Victor read never returned")
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals(FamilyMember.RACHEL, model.state.value.activeProfile)
        assertEquals("rachel-account", model.state.value.financeDocument?.accounts?.single()?.key)
    }

    @Test
    fun `late finance response cannot overwrite a newer load after profile ABA`() {
        val source = AbaFinanceSource()
        val model = VaultViewModel(financeSource = source, remoteInitiallyEnabled = true)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(source.firstVictorStarted.await(5, TimeUnit.SECONDS), "First Victor read never started")

        model.switchProfile(FamilyMember.RACHEL)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(source.rachelReturned.await(5, TimeUnit.SECONDS), "Rachel read never returned")

        model.switchProfile(FamilyMember.VICTOR)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(source.secondVictorReturned.await(5, TimeUnit.SECONDS), "Second Victor read never returned")
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("victor-new", model.state.value.financeDocument?.accounts?.single()?.key)

        source.releaseFirstVictor.countDown()
        assertTrue(source.firstVictorReturned.await(5, TimeUnit.SECONDS), "First Victor read never returned")
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals(FamilyMember.VICTOR, model.state.value.activeProfile)
        assertEquals("victor-new", model.state.value.financeDocument?.accounts?.single()?.key)
    }
}

private class AbaFinanceSource : FinanceReadSource {
    override suspend fun loadQuotes() = ConvexResult.Missing

    val firstVictorStarted = CountDownLatch(1)
    val releaseFirstVictor = CountDownLatch(1)
    val firstVictorReturned = CountDownLatch(1)
    val rachelReturned = CountDownLatch(1)
    val secondVictorReturned = CountDownLatch(1)
    private val victorReads = AtomicInteger()

    override suspend fun load(viewer: FamilyMember): LoadedFinanceRead {
        if (viewer == FamilyMember.RACHEL) {
            rachelReturned.countDown()
            return loadedFinance("rachel", FamilyMember.RACHEL)
        }
        return if (victorReads.incrementAndGet() == 1) {
            suspendCoroutine { continuation ->
                firstVictorStarted.countDown()
                thread(name = "aba-finance-test", isDaemon = true) {
                    releaseFirstVictor.await()
                    continuation.resume(loadedFinance("victor-old", FamilyMember.VICTOR))
                    firstVictorReturned.countDown()
                }
            }
        } else {
            secondVictorReturned.countDown()
            loadedFinance("victor-new", FamilyMember.VICTOR)
        }
    }
}

private class DelayedVictorFinanceSource : FinanceReadSource {
    override suspend fun loadQuotes() = ConvexResult.Missing

    val victorStarted = CountDownLatch(1)
    val releaseVictor = CountDownLatch(1)
    val victorReturned = CountDownLatch(1)
    val rachelReturned = CountDownLatch(1)

    override suspend fun load(viewer: FamilyMember): LoadedFinanceRead =
        if (viewer == FamilyMember.VICTOR) {
            suspendCoroutine { continuation ->
                victorStarted.countDown()
                thread(name = "late-finance-test", isDaemon = true) {
                    releaseVictor.await()
                    continuation.resume(loaded("victor-account", FamilyMember.VICTOR))
                    victorReturned.countDown()
                }
            }
        } else {
            rachelReturned.countDown()
            loaded("rachel-account", FamilyMember.RACHEL)
        }

    private fun loaded(key: String, owner: FamilyMember) = loadedFinance(key, owner)
}

private fun loadedFinance(key: String, owner: FamilyMember) =
    LoadedFinanceRead(
        finance = ConvexResult.Ok(
            FinanceDocumentSnapshot(
                document = FinanceDocument(
                    updatedAtMs = 1L,
                    lastUpdated = "2026-07-31",
                    retirementTotalCents = null,
                    accounts = listOf(
                        FinanceAccount(
                            key = key,
                            owner = owner,
                            provider = "Test",
                            totalValueCents = 1L,
                            weeklyContributionCents = 0L,
                            weeklyContributionDay = null,
                            holdings = emptyList(),
                        ),
                    ),
                ),
                complete = true,
            ),
        ),
        quotes = ConvexResult.Missing,
        unauthorized = false,
    )

private class QuoteFinanceSource(val deferFinance: Boolean = false, val financeRejected: Boolean = false) : FinanceReadSource {
    var financeReads = 0
    var quoteReads = 0
    var quoteResult: ConvexResult<MarketQuoteReadSnapshot> = quoteResult(123L)
    var deferQuotes = false
    var pendingQuote: Continuation<ConvexResult<MarketQuoteReadSnapshot>>? = null
    var pendingFinance: Continuation<LoadedFinanceRead>? = null

    override suspend fun load(viewer: FamilyMember): LoadedFinanceRead {
        financeReads++
        if (deferFinance) return suspendCoroutine { pendingFinance = it }
        val loaded = loadedFinance(viewer.name, viewer).copy(quotes = quoteResult)
        return if (financeRejected) loaded.copy(finance = ConvexResult.Unauthorized, unauthorized = true) else loaded
    }

    override suspend fun loadQuotes(): ConvexResult<MarketQuoteReadSnapshot> {
        quoteReads++
        if (deferQuotes) return suspendCoroutine { pendingQuote = it }
        return quoteResult
    }
}

private fun quoteResult(price: Long, status: MarketQuoteStatus = MarketQuoteStatus.LIVE) =
    ConvexResult.Ok(MarketQuoteReadSnapshot(
        MarketQuoteSnapshot(MarketSymbol.entries.map { MarketQuote(it, price, "test", "2026-09-07T12:00:00Z", status) }),
        complete = true,
    ))
