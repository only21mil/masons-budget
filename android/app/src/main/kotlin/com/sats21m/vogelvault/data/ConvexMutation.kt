package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import java.util.Base64
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Closed catalogue for the public row mutations Android is allowed to call.
 *
 * Values accepted as Convex `v.int64()` are encoded here rather than passing
 * through a JSON number. This keeps cents and sats exact on the wire.
 */
internal sealed class ConvexMutation(val path: String) {
    abstract fun arguments(): JsonObject

    data class UpsertTransaction(
        val transaction: TransactionInput,
        val sourceFile: String? = null,
        val baseUpdatedAtMs: Long? = null,
    ) : ConvexMutation("tables:upsertTransaction") {
        override fun arguments(): JsonObject = buildMap<String, JsonElement> {
            put("transaction", transaction.toJson())
            sourceFile?.let { put("sourceFile", JsonPrimitive(it)) }
            baseUpdatedAtMs?.let { put("baseUpdatedAtMs", JsonPrimitive(it)) }
        }.let(::JsonObject)
    }

    data class DeleteTransaction(
        val txId: String,
        val owner: FamilyMember,
        val sourceFile: String,
        val baseUpdatedAtMs: Long? = null,
    ) : ConvexMutation("tables:deleteTransaction") {
        init {
            require(txId.isNotBlank()) { "transaction id must not be blank" }
            require(sourceFile.isNotBlank()) { "source file must not be blank" }
            require(sourceFile == owner.transactionsDataFileName) {
                "source file must match the transaction owner"
            }
        }

        override fun arguments(): JsonObject = buildMap<String, JsonElement> {
            put("txId", JsonPrimitive(txId))
            put("owner", JsonPrimitive(owner.key))
            put("sourceFile", JsonPrimitive(sourceFile))
            baseUpdatedAtMs?.let { put("baseUpdatedAtMs", JsonPrimitive(it)) }
        }.let(::JsonObject)
    }

    data class UpsertTodoFromDevice(
        val owner: FamilyMember,
        val todo: JsonObject,
        val baseUpdatedAtMs: Long?,
    ) : ConvexMutation("tables:upsertTodoFromDevice") {
        override fun arguments(): JsonObject = buildMap<String, JsonElement> {
            put("owner", JsonPrimitive(owner.key))
            put("sourceFile", JsonPrimitive("todos"))
            put("todo", todo)
            baseUpdatedAtMs?.let { put("baseUpdatedAtMs", JsonPrimitive(it)) }
        }.let(::JsonObject)
    }

    data class DeleteTodoFromDevice(
        val todoId: String,
        val owner: FamilyMember,
        val baseUpdatedAtMs: Long,
    ) : ConvexMutation("tables:deleteTodoFromDevice") {
        init {
            require(todoId.isNotBlank()) { "todo id must not be blank" }
        }

        override fun arguments(): JsonObject = jsonObject(
            "entityId" to JsonPrimitive(todoId),
            "owner" to JsonPrimitive(owner.key),
            "sourceFile" to JsonPrimitive("todos"),
            "baseUpdatedAtMs" to JsonPrimitive(baseUpdatedAtMs),
        )
    }

    data class RestoreTodoFromDevice(
        val owner: FamilyMember,
        val todo: JsonObject,
        val baseUpdatedAtMs: Long,
    ) : ConvexMutation("tables:restoreTodoFromDevice") {
        override fun arguments(): JsonObject = jsonObject(
            "owner" to JsonPrimitive(owner.key),
            "sourceFile" to JsonPrimitive("todos"),
            "todo" to todo,
            "baseUpdatedAtMs" to JsonPrimitive(baseUpdatedAtMs),
        )
    }

    data class UpsertBtcBuy(
        val buy: BtcBuyInput,
        val sourceFile: String? = null,
    ) : ConvexMutation("tables:upsertBtcBuy") {
        override fun arguments(): JsonObject =
            argumentsWithOptionalSource("buy", buy.toJson(), sourceFile)
    }

