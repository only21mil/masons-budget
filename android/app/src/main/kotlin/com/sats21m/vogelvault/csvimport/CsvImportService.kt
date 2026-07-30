package com.sats21m.vogelvault.csvimport

import com.sats21m.vogelvault.data.TransactionInput
import com.sats21m.vogelvault.data.TransactionKind
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.budgetTransactionsFor
import java.math.BigDecimal
import java.math.RoundingMode
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.format.ResolverStyle
import java.util.Locale

internal enum class CsvImportSource(
    val label: String,
    val description: String,
) {
    STRIKE("Strike", "Date, Amount BTC, Type, Memo"),
    CASH_APP("Cash App", "Date, Asset Amount, Notes"),
    COINBASE("Coinbase", "Timestamp, Quantity, Type"),
    KRAKEN("Kraken", "Time, Asset, Amount, Fee"),
    SELF_CUSTODY("Self-Custody Node", "Generic Bitcoin node CSV"),
    CUSTOM("Custom CSV", "Auto-detect date, amount, and memo"),
}

internal data class CsvColumnMapping(
    val dateIndex: Int? = null,
    val amountIndex: Int? = null,
    val memoIndex: Int? = null,
    val typeIndex: Int? = null,
    val feeIndex: Int? = null,
)

/** Which way money moved, as stated by the source rather than inferred from a magnitude. */
internal enum class CsvDirection {
    /** A purchase or send. Stored positive. */
    MONEY_OUT,

    /** A refund, return or receive. Stored negative unless the row is income. */
    MONEY_IN,
}

/** Where a row's direction came from. */
internal enum class CsvDirectionEvidence {
    /** The amount cell carried an explicit `-`, `+` or `(1.23)` marker. */
    AMOUNT_SIGN,

    /** A Type column named the direction and the amount cell was silent. */
    TYPE_COLUMN,

    /** Neither the amount nor a Type column stated a direction; treated as a purchase. */
    DEFAULTED,

    /**
     * An explicit amount sign and a Type column named opposite directions. No
     * direction is resolved: the row is rejected by name instead of guessed at.
     */
    CONTRADICTED,
}

/**
 * The direction a row's raw cells state, resolved without consulting the parsed
 * magnitude. Deriving `kind` from this instead of from the money it produces is
 * what stops the sign check from being a tautology.
 */
internal data class CsvSignContract(
    /**
     * The direction the row states, or null when the amount sign and the Type
     * column state opposite directions. A null direction is never resolved into a
     * winner: signing money on a guess is the corruption this class exists to stop.
     */
    val direction: CsvDirection?,
    val evidence: CsvDirectionEvidence,
    /** The Type cell verbatim, so a rejection can quote what the source said. */
    val typeCell: String = "",
    /** The amount cell verbatim, so a rejection can quote the sign it carried. */
    val amountCell: String = "",
    /** What the amount sign said alone; null when the cell carried no sign. */
    val amountSays: CsvDirection? = null,
    /** What the Type column said alone; null when it was silent or ambiguous. */
    val typeSays: CsvDirection? = null,
) {
    /** What the amount cell said on its own, so a rejection can name that source. */
    fun amountStatement(): String = "its amount \"$amountCell\" says ${movement(amountSays)}"

    /** What the Type column said on its own, so a rejection can name that source. */
    fun typeStatement(): String = "its type \"$typeCell\" says ${movement(typeSays)}"

    /** Human-readable account of what the source said, for a named rejection. */
    fun statement(): String = when (evidence) {
        CsvDirectionEvidence.AMOUNT_SIGN -> "${movement(direction)} by its amount sign"
        CsvDirectionEvidence.TYPE_COLUMN -> "${movement(direction)} by its type \"$typeCell\""
        CsvDirectionEvidence.DEFAULTED -> "${movement(direction)} with no stated direction"
        CsvDirectionEvidence.CONTRADICTED -> "${amountStatement()} while ${typeStatement()}"
    }

    private fun movement(of: CsvDirection?): String = when (of) {
        CsvDirection.MONEY_IN -> "a refund"
        CsvDirection.MONEY_OUT -> "a purchase"
        null -> "nothing"
    }
}

