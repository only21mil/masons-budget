package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.FiatValuation
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.legacyFiatValuation
import java.time.LocalDate
import java.time.format.DateTimeParseException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A complete or explicitly bounded public row response. */
data class RowSnapshot<out T>(
    val rows: List<T>,
    val complete: Boolean,
)

/** A Bitcoin bill-payment row. Android has no domain/UI consumer yet. */
data class BtcBillPayRow(
    val id: String,
    val owner: FamilyMember,
    val date: String,
    val month: String,
    val merchant: String,
    val category: String,
    val amountUsdCents: Long,
    val btcSpentSats: Long,
    val btcPriceCents: Long,
    val platform: String?,
    val note: String?,
    val feeUsdCents: Long,
    val reference: String?,
    val updatedAtMs: Long,
)

data class IncomeRow(
    val id: String,
    val owner: FamilyMember,
    val date: String,
    val month: String,
    val amountCents: Long,
    val source: String,
    val loggedBy: String?,
    val note: String?,
    val archimedesRequestId: String?,
    val updatedAtMs: Long,
)

data class BtcBalanceAccountRow(
    val key: String,
    val label: String,
    val custody: Custody,
    val sats: Long,
    val fiatCents: Long,
    val fiatValuation: FiatValuation? = legacyFiatValuation(sats, fiatCents),
)

data class BtcBalanceTotalsRow(
    val sats: Long,
    val fiatCents: Long,
    val exchangeSats: Long,
    val selfCustodySats: Long,
    val fiatValuation: FiatValuation? = legacyFiatValuation(sats, fiatCents),
)

data class BtcBalanceDocumentRow(
    val owner: FamilyMember,
    val schemaVersion: Long,
    val asOf: String,
    val accounts: List<BtcBalanceAccountRow>,
    val totals: BtcBalanceTotalsRow,
    val source: String?,
    val basis: String?,
    /** Confidence in the sats balance only. */
    val confidence: String?,
    val updatedAtMs: Long,
    val balanceConfidence: String? = confidence,
)

data class BudgetCategoryRow(
    val name: String,
    val icon: String?,
    val budgetCents: Long,
)

data class BudgetPaycheckRow(
    val date: String,
    val platform: String?,
    val source: String?,
    val amountCents: Long,
    val netCents: Long,
    val note: String?,
)

data class BudgetIncomeRow(
    val weeklyGrossCents: Long,
    val weeklyStrikeCents: Long,
    val weeklyRiverCents: Long,
    val payFrequency: String?,
    val monthlyGrossCents: Long,
    val mtdIncomeCents: Long,
    val ytdIncomeCents: Long,
    val paychecks: List<BudgetPaycheckRow>,
)

data class BudgetMonthlyHistoryRow(
    val month: String,
    val incomeCents: Long,
    val expensesCents: Long,
    val savingsBps: Long,
)

data class BudgetDocumentRow(
    val owner: FamilyMember,
    val month: String,
    val coinbaseOneBalanceCents: Long,
    val categories: List<BudgetCategoryRow>,
    val effectiveApr: String?,
    val strategyNote: String?,
    val income: BudgetIncomeRow?,
    val mtdIncomeCents: Long,
    val ytdIncomeCents: Long,
    val monthlyHistory: List<BudgetMonthlyHistoryRow>,
    val updatedAtMs: Long,
)

data class BudgetDocumentSnapshot(
    val document: BudgetDocumentRow?,
    val complete: Boolean,
)

data class BtcSnapshotMetadataRow(
    val owner: FamilyMember,
    val schemaVersion: Long,
    val asOf: String,
    val source: String?,
    val basis: String?,
    /** Transition-only alias from the legacy public field. */
    val confidence: String?,
    val updatedAtMs: Long,
    val balanceConfidence: String? = confidence,
)

/** Internal wire envelope. No Convex document shape crosses this boundary. */
internal data class PublicRowEnvelope<Dto>(
    val rows: List<Dto>,
    val complete: Boolean,
)