    data class UpsertBtcBillPayFromDevice(
        val owner: FamilyMember,
        val billPay: BtcBillPayInput,
        val baseUpdatedAtMs: Long? = null,
        val sourceFile: String = BTC_BILL_PAYS_SOURCE_FILE,
    ) : ConvexMutation("tables:upsertBtcBillPayFromDevice") {
        init {
            require(owner.isAdult) { "Bitcoin bill pays are adult household rows" }
            require(sourceFile == BTC_BILL_PAYS_SOURCE_FILE) {
                "Bitcoin bill pays must use the canonical source file"
            }
        }

        override fun arguments(): JsonObject = buildMap<String, JsonElement> {
            put("owner", JsonPrimitive(owner.key))
            put("sourceFile", JsonPrimitive(sourceFile))
            put("billPay", billPay.toJson())
            baseUpdatedAtMs?.let { put("baseUpdatedAtMs", JsonPrimitive(it)) }
        }.let(::JsonObject)
    }

    /**
     * One device mutation for a BTC purchase and its optional USD income row.
     *
     * The server owns the transaction boundary: sending [linkedIncome] asks it
     * to commit both rows together, while omitting it preserves the ordinary
     * Bitcoin-buy write. The Android boundary still rejects mismatched identity
     * locally so a retry cannot accidentally attach a different income row.
     */
    data class UpsertBtcBuyFromDevice(
        val owner: FamilyMember,
        val sourceFile: String,
        val buy: BtcBuyInput,
        val linkedIncome: LinkedIncomeInput? = null,
        val baseUpdatedAtMs: Long? = null,
    ) : ConvexMutation("tables:upsertBtcBuyFromDevice") {
        init {
            require(owner.isAdult) { "device Bitcoin-buy writes are adult-household only" }
            require(sourceFile == owner.btcBuysDataFileName) {
                "source file must match the Bitcoin-buy owner"
            }
            require(buy.owner == owner) { "Bitcoin buy owner must match the request owner" }
            linkedIncome?.let { income ->
                require(income.id == buy.id) { "linked income and Bitcoin buy must share an id" }
                require(income.owner == owner) { "linked income owner must match the request owner" }
                require(income.date == buy.date) { "linked income and Bitcoin buy must share a date" }
                require(income.amountCents == buy.usdCents) {
                    "linked income amount must match Bitcoin-buy USD cents"
                }
            }
        }

        override fun arguments(): JsonObject = buildMap<String, JsonElement> {
            put("owner", JsonPrimitive(owner.key))
            put("sourceFile", JsonPrimitive(sourceFile))
            put("buy", buy.toJson())
            linkedIncome?.let { put("linkedIncome", it.toJson()) }
            baseUpdatedAtMs?.let { put("baseUpdatedAtMs", JsonPrimitive(it)) }
        }.let(::JsonObject)
    }

    data class UpsertBtcAccount(
        val account: BtcAccountInput,
        val sourceFile: String? = null,
    ) : ConvexMutation("tables:upsertBtcAccount") {
        override fun arguments(): JsonObject =
            argumentsWithOptionalSource("account", account.toJson(), sourceFile)
    }

    data class UpsertBudgetCategory(
        val viewer: FamilyMember,
        val month: String,
        val category: BudgetCategoryInput,
    ) : ConvexMutation("tables:upsertBudgetCategory") {
        init {
            require(month.matches(BUDGET_MONTH_PATTERN)) {
                "budget month must be canonical yyyy-MM"
            }
        }

        override fun arguments(): JsonObject =
            jsonObject(
                "viewer" to JsonPrimitive(viewer.key),
                "month" to JsonPrimitive(month),
                "category" to category.toJson(),
            )
    }
}

internal enum class TransactionKind(val wireValue: String) {
    SPEND("spend"),
    CREDIT("credit"),
}

internal data class TransactionInput(
    val id: String,
    val date: String,
    val merchant: String,
    /** Purchases are positive; refunds are negative, for every owner. */
    val amountCents: Long,
    val category: String,
    val kind: TransactionKind = TransactionKind.SPEND,
    val card: String? = null,
    val note: String? = null,
    val amountSats: Long? = null,
    val owner: FamilyMember? = null,
) {
    init {
        require(id.isNotBlank()) { "transaction id must not be blank" }
        require(date.isNotBlank()) { "transaction date must not be blank" }
        require(merchant.isNotBlank()) { "transaction merchant must not be blank" }
        require(category.isNotBlank()) { "transaction category must not be blank" }
        require(amountCents != 0L) { "transaction amount must not be zero" }
        require(category != "Income" || kind == TransactionKind.CREDIT) {
            "Income transactions must be credits"
        }
        require(amountSats == null || (category == "Income" && amountSats > 0L)) {
            "only Income may carry a positive sats amount"
        }

        val expectedNegative = category != "Income" && kind == TransactionKind.CREDIT
        require((amountCents < 0L) == expectedNegative) {
            if (expectedNegative) {
                "refunds must have a negative amount"
            } else {
                "purchases and income must have a positive amount"
            }
        }
    }

    fun toJson(): JsonObject = buildMap<String, JsonElement> {
        put("id", JsonPrimitive(id))
        put("date", JsonPrimitive(date))
        put("merchant", JsonPrimitive(merchant))
        put("amountCents", amountCents.toConvexInt64())
        put("kind", JsonPrimitive(kind.wireValue))
        put("category", JsonPrimitive(category))
        card?.let { put("card", JsonPrimitive(it)) }
        note?.let { put("note", JsonPrimitive(it)) }
        amountSats?.let { put("amountSats", it.toConvexInt64()) }
        owner?.let { put("owner", JsonPrimitive(it.key)) }
    }.let(::JsonObject)
}