internal data class CsvImportedTransaction(
    val id: String,
    val date: LocalDate,
    val merchant: String,
    /** Signed Bitcoin amount. Purchases are positive; refunds are negative. */
    val sats: Long,
    /** Signed fiat value at the supplied import price, or null when no price is available. */
    val amountUsdCents: Long?,
    val category: String,
    val source: CsvImportSource,
    /** 1-based CSV row this came from, so a rejection can name it. */
    val rowNumber: Int = 0,
    /**
     * The verbatim amount cell. Retained so [CsvImportService.prepareTransactions]
     * can re-derive direction from the source text rather than from [sats].
     */
    val amountCell: String = "",
    /** The verbatim Type cell, empty when the source has no Type column. */
    val typeCell: String = "",
) {
    val isIncome: Boolean
        get() = category.equals("Income", ignoreCase = true)

    /** Direction re-derived from the raw cells; never from [sats] or [amountUsdCents]. */
    val signContract: CsvSignContract
        get() = CsvImportService.resolveSignContract(amountCell, typeCell)
}

internal data class CsvPreparedTransaction(
    val transaction: TransactionInput,
    val sourceFile: String,
)

internal sealed class CsvImportException(message: String) : IllegalArgumentException(message) {
    data object EmptyFile : CsvImportException("CSV file is empty")
    data object MissingRequiredColumns :
        CsvImportException("Required columns (date and amount) were not found")
    data object InvalidUtf8 : CsvImportException("CSV file is not valid UTF-8")
    data object MalformedCsv : CsvImportException("CSV contains an unclosed quoted field")
    data object PriceUnavailable :
        CsvImportException("A positive Bitcoin price is required before importing")

    class DateParseFailure(row: Int) :
        CsvImportException("Could not parse the date on row $row")

    class AmountParseFailure(row: Int) :
        CsvImportException("Could not parse the amount on row $row")

    class AmbiguousAmountColumns(headers: List<String>) :
        CsvImportException(
            "Multiple amount columns matched the same CSV preference: " +
                headers.joinToString { "\"$it\"" } +
                ". Nothing was imported because the app cannot safely choose between financial columns",
        )

    class IncomeSignContradiction(row: Int) :
        CsvImportException(
            "Row $row is income but its amount is negative; income must be positive",
        )

    class SignContradiction(row: Int, stated: String, stored: String) :
        CsvImportException(
            "Row $row states $stated but was stored as $stored; the import was stopped " +
                "instead of writing the wrong sign",
        )

    class SignTypeContradiction(row: Int, amount: String, type: String) :
        CsvImportException(
            "Row $row contradicts itself: $amount but $type. Nothing was imported " +
                "because neither source can be trusted over the other; correct the row " +
                "or drop one of the two columns, then import again",
        )
}

/**
 * Decimal-safe CSV parsing and transaction preparation.
 *
 * CSV amounts remain Bitcoin amounts until [amountUsdCents] is derived from the
 * explicit integer-cent import price. No financial value passes through Double.
 */
