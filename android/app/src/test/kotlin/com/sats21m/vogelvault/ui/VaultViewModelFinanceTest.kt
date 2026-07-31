package com.sats21m.vogelvault.ui

import android.os.Looper
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.FinanceDocumentSnapshot
import com.sats21m.vogelvault.data.FinanceReadSource
import com.sats21m.vogelvault.data.LoadedFinanceRead
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.FinanceAccount
import com.sats21m.vogelvault.domain.FinanceDocument
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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
}

private class DelayedVictorFinanceSource : FinanceReadSource {
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

    private fun loaded(key: String, owner: FamilyMember) = LoadedFinanceRead(
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
}
