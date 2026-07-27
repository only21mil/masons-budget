package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.fail
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ConvexWireGoldenValuesTest {
    @Test
    fun `real captures decode to exact production values`() {
        val repository = RowQueryRepositories.convex(
            configSource = MutableConvexConfigSource(
                ConvexConfig(DEPLOYMENT, "fixture-only-token", remoteReadEnabled = true),
            ),
            http = GoldenPoster(),
        )

        val transactions = requireOk(
            runBlocking {
                repository.listTransactions(FamilyMember.VICTOR, limit = 3)
            },
            "listTransactions",
        )
        assertEquals("t1784233824245", transactions.rows[0].id)
        assertEquals(27_918L, transactions.rows[0].amount)
        assertEquals(-27_918L, transactions.rows[0].spendAmount)
        assertEquals(27_918L, transactions.rows[0].displaySpendAmount)

        val todos = requireOk(
            runBlocking {
                repository.listTodos(FamilyMember.VICTOR, limit = 3)
            },
            "listTodos",
        )
        assertEquals("8A56A12C-DB12-4766-96BF-6E3AE7D1EFC9", todos.rows[0].id)
        assertEquals("Reports", todos.rows[0].project)
        assertEquals(true, todos.rows[0].done)

        val buys = requireOk(
            runBlocking {
                repository.listBtcBuys(
                    FamilyMember.VICTOR,
                    RowVisibilityScope.VISIBLE,
                    limit = 3,
                )
            },
            "listBtcBuys",
        )
        assertEquals("b1784166358832", buys.rows[0].id)
        assertEquals(148_033L, buys.rows[0].sats)
        assertEquals(6_563_401L, buys.rows[0].priceUsdCents)
        assertEquals(9_813L, buys.rows[0].usdCents)

        val billPays = requireOk(
            runBlocking {
                repository.listBtcBillPays(
                    FamilyMember.VICTOR,
                    RowVisibilityScope.VISIBLE,
                    limit = 3,
                )
            },
            "listBtcBillPays",
        )
        assertEquals("bp030", billPays.rows[0].id)
        assertEquals(30_673L, billPays.rows[0].amountUsdCents)
        assertEquals(481_122L, billPays.rows[0].btcSpentSats)
        assertEquals(6_375_306L, billPays.rows[0].btcPriceCents)
        assertEquals(0L, billPays.rows[0].feeUsdCents)

        val counts = requireOk(
            runBlocking { repository.rowCounts() },
            "rowCounts",
        )
        assertEquals(911L, counts.transactions)
        assertEquals(25L, counts.todos)
        assertEquals(33L, counts.btcBuys)
        assertEquals(31L, counts.btcBillPays)
        assertEquals(0L, counts.btcAccounts)

        val budget = requireOk(
            runBlocking {
                repository.getBudgetDocument(
                    FamilyMember.VICTOR,
                    BudgetQueryScope.NET_WORTH,
                )
            },
            "getBudgetDocument",
        )
        assertEquals(true, budget.complete)
        assertEquals(null, budget.document)

        val accounts = requireOk(
            runBlocking {
                repository.listBtcAccounts(
                    FamilyMember.VICTOR,
                    RowVisibilityScope.VISIBLE,
                )
            },
            "listBtcAccounts",
        )
        assertEquals(false, accounts.complete)
        assertEquals(emptyList(), accounts.rows)
    }

    private fun <T> requireOk(result: ConvexResult<T>, query: String): T =
        (result as? ConvexResult.Ok)?.value
            ?: fail("production golden $query did not decode (${result::class.simpleName})")

    private class GoldenPoster : HttpPoster {
        override suspend fun postJson(url: String, body: String): HttpTextResponse {
            val request = Json.parseToJsonElement(body).jsonObject
            val path = request.getValue("path").jsonPrimitive.content
            val format = request.getValue("format").jsonPrimitive.content
            val query = QUERY_NAMES[path]
                ?: error("no committed production golden for $path")
            return HttpTextResponse(200, goldenFixture("$query.$format.json").readText())
        }
    }

    private companion object {
        const val DEPLOYMENT = "https://example.invalid"
        val QUERY_NAMES = mapOf(
            "tables:rowCounts" to "rowCounts",
            "tables:listTransactions" to "listTransactions",
            "tables:listTodos" to "listTodos",
            "tables:listBtcBuys" to "listBtcBuys",
            "tables:listBtcAccounts" to "listBtcAccounts",
            "tables:listBtcBillPays" to "listBtcBillPays",
            "tables:getBudgetDocument" to "getBudgetDocument",
        )

        fun goldenFixture(name: String): File {
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
}
