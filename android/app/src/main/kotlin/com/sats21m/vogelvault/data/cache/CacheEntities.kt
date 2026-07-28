package com.sats21m.vogelvault.data.cache

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.TypeConverter
import com.sats21m.vogelvault.domain.FamilyMember

enum class SnapshotAuthorization(val key: String) {
    AUTHORIZED("authorized"),
    UNAUTHORIZED("unauthorized"),
}

enum class SnapshotFreshness(val key: String) {
    CURRENT("current"),
    STALE_AUTH("stale_auth"),
}

class CacheTypeConverters {
    @TypeConverter
    fun familyMemberToKey(owner: FamilyMember): String = owner.key

    @TypeConverter
    fun familyMemberFromKey(key: String): FamilyMember =
        requireNotNull(FamilyMember.fromKeyOrNull(key)) {
            "Unknown cached owner: $key"
        }

    @TypeConverter
    fun snapshotAuthorizationToKey(value: SnapshotAuthorization): String = value.key

    @TypeConverter
    fun snapshotAuthorizationFromKey(key: String): SnapshotAuthorization =
        requireNotNull(SnapshotAuthorization.entries.firstOrNull { it.key == key }) {
            "Unknown snapshot authorization: $key"
        }

    @TypeConverter
    fun snapshotFreshnessToKey(value: SnapshotFreshness): String = value.key

    @TypeConverter
    fun snapshotFreshnessFromKey(key: String): SnapshotFreshness =
        requireNotNull(SnapshotFreshness.entries.firstOrNull { it.key == key }) {
            "Unknown snapshot freshness: $key"
        }
}

/**
 * One fetch of one logical Convex query.
 *
 * A query may have several generations on disk. Readers join only the complete,
 * active generation; a failed or partial refresh therefore cannot replace the
 * last-known-good result. Generation is a [Long] allocated inside the same Room
 * transaction that stores and (when complete) activates the rows.
 */
@Entity(
    tableName = "query_snapshots",
    primaryKeys = ["query_key", "generation"],
    indices = [
        Index(value = ["query_key", "is_active"]),
        Index(value = ["query_key", "is_complete", "activated_at_ms"]),
    ],
)
data class QuerySnapshotEntity(
    @ColumnInfo(name = "query_key") val queryKey: String,
    val generation: Long,
    val kind: String,
    @ColumnInfo(name = "started_at_ms") val startedAtMs: Long,
    @ColumnInfo(name = "finished_at_ms") val finishedAtMs: Long?,
    @ColumnInfo(name = "expected_row_count") val expectedRowCount: Long?,
    @ColumnInfo(name = "row_count") val rowCount: Long,
    @ColumnInfo(name = "is_complete") val isComplete: Boolean,
    /** complete | upstream_incomplete | row_count_mismatch | writing */
    @ColumnInfo(name = "completeness") val completeness: String,
    @ColumnInfo(name = "is_active") val isActive: Boolean,
    @ColumnInfo(name = "activated_at_ms") val activatedAtMs: Long?,
    val authorization: SnapshotAuthorization,
    val freshness: SnapshotFreshness,
    @ColumnInfo(name = "invalidated_at_ms") val invalidatedAtMs: Long?,
)

