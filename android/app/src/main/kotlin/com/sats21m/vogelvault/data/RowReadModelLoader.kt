package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetCategory
import com.sats21m.vogelvault.domain.BudgetIncome
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.IncomeEntry
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.Slice
import java.util.logging.Logger
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/**
 * A non-secret diagnosis for a rejected row projection.
 *
 * The tag is carried in [Slice.source] because the shared domain model has no
 * failure-metadata field. This preserves the cause through Room/cache fallback
 * without weakening the fail-closed [Freshness.ERROR] contract.
 */
enum class RowReadFailure(
    internal val sourceTag: String,
) {
    UNAUTHORIZED("unauthorized"),
    DISABLED("disabled"),
    NOT_CONFIGURED("not_configured"),
    TRANSPORT("transport"),
    HTTP("http"),
    DEPLOYMENT_MISCONFIGURED("deployment_misconfigured"),
    SERVER_REJECTED("server_rejected"),
    MALFORMED_PAYLOAD("malformed_payload"),
    ;

    internal fun attachTo(source: String): String = "$source$FAILURE_MARKER$sourceTag"

    companion object {
        internal const val FAILURE_MARKER = " · failure="

        internal fun fromSource(source: String): RowReadFailure? {
            val tag = source.substringAfterLast(FAILURE_MARKER, missingDelimiterValue = "")
            return entries.firstOrNull { it.sourceTag == tag }
        }
    }
}

/** A stable projection identity that contains no request arguments or row data. */
enum class RowReadProjection(internal val sourceName: String) {
    TRANSACTIONS("Convex rows · transactions"),
    BUDGET("Convex rows · budget"),
    BITCOIN_ACCOUNTS("Convex rows · bitcoin accounts"),
    BITCOIN_BUYS("Convex rows · bitcoin buys"),
    TODOS("Convex rows · todos"),
    INCOME("Convex rows · income"),
    BITCOIN_BALANCE("Convex rows · bitcoin balance"),
    BITCOIN_BILL_PAYS("Convex rows · bitcoin bill pays"),
    BITCOIN_TRANSFERS("Convex rows · bitcoin transfers"),
    FINANCE("Convex finance"),
    MARKET_QUOTES("Convex market quotes"),
    ;

    companion object {
        internal fun fromSource(source: String): RowReadProjection? {
            val base = source.substringBefore(RowReadFailure.FAILURE_MARKER)
            return entries.firstOrNull { it.sourceName == base }
        }
    }
}

/** One failed projection and its closed, secret-free diagnosis. */
data class RowReadDiagnostic(
    val projection: RowReadProjection,
    val failure: RowReadFailure,
) {
    companion object {
        internal fun fromSource(source: String): RowReadDiagnostic? {
            val projection = RowReadProjection.fromSource(source) ?: return null
            val failure = RowReadFailure.fromSource(source) ?: return null
            return RowReadDiagnostic(projection, failure)
        }
    }
}

/** Every failed projection retained by this model's slices. */
val ReadModel.rowReadDiagnostics: Set<RowReadDiagnostic>
    get() =
        listOf(
            transactions.source,
            budget.source,
            btcAccounts.source,
            btcBuys.source,
            todos.source,
            income.source,
            btcBalance.source,
            btcBillPays.source,
            btcTransfers.source,
        ).mapNotNullTo(linkedSetOf()) { RowReadDiagnostic.fromSource(it) }

/** Compatibility cause-only view. Prefer [rowReadDiagnostics]. */
val ReadModel.rowReadFailures: Set<RowReadFailure>
    get() = rowReadDiagnostics.mapTo(linkedSetOf()) { it.failure }

/**
 * Builds the UI read model from bounded public row queries.
 *
 * Every call deliberately omits `limit`, which requests a complete replacement
 * snapshot. An incomplete response is rejected rather than rendered as if it
 * were the whole ledger.
 */
