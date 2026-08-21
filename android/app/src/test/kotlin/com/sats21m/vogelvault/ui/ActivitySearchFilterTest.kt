package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Transaction
import org.junit.Test
import kotlin.system.measureNanoTime
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ActivitySearchFilterTest {

    private val cafe = Transaction(
        id = "cafe",
        date = "2026-07-29",
        merchant = "Café São Paulo",
        amount = -4_275L,
        category = "Dining",
        card = "lightning",
        note = "Family dinner",
        owner = FamilyMember.VICTOR,
    )

    @Test
    fun `matches Apple fields with case and diacritic folding`() {
        val index = ActivitySearchIndex.build(listOf(cafe))

        listOf(
            "cafe sao",
            "FAMILY",
            "42.75",
            "dining",
            "LIGHTNING",
        ).forEach { query ->
            assertEquals(listOf(cafe), index.search(query, ActivityTransactionFilter.ALL), query)
        }
        assertTrue(index.search("groceries", ActivityTransactionFilter.ALL).isEmpty())
        assertEquals(listOf(cafe), index.search("  ", ActivityTransactionFilter.ALL))
    }

    @Test
    fun `fiat amount search translates integer cents to Decimal description`() {
        assertEquals("42.75", canonicalDecimalAmount(4_275L))
        assertEquals("-42.75", canonicalDecimalAmount(-4_275L))
        assertEquals("42", canonicalDecimalAmount(4_200L))
        assertEquals("0.05", canonicalDecimalAmount(5L))
        assertEquals("-92233720368547758.08", canonicalDecimalAmount(Long.MIN_VALUE))
    }

    @Test
    fun `filters use Apple income spend and payment rail semantics`() {
        val income = transaction("income", amount = 500_000L, category = "income", card = null)
        val spend = transaction("spend", amount = 2_500L, category = "Shopping", card = "visa")
        val lightning = transaction("lightning", amount = 900L, category = "Dining", card = "lightning")
        val onChain = transaction("on-chain", amount = 1_100L, category = "Other", card = "on-chain")
        val legacyOnChain = transaction("legacy", amount = 1_200L, category = "Other", card = null)
        val zero = transaction("zero", amount = 0L, category = "Other", card = null)
        val index = ActivitySearchIndex.build(
            listOf(income, spend, lightning, onChain, legacyOnChain, zero),
        )

        assertEquals(listOf(income), index.search("", ActivityTransactionFilter.INCOME))
        assertEquals(
            listOf(spend, lightning, onChain, legacyOnChain),
            index.search("", ActivityTransactionFilter.SPENDS),
        )
        assertEquals(listOf(lightning), index.search("", ActivityTransactionFilter.LIGHTNING))
        assertEquals(
            listOf(income, onChain, legacyOnChain, zero),
            index.search("", ActivityTransactionFilter.ON_CHAIN),
        )
    }

    @Test
    fun `canonical card labels stay out of bitcoin rail filters while on-chain label remains filterable`() {
        val cardRows = listOf(
            transaction("coinbase", amount = 100L, category = "Shopping", card = "Coinbase Card"),
            transaction("aven", amount = 200L, category = "Shopping", card = "Aven"),
            transaction("sofi", amount = 300L, category = "Shopping", card = "SoFi Card"),
            transaction("capital-one", amount = 400L, category = "Shopping", card = "Capital One VX"),
        )
        val lightning = transaction("lightning-canonical", amount = 500L, category = "Other", card = "lightning")
        val onChain = transaction("on-chain-canonical", amount = 600L, category = "Other", card = "on-chain")
        val selectorWire = transaction("on-chain-wire", amount = 700L, category = "Other", card = "on_chain")
        val index = ActivitySearchIndex.build(cardRows + lightning + onChain + selectorWire)

        assertEquals(listOf(lightning), index.search("", ActivityTransactionFilter.LIGHTNING))
        assertEquals(listOf(onChain), index.search("", ActivityTransactionFilter.ON_CHAIN))
        assertTrue(
            index.search("", ActivityTransactionFilter.LIGHTNING)
                .none { it.card in cardRows.map(Transaction::card) },
        )
        assertTrue(
            index.search("", ActivityTransactionFilter.ON_CHAIN)
                .none { it.card in cardRows.map(Transaction::card) },
        )
    }

    @Test
    fun `production sized cached ledger indexes and filters within bounded time`() {
        val transactions = List(911) { index ->
            transaction(
                id = "transaction-$index",
                amount = 100L + index,
                category = if (index % 11 == 0) "Income" else "Shopping",
                card = if (index % 2 == 0) "lightning" else "on-chain",
                merchant = if (index == 732) "Café Needle" else "Merchant $index",
                note = "Cached row $index",
            )
        }

        lateinit var index: ActivitySearchIndex
        val buildMillis = measureNanoTime {
            index = ActivitySearchIndex.build(transactions)
        } / 1_000_000.0
        val queryMillis = measureNanoTime {
            assertEquals(
                listOf(transactions[732]),
                index.search("cafe needle", ActivityTransactionFilter.LIGHTNING),
            )
        } / 1_000_000.0

        println(
            "ACTIVITY_SEARCH_INDEX_MS=%.3f QUERY_MS=%.3f ROWS=%d".format(
                buildMillis,
                queryMillis,
                transactions.size,
            ),
        )
        assertTrue(buildMillis < 150.0, "Indexing 911 cached rows took $buildMillis ms")
        assertTrue(queryMillis < 25.0, "Filtering 911 cached rows took $queryMillis ms")
    }

    private fun transaction(
        id: String,
        amount: Long,
        category: String,
        card: String?,
        merchant: String = id,
        note: String? = null,
    ) = Transaction(
        id = id,
        date = "2026-07-29",
        merchant = merchant,
        amount = amount,
        category = category,
        card = card,
        note = note,
        owner = FamilyMember.VICTOR,
    )
}
