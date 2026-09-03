package com.sats21m.vogelvault.domain

/**
 * The Vogel Vault — Convex row read model, Kotlin mirror.
 *
 * Mirrors `shared/domain/src/readModel.ts` and, behind that,
 * the Apple client's compatibility DTO boundary.
 *
 * Money is held as integer minor units — USD cents and satoshis — never as a
 * `Double`. See [Money].
 */

/** Every legacy `dataFiles` blob retained for compatibility tooling. */
val LEGACY_DATA_FILE_NAMES: List<String> = listOf(
    "transactions",
    "budget",
    "bitcoin-buys",
    "bitcoin-bill-pays",
    "btc-balance-snapshot",
    "finances",
    "todos",
    "mason-transactions",
    "mason-budget",
    "mason-bitcoin-buys",
    "maddox-transactions",
    "son-balances",
)

/** Freshness of a slice of the read model, surfaced explicitly in the UI. */
enum class Freshness { DEMO, LIVE, STALE, ERROR, EMPTY, LOADING }

/**
 * A slice of the read model plus where it came from and how much to trust it.
 *
 * The UI never renders a figure without also being able to say how fresh it is.
 */
data class Slice<T>(
    val status: Freshness,
    val value: T,
    /** Unix ms of the remote write this came from; null for demo or never-loaded data. */
    val updatedAt: Long?,
    val source: String,
) {
    /**
     * True when a figure derived from this slice must not be shown.
     *
     * `DEMO` is deliberately visible but unmistakably labelled. `EMPTY` is
     * deliberately excluded because an empty ordinary collection can be a real
     * zero. `ERROR` and `LOADING` are suppressed.
     */
    val suppressFigures: Boolean
        get() = status == Freshness.ERROR || status == Freshness.LOADING

    /**
     * Required financial projections cannot turn a successful empty response
     * into a confident zero. Consumers opt into this stricter rule per metric;
     * ordinary collections such as todos continue to use [suppressFigures].
     */
    val requiredProjectionUnavailable: Boolean
        get() = suppressFigures || status == Freshness.EMPTY
}

// ── Transactions ────────────────────────────────────────────────────────────

data class Transaction(
    val id: String,
    val date: String,
    val merchant: String,
    /** Signed stored amount. Positive is money out; negative is a credit/refund. */
    val amount: Long,
    val category: String,
    val card: String? = null,
    val note: String? = null,
    override val owner: FamilyMember,
    /**
     * Signed contribution to budget actuals.
     *
     * Income contributes zero. Adult and child purchases are positive; credits
     * and refunds are negative. Row responses provide this value directly;
     * legacy fixtures derive the same contract from [amount].
     */
    val spendAmount: Long =
        if (category == "Income") 0L else amount,
    /** Stable rendering magnitude; never used for budget maths. */
    val displaySpendAmount: Long = kotlin.math.abs(spendAmount),
    /** Exact BTC Income quantity when the row posts to the Bitcoin ledger. */
    val amountSats: Long? = null,
    /** Stored Bitcoin account identity for exact edit round-trips. */
    val bitcoinAccountKey: String? = null,
    /** Exact remote revision for optimistic writeback. */
    val updatedAtMs: Long = 0L,
) : Owned {
    /**
     * A credit/refund that reduces spend.
     */
    val hasOppositeSpendSign: Boolean
        get() = spendAmount < 0L
}

val Transaction.incomeAmount: Long
    get() = if (category == "Income" && amount > 0L) amount else 0L

val Transaction.isSpend: Boolean
    get() = category != "Income" && amount != 0L

// ── Budget ──────────────────────────────────────────────────────────────────

data class BudgetCategory(
    val name: String,
    val budgetCents: Long,
    val spentCents: Long,
    val icon: String? = null,
) {
    val remainingCents: Long? get() = subtractExactOrNull(budgetCents, spentCents)
    val isOverBudget: Boolean get() = spentCents > budgetCents
}

data class BudgetIncome(
    val weeklyGrossCents: Long,
    val monthlyGrossCents: Long,
    val mtdIncomeCents: Long,
    val ytdIncomeCents: Long,
    val payFrequency: String? = null,
)

