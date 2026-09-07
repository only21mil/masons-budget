package com.sats21m.vogelvault.domain

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.math.BigDecimal
import java.time.Instant
import java.time.YearMonth
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import org.junit.jupiter.api.Assumptions.assumeTrue

class RedesignFixtureParityTest {
    @Test
    fun `Money Out Today matches the shared fixture after sibling integration`() {
        val fixture = requireFixture("money-out-today-cases.json")
        val root = JsonParser.parseString(fixture.readText()).asJsonObject
        val date = root.string("date")
        val transactions = root.array("transactions").map { element ->
            val row = element.asJsonObject
            Transaction(
                id = row.string("id"),
                date = row.string("date"),
                merchant = row.string("id"),
                amount = row.string("amountCents").toLong(),
                category = row.string("category"),
                owner = row.owner("owner"),
            )
        }
        val billPays = root.array("billPays").map { element ->
            val row = element.asJsonObject
            BtcBillPay(
                id = row.string("id"),
                date = row.string("date"),
                merchant = row.string("id"),
                category = if (row.optionalString("budgetEffect") == "credit_card_payment") {
                    "Credit Card Payment"
                } else {
                    "Bills"
                },
                budgetEffect = BillPayBudgetEffect.fromWireOrDefault(
                    row.optionalString("budgetEffect") ?: "budget_category",
                ),
                amountUsdCents = row.string("principalCents").toLong(),
                btcSpentSats = 1L,
                feeUsdCents = row.string("feeUsdCents").toLong(),
                platform = null,
                note = null,
                owner = row.owner("owner"),
            )
        }

        root.array("cases").forEach { element ->
            val case = element.asJsonObject
            val result = deriveMoneyOutToday(
                activeProfile = case.owner("activeProfile"),
                day = date,
                transactions = transactions,
                billPays = billPays,
            )
            assertEquals(case.owner("expectedOwner"), result.owner)
            assertEquals(case.string("expectedTotalCents").toLong(), result.totalCents)
            assertEquals(
                case.array("expectedSourceIds").map { it.asString },
                result.sourceIds,
            )
        }
    }

    @Test
    fun `category deletion matches the shared fixture after sibling integration`() {
        val fixture = requireFixture("budget-category-deletion-cases.json")
        val root = JsonParser.parseString(fixture.readText()).asJsonObject

        root.array("accepted").forEach { element ->
            val case = element.asJsonObject
            val revision = case.get("baseUpdatedAtMs").checkedRevision()
            val categoryName = case.string("categoryName")
            val result = validateCurrentMonthCategoryDelete(
                activeProfile = case.owner("activeProfile"),
                currentMonth = case.string("currentMonth"),
                budget = Budget(
                    month = case.string("currentMonth"),
                    categories = listOf(BudgetCategory(categoryName, 1L, 0L)),
                    owner = case.owner("budgetOwner"),
                    updatedAtMs = requireNotNull(revision),
                ),
                sourceFile = case.string("sourceFile"),
                categoryName = categoryName,
                baseUpdatedAtMs = revision,
            )
            assertEquals(null, result.rejection, case.string("name"))
            assertEquals(case.owner("expectedOwner"), result.intent?.owner, case.string("name"))
        }

        val accepted = root.array("accepted").first().asJsonObject
        root.array("rejected").forEach { element ->
            val case = element.asJsonObject
            val replace = case.getAsJsonObject("replace") ?: JsonObject()
            val revisionElement = replace.get("baseUpdatedAtMs") ?: accepted.get("baseUpdatedAtMs")
            val revision = revisionElement.checkedRevision()
            val expected = rejection(case.string("reason"))
            if (revision == null) {
                assertEquals(CategoryDeleteRejection.INVALID_REVISION, expected, case.string("name"))
                return@forEach
            }
            val currentMonth = replace.optionalString("currentMonth") ?: accepted.string("currentMonth")
            val categoryName = replace.optionalString("categoryName") ?: accepted.string("categoryName")
            val result = validateCurrentMonthCategoryDelete(
                activeProfile = replace.optionalOwner("activeProfile") ?: accepted.owner("activeProfile"),
                currentMonth = currentMonth,
                budget = Budget(
                    month = case.optionalString("budgetMonth") ?: accepted.string("currentMonth"),
                    categories = listOf(BudgetCategory("Groceries", 1L, 0L)),
                    owner = case.optionalOwner("budgetOwner") ?: accepted.owner("budgetOwner"),
                    updatedAtMs = accepted.get("baseUpdatedAtMs").checkedRevision()!!,
                ),
                sourceFile = replace.optionalString("sourceFile") ?: accepted.string("sourceFile"),
                categoryName = categoryName,
                baseUpdatedAtMs = revision,
            )
            assertEquals(expected, result.rejection, case.string("name"))
        }
    }

