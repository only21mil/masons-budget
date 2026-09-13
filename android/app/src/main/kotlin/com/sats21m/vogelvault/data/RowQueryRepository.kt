package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcTransfer
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Public table counts used to verify a complete backfill. */
data class RowCounts(
    val transactions: Long,
    val todos: Long,
    val btcBuys: Long,
    val btcBillPays: Long,
    val btcAccounts: Long,
    val income: Long,
    val balanceDocuments: Long,
    val budgetDocuments: Long,
    val btcBalanceDocuments: Long,
    val financeDocuments: Long,
)

/** Row/document API, deliberately separate from the legacy whole-file repository. */
interface RowQueryRepository {
    suspend fun listTransactions(
        viewer: FamilyMember,
        month: String? = null,
        limit: Int? = null,
    ): ConvexResult<RowSnapshot<Transaction>>

    suspend fun listTodos(
        viewer: FamilyMember,
        done: Boolean? = null,
        limit: Int? = null,
    ): ConvexResult<RowSnapshot<TodoItem>>

    suspend fun listIncome(
        viewer: FamilyMember,
        month: String? = null,
        limit: Int? = null,
    ): ConvexResult<RowSnapshot<IncomeRow>>

    suspend fun listBtcTransfers(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String? = null,
        limit: Int? = null,
    ): ConvexResult<RowSnapshot<BtcTransfer>>

    suspend fun listBtcBuys(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String? = null,
        limit: Int? = null,
    ): ConvexResult<RowSnapshot<BtcBuy>>

    suspend fun listBtcBillPays(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String? = null,
        limit: Int? = null,
    ): ConvexResult<RowSnapshot<BtcBillPayRow>>

    suspend fun listBtcAccounts(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        limit: Int? = null,
    ): ConvexResult<RowSnapshot<BtcAccount>>

    suspend fun getBudgetDocument(
        viewer: FamilyMember,
        scope: BudgetQueryScope,
    ): ConvexResult<BudgetDocumentSnapshot>

