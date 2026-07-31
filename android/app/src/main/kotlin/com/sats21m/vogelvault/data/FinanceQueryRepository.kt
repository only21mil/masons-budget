package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember

interface FinanceQueryRepository {
    suspend fun getFinanceDocument(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<FinanceDocumentSnapshot>

    suspend fun getMarketQuoteSnapshot(): ConvexResult<MarketQuoteReadSnapshot>
}

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