internal class CsvImportService {
    fun parse(
        data: ByteArray,
        source: CsvImportSource,
        btcPriceCents: Long?,
    ): List<CsvImportedTransaction> {
        val content = decodeUtf8(data)
        val rows = parseRows(content)
        if (rows.isEmpty()) throw CsvImportException.EmptyFile

        val headers = rows.first().mapIndexed { index, value ->
            if (index == 0) value.removePrefix("\uFEFF") else value
        }
        val mapping = when (source) {
            CsvImportSource.STRIKE -> mapStrike(headers)
            CsvImportSource.CASH_APP -> mapCashApp(headers)
            CsvImportSource.COINBASE -> mapCoinbase(headers)
            CsvImportSource.KRAKEN -> mapKraken(headers)
            CsvImportSource.SELF_CUSTODY, CsvImportSource.CUSTOM ->
                autoDetectColumns(headers)
        }
        val dateIndex = mapping.dateIndex
            ?: throw CsvImportException.MissingRequiredColumns
        val amountIndex = mapping.amountIndex
            ?: throw CsvImportException.MissingRequiredColumns

        return rows.drop(1).mapIndexedNotNull { index, columns ->
            if (dateIndex >= columns.size || amountIndex >= columns.size) {
                return@mapIndexedNotNull null
            }
            val rowNumber = index + 2
            val date = parseDate(columns[dateIndex])
                ?: throw CsvImportException.DateParseFailure(rowNumber)
            val amountCell = columns[amountIndex]
            val amount = parseAmount(amountCell)
                ?: throw CsvImportException.AmountParseFailure(rowNumber)
            val typeCell = mapping.typeIndex
                ?.takeIf { it < columns.size }
                ?.let { columns[it] }
                .orEmpty()
            val memo = mapping.memoIndex
                ?.takeIf { it < columns.size }
                ?.let { sanitize(columns[it]) }
                .orEmpty()
            val merchant = memo.ifEmpty { source.label }
            val category = guessCategory(merchant)
            val isIncome = category.equals("Income", ignoreCase = true)

            val contract = resolveSignContract(amountCell, typeCell)
            // A row whose sign and Type column disagree states two different
            // amounts of money. Picking either one silently mis-signs money the
            // user will never re-check, so the row is rejected by name instead.
            val direction = contract.direction
                ?: throw CsvImportException.SignTypeContradiction(
                    row = rowNumber,
                    amount = contract.amountStatement(),
                    type = contract.typeStatement(),
                )
            if (isIncome &&
                direction == CsvDirection.MONEY_IN &&
                contract.evidence == CsvDirectionEvidence.AMOUNT_SIGN
            ) {
                // Income is stored positive with kind CREDIT. Re-signing an
                // explicitly negative amount would silently rewrite money, so stop.
                throw CsvImportException.IncomeSignContradiction(rowNumber)
            }
            val magnitude = amount.abs()
            val signed = if (storedNegative(direction, isIncome)) {
                magnitude.negate()
            } else {
                magnitude
            }
            val sats = try {
                convertToSats(signed, source)
            } catch (_: ArithmeticException) {
                throw CsvImportException.AmountParseFailure(rowNumber)
            }
            val cents = btcPriceCents
                ?.takeIf { it > 0L }
                ?.let { Money.satsToUsdCents(sats, it) }

            CsvImportedTransaction(
                id = stableRowId(source, rowNumber, columns),
                date = date,
                merchant = merchant,
                sats = sats,
                amountUsdCents = cents,
                category = category,
                source = source,
                rowNumber = rowNumber,
                amountCell = amountCell,
                typeCell = typeCell,
            )
        }
    }

    /**
     * Filter only against the viewer's budget scope.
     *
     * Adults can inspect child rows, but those rows must not suppress a matching
     * adult-household import. Rachel and Victor share the same adult scope.
     */
    fun filterDuplicates(
        imported: List<CsvImportedTransaction>,
        existing: List<Transaction>,
        owner: FamilyMember,
    ): List<CsvImportedTransaction> {
        val scopedExisting = existing.budgetTransactionsFor(owner)
        val existingIds = scopedExisting.mapTo(mutableSetOf(), Transaction::id)
        val existingKeys = scopedExisting
            .mapTo(mutableSetOf()) {
                duplicateKey(it.date, it.amount, it.merchant)
            }
        return imported.filter { row ->
            if (row.id in existingIds) return@filter false
            val cents = row.amountUsdCents ?: return@filter true
            duplicateKey(row.date.toString(), cents, row.merchant) !in existingKeys
        }
    }

