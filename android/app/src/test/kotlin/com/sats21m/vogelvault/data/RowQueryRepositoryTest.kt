package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.fail
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class RowQueryRepositoryTest {
    @Test
    fun `transaction rows decode exact int64 money and preserve completeness`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[{"txId":"tx-1","owner":"victor","date":"2026-07-25","month":"2026-07","merchant":"Cafe","amountCents":${int64(-14218)},"spendAmount":${int64(14218)},"displaySpendAmount":${int64(14218)},"hasOppositeSpendSign":false,"category":"Food","card":"visa","note":"lunch","updatedAtMs":1785000000000}]""",
            ),
        )
        val repository = repositoryWith(poster)

        val result = runBlocking { repository.listTransactions(FamilyMember.RACHEL, month = "2026-07", limit = 25) }
        val snapshot = (result as? ConvexResult.Ok)?.value ?: fail("expected Ok, got $result")

        assertEquals(-14_218L, snapshot.rows.single().amount)
        assertEquals(14_218L, snapshot.rows.single().signedSpendContribution)
        assertEquals(14_218L, snapshot.rows.single().rowDisplaySpendAmount)
        assertEquals(FamilyMember.VICTOR, snapshot.rows.single().owner)
        assertEquals(true, snapshot.complete)
        val args = sentArgs(poster)
        assertEquals("rachel", args["viewer"]?.jsonPrimitive?.content)
        assertEquals("2026-07", args["month"]?.jsonPrimitive?.content)
        assertEquals(25, args["limit"]?.jsonPrimitive?.int)
    }

    @Test
    fun `bounded incomplete snapshots remain explicitly incomplete`() {
        val poster = RecordingPoster(rowSuccess("[]", complete = false))

        val result = runBlocking { repositoryWith(poster).listTransactions(FamilyMember.VICTOR, limit = 1) }
        val snapshot = (result as ConvexResult.Ok).value

        assertFalse(snapshot.complete)
        assertEquals(emptyList(), snapshot.rows)
    }

    @Test
    fun `typed todo args stay boolean and numeric on the wire`() {
        val poster = RecordingPoster(rowSuccess("[]"))
        val repository = repositoryWith(poster)

        runBlocking { repository.listTodos(FamilyMember.MASON, done = false, limit = 12) }

        val args = sentArgs(poster)
        assertEquals(false, args["done"]?.jsonPrimitive?.boolean)
        assertEquals(12, args["limit"]?.jsonPrimitive?.int)
        assertEquals("tables:listTodos", sentPath(poster))
    }

    @Test
    fun `bitcoin queries require and send explicit visibility scope`() {
        val poster = RecordingPoster(rowSuccess("[]"))
        val repository = repositoryWith(poster)

        runBlocking { repository.listBtcBuys(FamilyMember.VICTOR, RowVisibilityScope.NET_WORTH) }

        assertEquals("netWorth", sentArgs(poster)["scope"]?.jsonPrimitive?.content)
        assertEquals("tables:listBtcBuys", sentPath(poster))
    }

    @Test
    fun `one unknown owner rejects the entire row envelope`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[
                    ${transaction("tx-1", "victor", int64(-500))},
                    ${transaction("tx-2", "Mason ", int64(900))}
                ]""".trimIndent(),
            ),
        )

        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking { repositoryWith(poster).listTransactions(FamilyMember.VICTOR) },
        )
    }

    @Test
    fun `one numeric int64 fallback rejects the entire row envelope`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[
                    ${transaction("tx-1", "victor", int64(-500))},
                    ${transaction("tx-2", "mason", "900")}
                ]""".trimIndent(),
            ),
        )

        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking { repositoryWith(poster).listTransactions(FamilyMember.VICTOR) },
        )
    }

    @Test
    fun `negative signed refund decodes with opposite spend sign`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[{"txId":"tx-1","owner":"victor","date":"2026-07-25","month":"2026-07","merchant":"Refund","amountCents":${int64(500)},"spendAmount":${int64(-500)},"displaySpendAmount":${int64(500)},"hasOppositeSpendSign":true,"category":"Food","updatedAtMs":1785000000000}]""",
            ),
        )

        val result = runBlocking { repositoryWith(poster).listTransactions(FamilyMember.VICTOR) }
        val row = (result as? ConvexResult.Ok)?.value?.rows?.single() ?: fail("expected refund row")

        assertEquals(-500L, row.signedSpendContribution)
        assertEquals(500L, row.rowDisplaySpendAmount)
    }

    @Test
    fun `mismatched opposite spend sign rejects the entire transaction envelope`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[{"txId":"tx-1","owner":"victor","date":"2026-07-25","month":"2026-07","merchant":"Cafe","amountCents":${int64(-500)},"spendAmount":${int64(500)},"displaySpendAmount":${int64(500)},"hasOppositeSpendSign":true,"category":"Food","updatedAtMs":1785000000000}]""",
            ),
        )

        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking { repositoryWith(poster).listTransactions(FamilyMember.VICTOR) },
        )
    }

    @Test
    fun `unknown custody rejects every account atomically`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[
                    ${account("strike", "victor", "exchange", 10)},
                    ${account("coldcard", "mason", "custodial-ish", 30)}
                ]""".trimIndent(),
            ),
        )

        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking {
                repositoryWith(poster).listBtcAccounts(FamilyMember.VICTOR, RowVisibilityScope.VISIBLE)
            },
        )
    }

    @Test
    fun `valid accounts map only closed custody and owners`() {
        val poster = RecordingPoster(rowSuccess("[${account("coldcard", "mason", "self_custody", 123456)}]"))

        val result = runBlocking {
            repositoryWith(poster).listBtcAccounts(FamilyMember.VICTOR, RowVisibilityScope.VISIBLE)
        }
        val account = (result as? ConvexResult.Ok)?.value?.rows?.single()
            ?: fail("expected account, got $result")
        assertEquals(Custody.SELF_CUSTODY, account.custody)
        assertEquals(FamilyMember.MASON, account.owner)
        assertEquals(123_456L, account.sats)
    }

    @Test
    fun `bill pay money and current row counts decode while ignoring future fields`() {
        val billPoster = RecordingPoster(
            rowSuccess(
                """[{"billPayId":"bp-1","owner":"victor","date":"2026-07-20","month":"2026-07","merchant":"Utility","category":"Bills","amountUsdCents":${int64(12500)},"btcSpentSats":${int64(13000)},"btcPriceCents":${int64(9600000)},"feeUsdCents":${int64(25)},"updatedAtMs":1785000000000}]""",
            ),
        )
        val billResult = runBlocking {
            repositoryWith(billPoster).listBtcBillPays(
                FamilyMember.VICTOR,
                RowVisibilityScope.VISIBLE,
            )
        }
        val bill = (billResult as? ConvexResult.Ok)?.value?.rows?.single()
            ?: fail("expected bill pay, got $billResult")
        assertEquals(12_500L, bill.amountUsdCents)
        assertEquals(13_000L, bill.btcSpentSats)
        assertEquals("visible", sentArgs(billPoster)["scope"]?.jsonPrimitive?.content)

        val countPoster = RecordingPoster(
            success(
                """{"transactions":905,"todos":25,"btcBuys":31,"btcBillPays":4,"btcAccounts":7,"income":12,"balanceDocuments":2,"budgetDocuments":2,"btcBalanceDocuments":2,"financeDocuments":1,"futureProjectionCount":99}""",
            ),
        )
        val countResult = runBlocking { repositoryWith(countPoster).rowCounts() }
        assertEquals(
            RowCounts(
                transactions = 905,
                todos = 25,
                btcBuys = 31,
                btcBillPays = 4,
                btcAccounts = 7,
                income = 12,
                balanceDocuments = 2,
                budgetDocuments = 2,
                btcBalanceDocuments = 2,
                financeDocuments = 1,
            ),
            (countResult as ConvexResult.Ok).value,
        )
    }

    @Test
    fun `budget document decodes tagged money and closed owner`() {
        val response = """{
            "document":{
                "owner":"victor",
                "month":"2026-07",
                "coinbaseOneBalanceCents":${int64(12550)},
                "categories":[{"name":"Groceries","icon":"cart","budgetCents":${int64(90000)}}],
                "effectiveApr":"4.5%",
                "strategyNote":"Synthetic fixture",
                "income":{
                    "weeklyGrossCents":${int64(120000)},
                    "weeklyStrikeCents":${int64(10000)},
                    "weeklyRiverCents":${int64(5000)},
                    "payFrequency":"weekly",
                    "monthlyGrossCents":${int64(480000)},
                    "mtdIncomeCents":${int64(250000)},
                    "ytdIncomeCents":${int64(3000000)},
                    "paychecks":[{"date":"2026-07-19","platform":"direct","source":"employer","amountCents":${int64(250000)},"netCents":${int64(250000)}}]
                },
                "mtdIncomeCents":${int64(250000)},
                "ytdIncomeCents":${int64(3000000)},
                "monthlyHistory":[{"month":"2026-06","incomeCents":${int64(480000)},"expensesCents":${int64(320000)},"savingsBps":3333}],
                "updatedAtMs":1785000000000
            },
            "complete":true
        }""".trimIndent()
        val poster = RecordingPoster(success(response))

        val result = runBlocking {
            repositoryWith(poster).getBudgetDocument(FamilyMember.RACHEL, BudgetQueryScope.NET_WORTH)
        }
        val snapshot = (result as? ConvexResult.Ok)?.value ?: fail("expected budget, got $result")

        assertEquals(90_000L, snapshot.document?.categories?.single()?.budgetCents)
        assertEquals(250_000L, snapshot.document?.income?.paychecks?.single()?.netCents)
        assertEquals("netWorth", sentArgs(poster)["scope"]?.jsonPrimitive?.content)
        assertEquals("tables:getBudgetDocument", sentPath(poster))
    }

    @Test
    fun `snapshot metadata rejects unknown owners atomically`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[
                    {"owner":"victor","schemaVersion":${int64(2)},"asOf":"2026-07-18T12:00:00Z","updatedAtMs":1785000000000},
                    {"owner":"other","schemaVersion":${int64(2)},"asOf":"2026-07-18T12:00:00Z","updatedAtMs":1785000000000}
                ]""".trimIndent(),
            ),
        )

        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking {
                repositoryWith(poster).getBtcSnapshotMetadata(
                    FamilyMember.VICTOR,
                    RowVisibilityScope.VISIBLE,
                )
            },
        )
    }

    @Test
    fun `disabled row repository never attempts work`() = runBlocking {
        val repository = RowQueryRepositories.disabled()

        assertEquals(ConvexResult.Disabled, repository.listTransactions(FamilyMember.VICTOR))
        assertEquals(
            ConvexResult.Disabled,
            repository.listBtcAccounts(FamilyMember.VICTOR, RowVisibilityScope.NET_WORTH),
        )
        assertEquals(
            ConvexResult.Disabled,
            repository.getBudgetDocument(FamilyMember.VICTOR, BudgetQueryScope.NET_WORTH),
        )
        assertEquals(ConvexResult.Disabled, repository.rowCounts())
    }

    private fun repositoryWith(poster: RecordingPoster): RowQueryRepository =
        RowQueryRepositories.convex(
            configSource = MutableConvexConfigSource(
                ConvexConfig(DEPLOYMENT, testToken(), remoteReadEnabled = true),
            ),
            http = poster,
        )

    private fun success(value: String): HttpTextResponse =
        HttpTextResponse(200, """{"status":"success","value":$value}""")

    private fun rowSuccess(rows: String, complete: Boolean = true): HttpTextResponse =
        success("""{"rows":$rows,"complete":$complete}""")

    private fun sentArgs(poster: RecordingPoster) =
        Json.parseToJsonElement(poster.bodies.single()).jsonObject["args"]!!.jsonObject

    private fun sentPath(poster: RecordingPoster): String =
        Json.parseToJsonElement(poster.bodies.single()).jsonObject["path"]!!.jsonPrimitive.content

    private fun transaction(id: String, owner: String, amount: String): String =
        """{"txId":"$id","owner":"$owner","date":"2026-07-25","month":"2026-07","merchant":"Cafe","amountCents":$amount,"spendAmount":${int64(500)},"displaySpendAmount":${int64(500)},"hasOppositeSpendSign":false,"category":"Food","updatedAtMs":1785000000000}"""

    private fun account(key: String, owner: String, custody: String, sats: Long): String =
        """{"key":"$key","owner":"$owner","label":"$key","custody":"$custody","sats":${int64(sats)},"fiatCents":${int64(20)},"asOf":"2026-07-18T12:00:00Z","schemaVersion":${int64(2)},"updatedAtMs":1785000000000}"""

    private fun int64(value: Long): String {
        val bytes = ByteArray(Long.SIZE_BYTES)
        for (index in bytes.indices) {
            bytes[index] = ((value ushr (index * 8)) and 0xff).toByte()
        }
        val encoded = java.util.Base64.getEncoder().encodeToString(bytes)
        return "{\"\$integer\":\"$encoded\"}"
    }

    private companion object {
        const val DEPLOYMENT = "https://keen-elephant-452.convex.cloud"
    }
}
