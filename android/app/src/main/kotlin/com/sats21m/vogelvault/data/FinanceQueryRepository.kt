package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember

interface FinanceQueryRepository {
    suspend fun getFinanceDocument(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<FinanceDocumentSnapshot>

    suspend fun getMarketQuoteSnapshot(): ConvexResult<MarketQuoteReadSnapshot>
}

data class LoadedFinanceRead(
    val finance: ConvexResult<FinanceDocumentSnapshot>,
    val quotes: ConvexResult<MarketQuoteReadSnapshot>,
    val unauthorized: Boolean,
)

interface FinanceReadSource {
    suspend fun load(viewer: FamilyMember): LoadedFinanceRead
}

/**
 * Direct finance reads with the same credential rejection contract as the row cache.
 *
 * Finance is intentionally not written into Room: there is no compatible schema yet.
 * A request snapshots its credential, reports at most one rejection for that attempt,
 * and retries both reads when the application installs an eligible fallback.
 */
class RecoveringFinanceReadSource(
    private val remote: FinanceQueryRepository,
    private val configSource: ConvexConfigSource? = null,
    private val onUnauthorized: (ConvexConfig) -> Boolean = { false },
) : FinanceReadSource {
    override suspend fun load(viewer: FamilyMember): LoadedFinanceRead {
        val first = loadOnce(viewer)
        return if (first.retryWithFallback) loadOnce(viewer).loaded else first.loaded
    }

    private suspend fun loadOnce(viewer: FamilyMember): FinanceLoadAttempt {
        val requestConfig = configSource?.current()
        val finance = remote.getFinanceDocument(viewer, RowVisibilityScope.NET_WORTH)
        val quotes = remote.getMarketQuoteSnapshot()
        val unauthorized = finance === ConvexResult.Unauthorized || quotes === ConvexResult.Unauthorized
        val retry = unauthorized && requestConfig != null && onUnauthorized(requestConfig)
        return FinanceLoadAttempt(
            loaded = LoadedFinanceRead(finance, quotes, unauthorized),
            retryWithFallback = retry,
        )
    }
}

private data class FinanceLoadAttempt(
    val loaded: LoadedFinanceRead,
    val retryWithFallback: Boolean,
)

object DisabledFinanceQueryRepository : FinanceQueryRepository {
    override suspend fun getFinanceDocument(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<FinanceDocumentSnapshot> = ConvexResult.Disabled

    override suspend fun getMarketQuoteSnapshot(): ConvexResult<MarketQuoteReadSnapshot> =
        ConvexResult.Disabled
}

internal class ConvexFinanceQueryRepository(
    private val client: ConvexQueryClient,
) : FinanceQueryRepository {
    override suspend fun getFinanceDocument(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<FinanceDocumentSnapshot> =
        client.query(ConvexQuery.GetFinanceDocument(viewer, scope)).decode { value ->
            FinanceReadDecoder.financeDocument(value.parsed)
        }

    override suspend fun getMarketQuoteSnapshot(): ConvexResult<MarketQuoteReadSnapshot> =
        client.query(ConvexQuery.GetMarketQuoteSnapshot).decode { value ->
            FinanceReadDecoder.marketQuotes(value.parsed)
        }
}

object FinanceQueryRepositories {
    fun disabled(): FinanceQueryRepository = DisabledFinanceQueryRepository

    fun convex(
        configSource: ConvexConfigSource,
        http: HttpPoster = UrlConnectionHttpPoster(),
    ): FinanceQueryRepository =
        ConvexFinanceQueryRepository(ConvexQueryClient(configSource, http))
}
