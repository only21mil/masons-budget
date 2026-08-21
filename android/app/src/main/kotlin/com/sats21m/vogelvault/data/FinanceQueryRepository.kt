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
    private val remoteForConfig: (ConvexConfig) -> FinanceQueryRepository,
    private val configSource: ConvexConfigSource,
    private val onUnauthorized: (ConvexConfig) -> Boolean = { false },
) : FinanceReadSource {
    constructor(
        remote: FinanceQueryRepository,
        configSource: ConvexConfigSource? = null,
        onUnauthorized: (ConvexConfig) -> Boolean = { false },
    ) : this(
        remoteForConfig = { remote },
        configSource = configSource ?: DisabledConvexConfigSource,
        onUnauthorized = onUnauthorized,
    )

    override suspend fun load(viewer: FamilyMember): LoadedFinanceRead {
        val first = loadOnce(viewer)
        return if (first.retryWithFallback) loadOnce(viewer).loaded else first.loaded
    }

    private suspend fun loadOnce(viewer: FamilyMember): FinanceLoadAttempt {
        val requestConfig = configSource.current()
        val remote = remoteForConfig(requestConfig)
        val finance = remote.getFinanceDocument(viewer, RowVisibilityScope.NET_WORTH)
        val quotes = remote.getMarketQuoteSnapshot()
        val unauthorized = finance === ConvexResult.Unauthorized || quotes === ConvexResult.Unauthorized
        val recoveredHere = unauthorized && onUnauthorized(requestConfig)
        val currentConfig = configSource.current()
        val recoveredConcurrently =
            unauthorized &&
                currentConfig.allowsRemoteRead &&
                !currentConfig.hasSameReadConfigurationAs(requestConfig)
        return FinanceLoadAttempt(
            loaded = LoadedFinanceRead(finance, quotes, unauthorized),
            retryWithFallback = recoveredHere || recoveredConcurrently,
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

    /** One immutable request configuration shared by every query in an attempt. */
    fun convex(
        config: ConvexConfig,
        http: HttpPoster = UrlConnectionHttpPoster(),
    ): FinanceQueryRepository =
        convex(
            configSource = object : ConvexConfigSource {
                override fun current(): ConvexConfig = config
            },
            http = http,
        )
}
