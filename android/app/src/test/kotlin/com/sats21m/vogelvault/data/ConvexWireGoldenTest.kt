package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember
import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

/**
 * Contract tests against responses captured from the production Convex HTTP API.
 *
 * These fixtures are observations of the wire format, not hand-authored payloads
 * shaped to match this decoder.
 */
class ConvexWireGoldenTest {
    @Test
    fun `production convex encoded payloads validate through the real row repository`() {
        val failures = buildList {
            verifyStaleTransactionProjectionUsesCanonicalAmount()?.let(::add)
            verifyOk("listTodos") {
                it.listTodos(FamilyMember.VICTOR)
            }?.let(::add)
            verifyOk("listBtcBuys") {
                it.listBtcBuys(FamilyMember.VICTOR, RowVisibilityScope.VISIBLE)
            }?.let(::add)
            verifyOk("listBtcBillPays") {
                it.listBtcBillPays(FamilyMember.VICTOR, RowVisibilityScope.VISIBLE)
            }?.let(::add)
            verifyOk("listBtcAccounts") {
                it.listBtcAccounts(FamilyMember.VICTOR, RowVisibilityScope.VISIBLE)
            }?.let(::add)
            verifyOk("getBudgetDocument") {
                it.getBudgetDocument(FamilyMember.VICTOR, BudgetQueryScope.NET_WORTH)
            }?.let(::add)
            verifyOk("rowCounts") {
                it.rowCounts()
            }?.let(::add)
        }

        assertTrue(
            failures.isEmpty(),
            failures.joinToString(
                prefix = "Production convex_encoded_json captures failed to decode:\n",
                separator = "\n",
            ),
        )
    }

    private fun verifyStaleTransactionProjectionUsesCanonicalAmount(): String? {
        val repository = repositoryFor("listTransactions")
        val result = runBlocking {
            repository.listTransactions(FamilyMember.VICTOR)
        }
        val snapshot = (result as? ConvexResult.Ok)?.value
            ?: return "listTransactions: expected stale production projection to decode, got $result"
        val transaction = snapshot.rows.firstOrNull()
            ?: return "listTransactions: production capture decoded with no rows"
        return when {
            transaction.amount != 27_918L ->
                "listTransactions: expected canonical amount 27918, got ${transaction.amount}"
            transaction.spendAmount != 27_918L ->
                "listTransactions: expected locally derived spend 27918, got ${transaction.spendAmount}"
            transaction.displaySpendAmount != 27_918L ->
                "listTransactions: expected locally derived display spend 27918, got ${transaction.displaySpendAmount}"
            transaction.hasOppositeSpendSign ->
                "listTransactions: expected locally derived opposite-sign flag false"
            else -> null
        }
    }

    private fun verifyOk(
        query: String,
        execute: suspend (RowQueryRepository) -> ConvexResult<*>,
    ): String? {
        val repository = repositoryFor(query)
        val result = runBlocking { execute(repository) }
        return if (result is ConvexResult.Ok) null else "$query: $result"
    }

    private fun repositoryFor(query: String): RowQueryRepository {
        val poster = RecordingPoster(
            HttpTextResponse(
                code = 200,
                body = goldenFixture("$query.convex_encoded_json.json").readText(),
            ),
        )
        val repository = RowQueryRepositories.convex(
            configSource = MutableConvexConfigSource(
                ConvexConfig(DEPLOYMENT, testToken(), remoteReadEnabled = true),
            ),
            http = poster,
        )
        return repository
    }

    private fun goldenFixture(name: String): File {
        val workingDirectory = requireNotNull(System.getProperty("user.dir"))
        var directory = File(workingDirectory).absoluteFile
        while (true) {
            val candidate = File(directory, "shared/domain/fixtures/convex-wire-golden/$name")
            if (candidate.isFile) return candidate
            directory = directory.parentFile
                ?: error("Could not locate convex-wire-golden/$name from $workingDirectory")
        }
    }

    private companion object {
        const val DEPLOYMENT = "https://keen-elephant-452.convex.cloud"
    }
}