data class Budget(
    val month: String,
    val categories: List<BudgetCategory>,
    val income: BudgetIncome? = null,
    val strategyNote: String? = null,
    override val owner: FamilyMember,
    /** Exact remote document revision used by budget write fences. */
    val updatedAtMs: Long = 0L,
) : Owned {
    val plannedCents: Long? get() = categories.sumExactOrNull(BudgetCategory::budgetCents)
    val actualCents: Long? get() = categories.sumExactOrNull(BudgetCategory::spentCents)
    val remainingCents: Long?
        get() {
            val planned = plannedCents ?: return null
            val actual = actualCents ?: return null
            return subtractExactOrNull(planned, actual)
        }
    val overBudgetCount: Int get() = categories.count { it.isOverBudget }
}

// ── Bitcoin ─────────────────────────────────────────────────────────────────

enum class Custody(val key: String) {
    EXCHANGE("exchange"),
    SELF_CUSTODY("self_custody");

    val label: String get() = if (this == SELF_CUSTODY) "Self custody" else "Exchange"
}

/**
 * A USD valuation with evidence independent from the BTC quantity.
 *
 * [cents] may legitimately be zero. A null valuation means USD is unavailable;
 * balance confidence must never be promoted into [confidence].
 */
data class FiatValuation(
    val cents: Long,
    val priceCents: Long? = null,
    val quotedAt: String? = null,
    val source: String? = null,
    val confidence: String? = null,
)

/** Conservative compatibility for rows that predate an availability field. */
fun legacyFiatValuation(sats: Long, fiatCents: Long): FiatValuation? =
    if (sats > 0L && fiatCents == 0L) null else FiatValuation(fiatCents)

data class BtcAccount(
    val key: String,
    val label: String,
    val custody: Custody,
    val sats: Long,
    /** Transition-only mirror. Render [fiatValuation], never this field. */
    val fiatCents: Long,
    override val owner: FamilyMember,
    val fiatValuation: FiatValuation? = legacyFiatValuation(sats, fiatCents),
) : Owned {
    val fiatFiguresUnavailable: Boolean get() = fiatValuation == null
}

data class BtcBuy(
    val id: String,
    val date: String,
    val source: String,
    val sats: Long,
    val priceUsdCents: Long,
    val usdCents: Long,
    val costBasisStatus: String? = null,
    override val owner: FamilyMember,
    val feeUsdCents: Long = 0L,
    /**
     * The server's revision for the row, mirroring Transaction.updatedAtMs.
     * 0 means "unknown" (fixtures, legacy readers) and must never be treated
     * as a fetch-local timestamp: cache revisions and server revisions have
     * to stay comparable inside one table family.
     */
    val updatedAtMs: Long = 0L,
) : Owned {
    init {
        require(feeUsdCents >= 0L) { "Bitcoin buy feeUsdCents must be nonnegative" }
    }
}

/**
 * An internal movement between two Bitcoin accounts.
 *
 * The principal is moved from one account to another; only the network fee
 * changes the aggregate Bitcoin balance. Transfers never become fiat income or
 * spending rows.
 */
data class BtcTransfer(
    val id: String,
    override val owner: FamilyMember,
    val date: String,
    val fromAccountKey: String,
    val toAccountKey: String,
    val sats: Long,
    val feeSats: Long,
    val note: String? = null,
) : Owned {
    init {
        require(id.isNotBlank()) { "Bitcoin transfer id must not be empty" }
        require(date.isNotBlank()) { "Bitcoin transfer date must not be empty" }
        require(fromAccountKey.isNotBlank()) { "Bitcoin transfer source account must not be empty" }
        require(toAccountKey.isNotBlank()) { "Bitcoin transfer destination account must not be empty" }
        require(fromAccountKey != toAccountKey) {
            "Bitcoin transfer source and destination must differ"
        }
        require(sats > 0L) { "Bitcoin transfer sats must be positive" }
        require(feeSats >= 0L) { "Bitcoin transfer feeSats must be nonnegative" }
        require(sats <= Long.MAX_VALUE - feeSats) {
            "Bitcoin transfer debit exceeds signed int64"
        }
    }

    val principalSats: Long get() = sats
    val totalBtcDeltaSats: Long get() = -feeSats
    val netWorthDeltaSats: Long get() = -feeSats
    val incomeCentsDelta: Long get() = 0L
    val spendCentsDelta: Long get() = 0L
    val affectsIncomeOrSpend: Boolean get() = false
}

