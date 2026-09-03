package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.fail
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Contract tests against the committed synthetic Convex wire fixtures.
 *
 * These fixtures pin the wire format (field sets, int64 tagging, envelope
 * shapes) with clearly fake values; they carry no production household data.
 */
class ConvexWireGoldenValuesTest {
    @Test
    fun `synthetic captures decode to the expected fixture values`() {
        val repository = RowQueryRepositories.convex(
            configSource = MutableConvexConfigSource(
                ConvexConfig(DEPLOYMENT, "fixture-only-token", remoteReadEnabled = true),
            ),
            http = GoldenPoster(),
        )

        val rawTransactions = Json.parseToJsonElement(
            goldenFixture("listTransactions.json.json").readText(),
        ).jsonObject.getValue("value").jsonObject
            .getValue("rows").jsonArray[0].jsonObject
        assertEquals("1000", rawTransactions.getValue("amountCents").jsonPrimitive.content)
        assertEquals("1000", rawTransactions.getValue("spendAmount").jsonPrimitive.content)
        assertEquals(false, rawTransactions.getValue("hasOppositeSpendSign").jsonPrimitive.boolean)
        val transactions = requireOk(
            runBlocking {
                repository.listTransactions(FamilyMember.VICTOR, limit = 3)
            },
            "listTransactions",
        )
        assertEquals(1_000L, transactions.rows[0].amount)
        assertEquals(1_000L, transactions.rows[0].spendAmount)
        assertEquals(1_000L, transactions.rows[0].displaySpendAmount)
        assertEquals(false, transactions.rows[0].hasOppositeSpendSign)

        val todos = requireOk(
            runBlocking {
                repository.listTodos(FamilyMember.VICTOR, limit = 3)
            },
            "listTodos",
        )
        assertEquals("00000000-0000-4000-8000-000000000001", todos.rows[0].id)
        assertEquals("Sample", todos.rows[0].project)
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
        assertEquals("sample-buy-0000000001", buys.rows[0].id)
        assertEquals(100_000L, buys.rows[0].sats)
        assertEquals(500_000L, buys.rows[0].priceUsdCents)
        assertEquals(500_000L, buys.rows[0].usdCents)
        assertEquals(0L, buys.rows[0].feeUsdCents)

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
        assertEquals("sample-billpay-000000001", billPays.rows[0].id)
        assertEquals(120_000L, billPays.rows[0].amountUsdCents)
        assertEquals(24_000_000L, billPays.rows[0].btcSpentSats)
        assertEquals(500_000L, billPays.rows[0].btcPriceCents)
        assertEquals(0L, billPays.rows[0].feeUsdCents)

        val counts = requireOk(
            runBlocking { repository.rowCounts() },
            "rowCounts",
        )
        assertEquals(10L, counts.transactions)
        assertEquals(3L, counts.todos)
        assertEquals(5L, counts.btcBuys)
        assertEquals(5L, counts.btcBillPays)
        assertEquals(3L, counts.btcAccounts)

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
        val budgetDocument = requireNotNull(budget.document)
        assertEquals(FamilyMember.VICTOR, budgetDocument.owner)
        assertEquals("June 2099", budgetDocument.month)
        assertEquals(0L, budgetDocument.coinbaseOneBalanceCents)
        assertEquals("Sample Category 1", budgetDocument.categories[0].name)
        assertEquals(400_000L, budgetDocument.categories[0].budgetCents)
        assertEquals("January 2099", budgetDocument.monthlyHistory[0].month)
        assertEquals(2_500L, budgetDocument.monthlyHistory[0].savingsBps)

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
        assertEquals(3, accounts.rows.size)
        assertEquals("sample-account-01", accounts.rows[0].key)
        assertEquals(FamilyMember.MASON, accounts.rows[0].owner)
        assertEquals(100_000_000L, accounts.rows[0].sats)
        assertNull(
            accounts.rows[0].fiatValuation,
            "convex_encoded_json must not promote the legacy zero to an available valuation",
        )

        val rawAccount = Json.parseToJsonElement(
            goldenFixture("listBtcAccounts.json.json").readText(),
        ).jsonObject.getValue("value").jsonObject
            .getValue("rows").jsonArray[0].jsonObject
        assertEquals("100000000", rawAccount.getValue("sats").jsonPrimitive.content)
        assertEquals("0", rawAccount.getValue("fiatCents").jsonPrimitive.content)
    }

    private fun <T> requireOk(result: ConvexResult<T>, query: String): T =
        (result as? ConvexResult.Ok)?.value
            ?: fail("wire golden $query did not decode (${result::class.simpleName})")

    private class GoldenPoster : HttpPoster {
        override suspend fun postJson(url: String, body: String): HttpTextResponse {
            val request = Json.parseToJsonElement(body).jsonObject
            val path = request.getValue("path").jsonPrimitive.content
            val format = request.getValue("format").jsonPrimitive.content
            val query = QUERY_NAMES[path]
                ?: error("no committed wire golden for $path")
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