    /**
     * Build writes from parsed rows.
     *
     * `kind` comes from the direction stated by the row's raw cells, re-derived
     * here, and the stored sign is then checked against it. The two agree only if
     * both the Type read and the sign application are still correct: checking the
     * sign against a `kind` inferred from that same sign proves nothing.
     *
     * A row whose cells contradict each other has no direction to check against
     * and is refused here as well, so no route to the write client can pick a
     * winner behind the parse-time rejection.
     */
    fun prepareTransactions(
        imported: List<CsvImportedTransaction>,
        owner: FamilyMember,
    ): List<CsvPreparedTransaction> = imported.map { row ->
        val cents = row.amountUsdCents
            ?: throw CsvImportException.PriceUnavailable
        val contract = row.signContract
        val direction = contract.direction
            ?: throw CsvImportException.SignTypeContradiction(
                row = row.rowNumber,
                amount = contract.amountStatement(),
                type = contract.typeStatement(),
            )
        val kind = when {
            row.isIncome -> TransactionKind.CREDIT
            direction == CsvDirection.MONEY_IN -> TransactionKind.CREDIT
            else -> TransactionKind.SPEND
        }
        val expectedNegative = storedNegative(direction, row.isIncome)
        if ((cents < 0L) != expectedNegative || (row.sats < 0L) != expectedNegative) {
            throw CsvImportException.SignContradiction(
                row = row.rowNumber,
                stated = contract.statement(),
                stored = if (cents < 0L) "a refund" else "a purchase",
            )
        }
        CsvPreparedTransaction(
            transaction = TransactionInput(
                id = row.id,
                date = row.date.toString(),
                merchant = row.merchant,
                amountCents = cents,
                category = row.category,
                kind = kind,
                note = "Imported from ${row.source.label}; ${row.sats} sats",
                owner = owner,
            ),
            sourceFile = owner.transactionsDataFileName,
        )
    }

    fun autoDetectColumns(headers: List<String>): CsvColumnMapping {
        return sourceMapping(
            headers = headers,
            date = listOf("date", "timestamp", "time"),
            // Prefer a stated Bitcoin unit over a generic amount. If the first
            // applicable preference still names multiple columns, sourceMapping
            // rejects the file instead of guessing between financial units.
            amount = listOf("sats", "btc", "quantity", "qty", "amount"),
            memo = listOf("memo", "note", "description", "merchant", "narrative"),
            type = listOf("type"),
            fee = listOf("fee"),
        )
    }

    fun guessCategory(memo: String): String {
        val normalized = memo.lowercase(Locale.US)
        val categories = listOf(
            listOf("rent", "mortgage", "landlord") to "Housing",
            listOf("grocery", "costco", "walmart", "trader joe", "whole foods", "safeway", "kroger") to
                "Groceries",
            listOf("pharmacy", "cvs", "walgreens", "medicine", "rx") to "Health",
            listOf("uber", "lyft", "gas", "shell", "chevron", "parking", "transit") to "Transport",
            listOf("restaurant", "doordash", "grubhub", "chipotle", "mcdonald", "starbucks", "coffee") to
                "Dining",
            listOf("netflix", "spotify", "hulu", "disney", "apple tv", "youtube") to "Entertainment",
            listOf("electric", "water", "internet", "comcast", "verizon", "tmobile", "at&t") to "Utilities",
            listOf("amazon", "target", "bestbuy", "apple.com") to "Shopping",
            listOf("salary", "payroll", "direct deposit", "income") to "Income",
            listOf("btc", "bitcoin", "sats", "lightning", "strike") to "Bitcoin",
        )
        return categories.firstOrNull { (keywords, _) ->
            keywords.any(normalized::contains)
        }?.second ?: "Other"
    }

