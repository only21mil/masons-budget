package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.Slice
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import kotlin.test.Test
import kotlin.test.assertEquals

class VaultUiStateStatusTest {
    @Test
    fun `global status does not report no data when transaction rows arrived`() {
        val rows =
            List(911) { index ->
                Transaction(
                    id = "tx-$index",
                    date = "2026-07-16",
                    merchant = "Merchant $index",
                    amount = 100L,
                    category = "Other",
                    owner = FamilyMember.VICTOR,
                    spendAmount = 100L,
                    displaySpendAmount = 100L,
                )
            }
        val data =
            ReadModel(
                transactions = Slice(Freshness.LIVE, rows, 123L, "Convex rows · transactions"),
                budget = Slice(Freshness.EMPTY, null, null, "Convex rows · budget"),
                btcAccounts =
                    Slice(
                        Freshness.EMPTY,
                        emptyList<BtcAccount>(),
                        null,
                        "Convex rows · bitcoin accounts",
                    ),
                btcBuys =
                    Slice(
                        Freshness.EMPTY,
                        emptyList<BtcBuy>(),
                        null,
                        "Convex rows · bitcoin buys",
                    ),
                todos =
                    Slice(
                        Freshness.EMPTY,
                        emptyList<TodoItem>(),
                        null,
                        "Convex rows · todos",
                    ),
                btcPriceCents = 0L,
            )

        assertEquals(Freshness.LIVE, VaultUiState(data = data).worstStatus)
    }
}