    @Test
    fun `budget plan carry matches the shared fixture after sibling integration`() {
        val fixture = requireFixture("budget-plan-carry-cases.json")
        val root = JsonParser.parseString(fixture.readText()).asJsonObject
        assertEquals(2, root.get("contractVersion").asInt)
        assertEquals("UTC", root.string("currentMonthRule"))
        root.array("currentMonthCases").forEach { element ->
            val case = element.asJsonObject
            assertEquals(
                case.string("expectedMonth"),
                budgetCurrentMonth(Instant.ofEpochMilli(case.get("epochMillis").asLong)),
                case.string("name"),
            )
            assertEquals(
                case.string("chicagoLocalMonth"),
                YearMonth.from(
                    Instant.ofEpochMilli(case.get("epochMillis").asLong)
                        .atZone(ZoneId.of("America/Chicago")),
                ).toString(),
                "${case.string("name")} local control",
            )
        }

        root.array("accepted").forEach { element ->
            val case = element.asJsonObject
            val revision = requireNotNull(case.get("baseUpdatedAtMs").checkedRevision())
            val result = validateBudgetPlanCarry(
                activeProfile = case.owner("activeProfile"),
                currentMonth = case.string("currentMonth"),
                selectedMonth = case.optionalString("selectedMonth"),
                budget = Budget(
                    month = case.string("budgetMonth"),
                    categories = listOf(BudgetCategory("Groceries", 1L, 0L)),
                    owner = case.owner("budgetOwner"),
                    updatedAtMs = revision,
                ),
                baseUpdatedAtMs = revision,
            )
            assertEquals(null, result.rejection, case.string("name"))
            assertEquals(
                BudgetPlanCarryIntent(
                    owner = case.owner("expectedOwner"),
                    sourceFile = case.string("expectedSourceFile"),
                    fromMonth = case.string("expectedFromMonth"),
                    toMonth = case.string("expectedToMonth"),
                    baseUpdatedAtMs = revision,
                ),
                result.intent,
                case.string("name"),
            )
        }

        val accepted = root.array("accepted").first().asJsonObject
        val acceptedRevision = accepted.get("baseUpdatedAtMs").checkedRevision()!!
        root.array("rejected").forEach { element ->
            val case = element.asJsonObject
            val replace = case.getAsJsonObject("replace") ?: JsonObject()
            val revision = (replace.get("baseUpdatedAtMs") ?: accepted.get("baseUpdatedAtMs")).checkedRevision()
            val expected = carryRejection(case.string("reason"))
            if (revision == null) {
                assertEquals(BudgetPlanCarryRejection.INVALID_REVISION, expected, case.string("name"))
                return@forEach
            }
            val result = validateBudgetPlanCarry(
                activeProfile = replace.optionalOwner("activeProfile") ?: accepted.owner("activeProfile"),
                currentMonth = replace.optionalString("currentMonth") ?: accepted.string("currentMonth"),
                selectedMonth = replace.optionalString("selectedMonth") ?: accepted.optionalString("selectedMonth"),
                budget = Budget(
                    month = case.optionalString("budgetMonth") ?: accepted.string("budgetMonth"),
                    categories = listOf(BudgetCategory("Groceries", 1L, 0L)),
                    owner = case.optionalOwner("budgetOwner") ?: accepted.owner("budgetOwner"),
                    updatedAtMs = acceptedRevision,
                ),
                baseUpdatedAtMs = revision,
            )
            assertEquals(expected, result.rejection, case.string("name"))
        }
    }

    private fun carryRejection(value: String): BudgetPlanCarryRejection = when (value) {
        "invalid-current-month" -> BudgetPlanCarryRejection.INVALID_CURRENT_MONTH
        "invalid-selected-month" -> BudgetPlanCarryRejection.INVALID_SELECTED_MONTH
        "unsupported-profile" -> BudgetPlanCarryRejection.UNSUPPORTED_PROFILE
        "owner-mismatch" -> BudgetPlanCarryRejection.OWNER_MISMATCH
        "invalid-plan-month" -> BudgetPlanCarryRejection.INVALID_PLAN_MONTH
        "plan-is-current" -> BudgetPlanCarryRejection.PLAN_IS_CURRENT
        "invalid-revision" -> BudgetPlanCarryRejection.INVALID_REVISION
        "revision-mismatch" -> BudgetPlanCarryRejection.REVISION_MISMATCH
        else -> error("Unknown budget plan carry rejection: $value")
    }

    private fun requireFixture(name: String): File {
        var directory = File(requireNotNull(System.getProperty("user.dir"))).absoluteFile
        while (true) {
            val candidate = File(directory, "shared/domain/fixtures/$name")
            if (candidate.isFile) return candidate
            directory = directory.parentFile ?: break
        }
        assumeTrue(false, "requires sibling shared fixture $name at final integration")
        error("unreachable after skipped parity assumption")
    }

    private fun JsonObject.string(key: String): String = get(key).asString
    private fun JsonObject.optionalString(key: String): String? = get(key)?.asString
    private fun JsonObject.array(key: String) = getAsJsonArray(key)
    private fun JsonObject.owner(key: String): FamilyMember =
        requireNotNull(FamilyMember.fromKeyOrNull(string(key)))
    private fun JsonObject.optionalOwner(key: String): FamilyMember? =
        optionalString(key)?.let(FamilyMember::fromKeyOrNull)

    private fun JsonElement.checkedRevision(): Long? = runCatching {
        val decimal = BigDecimal(asJsonPrimitive.asString)
        val value = decimal.longValueExact()
        value.takeIf { it in 1L..9_007_199_254_740_991L }
    }.getOrNull()

    private fun rejection(value: String): CategoryDeleteRejection = when (value) {
        "invalid-current-month" -> CategoryDeleteRejection.INVALID_CURRENT_MONTH
        "unsupported-profile" -> CategoryDeleteRejection.UNSUPPORTED_PROFILE
        "owner-mismatch" -> CategoryDeleteRejection.OWNER_MISMATCH
        "month-mismatch" -> CategoryDeleteRejection.MONTH_MISMATCH
        "source-mismatch" -> CategoryDeleteRejection.SOURCE_MISMATCH
        "invalid-category" -> CategoryDeleteRejection.INVALID_CATEGORY
        "missing-category" -> CategoryDeleteRejection.MISSING_CATEGORY
        "ambiguous-category" -> CategoryDeleteRejection.AMBIGUOUS_CATEGORY
        "invalid-revision" -> CategoryDeleteRejection.INVALID_REVISION
        "revision-mismatch" -> CategoryDeleteRejection.REVISION_MISMATCH
        else -> error("Unknown category deletion rejection: $value")
    }
}