/** The single scoped BTC balance document that supplies net-worth totals. */
data class BtcBalance(
    override val owner: FamilyMember,
    val asOf: String,
    val accounts: List<BtcAccount>,
    val totalSats: Long,
    /** Transition-only mirror. Render [fiatValuation], never this field. */
    val fiatCents: Long,
    val exchangeSats: Long,
    val selfCustodySats: Long,
    val fiatValuation: FiatValuation? = legacyFiatValuation(totalSats, fiatCents),
    /** Confidence in the sats balance only. */
    val balanceConfidence: String? = null,
) : Owned {
    val fiatFiguresUnavailable: Boolean get() = fiatValuation == null
}

data class IncomeEntry(
    val id: String,
    val date: String,
    val month: String,
    val amountCents: Long,
    val sourceName: String,
    val note: String?,
    override val owner: FamilyMember,
) : Owned

/** How a Bitcoin bill pay participates in the monthly budget. */
enum class BillPayBudgetEffect(val wireValue: String) {
    BUDGET_CATEGORY("budget_category"),
    CREDIT_CARD_PAYMENT("credit_card_payment"),
    ;

    companion object {
        /** Old rows predate this field and were all budget-excluded payments. */
        fun fromWireOrNull(value: String?): BillPayBudgetEffect? =
            entries.firstOrNull { it.wireValue == value }

        fun fromWireOrDefault(value: String?): BillPayBudgetEffect =
            value?.let(::fromWireOrNull) ?: CREDIT_CARD_PAYMENT
    }
}

data class BtcBillPay(
    val id: String,
    val date: String,
    val merchant: String,
    val category: String,
    val budgetEffect: BillPayBudgetEffect = BillPayBudgetEffect.CREDIT_CARD_PAYMENT,
    val amountUsdCents: Long,
    val btcSpentSats: Long,
    val btcPriceCents: Long = 0L,
    val feeUsdCents: Long = 0L,
    val platform: String?,
    val note: String?,
    val reference: String? = null,
    override val owner: FamilyMember,
) : Owned {
    init {
        require(feeUsdCents >= 0L) { "Bitcoin bill pay feeUsdCents must be nonnegative" }
    }
}

// ── Todos ───────────────────────────────────────────────────────────────────

data class TodoItem(
    val id: String,
    val title: String,
    val done: Boolean = false,
    val project: String? = null,
    val area: String? = null,
    val due: String? = null,
    val flagged: Boolean = false,
    override val owner: FamilyMember,
    val lane: String? = null,
    val notes: String? = null,
    val priority: Long? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val completedAt: String? = null,
    val updatedAtMs: Long = 0L,
) : ProfileScopedTodo

/**
 * Due on or before [date], comparing ISO `yyyy-MM-dd` strings lexically.
 *
 * Lives here rather than at the call site: a consumer module cannot smart-cast
 * `due` across the module boundary, and this is a domain rule regardless.
 */
fun TodoItem.isDueOnOrBefore(date: String): Boolean {
    val dueDate = due ?: return false
    return dueDate <= date
}

/** Open and due — the Today list. */
fun TodoItem.isDueBy(date: String): Boolean = !done && isDueOnOrBefore(date)

// ── Aggregate ───────────────────────────────────────────────────────────────

/**
 * Everything a screen can read, unfiltered and tagged with canonical owners.
 *
 * Screens apply [visibleTo] / [netWorthScopeFor] to financial rows and [todosFor]
 * to todos. Handing pre-filtered data to the UI would hide a missing projection
 * instead of exposing it.
 */
