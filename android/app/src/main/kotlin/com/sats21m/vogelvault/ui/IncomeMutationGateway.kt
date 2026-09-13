package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.LinkedIncomeInput
import com.sats21m.vogelvault.domain.IncomeEntry
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.DisplayUnit
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

internal class IncomeMutationGateway(private val client: ConvexDeviceMutationClient) {
    suspend fun upsert(entry: IncomeEntry): ConvexResult<String> {
        val result = client.mutate(ConvexMutation.UpsertIncomeFromDevice(
            owner = entry.owner,
            income = LinkedIncomeInput(entry.id, entry.owner, entry.date, entry.amountCents, entry.sourceName, entry.note),
        ))
        return when (result) {
            is ConvexResult.Ok -> {
                val receipt = result.value.parsed as? JsonObject
                val accepted = (receipt?.get("ok") as? JsonPrimitive)?.booleanOrNull == true
                val id = (receipt?.get("entityId") as? JsonPrimitive)?.contentOrNull
                val outcome = (receipt?.get("outcome") as? JsonPrimitive)?.contentOrNull
                if (accepted && id == entry.id && outcome in setOf("inserted", "updated")) ConvexResult.Ok(entry.id)
                else ConvexResult.Failed("Invalid income response")
            }
            is ConvexResult.Failed -> result
            ConvexResult.Disabled -> ConvexResult.Disabled
            ConvexResult.NotConfigured -> ConvexResult.NotConfigured
            ConvexResult.Unauthorized -> ConvexResult.Unauthorized
            ConvexResult.Missing -> ConvexResult.Missing
        }
    }
}

internal fun prepareIncome(draft: AddTransactionDraft, id: String): Result<IncomeEntry> = runCatching {
    require(draft.type == AddTransactionType.INCOME) { "Choose Income" }
    require(draft.inputUnit == DisplayUnit.USD) { "Enter income in USD" }
    require(id.isNotBlank()) { "Income draft is missing" }
    val source = draft.merchant.trim()
    require(source.isNotEmpty()) { "Enter an income source" }
    val cents = Money.exactPositiveMinorUnitsOrNull(draft.amount, 2, allowZero = false)
    require(cents != null) { "Enter a positive USD amount with at most two decimal places" }
    IncomeEntry(id = id, owner = draft.owner.ledgerOwner, date = draft.date.toString(),
        month = draft.date.toString().take(7), amountCents = cents, sourceName = source,
        note = draft.note.trim().takeIf { it.isNotEmpty() })
}