/**
 * Reject the entire response if one financial row is malformed.
 *
 * Only required contract fields are read. Unknown envelope and row fields are
 * deliberately ignored so additive backend changes remain forward-compatible.
 */
internal fun <T> JsonElement.decodeRowEnvelope(decoder: (JsonElement) -> T?): PublicRowEnvelope<T>? {
    val envelope = this as? JsonObject ?: return null
    val complete = envelope.requiredBoolean("complete") ?: return null
    val encodedRows = envelope["rows"] as? JsonArray ?: return null
    val rows = ArrayList<T>(encodedRows.size)
    for (encodedRow in encodedRows) {
        rows += decoder(encodedRow) ?: return null
    }
    return PublicRowEnvelope(rows, complete)
}

internal data class PublicTransactionDto(
    val txId: String,
    val owner: FamilyMember,
    val date: String,
    val month: String,
    val merchant: String,
    val amountCents: Long,
    val spendAmount: Long,
    val displaySpendAmount: Long,
    val hasOppositeSpendSign: Boolean,
    val category: String,
    val card: String?,
    val note: String?,
    val updatedAtMs: Long,
) {
    fun toDomain(): Transaction = Transaction(
        id = txId,
        date = date,
        merchant = merchant,
        amount = amountCents,
        category = category,
        card = card,
        note = note,
        owner = owner,
        spendAmount = spendAmount,
        displaySpendAmount = displaySpendAmount,
    )

    companion object {
        fun decode(element: JsonElement): PublicTransactionDto? {
            val row = element as? JsonObject ?: return null
            val card = row.decodedOptionalString("card") ?: return null
            val note = row.decodedOptionalString("note") ?: return null
            val amountCents = row.rowInt64("amountCents") ?: return null
            // abs(Long.MIN_VALUE) overflows back to Long.MIN_VALUE, so this
            // canonical amount cannot produce a nonnegative display magnitude.
            if (amountCents == Long.MIN_VALUE) return null
            val category = row.rowStringAllowEmpty("category") ?: return null
            // These projection fields remain required and strictly typed for
            // wire-contract completeness, but amountCents is the sole source
            // of truth. A stale server projection must not reject the ledger.
            row.rowInt64("spendAmount") ?: return null
            row.rowInt64("displaySpendAmount") ?: return null
            row.requiredBoolean("hasOppositeSpendSign") ?: return null
            val spendAmount = if (category == "Income") 0L else amountCents
            val date = row.rowString("date") ?: return null
            val month = row.rowString("month") ?: return null
            if (!isCanonicalTransactionDate(date, month)) return null
            return PublicTransactionDto(
                txId = row.rowString("txId") ?: return null,
                owner = row.rowOwner() ?: return null,
                date = date,
                month = month,
                merchant = row.rowStringAllowEmpty("merchant") ?: return null,
                amountCents = amountCents,
                spendAmount = spendAmount,
                displaySpendAmount = kotlin.math.abs(spendAmount),
                hasOppositeSpendSign = spendAmount < 0L,
                category = category,
                card = card.value,
                note = note.value,
                updatedAtMs = row.requiredLong("updatedAtMs") ?: return null,
            )
        }
    }
}

private val canonicalTransactionDatePattern =
    Regex("""^(?!0000)(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$""")
private val canonicalTransactionMonthPattern =
    Regex("""^(?!0000)\d{4}-(0[1-9]|1[0-2])$""")

private fun isCanonicalTransactionDate(date: String, month: String): Boolean {
    if (!canonicalTransactionDatePattern.matches(date) ||
        !canonicalTransactionMonthPattern.matches(month) ||
        date.take(7) != month
    ) {
        return false
    }
    return try {
        LocalDate.parse(date)
        true
    } catch (_: DateTimeParseException) {
        false
    }
}

