package com.sats21m.vogelvault.domain

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Kotlin mirror of shared/domain/test/finance.test.ts. */
class FinanceParityTest {

    private val fixtures: JsonObject = loadFixture()

    private fun loadFixture(): JsonObject {
        var dir: File? = File(System.getProperty("user.dir"))
        while (dir != null) {
            val candidate = File(dir, "shared/domain/fixtures/finance-market-cases.json")
            if (candidate.isFile) return JsonParser.parseString(candidate.readText()).asJsonObject
            dir = dir.parentFile
        }
        error("Could not locate finance-market-cases.json from ${System.getProperty("user.dir")}")
    }

    private fun member(key: String): FamilyMember =
        FamilyMember.fromKeyOrNull(key) ?: error("Unknown family member: $key")

    private fun nullableString(row: JsonObject, key: String): String? =
        row[key]?.takeUnless { it.isJsonNull }?.asString

    private val quotes: List<MarketQuote> by lazy {
        fixtures.getAsJsonObject("marketSnapshot").getAsJsonArray("quotes").map {
            val row = it.asJsonObject
            MarketQuote(
                symbol = MarketSymbol.valueOf(row["symbol"].asString),
                priceCents = row["priceCents"].takeUnless { value -> value.isJsonNull }?.asLong,
                source = row["source"].asString,
                fetchedAt = nullableString(row, "fetchedAt"),
                status = MarketQuoteStatus.valueOf(row["status"].asString.uppercase()),
            )
        }
    }

    private val accounts: List<FinanceAccount> by lazy {
        fixtures.getAsJsonObject("netWorth").getAsJsonArray("accounts").map {
            val row = it.asJsonObject
            FinanceAccount(
                key = row["key"].asString,
                owner = member(row["owner"].asString),
                provider = row["provider"].asString,
                totalValueCents = row["totalValueCents"].asLong,
                weeklyContributionCents = row["weeklyContributionCents"].asLong,
                weeklyContributionDay = nullableString(row, "weeklyContributionDay"),
                holdings = row.getAsJsonArray("holdings").map { holdingElement ->
                    val holding = holdingElement.asJsonObject
                    FinanceHolding(
                        name = holding["name"].asString,
                        category = holding["category"].asString,
                        ticker = nullableString(holding, "ticker"),
                        valueCents = holding["valueCents"].asLong,
                        costBasisCents = 0L,
                        gainBps = 0L,
                        sharesDecimal = holding["sharesDecimal"].asString,
                        avgCostCents = 0L,
                        currentPricePerShareCents = 0L,
                        isProxy = false,
                    )
                },
            )
        }
    }

    @Test
    fun `shared quote snapshot is the closed three-symbol set`() {
        assertEquals(
            listOf(MarketSymbol.BTC, MarketSymbol.VOO, MarketSymbol.IBIT),
            MarketQuoteSnapshot(quotes).quotes.map { it.symbol },
        )
        assertEquals(MarketQuoteStatus.STALE, quotes[2].status)
        assertTrue(quotes[2].isUsable)

        assertFailsWith<IllegalArgumentException> {
            MarketQuoteSnapshot(listOf(quotes[0], quotes[0], quotes[2]))
        }
        assertFailsWith<IllegalArgumentException> {
            quotes[0].copy(status = MarketQuoteStatus.UNAVAILABLE)
        }
        assertFailsWith<IllegalArgumentException> {
            quotes[0].copy(priceCents = 0L)
        }
    }

    @Test
    fun `live and stale quotes require real canonical UTC ISO instants`() {
        for (status in listOf(MarketQuoteStatus.LIVE, MarketQuoteStatus.STALE)) {
            assertEquals(
                "2026-07-30T15:00:00Z",
                quotes[0].copy(status = status, fetchedAt = "2026-07-30T15:00:00Z").fetchedAt,
            )
            assertEquals(
                "2024-02-29T23:59:59.123Z",
                quotes[0].copy(status = status, fetchedAt = "2024-02-29T23:59:59.123Z").fetchedAt,
            )
            assertEquals(
                "2026-07-30T15:00:00.000Z",
                quotes[0].copy(status = status, fetchedAt = "2026-07-30T15:00:00.000Z").fetchedAt,
            )
        }
    }

    @Test
    fun `quote timestamps reject invalid dates and noncanonical normalized forms`() {
        val invalid = listOf(
            "",
            "2026-02-30T15:00:00Z",
            "2026-13-01T15:00:00Z",
            "2026-07-30T24:00:00Z",
            "2026-07-30 15:00:00Z",
            "2026-07-30T15:00:00z",
            "2026-07-30T15:00:00",
            "2026-07-30T10:00:00-05:00",
            "2026-07-30T15:00:00.12Z",
            " 2026-07-30T15:00:00Z ",
        )

        for (fetchedAt in invalid) {
            assertFailsWith<IllegalArgumentException>(fetchedAt) {
                quotes[0].copy(fetchedAt = fetchedAt)
            }
        }
    }

