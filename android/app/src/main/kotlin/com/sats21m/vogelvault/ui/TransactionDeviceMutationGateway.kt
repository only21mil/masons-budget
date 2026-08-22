package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexResult
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * Android's add surface uses the capability-scoped transaction endpoint rather
 * than the legacy sync-token mutation. This keeps the source selector on the
 * same device-auth boundary as the other interactive Android writers.
 */
internal class TransactionDeviceMutationGateway(
    private val client: ConvexDeviceMutationClient,
) {
    suspend fun upsert(row: PreparedTransaction): ConvexResult<DeviceTransactionWriteReceipt> {
        val owner = row.input.owner ?: return ConvexResult.Failed("transaction owner is missing")
        return client.mutate(
            ConvexMutation.UpsertTransactionFromDevice(
                owner = owner,
                sourceFile = row.sourceFile,
                transaction = row.input,
            ),
        ).mapSuccess { value ->
            val objectValue = value.parsed as? JsonObject ?: return@mapSuccess null
            val entityId = objectValue.string("entityId") ?: return@mapSuccess null
            val outcome = when (objectValue.string("outcome")) {
                "inserted" -> DeviceTransactionWriteOutcome.INSERTED
                "updated" -> DeviceTransactionWriteOutcome.UPDATED
                else -> return@mapSuccess null
            }
            if (objectValue.boolean("ok") != true || entityId != row.input.id) {
                return@mapSuccess null
            }
            DeviceTransactionWriteReceipt(entityId, outcome)
        }
    }
}

internal enum class DeviceTransactionWriteOutcome {
    INSERTED,
    UPDATED,
}

internal data class DeviceTransactionWriteReceipt(
    val entityId: String,
    val outcome: DeviceTransactionWriteOutcome,
)

private inline fun <T, R> ConvexResult<T>.mapSuccess(
    transform: (T) -> R?,
): ConvexResult<R> = when (this) {
    is ConvexResult.Ok -> transform(value)?.let { ConvexResult.Ok(it) }
        ?: ConvexResult.Failed("invalid write response")
    ConvexResult.Disabled -> ConvexResult.Disabled
    ConvexResult.NotConfigured -> ConvexResult.NotConfigured
    ConvexResult.Unauthorized -> ConvexResult.Unauthorized
    ConvexResult.Missing -> ConvexResult.Missing
    is ConvexResult.Failed -> this
}

private fun JsonObject.string(key: String): String? =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.boolean(key: String): Boolean? =
    (get(key) as? JsonPrimitive)?.booleanOrNull