internal data class BtcBuyInput(
    val id: String,
    val date: String,
    val source: String,
    val sats: Long,
    val priceUsdCents: Long,
    val usdCents: Long,
    val note: String? = null,
    val status: String? = null,
    val costBasisStatus: String? = null,
    val loggedBy: String? = null,
    val archimedesRequestId: String? = null,
    val owner: FamilyMember? = null,
) {
    init {
        require(id.isNotBlank()) { "bitcoin buy id must not be blank" }
        require(date.isNotBlank()) { "bitcoin buy date must not be blank" }
        require(source.isNotBlank()) { "bitcoin buy source must not be blank" }
    }

    fun toJson(): JsonObject = buildMap<String, JsonElement> {
        put("id", JsonPrimitive(id))
        put("date", JsonPrimitive(date))
        put("source", JsonPrimitive(source))
        put("sats", sats.toConvexInt64())
        put("priceUsdCents", priceUsdCents.toConvexInt64())
        put("usdCents", usdCents.toConvexInt64())
        note?.let { put("note", JsonPrimitive(it)) }
        status?.let { put("status", JsonPrimitive(it)) }
        costBasisStatus?.let { put("costBasisStatus", JsonPrimitive(it)) }
        loggedBy?.let { put("loggedBy", JsonPrimitive(it)) }
        archimedesRequestId?.let { put("archimedesRequestId", JsonPrimitive(it)) }
        owner?.let { put("owner", JsonPrimitive(it.key)) }
    }.let(::JsonObject)
}

internal const val BTC_BILL_PAYS_SOURCE_FILE = "bitcoin-bill-pays"
internal const val RIVER_BITCOIN_BILL_PAY_PLATFORM = "river_bitcoin_bill_pay"

internal data class BtcBillPayInput(
    val id: String,
    val owner: FamilyMember,
    val date: String,
    val merchant: String,
    val category: String,
    val budgetEffect: com.sats21m.vogelvault.domain.BillPayBudgetEffect,
    val amountUsdCents: Long,
    val btcSpentSats: Long,
    val btcPriceCents: Long,
    val feeUsdCents: Long,
    val platform: String = RIVER_BITCOIN_BILL_PAY_PLATFORM,
    val note: String? = null,
    val reference: String? = null,
) {
    init {
        require(id.isNotBlank()) { "bitcoin bill pay id must not be blank" }
        require(owner.isAdult) { "Bitcoin bill pays are adult household rows" }
        require(date.isNotBlank()) { "bitcoin bill pay date must not be blank" }
        require(merchant.isNotBlank()) { "bitcoin bill pay merchant must not be blank" }
        require(category.isNotBlank()) { "bitcoin bill pay category must not be blank" }
        require(amountUsdCents > 0L) { "bitcoin bill pay amount must be positive" }
        require(btcSpentSats > 0L) { "bitcoin bill pay sats must be positive" }
        require(btcPriceCents > 0L) { "bitcoin bill pay price must be positive" }
        require(feeUsdCents >= 0L) { "bitcoin bill pay fee must not be negative" }
        require(platform == RIVER_BITCOIN_BILL_PAY_PLATFORM) {
            "bitcoin bill pay platform must be River"
        }
        if (budgetEffect == com.sats21m.vogelvault.domain.BillPayBudgetEffect.CREDIT_CARD_PAYMENT) {
            require(category == "Credit Card Payment") {
                "credit card bill pays must use the Credit Card Payment category"
            }
        }
    }

    fun toJson(): JsonObject = buildMap<String, JsonElement> {
        put("id", JsonPrimitive(id))
        put("owner", JsonPrimitive(owner.key))
        put("date", JsonPrimitive(date))
        put("merchant", JsonPrimitive(merchant))
        put("category", JsonPrimitive(category))
        put("budgetEffect", JsonPrimitive(budgetEffect.wireValue))
        put("amountUsdCents", amountUsdCents.toConvexInt64())
        put("btcSpentSats", btcSpentSats.toConvexInt64())
        put("btcPriceCents", btcPriceCents.toConvexInt64())
        put("feeUsdCents", feeUsdCents.toConvexInt64())
        put("platform", JsonPrimitive(platform))
        note?.let { put("note", JsonPrimitive(it)) }
        reference?.let { put("reference", JsonPrimitive(it)) }
    }.let(::JsonObject)
}

