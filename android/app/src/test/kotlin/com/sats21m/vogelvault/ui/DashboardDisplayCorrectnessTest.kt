package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.PublicTransactionDto
import com.sats21m.vogelvault.data.decodeRowEnvelope
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.Slice
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

class DashboardDisplayCorrectnessTest {
    @Test
    fun `production spend is negative warning and credit is positive`() {
        val spend = productionTransactions().first().toDomain()
        val credit = PublicTransactionDto(
            txId = "credit",
            owner = FamilyMember.VICTOR,
            date = "2026-07-16",
            month = "2026-07",
            merchant = "Aven credit",
            amountCents = -2_500L,
            spendAmount = 2_500L,
            displaySpendAmount = 2_500L,
            hasOppositeSpendSign = false,
            category = "Dining & Drinks",
            card = "Aven",
            note = null,
            updatedAtMs = 0L,
        ).toDomain()

        assertEquals(
            TransactionPresentation("-$279.18", TransactionFigureTone.NEGATIVE),
            transactionPresentation(spend),
        )
        assertEquals(
            TransactionPresentation("+$25.00", TransactionFigureTone.POSITIVE),
            transactionPresentation(credit),
        )
    }

    @Test
    fun `global status does not report no data when transaction rows arrived`() {
        val rows = List(911) { index ->
            Transaction(
                id = "tx-$index",
                date = "2026-07-16",
                merchant = "Merchant $index",
                amount = 100L,
                category = "Other",
                owner = FamilyMember.VICTOR,
                spendAmount = -100L,
                displaySpendAmount = 100L,
            )
        }
        val data = ReadModel(
            transactions = Slice(Freshness.LIVE, rows, 123L, "Convex rows · transactions"),
            budget = Slice(Freshness.EMPTY, null, null, "Convex rows · budget"),
            btcAccounts = Slice(Freshness.EMPTY, emptyList<BtcAccount>(), null, "Convex rows · bitcoin accounts"),
            btcBuys = Slice(Freshness.EMPTY, emptyList<BtcBuy>(), null, "Convex rows · bitcoin buys"),
            todos = Slice(Freshness.EMPTY, emptyList<TodoItem>(), null, "Convex rows · todos"),
            btcPriceCents = 0L,
        )

        assertEquals(Freshness.LIVE, VaultUiState(data = data).worstStatus)
    }

    private fun productionTransactions(): List<PublicTransactionDto> {
        val response = Json.parseToJsonElement(
            goldenFixture("listTransactions.convex_encoded_json.json").readText(),
        ).jsonObject
        val value = requireNotNull(response["value"])
        return requireNotNull(value.decodeRowEnvelope(PublicTransactionDto::decode)).rows
    }

    private fun goldenFixture(name: String): File {
        val workingDirectory = requireNotNull(System.getProperty("user.dir"))
        var directory = File(workingDirectory).absoluteFile
        while (true) {
            val candidate = File(
                directory,
                "shared/domain/fixtures/convex-wire-golden/$name",
            )
            if (candidate.isFile) return candidate
            directory = directory.parentFile
                ?: error("Could not locate convex-wire-golden/$name from $workingDirectory")
        }
    }
}
