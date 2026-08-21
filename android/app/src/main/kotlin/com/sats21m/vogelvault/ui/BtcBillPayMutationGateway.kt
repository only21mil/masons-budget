package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.BtcBillPayInput
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.ConvexValue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/** The typed receipt returned by the one-row Bitcoin bill-pay device mutation. */
internal data class BtcBillPayUpsertReceipt(
    val entityId: String,
    val outcome: BtcBillPayUpsertOutcome,
)

internal enum class BtcBillPayUpsertOutcome { INSERTED, UPDATED }

/**
 * The only Android gateway for a Bitcoin bill-pay write.
 *
 * The UI supplies a validated request; this class makes exactly one capability
 * scoped mutation and rejects a receipt that does not identify that request.
 */
internal class BtcBillPayMutationGateway(
    private val client: ConvexDeviceMutationClient,
) {
    suspend fun upsert(
        request: BtcBillPayWriteRequest,
        baseUpdatedAtMs: Long?,
    ): ConvexResult<BtcBillPayUpsertReceipt> =
        client.mutate(
            ConvexMutation.UpsertBtcBillPayFromDevice(
                owner = request.owner.ledgerOwner,
                billPay = request.toDeviceInput(),
                baseUpdatedAtMs = baseUpdatedAtMs,
            ),
        ).mapSuccess { value ->
            val objectValue = value.parsed as? JsonObject ?: return@mapSuccess null
            val entityId = objectValue.string("entityId") ?: return@mapSuccess null
            val outcome = objectValue.string("outcome") ?: return@mapSuccess null
            if (objectValue.boolean("ok") != true || entityId != request.id) {
                return@mapSuccess null
            }
            val parsedOutcome = when (outcome) {
                "inserted" -> BtcBillPayUpsertOutcome.INSERTED
                "updated" -> BtcBillPayUpsertOutcome.UPDATED
                else -> return@mapSuccess null
            }
            BtcBillPayUpsertReceipt(entityId, parsedOutcome)
        }
}

private fun BtcBillPayWriteRequest.toDeviceInput(): BtcBillPayInput = BtcBillPayInput(
    id = id,
    owner = owner.ledgerOwner,
    date = date,
    merchant = merchant,
    category = category,
    budgetEffect = budgetEffect,
    amountUsdCents = amountUsdCents,
    btcSpentSats = btcSpentSats,
    btcPriceCents = btcPriceCents,
    feeUsdCents = feeUsdCents,
    note = note,
    reference = reference,
)

private inline fun <T, R> ConvexResult<T>.mapSuccess(transform: (T) -> R?): ConvexResult<R> = when (this) {
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
