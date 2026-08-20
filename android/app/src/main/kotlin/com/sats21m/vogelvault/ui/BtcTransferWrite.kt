package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.TransactionDraftIdStore
import com.sats21m.vogelvault.data.BtcTransferInput
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcTransfer
import com.sats21m.vogelvault.domain.FamilyMember
import java.time.LocalDate
import java.time.format.DateTimeParseException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

internal const val BTC_TRANSFER_SOURCE_FILE = "btc-transfers"

/**
 * Builds the one Android transfer request from the visible account projection.
 *
 * Rachel acts as the shared adult household ledger owner. Child profiles and
 * accounts owned by another ledger are refused before a device capability is
 * used, so the UI cannot accidentally post a child account into the household
 * balance document.
 */
internal fun btcTransferWriteRequest(
    viewer: FamilyMember,
    stableTransferId: String,
    date: String,
    fromAccountKey: String,
    toAccountKey: String,
    satsText: String,
    feeSatsText: String,
    note: String?,
    accounts: List<BtcAccount>,
): Result<BtcTransfer> = runCatching {
    require(viewer.isAdult) {
        "Bitcoin transfers are available only to adult household profiles."
    }
    val owner = viewer.ledgerOwner
    val id = stableTransferId.trim()
    require(id.isNotEmpty()) { "transfer id must not be empty" }

    val normalizedDate = try {
        LocalDate.parse(date.trim()).toString()
    } catch (_: DateTimeParseException) {
        throw IllegalArgumentException("Enter a date as yyyy-MM-dd.")
    }

    val normalizedFrom = fromAccountKey.trim()
    val normalizedTo = toAccountKey.trim()
    require(normalizedFrom.isNotEmpty()) { "Select a source Bitcoin account." }
    require(normalizedTo.isNotEmpty()) { "Select a destination Bitcoin account." }
    require(normalizedFrom != normalizedTo) {
        "Source and destination Bitcoin accounts must be different."
    }

    val accountsByKey = accounts.associateBy { it.key.trim() }
    require(accountsByKey.size == accounts.size) {
        "The visible Bitcoin accounts contain duplicate keys. Refresh and try again."
    }
    val from = accountsByKey[normalizedFrom]
        ?: throw IllegalArgumentException("Select a visible source Bitcoin account.")
    val to = accountsByKey[normalizedTo]
        ?: throw IllegalArgumentException("Select a visible destination Bitcoin account.")
    require(from.owner == owner && to.owner == owner) {
        "Both Bitcoin accounts must belong to the active household ledger."
    }

    val sats = parseWholeSats(satsText, "sats", allowBlank = false)
    val feeSats = parseWholeSats(feeSatsText, "feeSats", allowBlank = true)
    val debit = Math.addExact(sats, feeSats)
    require(debit <= from.sats) {
        "The source Bitcoin account does not have enough sats for this transfer and fee."
    }

    BtcTransfer(
        id = id,
        owner = owner,
        date = normalizedDate,
        fromAccountKey = normalizedFrom,
        toAccountKey = normalizedTo,
        sats = sats,
        feeSats = feeSats,
        note = note?.trim()?.takeIf { it.isNotEmpty() },
    )
}

private fun parseWholeSats(raw: String, field: String, allowBlank: Boolean): Long {
    val normalized = raw.trim().replace(",", "")
    if (normalized.isEmpty() && allowBlank) return 0L
    require(normalized.matches(Regex("\\d+"))) {
        "$field must be a whole number of sats."
    }
    return normalized.toLongOrNull()
        ?: throw IllegalArgumentException("$field is outside the supported satoshi range.")
}

internal enum class BtcTransferUpsertOutcome { INSERTED, UPDATED }

internal data class BtcTransferUpsertReceipt(
    val entityId: String,
    val outcome: BtcTransferUpsertOutcome,
)

/** The single device-capability write used by the transfer editor. */
internal class BtcTransferMutationGateway(
    private val client: ConvexDeviceMutationClient,
) {
    suspend fun upsert(
        transfer: BtcTransfer,
        baseUpdatedAtMs: Long? = null,
    ): ConvexResult<BtcTransferUpsertReceipt> =
        client.mutate(
            ConvexMutation.UpsertBtcTransferFromDevice(
                owner = transfer.owner,
                transfer = transfer.toDeviceMutationInput(),
                baseUpdatedAtMs = baseUpdatedAtMs,
            ),
        ).mapSuccess { value ->
            val objectValue = value.parsed as? JsonObject ?: return@mapSuccess null
            val entityId = objectValue.string("entityId") ?: return@mapSuccess null
            val outcome = when (objectValue.string("outcome")) {
                "inserted" -> BtcTransferUpsertOutcome.INSERTED
                "updated" -> BtcTransferUpsertOutcome.UPDATED
                else -> return@mapSuccess null
            }
            if (objectValue.boolean("ok") != true || entityId != transfer.id) {
                return@mapSuccess null
            }
            BtcTransferUpsertReceipt(entityId, outcome)
        }
}

private fun BtcTransfer.toDeviceMutationInput(): BtcTransferInput =
    BtcTransferInput(
        id = id,
        owner = owner,
        date = date,
        fromAccountKey = fromAccountKey,
        toAccountKey = toAccountKey,
        sats = sats,
        feeSats = feeSats,
        note = note,
    )

/**
 * Starts a transfer on the application-owned scope. The same stable id remains
 * leased for every non-accepted retry and rotates only after Convex confirms it.
 */
internal fun launchBtcTransferSave(
    scope: CoroutineScope,
    transfer: BtcTransfer,
    gateway: BtcTransferMutationGateway,
    transferDraftIds: TransactionDraftIdStore,
    onResult: (ConvexResult<BtcTransferUpsertReceipt>) -> Unit,
): Job = scope.launch {
    val result = gateway.upsert(transfer)
    if (result is ConvexResult.Ok<*>) {
        transferDraftIds.rotateAfterAcceptance(BTC_TRANSFER_SOURCE_FILE, transfer.id)
    }
    onResult(result)
}

internal fun btcTransferWriteFailureMessage(result: ConvexResult<*>): String? = when (result) {
    is ConvexResult.Ok -> null
    ConvexResult.Disabled -> "Bitcoin transfer not saved: authenticated writes are disabled."
    ConvexResult.NotConfigured -> "Bitcoin transfer not saved: Convex is not configured on this device."
    ConvexResult.Unauthorized -> "Bitcoin transfer not saved: the paired-device credential is missing or was rejected."
    ConvexResult.Missing -> "Bitcoin transfer not saved: Convex returned no write result."
    is ConvexResult.Failed -> "Bitcoin transfer not saved: the write failed (${result.reason})."
}

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