@Entity(
    tableName = "cached_transactions",
    primaryKeys = ["query_key", "generation", "source_file", "transaction_id"],
    foreignKeys = [
        ForeignKey(
            entity = QuerySnapshotEntity::class,
            parentColumns = ["query_key", "generation"],
            childColumns = ["query_key", "generation"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["query_key", "generation"])],
)
data class CachedTransactionEntity(
    @ColumnInfo(name = "query_key") val queryKey: String,
    val generation: Long,
    @ColumnInfo(name = "source_file") val sourceFile: String,
    @ColumnInfo(name = "transaction_id") val transactionId: String,
    val owner: FamilyMember,
    val date: String,
    val month: String,
    val merchant: String,
    /** Raw signed amount only. Spend projections are derived by the current domain model after reads. */
    @ColumnInfo(name = "amount_cents") val amountCents: Long,
    val category: String,
    val card: String?,
    val note: String?,
    @ColumnInfo(name = "updated_at_ms") val updatedAtMs: Long,
)

@Entity(
    tableName = "cached_todos",
    primaryKeys = ["query_key", "generation", "todo_id"],
    foreignKeys = [
        ForeignKey(
            entity = QuerySnapshotEntity::class,
            parentColumns = ["query_key", "generation"],
            childColumns = ["query_key", "generation"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["query_key", "generation"])],
)
data class CachedTodoEntity(
    @ColumnInfo(name = "query_key") val queryKey: String,
    val generation: Long,
    @ColumnInfo(name = "todo_id") val todoId: String,
    val owner: FamilyMember,
    val title: String,
    val done: Boolean,
    val flagged: Boolean,
    val lane: String?,
    val project: String?,
    val area: String?,
    val due: String?,
    val notes: String?,
    val priority: Long?,
    @ColumnInfo(name = "created_at") val createdAt: String?,
    @ColumnInfo(name = "updated_at") val updatedAt: String?,
    @ColumnInfo(name = "completed_at") val completedAt: String?,
    @ColumnInfo(name = "updated_at_ms") val updatedAtMs: Long,
    @ColumnInfo(name = "source_file") val sourceFile: String,
)

@Entity(
    tableName = "cached_btc_buys",
    primaryKeys = ["query_key", "generation", "source_file", "buy_id"],
    foreignKeys = [
        ForeignKey(
            entity = QuerySnapshotEntity::class,
            parentColumns = ["query_key", "generation"],
            childColumns = ["query_key", "generation"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["query_key", "generation"])],
)
data class CachedBtcBuyEntity(
    @ColumnInfo(name = "query_key") val queryKey: String,
    val generation: Long,
    @ColumnInfo(name = "source_file") val sourceFile: String,
    @ColumnInfo(name = "buy_id") val buyId: String,
    val owner: FamilyMember,
    val date: String,
    val month: String,
    val source: String,
    val sats: Long,
    @ColumnInfo(name = "price_usd_cents") val priceUsdCents: Long,
    @ColumnInfo(name = "usd_cents") val usdCents: Long,
    val note: String?,
    val status: String?,
    @ColumnInfo(name = "cost_basis_status") val costBasisStatus: String?,
    @ColumnInfo(name = "logged_by") val loggedBy: String?,
    @ColumnInfo(name = "archimedes_request_id") val archimedesRequestId: String?,
    @ColumnInfo(name = "updated_at_ms") val updatedAtMs: Long,
)

@Entity(
    tableName = "cached_btc_accounts",
    primaryKeys = ["query_key", "generation", "owner", "account_key"],
    foreignKeys = [
        ForeignKey(
            entity = QuerySnapshotEntity::class,
            parentColumns = ["query_key", "generation"],
            childColumns = ["query_key", "generation"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["query_key", "generation"])],
)
data class CachedBtcAccountEntity(
    @ColumnInfo(name = "query_key") val queryKey: String,
    val generation: Long,
    val owner: FamilyMember,
    @ColumnInfo(name = "account_key") val accountKey: String,
    val label: String,
    val custody: String,
    val sats: Long,
    @ColumnInfo(name = "fiat_cents") val fiatCents: Long,
    @ColumnInfo(name = "as_of") val asOf: String,
    @ColumnInfo(name = "schema_version") val schemaVersion: Long,
    @ColumnInfo(name = "source_file") val sourceFile: String,
    @ColumnInfo(name = "updated_at_ms") val updatedAtMs: Long,
)

/** Rows accepted from the transport before a query generation is assigned. */
data class TransactionCacheRow(
    val sourceFile: String,
    val transactionId: String,
    val owner: FamilyMember,
    val date: String,
    val month: String,
    val merchant: String,
    /** Raw signed amount only; never persist spendAmount or displaySpendAmount here. */
    val amountCents: Long,
    val category: String,
    val card: String? = null,
    val note: String? = null,
    val updatedAtMs: Long,
)

data class TodoCacheRow(
    val todoId: String,
    val owner: FamilyMember,
    val title: String,
    val done: Boolean,
    val flagged: Boolean,
    val lane: String? = null,
    val project: String? = null,
    val area: String? = null,
    val due: String? = null,
    val notes: String? = null,
    val priority: Long? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val completedAt: String? = null,
    val updatedAtMs: Long,
    val sourceFile: String,
)

data class BtcBuyCacheRow(
    val sourceFile: String,
    val buyId: String,
    val owner: FamilyMember,
    val date: String,
    val month: String,
    val source: String,
    val sats: Long,
    val priceUsdCents: Long,
    val usdCents: Long,
    val note: String? = null,
    val status: String? = null,
    val costBasisStatus: String? = null,
    val loggedBy: String? = null,
    val archimedesRequestId: String? = null,
    val updatedAtMs: Long,
)

data class BtcAccountCacheRow(
    val owner: FamilyMember,
    val accountKey: String,
    val label: String,
    val custody: String,
    val sats: Long,
    val fiatCents: Long,
    val asOf: String,
    val schemaVersion: Long,
    val sourceFile: String,
    val updatedAtMs: Long,
)

internal fun TransactionCacheRow.inSnapshot(
    queryKey: String,
    generation: Long,
) = CachedTransactionEntity(
    queryKey = queryKey,
    generation = generation,
    sourceFile = sourceFile,
    transactionId = transactionId,
    owner = owner,
    date = date,
    month = month,
    merchant = merchant,
    amountCents = amountCents,
    category = category,
    card = card,
    note = note,
    updatedAtMs = updatedAtMs,
)

internal fun TodoCacheRow.inSnapshot(
    queryKey: String,
    generation: Long,
) = CachedTodoEntity(
    queryKey = queryKey,
    generation = generation,
    todoId = todoId,
    owner = owner,
    title = title,
    done = done,
    flagged = flagged,
    lane = lane,
    project = project,
    area = area,
    due = due,
    notes = notes,
    priority = priority,
    createdAt = createdAt,
    updatedAt = updatedAt,
    completedAt = completedAt,
    updatedAtMs = updatedAtMs,
    sourceFile = sourceFile,
)

internal fun BtcBuyCacheRow.inSnapshot(
    queryKey: String,
    generation: Long,
) = CachedBtcBuyEntity(
    queryKey = queryKey,
    generation = generation,
    sourceFile = sourceFile,
    buyId = buyId,
    owner = owner,
    date = date,
    month = month,
    source = source,
    sats = sats,
    priceUsdCents = priceUsdCents,
    usdCents = usdCents,
    note = note,
    status = status,
    costBasisStatus = costBasisStatus,
    loggedBy = loggedBy,
    archimedesRequestId = archimedesRequestId,
    updatedAtMs = updatedAtMs,
)

internal fun BtcAccountCacheRow.inSnapshot(
    queryKey: String,
    generation: Long,
) = CachedBtcAccountEntity(
    queryKey = queryKey,
    generation = generation,
    owner = owner,
    accountKey = accountKey,
    label = label,
    custody = custody,
    sats = sats,
    fiatCents = fiatCents,
    asOf = asOf,
    schemaVersion = schemaVersion,
    sourceFile = sourceFile,
    updatedAtMs = updatedAtMs,
)