internal data class PublicTodoDto(
    val todoId: String,
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
    val createdAt: String?,
    val updatedAt: String?,
    val completedAt: String?,
    val updatedAtMs: Long,
) {
    fun toDomain(): TodoItem = TodoItem(
        id = todoId,
        title = title,
        done = done,
        project = project,
        area = area,
        due = due,
        flagged = flagged,
        owner = owner,
    )

    companion object {
        fun decode(element: JsonElement): PublicTodoDto? {
            val row = element as? JsonObject ?: return null
            val lane = row.decodedOptionalString("lane") ?: return null
            val project = row.decodedOptionalString("project") ?: return null
            val area = row.decodedOptionalString("area") ?: return null
            val due = row.decodedOptionalString("due") ?: return null
            val notes = row.decodedOptionalString("notes") ?: return null
            val priority = row.decodedOptionalInt64("priority") ?: return null
            val createdAt = row.decodedOptionalString("createdAt") ?: return null
            val updatedAt = row.decodedOptionalString("updatedAt") ?: return null
            val completedAt = row.decodedOptionalString("completedAt") ?: return null
            return PublicTodoDto(
                todoId = row.rowString("todoId") ?: return null,
                owner = row.rowOwner() ?: return null,
                title = row.rowStringAllowEmpty("title") ?: return null,
                done = row.requiredBoolean("done") ?: return null,
                flagged = row.requiredBoolean("flagged") ?: return null,
                lane = lane.value,
                project = project.value,
                area = area.value,
                due = due.value,
                notes = notes.value,
                priority = priority.value,
                createdAt = createdAt.value,
                updatedAt = updatedAt.value,
                completedAt = completedAt.value,
                updatedAtMs = row.requiredLong("updatedAtMs") ?: return null,
            )
        }
    }
}

internal data class PublicBtcBuyDto(
    val buyId: String,
    val owner: FamilyMember,
    val date: String,
    val month: String,
    val source: String,
    val sats: Long,
    val priceUsdCents: Long,
    val usdCents: Long,
    val note: String?,
    val status: String?,
    val costBasisStatus: String?,
    val loggedBy: String?,
    val archimedesRequestId: String?,
    val updatedAtMs: Long,
) {
    fun toDomain(): BtcBuy = BtcBuy(
        id = buyId,
        date = date,
        source = source,
        sats = sats,
        priceUsdCents = priceUsdCents,
        usdCents = usdCents,
        costBasisStatus = costBasisStatus,
        owner = owner,
    )

    companion object {
        fun decode(element: JsonElement): PublicBtcBuyDto? {
            val row = element as? JsonObject ?: return null
            val note = row.decodedOptionalString("note") ?: return null
            val status = row.decodedOptionalString("status") ?: return null
            val costBasisStatus = row.decodedOptionalString("costBasisStatus") ?: return null
            val loggedBy = row.decodedOptionalString("loggedBy") ?: return null
            val requestId = row.decodedOptionalString("archimedesRequestId") ?: return null
            return PublicBtcBuyDto(
                buyId = row.rowString("buyId") ?: return null,
                owner = row.rowOwner() ?: return null,
                date = row.rowString("date") ?: return null,
                month = row.rowString("month") ?: return null,
                source = row.rowStringAllowEmpty("source") ?: return null,
                sats = row.rowInt64("sats") ?: return null,
                priceUsdCents = row.rowInt64("priceUsdCents") ?: return null,
                usdCents = row.rowInt64("usdCents") ?: return null,
                note = note.value,
                status = status.value,
                costBasisStatus = costBasisStatus.value,
                loggedBy = loggedBy.value,
                archimedesRequestId = requestId.value,
                updatedAtMs = row.requiredLong("updatedAtMs") ?: return null,
            )
        }
    }
}