    suspend fun getBtcSnapshotMetadata(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcSnapshotMetadataRow>>

    suspend fun listBtcBalanceDocuments(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcBalanceDocumentRow>>

    suspend fun rowCounts(): ConvexResult<RowCounts>
}

object DisabledRowQueryRepository : RowQueryRepository {
    override suspend fun listTransactions(
        viewer: FamilyMember,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<Transaction>> = ConvexResult.Disabled

    override suspend fun listTodos(
        viewer: FamilyMember,
        done: Boolean?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<TodoItem>> = ConvexResult.Disabled

    override suspend fun listIncome(
        viewer: FamilyMember,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<IncomeRow>> = ConvexResult.Disabled

    override suspend fun listBtcTransfers(
        viewer: FamilyMember, scope: RowVisibilityScope, month: String?, limit: Int?,
    ): ConvexResult<RowSnapshot<BtcTransfer>> = ConvexResult.Disabled

    override suspend fun listBtcBuys(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBuy>> = ConvexResult.Disabled

    override suspend fun listBtcBillPays(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBillPayRow>> = ConvexResult.Disabled

    override suspend fun listBtcAccounts(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcAccount>> = ConvexResult.Disabled

    override suspend fun getBudgetDocument(
        viewer: FamilyMember,
        scope: BudgetQueryScope,
    ): ConvexResult<BudgetDocumentSnapshot> = ConvexResult.Disabled

    override suspend fun getBtcSnapshotMetadata(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcSnapshotMetadataRow>> = ConvexResult.Disabled

    override suspend fun listBtcBalanceDocuments(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcBalanceDocumentRow>> = ConvexResult.Disabled

    override suspend fun rowCounts(): ConvexResult<RowCounts> = ConvexResult.Disabled
}

internal class ConvexRowQueryRepository(
    private val client: ConvexQueryClient,
) : RowQueryRepository {
    override suspend fun listTransactions(
        viewer: FamilyMember,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<Transaction>> =
        client.query(ConvexQuery.ListTransactions(viewer, month, limit)).decodeRows(
            decode = PublicTransactionDto::decode,
            map = PublicTransactionDto::toDomain,
        )

    override suspend fun listTodos(
        viewer: FamilyMember,
        done: Boolean?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<TodoItem>> =
        client.query(ConvexQuery.ListTodos(viewer, done, limit)).decodeRows(
            decode = PublicTodoDto::decode,
            map = PublicTodoDto::toDomain,
        )

    override suspend fun listIncome(
        viewer: FamilyMember,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<IncomeRow>> =
        client.query(ConvexQuery.ListIncome(viewer, month, limit)).decodeRows(
            decode = PublicIncomeDto::decode,
            map = PublicIncomeDto::toRow,
        )

    override suspend fun listBtcTransfers(
        viewer: FamilyMember, scope: RowVisibilityScope, month: String?, limit: Int?,
    ): ConvexResult<RowSnapshot<BtcTransfer>> =
        client.query(ConvexQuery.ListBtcTransfers(viewer, scope, month, limit)).decodeRows(
            decode = PublicBtcTransferDto::decode,
            map = { it },
        )

    override suspend fun listBtcBuys(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBuy>> =
        client.query(ConvexQuery.ListBtcBuys(viewer, scope, month, limit)).decodeRows(
            decode = PublicBtcBuyDto::decode,
            map = PublicBtcBuyDto::toDomain,
        )

    override suspend fun listBtcBillPays(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBillPayRow>> =
        client.query(ConvexQuery.ListBtcBillPays(viewer, scope, month, limit)).decodeRows(
            decode = PublicBtcBillPayDto::decode,
            map = PublicBtcBillPayDto::toRow,
        )

    override suspend fun listBtcAccounts(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcAccount>> =
        client.query(ConvexQuery.ListBtcAccounts(viewer, scope, limit)).decodeRows(
            decode = PublicBtcAccountDto::decode,
            map = PublicBtcAccountDto::toDomain,
        )

    override suspend fun getBudgetDocument(
        viewer: FamilyMember,
        scope: BudgetQueryScope,
    ): ConvexResult<BudgetDocumentSnapshot> =
        client.query(ConvexQuery.GetBudgetDocument(viewer, scope)).decode { value ->
            PublicBudgetDocumentDto.decode(value.parsed)
        }

    override suspend fun getBtcSnapshotMetadata(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcSnapshotMetadataRow>> =
        client.query(ConvexQuery.GetBtcSnapshotMetadata(viewer, scope)).decode { value ->
            val envelope = PublicBtcSnapshotMetadataDto.decode(value.parsed) ?: return@decode null
            RowSnapshot(envelope.rows, envelope.complete)
        }

    override suspend fun listBtcBalanceDocuments(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcBalanceDocumentRow>> =
        client.query(ConvexQuery.ListBtcBalanceDocuments(viewer, scope)).decodeRows(
            decode = PublicBtcBalanceDocumentDto::decode,
            map = { it },
        )

    override suspend fun rowCounts(): ConvexResult<RowCounts> =
        client.query(ConvexQuery.RowCounts).decode { value ->
            val counts = value.parsed as? JsonObject ?: return@decode null
            RowCounts(
                transactions = counts.requiredLong("transactions") ?: return@decode null,
                todos = counts.requiredLong("todos") ?: return@decode null,
                btcBuys = counts.requiredLong("btcBuys") ?: return@decode null,
                btcBillPays = counts.requiredLong("btcBillPays") ?: return@decode null,
                btcAccounts = counts.requiredLong("btcAccounts") ?: return@decode null,
                income = counts.requiredLong("income") ?: return@decode null,
                balanceDocuments = counts.requiredLong("balanceDocuments") ?: return@decode null,
                budgetDocuments = counts.requiredLong("budgetDocuments") ?: return@decode null,
                btcBalanceDocuments =
                    counts.requiredLong("btcBalanceDocuments") ?: return@decode null,
                financeDocuments =
                    counts.requiredLong("financeDocuments") ?: return@decode null,
            )
        }
}

object RowQueryRepositories {
    fun disabled(): RowQueryRepository = DisabledRowQueryRepository

    fun convex(
        configSource: ConvexConfigSource,
        http: HttpPoster = UrlConnectionHttpPoster(),
    ): RowQueryRepository = ConvexRowQueryRepository(ConvexQueryClient(configSource, http))
}

private fun <Dto, Result> ConvexResult<ConvexValue>.decodeRows(
    decode: (JsonElement) -> Dto?,
    map: (Dto) -> Result,
): ConvexResult<RowSnapshot<Result>> = decode { value ->
    val envelope = value.parsed.decodeRowEnvelope(decode) ?: return@decode null
    RowSnapshot(envelope.rows.map(map), envelope.complete)
}