internal data class LinkedIncomeInput(
    val id: String,
    val owner: FamilyMember,
    val date: String,
    val amountCents: Long,
    val source: String,
    val note: String? = null,
    val loggedBy: String? = null,
) {
    init {
        require(id.isNotBlank()) { "linked income id must not be blank" }
        require(date.isNotBlank()) { "linked income date must not be blank" }
        require(amountCents > 0L) { "linked income amount must be positive" }
        require(source.isNotBlank()) { "linked income source must not be blank" }
    }

    fun toJson(): JsonObject = buildMap<String, JsonElement> {
        put("id", JsonPrimitive(id))
        put("owner", JsonPrimitive(owner.key))
        put("date", JsonPrimitive(date))
        put("amountCents", amountCents.toConvexInt64())
        put("source", JsonPrimitive(source))
        note?.let { put("note", JsonPrimitive(it)) }
        loggedBy?.let { put("loggedBy", JsonPrimitive(it)) }
    }.let(::JsonObject)
}

internal data class BtcAccountInput(
    val key: String,
    val owner: FamilyMember,
    val label: String,
    val custody: Custody,
    val sats: Long,
    val fiatCents: Long,
    val asOf: String,
    val schemaVersion: Long? = null,
) {
    init {
        require(key.isNotBlank()) { "bitcoin account key must not be blank" }
        require(label.isNotBlank()) { "bitcoin account label must not be blank" }
        require(asOf.isNotBlank()) { "bitcoin account as-of date must not be blank" }
    }

    fun toJson(): JsonObject = buildMap<String, JsonElement> {
        put("key", JsonPrimitive(key))
        put("owner", JsonPrimitive(owner.key))
        put("label", JsonPrimitive(label))
        put("custody", JsonPrimitive(custody.key))
        put("sats", sats.toConvexInt64())
        put("fiatCents", fiatCents.toConvexInt64())
        put("asOf", JsonPrimitive(asOf))
        schemaVersion?.let { put("schemaVersion", it.toConvexInt64()) }
    }.let(::JsonObject)
}

internal data class BudgetCategoryInput(
    val name: String,
    val budgetCents: Long,
    val icon: String? = null,
) {
    init {
        require(name.isNotBlank()) { "budget category name must not be blank" }
        require(budgetCents >= 0L) { "budget category amount must not be negative" }
    }

    fun toJson(): JsonObject = buildMap<String, JsonElement> {
        put("name", JsonPrimitive(name))
        put("budgetCents", budgetCents.toConvexInt64())
        icon?.trim()?.takeIf { it.isNotEmpty() }?.let { put("icon", JsonPrimitive(it)) }
    }.let(::JsonObject)
}

internal fun Long.toConvexInt64(): JsonObject {
    var remaining = this
    val bytes = ByteArray(Long.SIZE_BYTES) {
        (remaining and 0xffL).toByte().also { remaining = remaining shr Byte.SIZE_BITS }
    }
    return jsonObject(
        "\$integer" to JsonPrimitive(Base64.getEncoder().encodeToString(bytes)),
    )
}

private fun argumentsWithOptionalSource(
    valueKey: String,
    value: JsonObject,
    sourceFile: String?,
): JsonObject = buildMap<String, JsonElement> {
    put(valueKey, value)
    sourceFile?.let {
        require(it.isNotBlank()) { "source file must not be blank" }
        put("sourceFile", JsonPrimitive(it))
    }
}.let(::JsonObject)

private fun jsonObject(vararg entries: Pair<String, JsonElement>): JsonObject =
    JsonObject(linkedMapOf(*entries))

private val BUDGET_MONTH_PATTERN = Regex("""\d{4}-(0[1-9]|1[0-2])""")