internal data class PublicBtcAccountDto(
    val key: String,
    val owner: FamilyMember,
    val label: String,
    val custody: Custody,
    val sats: Long,
    val fiatCents: Long,
    val asOf: String,
    val schemaVersion: Long,
    val updatedAtMs: Long,
    val fiatValuation: FiatValuation?,
) {
    fun toDomain(): BtcAccount = BtcAccount(
        key = key,
        label = label,
        custody = custody,
        sats = sats,
        fiatCents = fiatCents,
        owner = owner,
        fiatValuation = fiatValuation,
    )

    companion object {
        fun decode(element: JsonElement): PublicBtcAccountDto? {
            val row = element as? JsonObject ?: return null
            val custodyKey = row.rowString("custody") ?: return null
            val sats = row.rowInt64("sats") ?: return null
            val legacyFiat = row.decodedOptionalInt64("fiatCents") ?: return null
            val fiatCents = legacyFiat.value ?: 0L
            val fiatValuation = row.decodedFiatValuation(sats, fiatCents) ?: return null
            return PublicBtcAccountDto(
                key = row.rowString("key") ?: return null,
                owner = row.rowOwner() ?: return null,
                label = row.rowStringAllowEmpty("label") ?: return null,
                custody = Custody.entries.firstOrNull { it.key == custodyKey } ?: return null,
                sats = sats,
                fiatCents = fiatCents,
                asOf = row.rowStringAllowEmpty("asOf") ?: return null,
                schemaVersion = row.rowInt64("schemaVersion") ?: return null,
                updatedAtMs = row.requiredLong("updatedAtMs") ?: return null,
                fiatValuation = fiatValuation.value,
            )
        }
    }
}

internal data class PublicBtcBillPayDto(
    val billPayId: String,
    val owner: FamilyMember,
    val date: String,
    val month: String,
    val merchant: String,
    val category: String,
    val amountUsdCents: Long,
    val btcSpentSats: Long,
    val btcPriceCents: Long,
    val platform: String?,
    val note: String?,
    val feeUsdCents: Long,
    val reference: String?,
    val updatedAtMs: Long,
) {
    fun toRow(): BtcBillPayRow = BtcBillPayRow(
        id = billPayId,
        owner = owner,
        date = date,
        month = month,
        merchant = merchant,
        category = category,
        amountUsdCents = amountUsdCents,
        btcSpentSats = btcSpentSats,
        btcPriceCents = btcPriceCents,
        platform = platform,
        note = note,
        feeUsdCents = feeUsdCents,
        reference = reference,
        updatedAtMs = updatedAtMs,
    )

    companion object {
        fun decode(element: JsonElement): PublicBtcBillPayDto? {
            val row = element as? JsonObject ?: return null
            val platform = row.decodedOptionalString("platform") ?: return null
            val note = row.decodedOptionalString("note") ?: return null
            val reference = row.decodedOptionalString("reference") ?: return null
            return PublicBtcBillPayDto(
                billPayId = row.rowString("billPayId") ?: return null,
                owner = row.rowOwner() ?: return null,
                date = row.rowString("date") ?: return null,
                month = row.rowString("month") ?: return null,
                merchant = row.rowStringAllowEmpty("merchant") ?: return null,
                category = row.rowStringAllowEmpty("category") ?: return null,
                amountUsdCents = row.rowInt64("amountUsdCents") ?: return null,
                btcSpentSats = row.rowInt64("btcSpentSats") ?: return null,
                btcPriceCents = row.rowInt64("btcPriceCents") ?: return null,
                platform = platform.value,
                note = note.value,
                feeUsdCents = row.rowInt64("feeUsdCents") ?: return null,
                reference = reference.value,
                updatedAtMs = row.requiredLong("updatedAtMs") ?: return null,
            )
        }
    }
}

