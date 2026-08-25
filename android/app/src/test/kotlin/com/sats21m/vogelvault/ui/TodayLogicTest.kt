package com.sats21m.vogelvault.ui

import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals

class TodayLogicTest {

    @Test
    fun `injected clock exposes tasks due after former hardcoded date`() {
        val july27 = Instant.parse("2026-07-27T12:00:00Z").toEpochMilli()
        val state = VaultViewModel(
            remoteInitiallyEnabled = false,
            clock = { july27 },
        ).state.value

        assertEquals(
            listOf("todo-0001"),
            todosDueToday(state, ZoneOffset.UTC).map { it.id },
        )
    }
}