    @Test
    fun `shared exact conversion vectors match half-away rounding`() {
        assertEquals("half away from zero", fixtures["rounding"].asString)
        for (entry in fixtures.getAsJsonArray("usdToSats")) {
            val row = entry.asJsonObject
            assertEquals(
                row["expectedSats"].asLong,
                Money.usdCentsToSats(row["cents"].asLong, row["btcPriceCents"].asLong),
                row["label"].asString,
            )
        }
        assertFailsWith<IllegalArgumentException> { Money.usdCentsToSats(1L, 0L) }
    }

    @Test
    fun `shared fractional-share vectors never use floating point`() {
        for (entry in fixtures.getAsJsonArray("shareValuations")) {
            val row = entry.asJsonObject
            assertEquals(
                row["expectedValueCents"].asLong,
                Money.sharesToValueCents(
                    row["sharesDecimal"].asString,
                    row["pricePerShareCents"].asLong,
                ),
                row["label"].asString,
            )
        }
        assertFailsWith<IllegalArgumentException> { Money.sharesToValueCents("1.2.3", 100L) }
        // Lot-level valuation has to opt in. The sign never enters the
        // magnitude, so the half cent still rounds away from zero.
        assertEquals(-1L, Money.sharesToValueCents("-0.005", 100L, signed = true))
        assertFailsWith<IllegalArgumentException> { Money.sharesToValueCents("-0.005", 100L) }
    }

    @Test
    fun `shares use the bounded canonical decimal fixture contract`() {
        val contract = fixtures.getAsJsonObject("sharesDecimalContract")
        assertEquals(contract["maxLength"].asInt, Money.SHARES_DECIMAL_MAX_LENGTH)
        assertEquals(contract["signedMaxLength"].asInt, Money.SHARES_DECIMAL_SIGNED_MAX_LENGTH)
        assertEquals(contract["maxPrecision"].asInt, Money.SHARES_DECIMAL_MAX_PRECISION)
        assertEquals(contract["maxScale"].asInt, Money.SHARES_DECIMAL_MAX_SCALE)
        assertEquals(contract["maxIntegerDigits"].asInt, Money.SHARES_DECIMAL_MAX_INTEGER_DIGITS)
        // An unsigned quantity is canonical whichever side asks for it, so the
        // signed reader accepts everything the unsigned reader does; only the
        // lot-only column may carry a minus.
        for (entry in contract.getAsJsonArray("valid")) {
            assertEquals(entry.asString, Money.sharesDecimalOrNull(entry.asString))
            assertEquals(entry.asString, Money.sharesDecimalOrNull(entry.asString, signed = true))
        }
        for (entry in contract.getAsJsonArray("lotOnly")) {
            assertEquals(entry.asString, Money.sharesDecimalOrNull(entry.asString, signed = true))
            assertEquals(null, Money.sharesDecimalOrNull(entry.asString), entry.asString)
        }
        for (entry in contract.getAsJsonArray("invalid")) {
            assertEquals(null, Money.sharesDecimalOrNull(entry.asString), entry.asString)
            assertEquals(
                null,
                Money.sharesDecimalOrNull(entry.asString, signed = true),
                entry.asString,
            )
        }
    }

    @Test
    fun `budget health matches iOS status and percentage boundaries`() {
        for (entry in fixtures.getAsJsonArray("budgetHealth")) {
            val row = entry.asJsonObject
            val expected = row.getAsJsonObject("expected")
            val actual = budgetHealth(row["plannedCents"].asLong, row["spentCents"].asLong)
            assertEquals(
                BudgetHealthStatus.valueOf(expected["status"].asString.replace("-", "_").uppercase()),
                actual.status,
                row["label"].asString,
            )
            assertEquals(expected["label"].asString, actual.label, row["label"].asString)
            assertEquals(expected["usedPercent"].asInt, actual.usedPercent, row["label"].asString)
            assertEquals(expected["barBasisPoints"].asInt, actual.barBasisPoints, row["label"].asString)
            assertEquals(
                expected["remainingPercent"].takeUnless { it.isJsonNull }?.asInt,
                actual.remainingPercent,
                row["label"].asString,
            )
            assertEquals(
                expected["overPercent"].takeUnless { it.isJsonNull }?.asInt,
                actual.overPercent,
                row["label"].asString,
            )
        }
    }

    @Test
    fun `category drill-down scopes owner month category and keeps refunds`() {
        val scope = fixtures.getAsJsonObject("categoryScope")
        val transactions = scope.getAsJsonArray("transactions").map {
            val row = it.asJsonObject
            Transaction(
                id = row["id"].asString,
                date = row["date"].asString,
                merchant = row["merchant"].asString,
                amount = row["amountCents"].asLong,
                category = row["category"].asString,
                owner = member(row["owner"].asString),
            )
        }

        for (entry in scope.getAsJsonArray("profiles")) {
            val row = entry.asJsonObject
            val selected = transactions.budgetCategoryTransactionsFor(
                viewer = member(row["viewer"].asString),
                month = scope["month"].asString,
                category = scope["category"].asString,
            )
            assertEquals(
                row.getAsJsonArray("expectedIds").map { it.asString },
                selected.map { it.id },
                row["viewer"].asString,
            )
        }

        val adultRows = transactions.budgetCategoryTransactionsFor(
            FamilyMember.VICTOR,
            scope["month"].asString,
            scope["category"].asString,
        )
        assertTrue(adultRows.any { it.amount < 0L }, "refund remains editable in drill-down")
    }