internal data class PublicIncomeDto(
    val incomeId: String,
    val owner: FamilyMember,
    val date: String,
    val month: String,
    val amountCents: Long,
    val source: String,
    val loggedBy: String?,
    val note: String?,
    val archimedesRequestId: String?,
    val updatedAtMs: Long,
) {
    fun toRow(): IncomeRow = IncomeRow(
        id = incomeId,
        owner = owner,
        date = date,
        month = month,
        amountCents = amountCents,
        source = source,
        loggedBy = loggedBy,
        note = note,
        archimedesRequestId = archimedesRequestId,
        updatedAtMs = updatedAtMs,
    )

    companion object {
        fun decode(element: JsonElement): PublicIncomeDto? {
            val row = element as? JsonObject ?: return null
            val loggedBy = row.decodedOptionalString("loggedBy") ?: return null
            val note = row.decodedOptionalString("note") ?: return null
            val requestId = row.decodedOptionalString("archimedesRequestId") ?: return null
            return PublicIncomeDto(
                incomeId = row.rowString("incomeId") ?: return null,
                owner = row.rowOwner() ?: return null,
                date = row.rowString("date") ?: return null,
                month = row.rowString("month") ?: return null,
                amountCents = row.rowInt64("amountCents") ?: return null,
                source = row.rowStringAllowEmpty("source") ?: return null,
                loggedBy = loggedBy.value,
                note = note.value,
                archimedesRequestId = requestId.value,
                updatedAtMs = row.requiredLong("updatedAtMs") ?: return null,
            )
        }
    }
}

internal object PublicBtcBalanceDocumentDto {
    fun decode(element: JsonElement): BtcBalanceDocumentRow? {
        val row = element as? JsonObject ?: return null
        val source = row.decodedOptionalString("source") ?: return null
        val basis = row.decodedOptionalString("basis") ?: return null
        val confidence = row.decodedOptionalString("confidence") ?: return null
        val balanceConfidence = row.decodedOptionalString("balanceConfidence") ?: return null
        val totals = row["totals"] as? JsonObject ?: return null
        val totalSats = totals.rowInt64("sats") ?: return null
        val legacyTotalFiat = totals.decodedOptionalInt64("fiatCents") ?: return null
        val totalFiatCents = legacyTotalFiat.value ?: 0L
        val totalFiatValuation =
            totals.decodedFiatValuation(totalSats, totalFiatCents) ?: return null
        return BtcBalanceDocumentRow(
            owner = row.rowOwner() ?: return null,
            schemaVersion = row.rowInt64("schemaVersion") ?: return null,
            asOf = row.rowStringAllowEmpty("asOf") ?: return null,
            accounts = row.decodeObjectArray("accounts", ::decodeAccount) ?: return null,
            totals = BtcBalanceTotalsRow(
                sats = totalSats,
                fiatCents = totalFiatCents,
                exchangeSats = totals.rowInt64("exchangeSats") ?: return null,
                selfCustodySats = totals.rowInt64("selfCustodySats") ?: return null,
                fiatValuation = totalFiatValuation.value,
            ),
            source = source.value,
            basis = basis.value,
            confidence = confidence.value,
            updatedAtMs = row.requiredLong("updatedAtMs") ?: return null,
            balanceConfidence = balanceConfidence.value ?: confidence.value,
        )
    }

    private fun decodeAccount(row: JsonObject): BtcBalanceAccountRow? {
        val custodyKey = row.rowString("custody") ?: return null
        val sats = row.rowInt64("sats") ?: return null
        val legacyFiat = row.decodedOptionalInt64("fiatCents") ?: return null
        val fiatCents = legacyFiat.value ?: 0L
        val fiatValuation = row.decodedFiatValuation(sats, fiatCents) ?: return null
        return BtcBalanceAccountRow(
            key = row.rowString("key") ?: return null,
            label = row.rowStringAllowEmpty("label") ?: return null,
            custody = Custody.entries.firstOrNull { it.key == custodyKey } ?: return null,
            sats = sats,
            fiatCents = fiatCents,
            fiatValuation = fiatValuation.value,
        )
    }
}