class RowReadModelLoader(
    private val repository: RowQueryRepository,
    private val nowMillis: () -> Long = System::currentTimeMillis,
) {
    suspend fun load(viewer: FamilyMember): ReadModel = coroutineScope {
        val transactions = async { repository.listTransactions(viewer) }
        val todos = async { repository.listTodos(viewer) }
        // VISIBLE is intentional for the oversight surfaces. Net-worth totals
        // are narrowed again by sharesNetWorthWith in the domain/UI.
        val btcBuys = async {
            repository.listBtcBuys(viewer, scope = RowVisibilityScope.VISIBLE)
        }
        val btcAccounts = async {
            repository.listBtcAccounts(viewer, scope = RowVisibilityScope.VISIBLE)
        }
        val btcBalance = async {
            repository.listBtcBalanceDocuments(viewer, scope = RowVisibilityScope.NET_WORTH)
        }
        val income = async { repository.listIncome(viewer) }
        val btcBillPays = async {
            repository.listBtcBillPays(viewer, scope = RowVisibilityScope.VISIBLE)
        }
        val btcTransfers = async {
            repository.listBtcTransfers(viewer, scope = RowVisibilityScope.VISIBLE)
        }
        val budget = async {
            repository.getBudgetDocument(viewer, scope = BudgetQueryScope.NET_WORTH)
        }

        val stamp = nowMillis()
        val transactionSlice = transactions.await().toTransactionSlice(stamp)
        val todoSlice =
            todos.await().toSlice(emptyList(), RowReadProjection.TODOS.sourceName, stamp)
        val buySlice =
            btcBuys.await().toSlice(emptyList(), RowReadProjection.BITCOIN_BUYS.sourceName, stamp)
        val accountSlice =
            btcAccounts.await().toSlice(
                emptyList(),
                RowReadProjection.BITCOIN_ACCOUNTS.sourceName,
                stamp,
            )
        val balanceSlice = btcBalance.await().toBtcBalanceSlice(stamp)
        val incomeSlice = income.await().toMappedSlice(
            emptyList(),
            RowReadProjection.INCOME.sourceName,
            stamp,
            IncomeRow::toDomain,
            completeEmptyIsLive = true,
        )
        val billPaySlice = btcBillPays.await().toMappedSlice(
            emptyList(),
            RowReadProjection.BITCOIN_BILL_PAYS.sourceName,
            stamp,
            map = BtcBillPayRow::toDomain,
            completeEmptyIsLive = true,
        )
        val budgetSlice = budget.await().toBudgetSlice(stamp)
        val latestBuy = buySlice.value.maxByOrNull { it.date }

        ReadModel(
            transactions = transactionSlice,
            budget = budgetSlice,
            btcAccounts = accountSlice,
            btcBuys = buySlice,
            todos = todoSlice,
            // Public account rows already carry their exact fiat valuation, but
            // the current ReadModel asks for a price. The newest buy is the only
            // exact integer-cent price exposed by this API. It is explicitly
            // dated so the UI cannot present it as live; zero is the honest
            // answer when there are no buys.
            btcPriceCents = latestBuy?.priceUsdCents ?: 0L,
            btcPriceAsOf = latestBuy?.date,
            income = incomeSlice,
            btcBalance = balanceSlice,
            btcBillPays = billPaySlice,
            btcTransfers = btcTransfers.await().toMappedSlice(emptyList(),
                RowReadProjection.BITCOIN_TRANSFERS.sourceName, stamp, { it }, completeEmptyIsLive = true),
        )
    }
}

private fun IncomeRow.toDomain(): IncomeEntry = IncomeEntry(
    id = id,
    date = date,
    month = month,
    amountCents = amountCents,
    sourceName = source,
    note = note,
    owner = owner,
)

private fun BtcBillPayRow.toDomain(): BtcBillPay = BtcBillPay(
    id = id,
    date = date,
    merchant = merchant,
    category = category,
    budgetEffect = budgetEffect,
    amountUsdCents = amountUsdCents,
    btcSpentSats = btcSpentSats,
    btcPriceCents = btcPriceCents,
    feeUsdCents = feeUsdCents,
    platform = platform,
    note = note,
    reference = reference,
    owner = owner,
    updatedAtMs = updatedAtMs,
)