    @Test
    fun `net worth scopes adult accounts and values every retirement asset once`() {
        val fixture = fixtures.getAsJsonObject("netWorth")
        val expected = fixture.getAsJsonObject("expectedAdult")
        val result = selectNetWorth(
            viewer = FamilyMember.VICTOR,
            bitcoinSats = fixture["bitcoinSats"].asLong,
            financeAccounts = accounts,
            quotes = quotes,
        )

        assertEquals(expected.getAsJsonArray("accountKeys").map { it.asString }, result.accounts.map { it.account.key })
        assertEquals(expected["retirementValueCents"].asLong, result.retirementValueCents)
        assertEquals(expected["bitcoinValueCents"].asLong, result.bitcoinValueCents)
        assertEquals(expected["retirementValueSats"].asLong, result.retirementValueSats)
        assertEquals(expected["totalValueCents"].asLong, result.totalValueCents)
        assertEquals(expected["totalValueSats"].asLong, result.totalValueSats)
        assertNotEquals(fixture["storedRetirementTotalCents"].asLong, result.retirementValueCents)

        val victor = assertNotNull(result.accounts.find { it.account.key == "victor-401k" })
        assertEquals(
            listOf(
                HoldingValuationBasis.MARKET_QUOTE,
                HoldingValuationBasis.MARKET_QUOTE,
                HoldingValuationBasis.STORED_VALUE,
            ),
            victor.holdings.map { it.basis },
        )
    }

    @Test
    fun `account total is fallback-only and missing BTC suppresses combined totals`() {
        val rachel = assertNotNull(accounts.find { it.key == "rachel-401k" })
        assertEquals(rachel.totalValueCents, rachel.marketValue(quotes).valueCents)

        val unavailableBtc = quotes.map {
            if (it.symbol == MarketSymbol.BTC) {
                MarketQuote(MarketSymbol.BTC, null, "Vogel Vault", null, MarketQuoteStatus.UNAVAILABLE)
            } else {
                it
            }
        }
        val fixture = fixtures.getAsJsonObject("netWorth")
        val result = selectNetWorth(
            FamilyMember.VICTOR,
            fixture["bitcoinSats"].asLong,
            accounts,
            unavailableBtc,
        )
        assertEquals(fixture.getAsJsonObject("expectedAdult")["retirementValueCents"].asLong, result.retirementValueCents)
        assertEquals(null, result.bitcoinValueCents)
        assertEquals(null, result.retirementValueSats)
        assertEquals(null, result.totalValueCents)
        assertEquals(null, result.totalValueSats)
        assertEquals(MarketQuoteStatus.UNAVAILABLE, result.btcQuote?.status)
    }

    @Test
    fun `unavailable equity quote remains distinct from an absent observation`() {
        val unavailableIbit = quotes.map {
            if (it.symbol == MarketSymbol.IBIT) {
                MarketQuote(
                    MarketSymbol.IBIT,
                    null,
                    "Vogel Vault",
                    null,
                    MarketQuoteStatus.UNAVAILABLE,
                )
            } else {
                it
            }
        }
        val ibit = accounts[0].holdings[1]
        val valuation = ibit.marketValue(unavailableIbit)

        assertEquals(HoldingValuationBasis.STORED_VALUE, valuation.basis)
        assertEquals(ibit.valueCents, valuation.valueCents)
        assertEquals(MarketQuoteStatus.UNAVAILABLE, valuation.quote?.status)
        assertEquals(MarketQuoteStatus.UNAVAILABLE, unavailableIbit.marketQuoteFor(MarketSymbol.IBIT)?.status)
        assertEquals(null, unavailableIbit.usableQuote(MarketSymbol.IBIT))

        val absent = ibit.marketValue(unavailableIbit.take(2))
        assertEquals(HoldingValuationBasis.STORED_VALUE, absent.basis)
        assertEquals(null, absent.quote)
    }

    @Test
    fun `zero-share VOO and IBIT holdings retain positive stored values`() {
        for ((ticker, shares) in listOf("VOO" to "0", "IBIT" to "0.000")) {
            val holding = accounts[0].holdings[0].copy(
                ticker = ticker,
                sharesDecimal = shares,
                valueCents = 12_345L,
            )
            val valuation = holding.marketValue(quotes)
            assertEquals(holding.valueCents, valuation.valueCents, ticker)
            assertEquals(HoldingValuationBasis.STORED_VALUE, valuation.basis, ticker)
            assertEquals(MarketSymbol.valueOf(ticker), valuation.quote?.symbol, ticker)
        }
    }
}