internal object PublicBudgetDocumentDto {
    fun decode(element: JsonElement): BudgetDocumentSnapshot? {
        val envelope = element as? JsonObject ?: return null
        val complete = envelope.requiredBoolean("complete") ?: return null
        val encodedDocument = envelope["document"]
        val document = when {
            encodedDocument == null || encodedDocument is kotlinx.serialization.json.JsonNull -> null
            else -> decodeDocument(encodedDocument) ?: return null
        }
        return BudgetDocumentSnapshot(document, complete)
    }

    private fun decodeDocument(element: JsonElement): BudgetDocumentRow? {
        val row = element as? JsonObject ?: return null
        val effectiveApr = row.decodedOptionalString("effectiveApr") ?: return null
        val strategyNote = row.decodedOptionalString("strategyNote") ?: return null
        val income = row.decodedOptionalObject("income", ::decodeIncome) ?: return null
        return BudgetDocumentRow(
            owner = row.rowOwner() ?: return null,
            month = row.rowString("month") ?: return null,
            coinbaseOneBalanceCents = row.rowInt64("coinbaseOneBalanceCents") ?: return null,
            categories = row.decodeObjectArray("categories", ::decodeCategory) ?: return null,
            effectiveApr = effectiveApr.value,
            strategyNote = strategyNote.value,
            income = income.value,
            mtdIncomeCents = row.rowInt64("mtdIncomeCents") ?: return null,
            ytdIncomeCents = row.rowInt64("ytdIncomeCents") ?: return null,
            monthlyHistory = row.decodeObjectArray("monthlyHistory", ::decodeHistory) ?: return null,
            updatedAtMs = row.requiredLong("updatedAtMs") ?: return null,
        )
    }

    private fun decodeCategory(row: JsonObject): BudgetCategoryRow? {
        val icon = row.decodedOptionalString("icon") ?: return null
        return BudgetCategoryRow(
            name = row.rowStringAllowEmpty("name") ?: return null,
            icon = icon.value,
            budgetCents = row.rowInt64("budgetCents") ?: return null,
        )
    }

    private fun decodeIncome(row: JsonObject): BudgetIncomeRow? {
        val payFrequency = row.decodedOptionalString("payFrequency") ?: return null
        return BudgetIncomeRow(
            weeklyGrossCents = row.rowInt64("weeklyGrossCents") ?: return null,
            weeklyStrikeCents = row.rowInt64("weeklyStrikeCents") ?: return null,
            weeklyRiverCents = row.rowInt64("weeklyRiverCents") ?: return null,
            payFrequency = payFrequency.value,
            monthlyGrossCents = row.rowInt64("monthlyGrossCents") ?: return null,
            mtdIncomeCents = row.rowInt64("mtdIncomeCents") ?: return null,
            ytdIncomeCents = row.rowInt64("ytdIncomeCents") ?: return null,
            paychecks = row.decodeObjectArray("paychecks", ::decodePaycheck) ?: return null,
        )
    }

    private fun decodePaycheck(row: JsonObject): BudgetPaycheckRow? {
        val platform = row.decodedOptionalString("platform") ?: return null
        val source = row.decodedOptionalString("source") ?: return null
        val note = row.decodedOptionalString("note") ?: return null
        return BudgetPaycheckRow(
            date = row.rowStringAllowEmpty("date") ?: return null,
            platform = platform.value,
            source = source.value,
            amountCents = row.rowInt64("amountCents") ?: return null,
            netCents = row.rowInt64("netCents") ?: return null,
            note = note.value,
        )
    }

    private fun decodeHistory(row: JsonObject): BudgetMonthlyHistoryRow? {
        return BudgetMonthlyHistoryRow(
            month = row.rowStringAllowEmpty("month") ?: return null,
            incomeCents = row.rowInt64("incomeCents") ?: return null,
            expensesCents = row.rowInt64("expensesCents") ?: return null,
            savingsBps = row.rowInt64("savingsBps") ?: return null,
        )
    }
}

