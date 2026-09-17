package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.MoneyOutToday
import com.sats21m.vogelvault.domain.deriveMoneyOutToday
import java.time.Instant
import java.time.ZoneId

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
