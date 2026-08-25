package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetCategory
import com.sats21m.vogelvault.domain.CategoryDeleteRejection
import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class BudgetCategoryDeletionGatewayTest {
    @Test
    fun `accepted adult delete sends canonical owner source name month and revision`() = runBlocking {
        val poster = RecordingPoster(success())
        val result = gateway(poster).delete(
            activeProfile = FamilyMember.RACHEL,
            budget = budget(),
            sourceFile = "budget",
            categoryName = "groceries",
            baseUpdatedAtMs = REVISION,
        )

        assertIs<BudgetCategoryDeleteResult.Submitted>(result)
        assertIs<ConvexResult.Ok<ConvexValue>>(result.result)
        val wire = Json.parseToJsonElement(poster.bodies.single()).jsonObject
        val args = wire.getValue("args").jsonObject
        assertEquals("tables:deleteBudgetCategoryFromDevice", wire.getValue("path").jsonPrimitive.content)
        assertEquals("victor", args.getValue("owner").jsonPrimitive.content)
        assertEquals("budget", args.getValue("sourceFile").jsonPrimitive.content)
        assertEquals(MONTH, args.getValue("month").jsonPrimitive.content)
        assertEquals("Groceries", args.getValue("entityId").jsonPrimitive.content)
        assertEquals(REVISION.toString(), args.getValue("baseUpdatedAtMs").jsonPrimitive.content)
    }

    @Test
    fun `Mason uses the canonical child budget identity`() = runBlocking {
        val poster = RecordingPoster(success())
        val result = gateway(poster).delete(
            activeProfile = FamilyMember.MASON,
            budget = budget(owner = FamilyMember.MASON, categoryName = "School"),
            sourceFile = "mason-budget",
            categoryName = "School",
            baseUpdatedAtMs = REVISION,
        )

        assertIs<BudgetCategoryDeleteResult.Submitted>(result)
        val args = Json.parseToJsonElement(poster.bodies.single()).jsonObject
            .getValue("args").jsonObject
        assertEquals("mason", args.getValue("owner").jsonPrimitive.content)
        assertEquals("mason-budget", args.getValue("sourceFile").jsonPrimitive.content)
    }

    @Test
    fun `invalid collision stale revision and unsupported profile never reach transport`() = runBlocking {
        val cases = listOf(
            Triple(
                FamilyMember.RACHEL,
                budget().copy(
                    categories = listOf(
                        BudgetCategory("Groceries", 1L, 0L),
                        BudgetCategory(" groceries ", 1L, 0L),
                    ),
                ),
                CategoryDeleteRejection.AMBIGUOUS_CATEGORY,
            ),
            Triple(FamilyMember.RACHEL, budget().copy(updatedAtMs = REVISION + 1L), CategoryDeleteRejection.REVISION_MISMATCH),
            Triple(FamilyMember.MADDOX, budget(owner = FamilyMember.MADDOX), CategoryDeleteRejection.UNSUPPORTED_PROFILE),
        )

        cases.forEach { (profile, candidate, rejection) ->
            val poster = RecordingPoster(success())
            val result = gateway(poster).delete(
                activeProfile = profile,
                budget = candidate,
                sourceFile = if (profile == FamilyMember.MASON) "mason-budget" else "budget",
                categoryName = "Groceries",
                baseUpdatedAtMs = REVISION,
            )
            assertEquals(BudgetCategoryDeleteResult.Rejected(rejection), result)
            assertTrue(poster.bodies.isEmpty())
        }
    }

    private fun gateway(poster: RecordingPoster) = BudgetCategoryDeletionGateway(
        client = ConvexDeviceMutationClient(
            configSource = MutableConvexConfigSource(
                ConvexConfig("https://budget-delete-test.convex.cloud"),
            ),
            credentialSource = ConvexDeviceCredentialSource {
                ConvexDeviceCredential("test-device", "t".repeat(43))
            },
            http = poster,
        ),
        trustedCurrentMonth = { MONTH },
    )

    private fun budget(
        owner: FamilyMember = FamilyMember.VICTOR,
        categoryName: String = "Groceries",
    ) = Budget(
        month = MONTH,
        categories = listOf(BudgetCategory(categoryName, 1L, 0L)),
        owner = owner,
        updatedAtMs = REVISION,
    )

    private fun success() = HttpTextResponse(
        200,
        """{"status":"success","value":{"ok":true,"entityId":"Groceries","removed":true}}""",
    )

    private companion object {
        const val MONTH = "2026-08"
        const val REVISION = 1_787_654_321_000L
    }
}