private fun BtcBalanceDocumentRow.toDomain(): BtcBalance = BtcBalance(
    owner = owner,
    asOf = asOf,
    accounts = accounts.map {
        BtcAccount(
            key = it.key,
            label = it.label,
            custody = it.custody,
            sats = it.sats,
            fiatCents = it.fiatCents,
            owner = owner,
            fiatValuation = it.fiatValuation,
        )
    },
    totalSats = totals.sats,
    fiatCents = totals.fiatCents,
    exchangeSats = totals.exchangeSats,
    selfCustodySats = totals.selfCustodySats,
    fiatValuation = totals.fiatValuation,
    balanceConfidence = balanceConfidence,
)

private val englishBudgetMonths = mapOf(
    "January" to "01",
    "February" to "02",
    "March" to "03",
    "April" to "04",
    "May" to "05",
    "June" to "06",
    "July" to "07",
    "August" to "08",
    "September" to "09",
    "October" to "10",
    "November" to "11",
    "December" to "12",
)
private val canonicalBudgetMonthPattern = Regex("""^(\d{4})-(0[1-9]|1[0-2])$""")
private val legacyBudgetMonthPattern = Regex("""^([A-Za-z]+) (\d{4})$""")

/**
 * Normalize the English legacy label without consulting the device locale,
 * timezone, or a lenient date parser.
 */
private fun canonicalBudgetMonth(raw: String): String? {
    val canonical = canonicalBudgetMonthPattern.matchEntire(raw)
    if (canonical != null) {
        return raw.takeUnless { canonical.groupValues[1] == "0000" }
    }

    val legacy = legacyBudgetMonthPattern.matchEntire(raw) ?: return null
    val year = legacy.groupValues[2]
    if (year == "0000") return null
    val month = englishBudgetMonths[legacy.groupValues[1]] ?: return null
    return "$year-$month"
}

private fun BudgetDocumentRow.toDomain(): Budget? {
    val canonicalMonth = canonicalBudgetMonth(month) ?: return null
    return Budget(
        month = canonicalMonth,
        categories =
            categories.map {
                BudgetCategory(
                    name = it.name,
                    budgetCents = it.budgetCents,
                    spentCents = 0L,
                    icon = it.icon,
                )
            },
        income = income?.let {
            BudgetIncome(
                weeklyGrossCents = it.weeklyGrossCents,
                monthlyGrossCents = it.monthlyGrossCents,
                mtdIncomeCents = it.mtdIncomeCents,
                ytdIncomeCents = it.ytdIncomeCents,
                payFrequency = it.payFrequency,
            )
        },
        strategyNote = strategyNote,
        owner = owner,
        updatedAtMs = updatedAtMs,
    )
}

private fun ConvexResult<BudgetDocumentSnapshot>.toBudgetSlice(stamp: Long): Slice<Budget?> =
    when (this) {
        is ConvexResult.Ok -> when {
            !value.complete ->
                errorSlice(
                    null,
                    RowReadProjection.BUDGET.sourceName,
                    RowReadFailure.MALFORMED_PAYLOAD,
                )
            value.document == null -> emptySlice(null, RowReadProjection.BUDGET.sourceName)
            else -> value.document.toDomain()?.let {
                liveSlice(it, RowReadProjection.BUDGET.sourceName, stamp)
            } ?: errorSlice(
                null,
                RowReadProjection.BUDGET.sourceName,
                RowReadFailure.MALFORMED_PAYLOAD,
            )
        }
        ConvexResult.Missing -> emptySlice(null, RowReadProjection.BUDGET.sourceName)
        else -> failureSlice(null, RowReadProjection.BUDGET.sourceName)
    }

/**
 * A complete transaction response with zero rows is an authoritative zero.
 *
 * `EMPTY` remains reserved for a query that produced no usable snapshot (for
 * example `Missing`), so required financial projections can still fail closed.
 */
private fun ConvexResult<RowSnapshot<com.sats21m.vogelvault.domain.Transaction>>.toTransactionSlice(
    stamp: Long,
): Slice<List<com.sats21m.vogelvault.domain.Transaction>> {
    val source = RowReadProjection.TRANSACTIONS.sourceName
    return when (this) {
        is ConvexResult.Ok ->
            if (value.complete) liveSlice(value.rows, source, stamp)
            else errorSlice(emptyList(), source, RowReadFailure.MALFORMED_PAYLOAD)
        ConvexResult.Missing -> emptySlice(emptyList(), source)
        else -> failureSlice(emptyList(), source)
    }
}

