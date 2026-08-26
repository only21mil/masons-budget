package com.sats21m.vogelvault.domain

import com.google.gson.Gson
import com.google.gson.JsonObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Parity suite for the family/visibility contract.
 *
 * Every case is driven by `shared/domain/fixtures/visibility-cases.json` — the
 * same file the TypeScript suite loads, ported case-for-case from
 * `MasonsBudgetTests/FamilyVisibilityTests.swift`. If the Swift suite changes,
 * the fixture changes in the same commit and all three clients move together.
 */
class FamilyParityTest {

    private val fixtures: JsonObject = loadFixtures()

    private fun loadFixtures(): JsonObject {
        // Walk up from the module dir to the repo root so the test works from
        // any Gradle invocation directory.
        var dir: File? = File(System.getProperty("user.dir"))
        while (dir != null) {
            val candidate = File(dir, "shared/domain/fixtures/visibility-cases.json")
            if (candidate.isFile) return Gson().fromJson(candidate.readText(), JsonObject::class.java)
            dir = dir.parentFile
        }
        error("Could not locate shared/domain/fixtures/visibility-cases.json from ${System.getProperty("user.dir")}")
    }

    private fun member(key: String): FamilyMember =
        FamilyMember.fromKeyOrNull(key) ?: error("Unknown member in fixture: $key")

    private fun pairCases(name: String) = fixtures.getAsJsonArray(name).map { it.asJsonObject }

    private fun memberCases(name: String) = fixtures.getAsJsonArray(name).map { it.asJsonObject }

    private fun memberCases(name: String, legacyName: String) =
        (fixtures.getAsJsonArray(name) ?: fixtures.getAsJsonArray(legacyName)).map { it.asJsonObject }

    private val members: List<FamilyMember>
        get() = fixtures.getAsJsonArray("members").map { member(it.asString) }

    // ── Core contract ───────────────────────────────────────────────────────

    @Test
    fun `canSee matches the Swift contract`() {
        for (case in pairCases("canSee")) {
            val viewer = member(case["viewer"].asString)
            val owner = member(case["owner"].asString)
            assertEquals(
                case["expected"].asBoolean,
                viewer.canSee(owner),
                "$viewer -> $owner",
            )
        }
    }

    @Test
    fun `every viewer and owner pair is covered`() {
        assertEquals(members.size * members.size, pairCases("canSee").size)
    }

    @Test
    fun `Rachel sees Victor's data - the v0_3 regression`() {
        assertTrue(FamilyMember.RACHEL.canSee(FamilyMember.VICTOR))
    }

    @Test
    fun `siblings stay isolated`() {
        assertFalse(FamilyMember.MASON.canSee(FamilyMember.MADDOX))
        assertFalse(FamilyMember.MADDOX.canSee(FamilyMember.MASON))
    }

    @Test
    fun `sharesNetWorth keeps child stacks out of adult totals`() {
        for (case in pairCases("sharesNetWorth")) {
            val viewer = member(case["viewer"].asString)
            val owner = member(case["owner"].asString)
            assertEquals(
                case["expected"].asBoolean,
                viewer.sharesNetWorth(owner),
                "$viewer -> $owner",
            )
        }
    }

    @Test
    fun `every viewer and owner net-worth pair is covered`() {
        assertEquals(members.size * members.size, pairCases("sharesNetWorth").size)
    }

    @Test
    fun `sharesNetWorth is strictly narrower than canSee`() {
        for (viewer in members) {
            for (owner in members) {
                if (viewer.sharesNetWorth(owner)) {
                    assertTrue(viewer.canSee(owner), "$viewer -> $owner")
                }
            }
        }
    }

    @Test
    fun `allowedSwitchTargets locks kids to their own profile`() {
        for (case in memberCases("allowedSwitchTargets")) {
            val subject = member(case["member"].asString)
            val expected = case.getAsJsonArray("expected").map { member(it.asString) }
            assertEquals(expected, subject.allowedSwitchTargets, subject.toString())
        }
    }

    @Test
    fun `showsFullBudget tracks adulthood`() {
        for (case in memberCases("showsFullBudget")) {
            val subject = member(case["member"].asString)
            assertEquals(case["expected"].asBoolean, subject.showsFullBudget)
            assertEquals(case["expected"].asBoolean, subject.isAdult)
        }
    }

    @Test
    fun `ledger owner keeps actor separate from financial ownership`() {
        for (case in memberCases("ledgerOwner")) {
            assertEquals(member(case["expected"].asString), member(case["member"].asString).ledgerOwner)
        }
    }

    @Test
    fun `legacy data file routing matches the Swift enum`() {
        // Accept the old fixture keys until the coordinated shared-domain PR
        // lands; the runtime symbols and preferred keys are neutral.
        for (case in memberCases("transactionsDataFileName", "mc2TransactionsFileName")) {
            assertEquals(case["expected"].asString, member(case["member"].asString).transactionsDataFileName)
        }
        for (case in memberCases("btcBuysDataFileName", "mc2BTCBuysFileName")) {
            assertEquals(case["expected"].asString, member(case["member"].asString).btcBuysDataFileName)
        }
        for (case in memberCases("hasDedicatedChildFinanceFiles", "hasDedicatedMC2ChildFinanceFiles")) {
            assertEquals(
                case["expected"].asBoolean,
                member(case["member"].asString).hasDedicatedChildFinanceFiles,
            )
        }
    }

