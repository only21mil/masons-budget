package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

class RecoveringFinanceReadSourceTest {
    @Test
    fun `unauthorized finance attempt recovers stored credential and retries both reads`() = runBlocking {
        val rejected = configured("rejected-token")
        val fallback = configured("fallback-token")
        val config = MutableConvexConfigSource(rejected)
        val repository = SequencedFinanceRepository(recoverOnSecondAttempt = true)
        var rejections = 0
        val source = RecoveringFinanceReadSource(repository, config) { requestConfig ->
            assertSame(rejected, requestConfig)
            rejections += 1
            config.update(fallback)
            true
        }

        val loaded = source.load(FamilyMember.VICTOR)

        assertEquals(1, rejections)
        assertEquals(2, repository.financeReads)
        assertEquals(2, repository.quoteReads)
        assertFalse(loaded.unauthorized)
        assertSame(ConvexResult.Missing, loaded.finance)
        assertSame(ConvexResult.Missing, loaded.quotes)
    }

    @Test
    fun `unrecoverable unauthorized remains distinct and invokes callback once per attempt`() = runBlocking {
        val repository = SequencedFinanceRepository(recoverOnSecondAttempt = false)
        var rejections = 0
        val source = RecoveringFinanceReadSource(
            remote = repository,
            configSource = MutableConvexConfigSource(configured("rejected-token")),
            onUnauthorized = {
                rejections += 1
                false
            },
        )

        val loaded = source.load(FamilyMember.VICTOR)

        assertEquals(1, rejections)
        assertEquals(1, repository.financeReads)
        assertEquals(1, repository.quoteReads)
        assertTrue(loaded.unauthorized)
        assertSame(ConvexResult.Unauthorized, loaded.finance)
        assertSame(ConvexResult.Unauthorized, loaded.quotes)
    }

    private fun configured(token: String) =
        ConvexConfig("https://finance-test.example", token, remoteReadEnabled = true)
}

private class SequencedFinanceRepository(
    private val recoverOnSecondAttempt: Boolean,
) : FinanceQueryRepository {
    var financeReads = 0
    var quoteReads = 0

    override suspend fun getFinanceDocument(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<FinanceDocumentSnapshot> {
        financeReads += 1
        return if (recoverOnSecondAttempt && financeReads > 1) {
            ConvexResult.Missing
        } else {
            ConvexResult.Unauthorized
        }
    }

    override suspend fun getMarketQuoteSnapshot(): ConvexResult<MarketQuoteReadSnapshot> {
        quoteReads += 1
        return if (recoverOnSecondAttempt && quoteReads > 1) {
            ConvexResult.Missing
        } else {
            ConvexResult.Unauthorized
        }
    }
}