data class ReadModel(
    val transactions: Slice<List<Transaction>>,
    val budget: Slice<Budget?>,
    val btcAccounts: Slice<List<BtcAccount>>,
    val btcBuys: Slice<List<BtcBuy>>,
    val todos: Slice<List<TodoItem>>,
    val btcPriceCents: Long,
    /** Date of the recorded buy supplying [btcPriceCents]; null means no price. */
    val btcPriceAsOf: String? = null,
    val income: Slice<List<IncomeEntry>> =
        Slice(Freshness.EMPTY, emptyList(), null, "Convex rows · income"),
    val btcBalance: Slice<BtcBalance?> =
        Slice(Freshness.EMPTY, null, null, "Convex rows · bitcoin balance"),
    val btcBillPays: Slice<List<BtcBillPay>> =
        Slice(Freshness.EMPTY, emptyList(), null, "Convex rows · bitcoin bill pays"),
) {
    val incomeFiguresUnavailable: Boolean
        get() = income.requiredProjectionUnavailable || income.value.isEmpty()

    val netWorthFiguresUnavailable: Boolean
        get() = btcBalance.requiredProjectionUnavailable || btcBalance.value == null

    val btcFiatFiguresUnavailable: Boolean
        get() = netWorthFiguresUnavailable || btcBalance.value?.fiatFiguresUnavailable != false

    val billPayLedgerUnavailable: Boolean
        get() = btcBillPays.requiredProjectionUnavailable || btcBillPays.value.isEmpty()

    /**
     * Budget actuals require every ledger that can contribute to monthly spend.
     *
     * A failed or absent bill-pay projection is not an empty spend list: treating
     * it as zero would make Actual, Remaining, exports, and alerts under-report
     * the household budget.
     */
    val budgetActualsUnavailable: Boolean
        get() =
            budget.requiredProjectionUnavailable ||
                transactions.requiredProjectionUnavailable ||
                btcBillPays.requiredProjectionUnavailable

    /** The source status to explain why budget actuals cannot be trusted. */
    val budgetActualsStatus: Freshness
        get() = when {
            budget.requiredProjectionUnavailable -> budget.status
            transactions.requiredProjectionUnavailable -> transactions.status
            else -> btcBillPays.status
        }
}

// ── Month scoping ───────────────────────────────────────────────────────────
//
// A budget is for one month, so its spend must come from that month's
// transactions and no others. iOS has always derived it this way
// (BudgetView.monthTransactions); this gives Android the same rule instead of
// trusting the compatibility projection's precomputed `spent` field.

/**
 * Transactions that contribute to [viewer]'s budget.
 *
 * Adults retain wide visibility for oversight, but their household budget follows
 * the narrower net-worth-sharing rule: Victor and Rachel share one budget while
 * child spending stays out of their totals. A child budget remains self-only.
 */
fun List<Transaction>.budgetTransactionsFor(viewer: FamilyMember): List<Transaction> =
    if (viewer.isAdult) netWorthScopeFor(viewer) else visibleTo(viewer)

/** Months that can contribute to [viewer]'s budget, newest first. */
fun List<Transaction>.budgetMonthsFor(
    viewer: FamilyMember,
    budgetMonth: String?,
    billPays: List<BtcBillPay> = emptyList(),
): List<String> {
    val present = budgetTransactionsFor(viewer).monthsPresent()
    val billPayMonths = billPays
        .budgetBillPaysFor(viewer)
        .asSequence()
        .filter { it.budgetEffect == BillPayBudgetEffect.BUDGET_CATEGORY }
        .map { monthOf(it.date) }
    return (listOfNotNull(budgetMonth) + present + billPayMonths).distinct().sortedDescending()
}

/** Bill pays that count toward a viewer's budget, using the same adult/child scope as transactions. */
fun List<BtcBillPay>.budgetBillPaysFor(viewer: FamilyMember): List<BtcBillPay> =
    if (viewer.isAdult) netWorthScopeFor(viewer) else visibleTo(viewer)

/** Bill pays shown in one budget category drilldown. */
fun List<BtcBillPay>.budgetCategoryBillPaysFor(
    viewer: FamilyMember,
    month: String,
    category: String,
): List<BtcBillPay> =
    budgetBillPaysFor(viewer).filter {
        it.budgetEffect == BillPayBudgetEffect.BUDGET_CATEGORY &&
            monthOf(it.date) == month &&
            it.category == category
    }

/** Resolve a persisted selection against the months still valid for this budget. */
fun resolveBudgetMonth(selected: String?, months: List<String>, budgetMonth: String?): String? =
    selected?.takeIf { it in months }
        ?: budgetMonth?.takeIf { it in months }
        ?: months.firstOrNull()

