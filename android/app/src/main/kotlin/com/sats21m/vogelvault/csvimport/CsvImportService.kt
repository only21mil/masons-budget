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
) {
    val isIncome: Boolean
        get() = category.equals("Income", ignoreCase = true)
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
            val amount = parseAmount(columns[amountIndex])
                ?: throw CsvImportException.AmountParseFailure(rowNumber)
            val sats = try {
                convertToSats(amount, source)
            } catch (_: ArithmeticException) {
                throw CsvImportException.AmountParseFailure(rowNumber)
            }
            val memo = mapping.memoIndex
                ?.takeIf { it < columns.size }
                ?.let { sanitize(columns[it]) }
                .orEmpty()
            val merchant = memo.ifEmpty { source.label }
            val cents = btcPriceCents
                ?.takeIf { it > 0L }
                ?.let { Money.satsToUsdCents(sats, it) }

            CsvImportedTransaction(
                id = stableRowId(source, rowNumber, columns),
                date = date,
                merchant = merchant,
                sats = sats,
                amountUsdCents = cents,
                category = guessCategory(merchant),
                source = source,
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

    fun prepareTransactions(
        imported: List<CsvImportedTransaction>,
        owner: FamilyMember,
    ): List<CsvPreparedTransaction> = imported.map { row ->
        val cents = row.amountUsdCents
            ?: throw CsvImportException.PriceUnavailable
        val kind = when {
            row.isIncome -> TransactionKind.CREDIT
            cents < 0L -> TransactionKind.CREDIT
            else -> TransactionKind.SPEND
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
        var date: Int? = null
        var amount: Int? = null
        var memo: Int? = null
        var type: Int? = null
        var fee: Int? = null

        headers.map(String::lowercase).forEachIndexed { index, header ->
            when {
                date == null && ("date" in header || "time" in header) -> date = index
                amount == null && listOf("amount", "qty", "quantity", "sats", "btc")
                    .any(header::contains) -> amount = index
                memo == null && listOf("memo", "note", "description", "merchant", "narrative")
                    .any(header::contains) -> memo = index
                type == null && "type" in header -> type = index
                fee == null && "fee" in header -> fee = index
            }
        }
        return CsvColumnMapping(date, amount, memo, type, fee)
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
    ): String = "$date|$cents|${merchant.lowercase(Locale.US).take(20)}"

    private fun mapStrike(headers: List<String>): CsvColumnMapping =
        sourceMapping(
            headers = headers,
            date = listOf("date"),
            amount = listOf("amount", "btc"),
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
        val lower = headers.map { it.lowercase(Locale.US) }
        fun first(keywords: List<String>): Int? =
            lower.indexOfFirst { header -> keywords.any(header::contains) }
                .takeIf { it >= 0 }
        return CsvColumnMapping(
            dateIndex = first(date),
            amountIndex = first(amount),
            memoIndex = first(memo),
            typeIndex = first(type),
            feeIndex = first(fee),
        )
    }

    private companion object {
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
