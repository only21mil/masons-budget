package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Closed Convex query catalogue.
 *
 * Callers cannot spell an arbitrary path or smuggle an untyped argument into the
 * request. Adding a query requires a case here and a decision about every JSON
 * type its server validator accepts.
 */
internal sealed class ConvexQuery(val path: String) {
    abstract fun arguments(): JsonObject

    data object ListDataFiles : ConvexQuery("dataFiles:list") {
        override fun arguments(): JsonObject = JsonObject(emptyMap())
    }

    data object GetDataFileVersions : ConvexQuery("dataFiles:getVersions") {
        override fun arguments(): JsonObject = JsonObject(emptyMap())
    }

    data class GetDataFile(val name: String) : ConvexQuery("dataFiles:get") {
        init {
            require(name.isNotBlank()) { "data file name must not be blank" }
        }

        override fun arguments(): JsonObject = jsonArguments("name" to JsonPrimitive(name))
    }

    data class ListTransactions(
        val viewer: FamilyMember,
        val month: String? = null,
        val limit: Int? = null,
    ) : ConvexQuery("tables:listTransactions") {
        init {
            validateMonth(month)
            validateLimit(limit)
        }

        override fun arguments(): JsonObject = rowArguments(viewer, limit, "month" to month)
    }

    data class ListTodos(
        val viewer: FamilyMember,
        val done: Boolean? = null,
        val limit: Int? = null,
    ) : ConvexQuery("tables:listTodos") {
        init {
            validateLimit(limit)
        }

        override fun arguments(): JsonObject = buildMap {
            put("viewer", JsonPrimitive(viewer.key))
            done?.let { put("done", JsonPrimitive(it)) }
            limit?.let { put("limit", JsonPrimitive(it)) }
        }.let(::JsonObject)
    }

    data class ListBtcBuys(
        val viewer: FamilyMember,
        val scope: RowVisibilityScope,
        val month: String? = null,
        val limit: Int? = null,
    ) : ConvexQuery("tables:listBtcBuys") {
        init {
            validateMonth(month)
            validateLimit(limit)
        }

        override fun arguments(): JsonObject = scopedRowArguments(viewer, scope, month, limit)
    }

    data class ListBtcBillPays(
        val viewer: FamilyMember,
        val scope: RowVisibilityScope,
        val month: String? = null,
        val limit: Int? = null,
    ) : ConvexQuery("tables:listBtcBillPays") {
        init {
            validateMonth(month)
            validateLimit(limit)
        }

        override fun arguments(): JsonObject = scopedRowArguments(viewer, scope, month, limit)
    }

    data class ListBtcAccounts(
        val viewer: FamilyMember,
        val scope: RowVisibilityScope,
        val limit: Int? = null,
    ) : ConvexQuery("tables:listBtcAccounts") {
        init {
            validateLimit(limit)
        }

        override fun arguments(): JsonObject = rowArguments(
            viewer,
            limit,
            "scope" to scope.wireValue,
        )
    }

    data class GetBudgetDocument(
        val viewer: FamilyMember,
        val scope: BudgetQueryScope,
    ) : ConvexQuery("tables:getBudgetDocument") {
        override fun arguments(): JsonObject = jsonArguments(
            "viewer" to JsonPrimitive(viewer.key),
            "scope" to JsonPrimitive(scope.wireValue),
        )
    }

    data class GetBtcSnapshotMetadata(
        val viewer: FamilyMember,
        val scope: RowVisibilityScope,
    ) : ConvexQuery("tables:getBtcSnapshotMetadata") {
        override fun arguments(): JsonObject = jsonArguments(
            "viewer" to JsonPrimitive(viewer.key),
            "scope" to JsonPrimitive(scope.wireValue),
        )
    }

    data object RowCounts : ConvexQuery("tables:rowCounts") {
        override fun arguments(): JsonObject = JsonObject(emptyMap())
    }

    private companion object {
        val MONTH = Regex("\\d{4}-(0[1-9]|1[0-2])")
        const val PUBLIC_SNAPSHOT_HARD_MAX = 2_000

        fun validateMonth(month: String?) {
            require(month == null || MONTH.matches(month)) { "month must be yyyy-MM" }
        }

        fun validateLimit(limit: Int?) {
            require(limit == null || limit in 1..PUBLIC_SNAPSHOT_HARD_MAX) {
                "limit must be between 1 and $PUBLIC_SNAPSHOT_HARD_MAX"
            }
        }

        fun scopedRowArguments(
            viewer: FamilyMember,
            scope: RowVisibilityScope,
            month: String?,
            limit: Int?,
        ): JsonObject = rowArguments(viewer, limit, "scope" to scope.wireValue, "month" to month)

        fun rowArguments(
            viewer: FamilyMember,
            limit: Int?,
            vararg optionalStrings: Pair<String, String?>,
        ): JsonObject = buildMap {
            put("viewer", JsonPrimitive(viewer.key))
            for ((key, value) in optionalStrings) {
                value?.let { put(key, JsonPrimitive(it)) }
            }
            limit?.let { put("limit", JsonPrimitive(it)) }
        }.let(::JsonObject)

        fun jsonArguments(vararg entries: Pair<String, JsonElement>): JsonObject =
            JsonObject(linkedMapOf(*entries))
    }
}

/** Explicit wider-visible versus narrower-net-worth row scope. */
enum class RowVisibilityScope(internal val wireValue: String) {
    VISIBLE("visible"),
    NET_WORTH("netWorth"),
}

/** Budget reads have one legal scope; its type makes the literal explicit. */
enum class BudgetQueryScope(internal val wireValue: String) {
    NET_WORTH("netWorth"),
}