internal object PublicBtcSnapshotMetadataDto {
    fun decode(element: JsonElement): PublicRowEnvelope<BtcSnapshotMetadataRow>? =
        element.decodeRowEnvelope(::decodeRow)

    private fun decodeRow(element: JsonElement): BtcSnapshotMetadataRow? {
        val row = element as? JsonObject ?: return null
        val source = row.decodedOptionalString("source") ?: return null
        val basis = row.decodedOptionalString("basis") ?: return null
        val confidence = row.decodedOptionalString("confidence") ?: return null
        val balanceConfidence = row.decodedOptionalString("balanceConfidence") ?: return null
        return BtcSnapshotMetadataRow(
            owner = row.rowOwner() ?: return null,
            schemaVersion = row.rowInt64("schemaVersion") ?: return null,
            asOf = row.rowStringAllowEmpty("asOf") ?: return null,
            source = source.value,
            basis = basis.value,
            confidence = confidence.value,
            updatedAtMs = row.requiredLong("updatedAtMs") ?: return null,
            balanceConfidence = balanceConfidence.value ?: confidence.value,
        )
    }
}

private data class OptionalField<T>(val value: T?)

private fun JsonObject.rowString(key: String): String? = rowStringAllowEmpty(key)?.takeIf { it.isNotEmpty() }

private fun JsonObject.rowStringAllowEmpty(key: String): String? =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.rowOwner(): FamilyMember? =
    FamilyMember.fromKeyOrNull(rowString("owner"))

private fun JsonObject.rowInt64(key: String): Long? = get(key)?.decodeConvexInt64OrNull()

private fun JsonObject.decodedOptionalString(key: String): OptionalField<String>? {
    if (!containsKey(key)) return OptionalField(null)
    return OptionalField(rowStringAllowEmpty(key) ?: return null)
}

private fun JsonObject.decodedOptionalInt64(key: String): OptionalField<Long>? {
    if (!containsKey(key)) return OptionalField(null)
    return OptionalField(getValue(key).decodeConvexInt64OrNull() ?: return null)
}

private fun JsonObject.decodedFiatValuation(
    sats: Long,
    legacyFiatCents: Long,
): OptionalField<FiatValuation>? {
    if (!containsKey("fiatValuation")) {
        return OptionalField(legacyFiatValuation(sats, legacyFiatCents))
    }
    val encoded = getValue("fiatValuation")
    if (encoded is kotlinx.serialization.json.JsonNull) return OptionalField(null)
    val valuation = encoded as? JsonObject ?: return null
    val priceCents = valuation.decodedOptionalInt64("priceCents") ?: return null
    val quotedAt = valuation.decodedOptionalString("quotedAt") ?: return null
    val source = valuation.decodedOptionalString("source") ?: return null
    val confidence = valuation.decodedOptionalString("confidence") ?: return null
    return OptionalField(
        FiatValuation(
            cents = valuation.rowInt64("cents") ?: return null,
            priceCents = priceCents.value,
            quotedAt = quotedAt.value,
            source = source.value,
            confidence = confidence.value,
        ),
    )
}

private fun <T> JsonObject.decodedOptionalObject(
    key: String,
    decode: (JsonObject) -> T?,
): OptionalField<T>? {
    if (!containsKey(key)) return OptionalField(null)
    val encoded = getValue(key) as? JsonObject ?: return null
    return OptionalField(decode(encoded) ?: return null)
}

private fun <T> JsonObject.decodeObjectArray(
    key: String,
    decode: (JsonObject) -> T?,
): List<T>? {
    val encoded = get(key) as? JsonArray ?: return null
    val decoded = ArrayList<T>(encoded.size)
    for (element in encoded) {
        val item = element as? JsonObject ?: return null
        decoded += decode(item) ?: return null
    }
    return decoded
}
