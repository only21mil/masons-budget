package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember
import java.io.IOException
import java.net.URI
import java.net.URISyntaxException
import java.time.LocalDate
import java.time.YearMonth
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Supplies the write credential without coupling transport to a storage choice.
 *
 * Production must back this with the encrypted Android configuration store.
 * The read token is deliberately not accepted as a fallback.
 */
internal fun interface ConvexSyncTokenSource {
    fun currentSyncToken(): String?
}

internal object DisabledConvexSyncTokenSource : ConvexSyncTokenSource {
    override fun currentSyncToken(): String? = null
}

/**
 * Calls Convex's HTTP mutation API for the closed [ConvexMutation] catalogue.
 *
 * Missing credentials, non-HTTPS deployments, network failures, non-success
 * HTTP responses, and Convex rejections all produce explicit non-OK results.
 */
internal class ConvexMutationClient(
    private val configSource: ConvexConfigSource,
    private val syncTokenSource: ConvexSyncTokenSource,
    private val http: HttpPoster = UrlConnectionHttpPoster(),
    private val transactionRevisions: TransactionRevisionStore = TransactionRevisionStore(),
) {
    suspend fun mutate(mutation: ConvexMutation): ConvexResult<ConvexValue> {
        val endpoint = mutationEndpoint(configSource.current().deploymentUrl)
            ?: return ConvexResult.NotConfigured
        val token = syncTokenSource.currentSyncToken()?.trim()?.takeIf { it.isNotEmpty() }
            ?: return ConvexResult.Unauthorized
        val body = requestBody(mutation, token)

        val response = try {
            http.postJson(endpoint, body)
        } catch (error: IOException) {
            return ConvexResult.Failed("transport failure (${error.javaClass.simpleName})")
        }

        val result = parse(response)
        if (result is ConvexResult.Ok) {
            when (mutation) {
                is ConvexMutation.UpsertTransaction -> {
                    decodeTransactionWriteReceipt(result.value, mutation)?.let { receipt ->
                        transactionRevisions.install(
                            sourceFile = mutation.sourceFile ?: DEFAULT_TRANSACTION_SOURCE,
                            txId = receipt.txId,
                            updatedAtMs = receipt.updatedAtMs,
                        )
                    }
                }

                is ConvexMutation.DeleteTransaction -> {
                    transactionRevisions.remove(mutation.sourceFile, mutation.txId)
                }

                else -> Unit
            }
        }
        return result
    }

    /**
     * Decodes the revision-bearing response required by an interactive create.
     * The generic mutation API remains for legacy/batch callers, but the add
     * surface must not report success while it has no fence for the next edit.
     */
    suspend fun upsertTransaction(
        mutation: ConvexMutation.UpsertTransaction,
    ): ConvexResult<TransactionWriteReceipt> {
        val result = mutate(mutation)
        return when (result) {
            is ConvexResult.Ok -> decodeTransactionWriteReceipt(result.value, mutation)
                ?.let { ConvexResult.Ok(it) }
                ?: ConvexResult.Failed("invalid write response")
            ConvexResult.Disabled -> ConvexResult.Disabled
            ConvexResult.NotConfigured -> ConvexResult.NotConfigured
            ConvexResult.Unauthorized -> ConvexResult.Unauthorized
            ConvexResult.Missing -> ConvexResult.Missing
            is ConvexResult.Failed -> result
        }
    }

    /**
     * Returns a revision installed by an accepted write while the row refresh
     * is still in flight. The shared application client makes this bridge
     * visible to both the add sheet and the detail actions without a Room
     * schema change.
     */
    internal fun acceptedTransactionRevision(sourceFile: String, txId: String): Long? =
        transactionRevisions.revisionFor(sourceFile, txId)

    private fun requestBody(mutation: ConvexMutation, token: String): String {
        val args = JsonObject(mutation.arguments() + ("token" to JsonPrimitive(token)))
        val request = JsonObject(
            linkedMapOf(
                "path" to JsonPrimitive(mutation.path),
                "args" to args,
                "format" to JsonPrimitive(CONVEX_RESPONSE_FORMAT),
            ),
        )
        return JSON.encodeToString(JsonElement.serializer(), request)
    }

    private fun parse(response: HttpTextResponse): ConvexResult<ConvexValue> {
        if (response.code != HTTP_OK) return ConvexResult.Failed("http ${response.code}")

        val envelope = try {
            JSON.parseToJsonElement(response.body) as? JsonObject
        } catch (error: SerializationException) {
            null
        } ?: return ConvexResult.Failed("malformed response envelope")

        return when (envelope.string("status")) {
            "success" -> {
                val value = envelope["value"]
                if (value == null || value is JsonNull) {
                    ConvexResult.Missing
                } else {
                    ConvexResult.Ok(ConvexValue(parsed = value, rawResponseJson = response.body))
                }
            }

            "error" -> {
                val errorData = envelope["errorData"]
                val message = if (errorData == null || errorData is JsonNull) {
                    envelope["errorMessage"].stringOrNull()
                } else {
                    errorData.stringOrNull()
                }
                if (message?.contains("Unauthorized", ignoreCase = true) == true) {
                    ConvexResult.Unauthorized
                } else {
                    ConvexResult.Failed("convex rejection")
                }
            }

            else -> ConvexResult.Failed("unrecognised response envelope")
        }
    }

    private fun JsonObject.string(key: String): String? = get(key).stringOrNull()

    private fun JsonElement?.stringOrNull(): String? =
        (this as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private companion object {
        const val HTTP_OK = 200
        const val CONVEX_RESPONSE_FORMAT = "convex_encoded_json"
        const val DEFAULT_TRANSACTION_SOURCE = "transactions"
        val JSON = Json {
            isLenient = false
            allowSpecialFloatingPointValues = false
        }

        fun mutationEndpoint(deploymentUrl: String?): String? {
            val base = deploymentUrl?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val secure = try {
                val uri = URI(base)
                uri.scheme?.lowercase() == "https" && !uri.host.isNullOrEmpty()
            } catch (error: URISyntaxException) {
                false
            }
            return if (secure) base.trimEnd('/') + "/api/mutation" else null
        }
    }
}

internal enum class TransactionWriteOutcome {
    INSERTED,
    UPDATED,
}

/** The server's complete receipt for one accepted transaction upsert. */
internal data class TransactionWriteReceipt(
    val txId: String,
    val owner: FamilyMember,
    val month: String,
    val outcome: TransactionWriteOutcome,
    val updatedAtMs: Long,
)

/**
 * Short-lived local revision storage shared by the add and detail surfaces.
 * The Room snapshot remains authoritative after refresh; this bridge closes
 * only the response-to-refresh gap and does not alter the database schema.
 */
internal class TransactionRevisionStore {
    private data class Key(val sourceFile: String, val txId: String)

    private val revisions = ConcurrentHashMap<Key, Long>()

    fun install(sourceFile: String, txId: String, updatedAtMs: Long) {
        require(sourceFile.isNotBlank()) { "source file must not be blank" }
        require(txId.isNotBlank()) { "transaction id must not be blank" }
        require(updatedAtMs > 0L) { "transaction revision must be positive" }
        revisions.merge(Key(sourceFile, txId), updatedAtMs, ::maxOf)
    }

    fun revisionFor(sourceFile: String, txId: String): Long? =
        revisions[Key(sourceFile, txId)]

    internal fun entryCount(): Int = revisions.size

    fun remove(sourceFile: String, txId: String) {
        revisions.remove(Key(sourceFile, txId))
    }
}

/**
 * Decode only the exact revision-bearing response used by interactive writes.
 * A generic successful envelope is not enough to fence the next operation.
 */
internal fun decodeTransactionWriteReceipt(
    value: ConvexValue,
    mutation: ConvexMutation.UpsertTransaction,
): TransactionWriteReceipt? {
    val objectValue = value.parsed as? JsonObject ?: return null
    val txId = objectValue.requiredString("txId") ?: return null
    val owner = FamilyMember.fromKeyOrNull(objectValue.requiredString("owner")) ?: return null
    val month = objectValue.requiredString("month") ?: return null
    val expectedOwner = mutation.transaction.owner ?: return null
    val expectedMonth = runCatching {
        YearMonth.from(LocalDate.parse(mutation.transaction.date)).toString()
    }.getOrNull() ?: return null
    if (
        txId != mutation.transaction.id ||
        owner != expectedOwner ||
        month != expectedMonth
    ) {
        return null
    }
    val outcome = when (objectValue.requiredString("outcome")) {
        "inserted" -> TransactionWriteOutcome.INSERTED
        "updated" -> TransactionWriteOutcome.UPDATED
        else -> return null
    }
    val updatedAtMs = objectValue.requiredLong("updatedAtMs") ?: return null
    if (updatedAtMs <= 0L) return null
    return TransactionWriteReceipt(txId, owner, month, outcome, updatedAtMs)
}