/** Month a transaction belongs to, as `yyyy-MM`.
 *
 * Ledger dates are ISO `yyyy-MM-dd`, so the month is a prefix — no date parsing and
 * no timezone to get wrong. A transaction dated the 1st belongs to that month for
 * every reader, which is what a ledger needs.
 */
fun monthOf(date: String): String = date.take(7)

fun Transaction.isInMonth(month: String): Boolean = monthOf(date) == month

fun List<Transaction>.inMonth(month: String): List<Transaction> = filter { it.isInMonth(month) }

/** Distinct months present, newest first. */
fun List<Transaction>.monthsPresent(): List<String> =
    map { monthOf(it.date) }.distinct().sortedDescending()

/** A budget category whose spend is derived from transactions, not reported. */
data class CategorySpend(
    val name: String,
    val budgetCents: Long,
    val spentCents: Long,
    val icon: String? = null,
) {
    /** Exact because [deriveBudgetSpend] rejects the projection before constructing this row. */
    val remainingCents: Long get() = budgetCents - spentCents
    val isOverBudget: Boolean get() = spentCents > budgetCents
}

data class BudgetSpend(
    val month: String,
    val categories: List<CategorySpend>,
    /**
     * Spend in this month matching no budget category. Surfaced rather than
     * dropped — silently discarding it would make the budget disagree with the
     * Activity screen for no visible reason.
     */
    val uncategorisedCents: Long,
    val plannedCents: Long,
    val actualCents: Long,
    val remainingCents: Long,
) {
    val overBudgetCount: Int get() = categories.count { it.isOverBudget }
}

/**
 * Derive a month's spend for [budget] from [transactions].
 *
 * [transactions] must already be filtered to what the viewer may see. Visibility
 * is deliberately not applied here so the two rules stay separate and testable.
 * Returns null when any category, aggregate, remaining, or uncategorised value
 * cannot be represented as exact signed 64-bit cents.
 */
fun deriveBudgetSpend(
    budget: Budget,
    transactions: List<Transaction>,
    billPays: List<BtcBillPay> = emptyList(),
): BudgetSpend? {
    val spentByCategory = mutableMapOf<String, Long>()
    for (transaction in transactions.inMonth(budget.month)) {
        val contribution = transaction.spendAmount
        if (contribution == 0L) continue
        spentByCategory[transaction.category] =
            addExactOrNull(spentByCategory[transaction.category] ?: 0L, contribution)
                ?: return null
    }
    for (billPay in billPays) {
        if (
            billPay.budgetEffect != BillPayBudgetEffect.BUDGET_CATEGORY ||
            monthOf(billPay.date) != budget.month
        ) {
            continue
        }
        spentByCategory[billPay.category] =
            addExactOrNull(spentByCategory[billPay.category] ?: 0L, billPay.amountUsdCents)
                ?: return null
    }

    val categories = budget.categories.map { category ->
        val spent = spentByCategory.remove(category.name) ?: 0L
        subtractExactOrNull(category.budgetCents, spent) ?: return null
        CategorySpend(
            name = category.name,
            budgetCents = category.budgetCents,
            spentCents = spent,
            icon = category.icon,
        )
    }

    val planned = categories.sumExactOrNull(CategorySpend::budgetCents) ?: return null
    val actual = categories.sumExactOrNull(CategorySpend::spentCents) ?: return null
    val remaining = subtractExactOrNull(planned, actual) ?: return null
    val uncategorised = spentByCategory.values.sumExactOrNull { it } ?: return null

    return BudgetSpend(
        month = budget.month,
        categories = categories,
        uncategorisedCents = uncategorised,
        plannedCents = planned,
        actualCents = actual,
        remainingCents = remaining,
    )
}

private fun addExactOrNull(left: Long, right: Long): Long? =
    try {
        Math.addExact(left, right)
    } catch (_: ArithmeticException) {
        null
    }

private fun subtractExactOrNull(left: Long, right: Long): Long? =
    try {
        Math.subtractExact(left, right)
    } catch (_: ArithmeticException) {
        null
    }

private inline fun <T> Iterable<T>.sumExactOrNull(value: (T) -> Long): Long? {
    var total = 0L
    for (item in this) {
        total = addExactOrNull(total, value(item)) ?: return null
    }
    return total
}