    @Test
    fun `untagged records default to Victor and explicit owners survive`() {
        val default = member(fixtures["defaultOwner"].asString)
        assertEquals(default, FamilyMember.coerceOwner(null))
        assertEquals(default, FamilyMember.coerceOwner("not-a-member"))
        assertEquals(FamilyMember.MASON, FamilyMember.coerceOwner("mason"))
    }

    // ── Collection filtering ────────────────────────────────────────────────

    private data class Row(
        val label: String,
        override val owner: FamilyMember,
        val spendAmount: Long = 0L,
    ) : Owned

    private fun transactions(): List<Row> =
        fixtures.getAsJsonArray("sampleTransactions").map {
            val obj = it.asJsonObject
            Row(
                label = obj["merchant"].asString,
                owner = member(obj["owner"].asString),
                spendAmount = Money.parseCents(obj["spendAmount"].asString),
            )
        }

    private fun accounts(): List<Row> =
        fixtures.getAsJsonArray("sampleAccounts").map {
            val obj = it.asJsonObject
            Row(label = obj["label"].asString, owner = member(obj["owner"].asString))
        }

    private fun expectations(): JsonObject = fixtures.getAsJsonObject("expectations")

    @Test
    fun `transaction filtering matches expected counts`() {
        val expected = expectations().getAsJsonObject("visibleTransactionCount")
        for (viewer in members) {
            assertEquals(
                expected[viewer.key].asInt,
                transactions().visibleTo(viewer).size,
                "${viewer.key} transaction visibility",
            )
        }
    }

    @Test
    fun `children see only their own transactions`() {
        val expected = expectations().getAsJsonObject("visibleTransactionMerchants")
        for ((key, value) in expected.entrySet()) {
            assertEquals(
                value.asJsonArray.map { it.asString },
                transactions().visibleTo(member(key)).map { it.label },
                key,
            )
        }
    }

    @Test
    fun `account filtering and net worth scope diverge for children`() {
        val visibleCount = expectations().getAsJsonObject("visibleAccountCount")
        val netWorthLabels = expectations().getAsJsonObject("netWorthAccountLabels")
        for (viewer in members) {
            assertEquals(
                visibleCount[viewer.key].asInt,
                accounts().visibleTo(viewer).size,
                "${viewer.key} account visibility",
            )
            assertEquals(
                netWorthLabels.getAsJsonArray(viewer.key).map { it.asString },
                accounts().netWorthScopeFor(viewer).map { it.label },
                "${viewer.key} net-worth scope",
            )
        }
    }

    @Test
    fun `an adult sees Mason's account but excludes it from net worth`() {
        val visible = accounts().visibleTo(FamilyMember.VICTOR).map { it.label }
        val netWorth = accounts().netWorthScopeFor(FamilyMember.VICTOR).map { it.label }
        assertTrue(visible.contains("Mason Strike"))
        assertFalse(netWorth.contains("Mason Strike"))
    }

    @Test
    fun `visible spend retains child rows for adult oversight`() {
        val totals = expectations().getAsJsonObject("visibleSpend")
        for (viewer in members) {
            assertEquals(
                Money.parseCents(totals[viewer.key].asString),
                transactions().visibleTo(viewer).sumOf { it.spendAmount },
                "${viewer.key} visible spend",
            )
        }
    }

    @Test
    fun `budget spend uses adult household scope and child self scope`() {
        val rows = fixtures.getAsJsonArray("sampleTransactions").map {
            val obj = it.asJsonObject
            Transaction(
                id = obj["id"].asString,
                date = "2026-07-01",
                merchant = obj["merchant"].asString,
                amount = Money.parseCents(obj["amount"].asString),
                category = obj["category"].asString,
                owner = member(obj["owner"].asString),
            )
        }
        val totals = expectations().getAsJsonObject("budgetSpend")
        val owners = expectations().getAsJsonObject("budgetOwners")

        for (viewer in members) {
            val scoped = rows.budgetTransactionsFor(viewer)
            assertEquals(
                owners.getAsJsonArray(viewer.key).map { member(it.asString) },
                scoped.map { it.owner }.distinct(),
                "${viewer.key} budget owners",
            )
            assertEquals(
                Money.parseCents(totals[viewer.key].asString),
                scoped.sumOf { it.spendAmount },
                "${viewer.key} budget spend",
            )
        }
    }

    @Test
    fun `empty collections do not throw`() {
        assertTrue(emptyList<Row>().visibleTo(FamilyMember.MASON).isEmpty())
        assertTrue(emptyList<Row>().netWorthScopeFor(FamilyMember.MASON).isEmpty())
    }
}
