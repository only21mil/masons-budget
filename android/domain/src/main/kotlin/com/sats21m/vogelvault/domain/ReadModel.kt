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
) {
    val remainingCents: Long get() = budgetCents - spentCents
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
) : Owned {
    val plannedCents: Long get() = categories.sumOf { it.budgetCents }
    val actualCents: Long get() = categories.sumOf { it.spentCents }
    val remainingCents: Long get() = plannedCents - actualCents
    val overBudgetCount: Int get() = categories.count { it.isOverBudget }
}

// ── Bitcoin ─────────────────────────────────────────────────────────────────

enum class Custody(val key: String) {
    EXCHANGE("exchange"),
    SELF_CUSTODY("self_custody");

    val label: String get() = if (this == SELF_CUSTODY) "Self custody" else "Exchange"
}

data class BtcAccount(
    val key: String,
    val label: String,
    val custody: Custody,
    val sats: Long,
    val fiatCents: Long,
    override val owner: FamilyMember,
) : Owned

data class BtcBuy(
    val id: String,
    val date: String,
    val source: String,
    val sats: Long,
    val priceUsdCents: Long,
    val usdCents: Long,
    val costBasisStatus: String? = null,
    override val owner: FamilyMember,
) : Owned

/** The single scoped BTC balance document that supplies net-worth totals. */
data class BtcBalance(
    override val owner: FamilyMember,
    val asOf: String,
    val accounts: List<BtcAccount>,
    val totalSats: Long,
    val fiatCents: Long,
    val exchangeSats: Long,
    val selfCustodySats: Long,
) : Owned

data class IncomeEntry(
    val id: String,
    val date: String,
    val month: String,
    val amountCents: Long,
    val sourceName: String,
    val note: String?,
    override val owner: FamilyMember,
) : Owned

data class BtcBillPay(
    val id: String,
    val date: String,
    val merchant: String,
    val category: String,
    val amountUsdCents: Long,
    val btcSpentSats: Long,
    val feeUsdCents: Long,
    val platform: String?,
    val note: String?,
    override val owner: FamilyMember,
) : Owned

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
) : Owned

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
 * Screens apply [visibleTo] / [netWorthScopeFor] themselves. Handing pre-filtered
 * data to the UI would hide a missing filter instead of exposing it.
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

    val billPayLedgerUnavailable: Boolean
        get() = btcBillPays.requiredProjectionUnavailable || btcBillPays.value.isEmpty()
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
fun List<Transaction>.budgetMonthsFor(viewer: FamilyMember, budgetMonth: String?): List<String> {
    val present = budgetTransactionsFor(viewer).monthsPresent()
    return (listOfNotNull(budgetMonth) + present).distinct().sortedDescending()
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
) {
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
) {
    val plannedCents: Long get() = categories.sumOf { it.budgetCents }
    val actualCents: Long get() = categories.sumOf { it.spentCents }
    val remainingCents: Long get() = plannedCents - actualCents
    val overBudgetCount: Int get() = categories.count { it.isOverBudget }
}

/**
 * Derive a month's spend for [budget] from [transactions].
 *
 * [transactions] must already be filtered to what the viewer may see. Visibility
 * is deliberately not applied here so the two rules stay separate and testable.
 */
fun deriveBudgetSpend(budget: Budget, transactions: List<Transaction>): BudgetSpend {
    val spentByCategory = mutableMapOf<String, Long>()
    for (transaction in transactions.inMonth(budget.month)) {
        val contribution = transaction.spendAmount
        if (contribution == 0L) continue
        spentByCategory[transaction.category] =
            (spentByCategory[transaction.category] ?: 0L) + contribution
    }

    val categories = budget.categories.map { category ->
        val spent = spentByCategory.remove(category.name) ?: 0L
        CategorySpend(name = category.name, budgetCents = category.budgetCents, spentCents = spent)
    }

    return BudgetSpend(
        month = budget.month,
        categories = categories,
        uncategorisedCents = spentByCategory.values.sum(),
    )
}
