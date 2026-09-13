package com.sats21m.vogelvault.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import com.sats21m.vogelvault.ui.components.LedgerTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.IncomeEntry
import com.sats21m.vogelvault.ui.theme.VaultSpace
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.math.BigInteger
import java.text.Normalizer
import java.util.Locale

internal enum class ActivityTransactionFilter(val label: String) {
    ALL("All"),
    INCOME("Income"),
    LEGACY_INCOME("Legacy income"),
    SPENDS("Spends"),
    LIGHTNING("Lightning"),
    ON_CHAIN("On-chain"),
}

internal const val ACTIVITY_FILTER_GROUP_TEST_TAG = "activity-filter-group"

/**
 * Immutable, normalized search data built once per locally cached ledger.
 *
 * Keeping this separate from Compose prevents every keystroke from normalizing
 * all 911 rows again. Both index construction and filtering are dispatched away
 * from the main thread by [rememberActivitySearchProjection].
 */
internal class ActivitySearchIndex private constructor(
    private val entries: List<Entry>,
) {
    fun search(query: String, filter: ActivityTransactionFilter): List<Transaction> {
        val needle = normalizeSearchValue(query)
        return entries.asSequence()
            .filter { it.matches(filter) }
            .filter { needle.isEmpty() || it.fields.any { field -> needle in field } }
            .map(Entry::transaction)
            .toList()
    }

    private data class Entry(
        val transaction: Transaction,
        val fields: List<String>,
    ) {
        fun matches(filter: ActivityTransactionFilter): Boolean {
            val isIncome = transaction.category.equals("Income", ignoreCase = true)
            return when (filter) {
                ActivityTransactionFilter.ALL -> true
                ActivityTransactionFilter.INCOME -> false
                ActivityTransactionFilter.LEGACY_INCOME -> isIncome
                ActivityTransactionFilter.SPENDS -> !isIncome && transaction.amount != 0L
                ActivityTransactionFilter.LIGHTNING ->
                    transaction.card == "lightning" || transaction.card == PaymentSource.ZEUS_LIGHTNING.wire
                ActivityTransactionFilter.ON_CHAIN ->
                    transaction.card == null ||
                        transaction.card == "on-chain" ||
                        transaction.card == PaymentSource.ZEUS_ON_CHAIN.wire
            }
        }
    }

    companion object {
        fun build(transactions: List<Transaction>): ActivitySearchIndex =
            ActivitySearchIndex(
                transactions.map { transaction ->
                    Entry(
                        transaction = transaction,
                        fields = listOfNotNull(
                            transaction.merchant,
                            transaction.note,
                            canonicalDecimalAmount(transaction.amount),
                            transaction.category,
                            transaction.card,
                        ).map(::normalizeSearchValue),
                    )
                },
            )
    }
}

internal data class ActivitySearchProjection(
    val query: String,
    val filter: ActivityTransactionFilter,
    val transactions: List<Transaction>?,
    val totalCount: Int,
    val onQueryChange: (String) -> Unit,
    val onFilterChange: (ActivityTransactionFilter) -> Unit,
    val incomeEntries: List<IncomeEntry> = emptyList(),
)

private data class SearchResult(
    val index: ActivitySearchIndex,
    val query: String,
    val filter: ActivityTransactionFilter,
    val transactions: List<Transaction>,
)

/**
 * Builds and queries the in-memory index on [Dispatchers.Default].
 *
 * A result is exposed only when it matches the current index, query and filter,
 * so a fast second keystroke can never briefly render a stale record count.
 */
@Composable
internal fun rememberActivitySearchProjection(
    transactions: List<Transaction>,
    profile: FamilyMember,
    incomeEntries: List<IncomeEntry> = emptyList(),
): ActivitySearchProjection {
    var query by rememberSaveable(profile) { mutableStateOf("") }
    var filterName by rememberSaveable(profile) {
        mutableStateOf(ActivityTransactionFilter.ALL.name)
    }
    val filter = ActivityTransactionFilter.valueOf(filterName)

    var index by remember(transactions) {
        mutableStateOf<ActivitySearchIndex?>(null)
    }
    LaunchedEffect(transactions) {
        index = withContext(Dispatchers.Default) {
            ActivitySearchIndex.build(transactions)
        }
    }
    var result by remember(index, query, filter) {
        mutableStateOf<SearchResult?>(null)
    }
    LaunchedEffect(index, query, filter) {
        val currentIndex = index ?: return@LaunchedEffect
        result = withContext(Dispatchers.Default) {
            SearchResult(
                index = currentIndex,
                query = query,
                filter = filter,
                transactions = currentIndex.search(query, filter),
            )
        }
    }
    val currentRows = if (
        filter == ActivityTransactionFilter.ALL &&
        normalizeSearchValue(query).isEmpty()
    ) {
        // The unfiltered list is already the correct cached projection. Render
        // it immediately while its reusable normalized index builds off-main.
        transactions
    } else {
        result
            ?.takeIf { it.index === index && it.query == query && it.filter == filter }
            ?.transactions
    }

    return ActivitySearchProjection(
        query = query,
        filter = filter,
        transactions = currentRows,
        totalCount = transactions.size,
        onQueryChange = { query = it },
        onFilterChange = { filterName = it.name },
        incomeEntries = filterIncomeEntries(incomeEntries, query),
    )
}

@Composable
internal fun ActivitySearchControls(projection: ActivitySearchProjection) {
    Column(verticalArrangement = Arrangement.spacedBy(VaultSpace.sm)) {
        LedgerTextField(
            value = projection.query,
            onValueChange = projection.onQueryChange,
            modifier = Modifier.fillMaxWidth(),
            placeholder = "Search activity",
            prefix = "/",
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .selectableGroup()
                .testTag(ACTIVITY_FILTER_GROUP_TEST_TAG),
            horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ActivityTransactionFilter.entries.forEach { filter ->
                SelectionChip(
                    label = filter.label,
                    semanticLabel = "${filter.label} activity filter",
                    actionLabel = "Filter activity by ${filter.label}",
                    selected = projection.filter == filter,
                    onSelect = { projection.onFilterChange(filter) },
                )
            }
        }
    }
}

/**
 * Swift's Decimal description is ungrouped and omits insignificant zeroes.
 * Android stores the same fiat value as integer cents, so translate units before
 * matching instead of exposing the wire/storage representation to search.
 */
internal fun canonicalDecimalAmount(cents: Long): String {
    val value = BigInteger.valueOf(cents)
    val digits = value.abs().toString().padStart(3, '0')
    val whole = digits.dropLast(2)
    val fraction = digits.takeLast(2).trimEnd('0')
    val unsigned = if (fraction.isEmpty()) whole else "$whole.$fraction"
    return if (value.signum() < 0) "-$unsigned" else unsigned
}

internal fun normalizeSearchValue(value: String): String =
    Normalizer.normalize(value, Normalizer.Form.NFD)
        .replace(COMBINING_MARKS, "")
        .lowercase(Locale.getDefault())
        .trim()

private val COMBINING_MARKS = Regex("\\p{M}+")

internal fun filterIncomeEntries(entries: List<IncomeEntry>, query: String): List<IncomeEntry> {
    val needle = normalizeSearchValue(query)
    return entries.filter { entry ->
        needle.isEmpty() || listOfNotNull(entry.sourceName, entry.note, canonicalDecimalAmount(entry.amountCents))
            .any { needle in normalizeSearchValue(it) }
    }
}
