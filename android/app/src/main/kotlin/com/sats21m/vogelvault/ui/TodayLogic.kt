package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.MoneyOutToday
import com.sats21m.vogelvault.domain.deriveMoneyOutToday
import com.sats21m.vogelvault.domain.isDueBy
import com.sats21m.vogelvault.domain.todosFor
import java.time.Instant
import java.time.ZoneId

internal fun todosDueToday(
    state: VaultUiState,
    zoneId: ZoneId = ZoneId.systemDefault(),
): List<TodoItem> =
    state.data.todos.value.todosFor(state.activeProfile)
        .filter { it.isDueBy(localDate(state.now, zoneId)) }

private fun localDate(epochMillis: Long, zoneId: ZoneId): String =
    Instant.ofEpochMilli(epochMillis)
        .atZone(zoneId)
        .toLocalDate()
        .toString()

internal fun moneyOutToday(
    state: VaultUiState,
    zoneId: ZoneId = ZoneId.systemDefault(),
): MoneyOutToday? {
    if (state.data.transactions.requiredProjectionUnavailable || state.data.billPayLedgerUnavailable) {
        return null
    }
    return deriveMoneyOutToday(
        activeProfile = state.activeProfile,
        day = localDate(state.now, zoneId),
        transactions = state.data.transactions.value,
        billPays = state.data.btcBillPays.value,
    )
}
