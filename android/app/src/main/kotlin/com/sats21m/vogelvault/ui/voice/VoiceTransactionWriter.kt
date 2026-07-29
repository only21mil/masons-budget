package com.sats21m.vogelvault.ui.voice

import androidx.annotation.StringRes
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.TransactionInput
import com.sats21m.vogelvault.data.TransactionKind
import com.sats21m.vogelvault.domain.FamilyMember
import java.time.LocalDate
import java.util.UUID

data class VoiceTransactionDraft(
    val amountCents: Long,
    val merchant: String,
    val category: String,
    val date: LocalDate,
    val card: String?,
    val note: String?,
    val owner: FamilyMember,
)

sealed interface VoiceTransactionSaveResult {
    data object Saved : VoiceTransactionSaveResult

    data class Failed(
        @StringRes val messageRes: Int,
    ) : VoiceTransactionSaveResult
}

/**
 * The only voice-to-write boundary.
 *
 * The UI calls this after explicit review. [TransactionInput] then independently
 * enforces the purchase/refund/income sign contract before any socket opens.
 */
internal class VoiceTransactionWriter(
    private val client: ConvexMutationClient,
    private val idFactory: () -> String = { "android-${UUID.randomUUID()}" },
) {
    suspend fun save(draft: VoiceTransactionDraft): VoiceTransactionSaveResult {
        val mutation =
            runCatching { draft.toUpsertMutation(idFactory()) }
                .getOrElse {
                    return VoiceTransactionSaveResult.Failed(R.string.voice_invalid_transaction)
                }
        return when (client.mutate(mutation)) {
            is ConvexResult.Ok -> VoiceTransactionSaveResult.Saved
            ConvexResult.Unauthorized ->
                VoiceTransactionSaveResult.Failed(R.string.voice_write_not_configured)
            ConvexResult.NotConfigured ->
                VoiceTransactionSaveResult.Failed(R.string.voice_write_not_configured)
            else -> VoiceTransactionSaveResult.Failed(R.string.voice_write_failed)
        }
    }
}

internal fun VoiceTransactionDraft.toUpsertMutation(id: String): ConvexMutation.UpsertTransaction =
    ConvexMutation.UpsertTransaction(
        transaction = toTransactionInput(id),
        sourceFile = owner.transactionsDataFileName,
    )

internal fun VoiceTransactionDraft.toTransactionInput(id: String): TransactionInput {
    val normalizedMerchant = merchant.trim()
    val normalizedCategory =
        category.trim().let {
            if (it.equals(INCOME_CATEGORY, ignoreCase = true)) INCOME_CATEGORY else it
        }
    val isIncome = normalizedCategory == INCOME_CATEGORY
    val kind =
        when {
            isIncome -> TransactionKind.CREDIT
            amountCents < 0L -> TransactionKind.CREDIT
            else -> TransactionKind.SPEND
        }
    return TransactionInput(
        id = id,
        date = date.toString(),
        merchant = normalizedMerchant,
        amountCents = amountCents,
        category = normalizedCategory,
        kind = kind,
        card = card?.trim()?.ifBlank { null },
        note = note?.trim()?.ifBlank { null },
        owner = owner,
    )
}

private const val INCOME_CATEGORY = "Income"
