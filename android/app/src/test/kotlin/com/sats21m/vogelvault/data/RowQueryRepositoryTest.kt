package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
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
                """[{"txId":"tx-1","owner":"victor","date":"2026-07-25","month":"2026-07","merchant":"Cafe","amountCents":${convexInt64(14218)},"spendAmount":${convexInt64(14218)},"displaySpendAmount":${convexInt64(14218)},"hasOppositeSpendSign":false,"category":"Food","card":"visa","note":"lunch","updatedAtMs":1785000000000.0}]""",
            ),
        )
        val repository = repositoryWith(poster)

        val result = runBlocking { repository.listTransactions(FamilyMember.RACHEL, month = "2026-07", limit = 25) }
        val snapshot = (result as? ConvexResult.Ok)?.value ?: fail("expected Ok, got $result")

        assertEquals(14_218L, snapshot.rows.single().amount)
        assertEquals(14_218L, snapshot.rows.single().spendAmount)
        assertEquals(14_218L, snapshot.rows.single().displaySpendAmount)
        assertFalse(snapshot.rows.single().hasOppositeSpendSign)
        assertEquals(FamilyMember.VICTOR, snapshot.rows.single().owner)
        assertEquals(true, snapshot.complete)
        val args = sentArgs(poster)
        assertEquals("rachel", args["viewer"]?.jsonPrimitive?.content)
        assertEquals("2026-07", args["month"]?.jsonPrimitive?.content)
        assertEquals(25, args["limit"]?.jsonPrimitive?.int)
    }

    @Test
    fun `sat income rows preserve exact sats and remote revision`() {
        val revision = 1_777_777_777_777L
        val poster = RecordingPoster(
            rowSuccess(
                """[{"txId":"income-1","owner":"victor","date":"2026-08-01","month":"2026-08","merchant":"Bitcoin income","amountCents":${convexInt64(8000)},"spendAmount":${convexInt64(0)},"displaySpendAmount":${convexInt64(0)},"hasOppositeSpendSign":false,"category":"Income","card":"river","amountSats":${convexInt64(123456)},"bitcoinAccountKey":"river-wallet","updatedAtMs":$revision.0}]""",
            ),
        )

        val result = runBlocking {
            repositoryWith(poster).listTransactions(FamilyMember.VICTOR, month = "2026-08")
        }
        val row = (result as? ConvexResult.Ok)?.value?.rows?.single()
            ?: fail("expected one decoded sat-Income row, got $result")

        assertEquals(123_456L, row.amountSats)
        assertEquals("river-wallet", row.bitcoinAccountKey)
        assertEquals(revision, row.updatedAtMs)
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
    fun `unknown response envelope and row fields are ignored`() {
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{
                    "status":"success",
                    "value":{
                        "rows":[{
                            "txId":"tx-1",
                            "owner":"victor",
                            "date":"2026-07-25",
                            "month":"2026-07",
                            "merchant":"Cafe",
                            "amountCents":${convexInt64(500)},
                            "spendAmount":${convexInt64(500)},
                            "displaySpendAmount":${convexInt64(500)},
                            "hasOppositeSpendSign":false,
                            "category":"Food",
                            "updatedAtMs":1785000000000.0,
                            "futureRowField":{"nested":true}
                        }],
                        "complete":true,
                        "futureEnvelopeField":"ignored"
                    },
                    "futureResponseField":42
                }""".trimIndent(),
            ),
        )

        val result = runBlocking {
            repositoryWith(poster).listTransactions(FamilyMember.VICTOR)
        }
        val transaction = (result as? ConvexResult.Ok)?.value?.rows?.single()
            ?: fail("expected forward-compatible row, got $result")

        assertEquals("tx-1", transaction.id)
        assertEquals(500L, transaction.spendAmount)
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
                    ${transaction("tx-1", "victor", convexInt64(-500))},
                    ${transaction("tx-2", "Mason ", convexInt64(900))}
                ]""".trimIndent(),
            ),
        )

        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking { repositoryWith(poster).listTransactions(FamilyMember.VICTOR) },
        )
    }

    @Test
    fun `convex encoded rows reject an untagged int64 alias atomically`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[
                    ${transaction("tx-1", "victor", convexInt64(-500))},
                    ${transaction("tx-2", "mason", "900")}
                ]""".trimIndent(),
            ),
        )

        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking { repositoryWith(poster).listTransactions(FamilyMember.VICTOR) },
        )
        assertEquals(
            "convex_encoded_json",
            Json.parseToJsonElement(poster.bodies.single())
                .jsonObject["format"]
                ?.jsonPrimitive
                ?.content,
        )
    }

    @Test
    fun `missing canonical transaction amount rejects the entire row envelope`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[{"txId":"tx-1","owner":"victor","date":"2026-07-25","month":"2026-07","merchant":"Cafe","spendAmount":${convexInt64(500)},"displaySpendAmount":${convexInt64(500)},"hasOppositeSpendSign":false,"category":"Food","updatedAtMs":1785000000000.0}]""",
            ),
        )

        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking { repositoryWith(poster).listTransactions(FamilyMember.VICTOR) },
        )
    }

    @Test
    fun `minimum int64 canonical transaction amount rejects the entire row envelope`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[{"txId":"tx-1","owner":"victor","date":"2026-07-25","month":"2026-07","merchant":"Refund","amountCents":${convexInt64(Long.MIN_VALUE)},"spendAmount":${convexInt64(Long.MIN_VALUE)},"displaySpendAmount":${convexInt64(Long.MIN_VALUE)},"hasOppositeSpendSign":true,"category":"Food","updatedAtMs":1785000000000.0}]""",
            ),
        )

        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking { repositoryWith(poster).listTransactions(FamilyMember.VICTOR) },
        )
    }

    @Test
    fun `missing transaction date or month rejects the entire row envelope`() {
        val missingDate =
            """{"txId":"tx-1","owner":"victor","month":"2026-07","merchant":"Cafe","amountCents":${convexInt64(500)},"spendAmount":${convexInt64(500)},"displaySpendAmount":${convexInt64(500)},"hasOppositeSpendSign":false,"category":"Food","updatedAtMs":1785000000000.0}"""
        val missingMonth =
            """{"txId":"tx-1","owner":"victor","date":"2026-07-25","merchant":"Cafe","amountCents":${convexInt64(500)},"spendAmount":${convexInt64(500)},"displaySpendAmount":${convexInt64(500)},"hasOppositeSpendSign":false,"category":"Food","updatedAtMs":1785000000000.0}"""

        for (row in listOf(missingDate, missingMonth)) {
            val poster = RecordingPoster(rowSuccess("[$row]"))
            assertEquals(
                ConvexResult.Failed("unexpected payload shape"),
                runBlocking { repositoryWith(poster).listTransactions(FamilyMember.VICTOR) },
            )
        }
    }

    @Test
    fun `malformed or contradictory transaction dates reject the entire row envelope`() {
        val invalidDateMonthPairs = listOf(
            "2026-7-25" to "2026-07",
            "2026-02-30" to "2026-02",
            "not-a-date" to "2026-07",
            "2026-07-25" to "2026-06",
        )

        for ((date, month) in invalidDateMonthPairs) {
            val poster = RecordingPoster(
                rowSuccess(
                    """[{"txId":"tx-1","owner":"victor","date":"$date","month":"$month","merchant":"Cafe","amountCents":${convexInt64(500)},"spendAmount":${convexInt64(500)},"displaySpendAmount":${convexInt64(500)},"hasOppositeSpendSign":false,"category":"Food","updatedAtMs":1785000000000.0}]""",
                ),
            )

            assertEquals(
                ConvexResult.Failed("unexpected payload shape"),
                runBlocking { repositoryWith(poster).listTransactions(FamilyMember.VICTOR) },
                "accepted date=$date month=$month",
            )
        }
    }

    @Test
    fun `invalid transaction query month fails before transport`() {
        val poster = RecordingPoster(rowSuccess("[]"))

        assertFailsWith<IllegalArgumentException> {
            runBlocking {
                repositoryWith(poster).listTransactions(
                    FamilyMember.VICTOR,
                    month = "2026-13",
                )
            }
        }
        assertEquals(emptyList(), poster.bodies)
    }

    @Test
    fun `missing envelope completeness rejects the transaction snapshot`() {
        val poster = RecordingPoster(success("""{"rows":[]}"""))

        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking { repositoryWith(poster).listTransactions(FamilyMember.VICTOR) },
        )
    }

    @Test
    fun `opposite spend sign flag accepts a refund and preserves its display magnitude`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[{"txId":"tx-1","owner":"victor","date":"2026-07-25","month":"2026-07","merchant":"Refund","amountCents":${convexInt64(-500)},"spendAmount":${convexInt64(-500)},"displaySpendAmount":${convexInt64(500)},"hasOppositeSpendSign":true,"category":"Food","updatedAtMs":1785000000000.0}]""",
            ),
        )

        val result = runBlocking {
            repositoryWith(poster).listTransactions(FamilyMember.VICTOR)
        }
        val refund = (result as? ConvexResult.Ok)?.value?.rows?.single()
            ?: fail("expected refund row, got $result")

        assertEquals(-500L, refund.spendAmount)
        assertEquals(500L, refund.displaySpendAmount)
        assertEquals(true, refund.hasOppositeSpendSign)
    }

    @Test
    fun `stale server projection is accepted and replaced by canonical amount derivation`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[{"txId":"tx-1","owner":"victor","date":"2026-07-25","month":"2026-07","merchant":"Cafe","amountCents":${convexInt64(500)},"spendAmount":${convexInt64(-500)},"displaySpendAmount":${convexInt64(500)},"hasOppositeSpendSign":true,"category":"Food","updatedAtMs":1785000000000.0}]""",
            ),
        )

        val result = runBlocking {
            repositoryWith(poster).listTransactions(FamilyMember.VICTOR)
        }
        val transaction = (result as? ConvexResult.Ok)?.value?.rows?.single()
            ?: fail("expected stale projection row to decode, got $result")

        assertEquals(500L, transaction.amount)
        assertEquals(500L, transaction.spendAmount)
        assertEquals(500L, transaction.displaySpendAmount)
        assertFalse(transaction.hasOppositeSpendSign)
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
    fun `standalone BTC accounts preserve explicit rounded zero and reject malformed valuation`() {
        val available = RecordingPoster(
            rowSuccess(
                """[{"key":"tiny","owner":"victor","label":"Tiny","custody":"self_custody","sats":${convexInt64(1)},"fiatValuation":{"cents":${convexInt64(0)},"priceCents":${convexInt64(6000000)},"quotedAt":"2026-07-29T12:00:00Z","source":"fixture quote","confidence":"verified"},"asOf":"2026-07-29","schemaVersion":${convexInt64(3)},"updatedAtMs":0.0}]""",
            ),
        )
        val account = (
            runBlocking {
                repositoryWith(available).listBtcAccounts(
                    FamilyMember.VICTOR,
                    RowVisibilityScope.NET_WORTH,
                )
            } as? ConvexResult.Ok
        )?.value?.rows?.single() ?: fail("expected explicit valuation")

        assertEquals(1L, account.sats)
        assertEquals(0L, assertNotNull(account.fiatValuation).cents)
        assertEquals("verified", account.fiatValuation?.confidence)

        val malformed = RecordingPoster(
            rowSuccess(
                """[{"key":"tiny","owner":"victor","label":"Tiny","custody":"self_custody","sats":${convexInt64(1)},"fiatValuation":{"cents":"0"},"asOf":"2026-07-29","schemaVersion":${convexInt64(3)},"updatedAtMs":0.0}]""",
            ),
        )
        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking {
                repositoryWith(malformed).listBtcAccounts(
                    FamilyMember.VICTOR,
                    RowVisibilityScope.NET_WORTH,
                )
            },
        )
    }

    @Test
    fun `bill pay money and row counts decode strictly`() {
        val billPoster = RecordingPoster(
            rowSuccess(
                """[{"billPayId":"bp-1","owner":"victor","date":"2026-07-20","month":"2026-07","merchant":"Utility","category":"Bills","amountUsdCents":${convexInt64(12500)},"btcSpentSats":${convexInt64(13000)},"btcPriceCents":${convexInt64(9600000)},"feeUsdCents":${convexInt64(25)},"updatedAtMs":1785000000000.0}]""",
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
                """{"transactions":905,"todos":25,"btcBuys":31,"btcBillPays":4,"btcAccounts":7,"income":16,"balanceDocuments":1,"budgetDocuments":2,"btcBalanceDocuments":2,"financeDocuments":1,"futureTable":99}""",
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
                income = 16,
                balanceDocuments = 1,
                budgetDocuments = 2,
                btcBalanceDocuments = 2,
                financeDocuments = 1,
            ),
            (countResult as ConvexResult.Ok).value,
        )
    }

    @Test
    fun `budget document decodes tagged money including savings basis points`() {
        // Production currently returns document:null, so savingsBps can only be
        // pinned here against the schema's v.int64() contract.
        val response = """{
            "document":{
                "owner":"victor",
                "month":"2026-07",
                "coinbaseOneBalanceCents":${convexInt64(12550)},
                "categories":[{"name":"Groceries","icon":"cart","budgetCents":${convexInt64(90000)}}],
                "effectiveApr":"4.5%",
                "strategyNote":"Synthetic fixture",
                "income":{
                    "weeklyGrossCents":${convexInt64(120000)},
                    "weeklyStrikeCents":${convexInt64(10000)},
                    "weeklyRiverCents":${convexInt64(5000)},
                    "payFrequency":"weekly",
                    "monthlyGrossCents":${convexInt64(480000)},
                    "mtdIncomeCents":${convexInt64(250000)},
                    "ytdIncomeCents":${convexInt64(3000000)},
                    "paychecks":[{"date":"2026-07-19","platform":"direct","source":"employer","amountCents":${convexInt64(250000)},"netCents":${convexInt64(250000)}}]
                },
                "mtdIncomeCents":${convexInt64(250000)},
                "ytdIncomeCents":${convexInt64(3000000)},
                "monthlyHistory":[{"month":"2026-06","incomeCents":${convexInt64(480000)},"expensesCents":${convexInt64(320000)},"savingsBps":${convexInt64(3333)}}],
                "updatedAtMs":1785000000000.0
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
        assertEquals(3_333L, snapshot.document?.monthlyHistory?.single()?.savingsBps)
        assertEquals("netWorth", sentArgs(poster)["scope"]?.jsonPrimitive?.content)
        assertEquals("tables:getBudgetDocument", sentPath(poster))
    }

    @Test
    fun `snapshot metadata rejects unknown owners atomically`() {
        val poster = RecordingPoster(
            rowSuccess(
                """[
                    {"owner":"victor","schemaVersion":${convexInt64(2)},"asOf":"2026-07-18T12:00:00Z","updatedAtMs":1785000000000.0},
                    {"owner":"other","schemaVersion":${convexInt64(2)},"asOf":"2026-07-18T12:00:00Z","updatedAtMs":1785000000000.0}
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
    fun `income rows decode the production row shape and reject malformed money`() {
        val valid = RecordingPoster(
            rowSuccess(
                """[{"incomeId":"income-01","owner":"victor","date":"2026-01-01","month":"2026-01","amountCents":${convexInt64(123456)},"source":"payroll","loggedBy":"victor","note":"production-shaped income fixture","archimedesRequestId":"income-arch-0","updatedAtMs":0.0}]""",
            ),
        )
        val result = runBlocking {
            repositoryWith(valid).listIncome(FamilyMember.RACHEL, month = "2026-01")
        }
        val row = (result as? ConvexResult.Ok)?.value?.rows?.single()
            ?: fail("expected production-shaped income row, got $result")

        assertEquals("income-01", row.id)
        assertEquals(123_456L, row.amountCents)
        assertEquals(FamilyMember.VICTOR, row.owner)
        assertEquals("tables:listIncome", sentPath(valid))
        assertEquals("convex_encoded_json", sentFormat(valid))

        val malformed = RecordingPoster(
            rowSuccess(
                """[{"incomeId":"income-01","owner":"victor","date":"2026-01-01","month":"2026-01","amountCents":"123456","source":"payroll","updatedAtMs":0.0}]""",
            ),
        )
        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking { repositoryWith(malformed).listIncome(FamilyMember.RACHEL) },
        )
    }

    @Test
    fun `btc balance documents decode exact totals and reject malformed sats`() {
        val valid = RecordingPoster(
            rowSuccess(
                """[{"owner":"victor","schemaVersion":${convexInt64(2)},"asOf":"2026-07-18T12:00:00Z","accounts":[{"key":"strike","label":"Strike","custody":"exchange","sats":${convexInt64(35000000)},"fiatCents":${convexInt64(3430055)}},{"key":"coldcard","label":"Coldcard","custody":"self_custody","sats":${convexInt64(150000000)},"fiatCents":${convexInt64(14700000)}}],"totals":{"sats":${convexInt64(185000000)},"fiatCents":${convexInt64(18130055)},"exchangeSats":${convexInt64(35000000)},"selfCustodySats":${convexInt64(150000000)}},"source":"synthetic","basis":"spot","confidence":"verified","updatedAtMs":0.0}]""",
            ),
        )
        val result = runBlocking {
            repositoryWith(valid).listBtcBalanceDocuments(
                FamilyMember.RACHEL,
                RowVisibilityScope.NET_WORTH,
            )
        }
        val document = (result as? ConvexResult.Ok)?.value?.rows?.single()
            ?: fail("expected production-shaped BTC balance document, got $result")

        assertEquals(185_000_000L, document.totals.sats)
        assertEquals(18_130_055L, document.totals.fiatCents)
        assertEquals(18_130_055L, document.totals.fiatValuation?.cents)
        assertEquals("verified", document.balanceConfidence)
        assertEquals(150_000_000L, document.accounts.last().sats)
        assertEquals("tables:listBtcBalanceDocuments", sentPath(valid))
        assertEquals("convex_encoded_json", sentFormat(valid))

        val malformed = RecordingPoster(
            rowSuccess(
                """[{"owner":"victor","schemaVersion":${convexInt64(2)},"asOf":"2026-07-18T12:00:00Z","accounts":[],"totals":{"sats":1.85,"fiatCents":${convexInt64(18130055)},"exchangeSats":${convexInt64(35000000)},"selfCustodySats":${convexInt64(150000000)}},"updatedAtMs":0.0}]""",
            ),
        )
        assertEquals(
            ConvexResult.Failed("unexpected payload shape"),
            runBlocking {
                repositoryWith(malformed).listBtcBalanceDocuments(
                    FamilyMember.RACHEL,
                    RowVisibilityScope.NET_WORTH,
                )
            },
        )
    }

    @Test
    fun `production-shaped BTC document keeps sats available and fiat unavailable`() {
        val production = RecordingPoster(
            rowSuccess(
                """[{"owner":"victor","schemaVersion":${convexInt64(2)},"asOf":"2026-07-16T01:56:49Z","accounts":[{"key":"cold","label":"Cold storage","custody":"self_custody","sats":${convexInt64(541782856)},"fiatCents":${convexInt64(0)}}],"totals":{"sats":${convexInt64(541782856)},"fiatCents":${convexInt64(0)},"exchangeSats":${convexInt64(0)},"selfCustodySats":${convexInt64(541782856)}},"source":"authoritative reconciliation","basis":"self-custody screenshot","confidence":"high","updatedAtMs":0.0}]""",
            ),
        )
        val document = (
            runBlocking {
                repositoryWith(production).listBtcBalanceDocuments(
                    FamilyMember.RACHEL,
                    RowVisibilityScope.NET_WORTH,
                )
            } as? ConvexResult.Ok
        )?.value?.rows?.single() ?: fail("expected production-shaped document")

        assertEquals(541_782_856L, document.totals.sats)
        assertNull(document.totals.fiatValuation)
        assertNull(document.accounts.single().fiatValuation)
        assertEquals("high", document.balanceConfidence)
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

    private fun sentFormat(poster: RecordingPoster): String =
        Json.parseToJsonElement(poster.bodies.single()).jsonObject["format"]!!.jsonPrimitive.content

    private fun transaction(id: String, owner: String, amount: String): String =
        """{"txId":"$id","owner":"$owner","date":"2026-07-25","month":"2026-07","merchant":"Cafe","amountCents":$amount,"spendAmount":${convexInt64(500)},"displaySpendAmount":${convexInt64(500)},"hasOppositeSpendSign":false,"category":"Food","updatedAtMs":1785000000000.0}"""

    private fun account(key: String, owner: String, custody: String, sats: Long): String =
        """{"key":"$key","owner":"$owner","label":"$key","custody":"$custody","sats":${convexInt64(sats)},"fiatCents":${convexInt64(20)},"asOf":"2026-07-18T12:00:00Z","schemaVersion":${convexInt64(2)},"updatedAtMs":1785000000000.0}"""

    /**
     * Synthetic tagged values are reserved for focused validation cases.
     * Production wire compatibility is covered by [ConvexWireGoldenTest].
     */
    private fun convexInt64(value: Long): String {
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