private fun <T> ConvexResult<RowSnapshot<T>>.toSlice(
    empty: List<T>,
    source: String,
    stamp: Long,
): Slice<List<T>> = when (this) {
    is ConvexResult.Ok -> when {
        !value.complete -> errorSlice(empty, source, RowReadFailure.MALFORMED_PAYLOAD)
        value.rows.isEmpty() -> emptySlice(empty, source)
        else -> liveSlice(value.rows, source, stamp)
    }
    ConvexResult.Missing -> emptySlice(empty, source)
    else -> failureSlice(empty, source)
}

private fun <T, R> ConvexResult<RowSnapshot<T>>.toMappedSlice(
    empty: List<R>,
    source: String,
    stamp: Long,
    map: (T) -> R,
    completeEmptyIsLive: Boolean = false,
): Slice<List<R>> = when (this) {
    is ConvexResult.Ok -> when {
        !value.complete -> errorSlice(empty, source, RowReadFailure.MALFORMED_PAYLOAD)
        value.rows.isEmpty() && !completeEmptyIsLive -> emptySlice(empty, source)
        else -> liveSlice(value.rows.map(map), source, stamp)
    }
    ConvexResult.Missing -> emptySlice(empty, source)
    else -> failureSlice(empty, source)
}

private fun ConvexResult<RowSnapshot<BtcBalanceDocumentRow>>.toBtcBalanceSlice(
    stamp: Long,
): Slice<BtcBalance?> {
    val source = RowReadProjection.BITCOIN_BALANCE.sourceName
    return when (this) {
        is ConvexResult.Ok -> when {
            !value.complete -> errorSlice(null, source, RowReadFailure.MALFORMED_PAYLOAD)
            value.rows.isEmpty() -> emptySlice(null, source)
            value.rows.size != 1 ->
                errorSlice(null, source, RowReadFailure.MALFORMED_PAYLOAD)
            else -> liveSlice(value.rows.single().toDomain(), source, stamp)
        }
        ConvexResult.Missing -> emptySlice(null, source)
        else -> failureSlice(null, source)
    }
}

private fun <T> liveSlice(value: T, source: String, stamp: Long): Slice<T> =
    Slice(Freshness.LIVE, value, stamp, source)

private fun <T> emptySlice(value: T, source: String): Slice<T> =
    Slice(Freshness.EMPTY, value, null, source)

private fun <T> ConvexResult<*>.failureSlice(value: T, source: String): Slice<T> =
    errorSlice(value, source, toRowReadFailure())

/** Shared non-secret failure taxonomy for row and finance reads. */
internal fun ConvexResult<*>.toRowReadFailure(): RowReadFailure =
    when (this) {
        ConvexResult.Unauthorized -> RowReadFailure.UNAUTHORIZED
        ConvexResult.Disabled -> RowReadFailure.DISABLED
        ConvexResult.NotConfigured -> RowReadFailure.NOT_CONFIGURED
        is ConvexResult.Failed -> when (failure) {
            ConvexFailure.Transport -> RowReadFailure.TRANSPORT
            is ConvexFailure.Http -> RowReadFailure.HTTP
            ConvexFailure.DeploymentMisconfigured -> RowReadFailure.DEPLOYMENT_MISCONFIGURED
            is ConvexFailure.ServerRejected -> RowReadFailure.SERVER_REJECTED
            ConvexFailure.MalformedResponse,
            ConvexFailure.InvalidResponse,
            -> RowReadFailure.MALFORMED_PAYLOAD
        }
        is ConvexResult.Ok,
        ConvexResult.Missing,
        -> RowReadFailure.MALFORMED_PAYLOAD
    }

private fun <T> errorSlice(
    value: T,
    source: String,
    failure: RowReadFailure,
): Slice<T> {
    rowReadLog.warning(
        "Convex row read unavailable: projection=${source.substringAfterLast(" · ")} " +
            "cause=${failure.name}",
    )
    return Slice(Freshness.ERROR, value, null, failure.attachTo(source))
}

private val rowReadLog: Logger = Logger.getLogger(RowReadModelLoader::class.java.name)