    private fun decodeUtf8(data: ByteArray): String {
        if (data.isEmpty()) throw CsvImportException.EmptyFile
        return try {
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(data))
                .toString()
        } catch (_: CharacterCodingException) {
            throw CsvImportException.InvalidUtf8
        }
    }

    private fun parseRows(content: String): List<List<String>> {
        if (content.isBlank()) throw CsvImportException.EmptyFile
        val rows = mutableListOf<List<String>>()
        val fields = mutableListOf<String>()
        val current = StringBuilder()
        var quoted = false
        var index = 0

        fun finishField() {
            fields += current.toString().trim()
            current.clear()
        }

        fun finishRow() {
            finishField()
            if (fields.any(String::isNotBlank)) rows += fields.toList()
            fields.clear()
        }

        while (index < content.length) {
            val char = content[index]
            when {
                char == '"' && quoted && content.getOrNull(index + 1) == '"' -> {
                    current.append('"')
                    index++
                }
                char == '"' -> quoted = !quoted
                char == ',' && !quoted -> finishField()
                (char == '\n' || char == '\r') && !quoted -> {
                    finishRow()
                    if (char == '\r' && content.getOrNull(index + 1) == '\n') index++
                }
                else -> current.append(char)
            }
            index++
        }
        if (quoted) throw CsvImportException.MalformedCsv
        if (current.isNotEmpty() || fields.isNotEmpty()) finishRow()
        return rows
    }

    private fun parseAmount(raw: String): BigDecimal? {
        val trimmed = raw.trim()
        val negativeParentheses = trimmed.startsWith("(") && trimmed.endsWith(")")
        val normalized = trimmed
            .removePrefix("(")
            .removeSuffix(")")
            .replace(",", "")
            .replace("$", "")
            .replace(" ", "")
        return normalized.toBigDecimalOrNull()
            ?.let { if (negativeParentheses) it.negate() else it }
    }

    private fun convertToSats(
        amount: BigDecimal,
        source: CsvImportSource,
    ): Long = when (source) {
        CsvImportSource.STRIKE,
        CsvImportSource.CASH_APP,
        CsvImportSource.COINBASE,
        -> amount.movePointRight(8).setScale(0, RoundingMode.HALF_UP).longValueExact()

        CsvImportSource.KRAKEN,
        CsvImportSource.SELF_CUSTODY,
        CsvImportSource.CUSTOM,
        -> if (amount.abs() < BigDecimal.ONE) {
            amount.movePointRight(8).setScale(0, RoundingMode.HALF_UP).longValueExact()
        } else {
            amount.setScale(0, RoundingMode.HALF_UP).longValueExact()
        }
    }

    private fun parseDate(raw: String): LocalDate? {
        val value = raw.trim()
        runCatching { return OffsetDateTime.parse(value, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toLocalDate() }
        runCatching { return LocalDateTime.parse(value, DateTimeFormatter.ISO_LOCAL_DATE_TIME).toLocalDate() }
        for (formatter in DATE_FORMATTERS) {
            try {
                return if (formatter in DATE_TIME_FORMATTERS) {
                    LocalDateTime.parse(value, formatter).toLocalDate()
                } else {
                    LocalDate.parse(value, formatter)
                }
            } catch (_: DateTimeParseException) {
                // Try the next explicit format.
            }
        }
        return null
    }

    private fun sanitize(input: String): String =
        input.replace("<", "")
            .replace(">", "")
            .replace("&", "and")
            .take(200)
            .trim()

    private fun stableRowId(
        source: CsvImportSource,
        rowNumber: Int,
        columns: List<String>,
    ): String {
        val canonical = buildString {
            append(source.name)
            append('\u001F')
            append(rowNumber)
            columns.forEach {
                append('\u001F')
                append(it.trim())
            }
        }
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(canonical.toByteArray(StandardCharsets.UTF_8))
            .take(12)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        return "csv-$digest"
    }

    private fun duplicateKey(
        date: String,
        cents: Long,
        merchant: String,
    ): String = "$date|$cents|${merchant.trim().lowercase(Locale.US)}"

    private fun mapStrike(headers: List<String>): CsvColumnMapping =
        sourceMapping(
            headers = headers,
            date = listOf("date"),
            amount = listOf("amount btc", "btc amount", "amount", "btc"),
            memo = listOf("memo", "description"),
            type = listOf("type"),
        )

    private fun mapCashApp(headers: List<String>): CsvColumnMapping =
        sourceMapping(
            headers = headers,
            date = listOf("date"),
            amount = listOf("asset amount", "amount"),
            memo = listOf("notes", "note"),
            fee = listOf("fee"),
        )

    private fun mapCoinbase(headers: List<String>): CsvColumnMapping =
        sourceMapping(
            headers = headers,
            date = listOf("timestamp", "date"),
            amount = listOf("quantity", "amount"),
            memo = listOf("notes", "type"),
            type = listOf("transaction type", "type"),
            fee = listOf("fee"),
        )

    private fun mapKraken(headers: List<String>): CsvColumnMapping =
        sourceMapping(
            headers = headers,
            date = listOf("time", "date"),
            amount = listOf("amount", "vol"),
            memo = listOf("type"),
            type = listOf("type"),
            fee = listOf("fee"),
        )

    private fun sourceMapping(
        headers: List<String>,
        date: List<String>,
        amount: List<String>,
        memo: List<String> = emptyList(),
        type: List<String> = emptyList(),
        fee: List<String> = emptyList(),
    ): CsvColumnMapping {
        val headerTokens = headers.map(::csvHeaderTokens)
        fun first(
            keywords: List<String>,
            rejectAmbiguousAmount: Boolean = false,
        ): Int? {
            // This loop order is the schema contract: a vendor's first requested
            // alias outranks every later alias regardless of file header order.
            // Multiple headers matching that same winning amount alias have no
            // declared tie-break, so refuse them instead of selecting by position.
            keywords.forEach { keyword ->
                val wanted = csvHeaderTokens(keyword)
                val matches = headerTokens.indices.filter { index ->
                    val candidate = headerTokens[index]
                    val feeOnly =
                        rejectAmbiguousAmount &&
                            candidate.any { it == "fee" || it == "fees" } &&
                            "fee" !in wanted
                    !feeOnly && wanted.isNotEmpty() && wanted.all(candidate::contains)
                }
                if (rejectAmbiguousAmount && matches.size > 1) {
                    throw CsvImportException.AmbiguousAmountColumns(
                        matches.map(headers::get),
                    )
                }
                matches.firstOrNull()?.let { return it }
            }
            return null
        }
        return CsvColumnMapping(
            dateIndex = first(date),
            amountIndex = first(amount, rejectAmbiguousAmount = true),
            memoIndex = first(memo),
            typeIndex = first(type),
            feeIndex = first(fee),
        )
    }

    private fun csvHeaderTokens(value: String): Set<String> =
        value
            .lowercase(Locale.US)
            .split(Regex("[^a-z0-9]+"))
            .filterTo(linkedSetOf(), String::isNotEmpty)

    internal companion object {
        /**
         * Resolve the direction stated by a row's raw cells.
         *
         * There is no precedence rule, because neither source deserves one. A
         * signed amount is unambiguous machine output but its convention belongs to
         * the exporting bank, and most banks write purchases negative where this
         * app stores them positive; a Type token is stated in the app's own terms
         * but has to survive a keyword classifier. Ranking one above the other just
         * chooses which population of files gets silently mis-signed. So when both
         * speak and disagree, no direction is returned and the caller rejects the
         * row by name. When only one speaks it is believed, which is what keeps
         * unsigned amounts taking their direction from the Type column.
         */
        fun resolveSignContract(
            amountCell: String,
            typeCell: String,
        ): CsvSignContract {
            val fromAmount = amountSignDirection(amountCell)
            val fromType = typeDirection(typeCell)
            val cells = CsvSignContract(
                direction = null,
                evidence = CsvDirectionEvidence.CONTRADICTED,
                typeCell = typeCell.trim(),
                amountCell = amountCell.trim(),
                amountSays = fromAmount,
                typeSays = fromType,
            )
            return when {
                fromAmount != null && fromType != null && fromAmount != fromType -> cells

                fromAmount != null -> cells.copy(
                    direction = fromAmount,
                    evidence = CsvDirectionEvidence.AMOUNT_SIGN,
                )

                fromType != null -> cells.copy(
                    direction = fromType,
                    evidence = CsvDirectionEvidence.TYPE_COLUMN,
                )

                else -> cells.copy(
                    direction = CsvDirection.MONEY_OUT,
                    evidence = CsvDirectionEvidence.DEFAULTED,
                )
            }
        }

        /**
         * The direction the amount cell states on its own, or null when it is
         * silent. An unsigned amount is silent: that silence, read as "positive",
         * is what turned typed refunds into purchases.
         */
        private fun amountSignDirection(amountCell: String): CsvDirection? {
            val trimmed = amountCell.trim()
                .replace("$", "")
                .replace(" ", "")
            val negative = trimmed.startsWith("-") ||
                (trimmed.startsWith("(") && trimmed.endsWith(")"))
            return when {
                negative -> CsvDirection.MONEY_IN
                trimmed.startsWith("+") -> CsvDirection.MONEY_OUT
                else -> null
            }
        }

        /**
         * Classify a Type cell by whole words. A cell naming both directions (for
         * example "Credit Card Purchase") is treated as silent rather than guessed
         * at, which leaves such rows exactly where they were before this change.
         */
        private fun typeDirection(typeCell: String): CsvDirection? {
            val words = typeCell.lowercase(Locale.US)
                .split(Regex("[^a-z]+"))
                .filter(String::isNotEmpty)
                .toSet()
            if (words.isEmpty()) return null
            val out = words.any(MONEY_OUT_WORDS::contains)
            val incoming = words.any(MONEY_IN_WORDS::contains)
            return when {
                out && !incoming -> CsvDirection.MONEY_OUT
                incoming && !out -> CsvDirection.MONEY_IN
                else -> null
            }
        }

        /** Income is stored positive with kind CREDIT; refunds are the only negatives. */
        private fun storedNegative(
            direction: CsvDirection,
            isIncome: Boolean,
        ): Boolean = direction == CsvDirection.MONEY_IN && !isIncome

        private val MONEY_OUT_WORDS = setOf(
            "debit", "debits", "purchase", "purchases", "purchased",
            "buy", "buys", "bought", "payment", "payments",
            "withdraw", "withdrawal", "withdrawals", "sent", "send",
            "spend", "charge", "charges", "fee", "fees",
        )

        private val MONEY_IN_WORDS = setOf(
            "credit", "credits", "refund", "refunds", "refunded",
            "return", "returns", "returned", "reversal", "reversed",
            "deposit", "deposits", "receive", "received", "rebate",
            "sell", "sells", "sold", "cashback", "payout",
        )

        val DATE_TIME_FORMATTERS = setOf(
            DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss").withResolverStyle(ResolverStyle.STRICT),
            DateTimeFormatter.ofPattern("MM/dd/uuuu HH:mm:ss").withResolverStyle(ResolverStyle.STRICT),
        )
        val DATE_FORMATTERS = listOf(
            DateTimeFormatter.ISO_LOCAL_DATE,
            *DATE_TIME_FORMATTERS.toTypedArray(),
            DateTimeFormatter.ofPattern("MM/dd/uuuu").withResolverStyle(ResolverStyle.STRICT),
            DateTimeFormatter.ofPattern("M/d/uuuu").withResolverStyle(ResolverStyle.STRICT),
            DateTimeFormatter.ofPattern("dd/MM/uuuu").withResolverStyle(ResolverStyle.STRICT),
        )
    }
}
