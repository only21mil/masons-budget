package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.isDueBy
import com.sats21m.vogelvault.domain.visibleTo
import java.time.Instant
import java.time.ZoneId

internal fun todosDueToday(
    state: VaultUiState,
    zoneId: ZoneId = ZoneId.systemDefault(),
): List<TodoItem> =
    state.data.todos.value.visibleTo(state.activeProfile)
        .filter { it.isDueBy(localDate(state.now, zoneId)) }

private fun localDate(epochMillis: Long, zoneId: ZoneId): String =
    Instant.ofEpochMilli(epochMillis)
        .atZone(zoneId)
        .toLocalDate()
        .toString()
