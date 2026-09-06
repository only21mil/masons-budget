package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetCategory
import com.sats21m.vogelvault.domain.BudgetPlanCarryRejection
import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class BudgetPlanCarryGatewayTest {
    @Test
    fun `adult copy sends canonical owner source months and revision`() = runBlocking {
        val poster = RecordingPoster(success())
        val result = gateway(poster).copyForward(
            activeProfile = FamilyMember.RACHEL,
            budget = budget(),
            selectedMonth = null,
        )

        assertIs<BudgetPlanCarryResult.Submitted>(result)
        assertEquals("2026-09", result.toMonth)
        assertIs<ConvexResult.Ok<ConvexValue>>(result.result)
        val wire = Json.parseToJsonElement(poster.bodies.single()).jsonObject
        val args = wire.getValue("args").jsonObject
        assertEquals("tables:copyBudgetPlanForwardFromDevice", wire.getValue("path").jsonPrimitive.content)
        assertEquals("victor", args.getValue("owner").jsonPrimitive.content)
        assertEquals("budget", args.getValue("sourceFile").jsonPrimitive.content)
        assertEquals("2026-08", args.getValue("fromMonth").jsonPrimitive.content)
        assertEquals("2026-09", args.getValue("toMonth").jsonPrimitive.content)
        assertEquals(REVISION.toString(), args.getValue("baseUpdatedAtMs").jsonPrimitive.content)
        assertEquals("test-device", args.getValue("deviceId").jsonPrimitive.content)
    }

    @Test
    fun `Mason uses the canonical child budget identity`() = runBlocking {
        val poster = RecordingPoster(success())
        val result = gateway(poster).copyForward(
            activeProfile = FamilyMember.MASON,
            budget = budget(owner = FamilyMember.MASON),
            selectedMonth = null,
        )

        assertIs<BudgetPlanCarryResult.Submitted>(result)
        val args = Json.parseToJsonElement(poster.bodies.single()).jsonObject.getValue("args").jsonObject
        assertEquals("mason", args.getValue("owner").jsonPrimitive.content)
        assertEquals("mason-budget", args.getValue("sourceFile").jsonPrimitive.content)
    }

    @Test
    fun `a current plan a stale revision and an unsupported profile never reach transport`() = runBlocking {
        val cases = listOf(
            Triple(FamilyMember.VICTOR, budget(month = CURRENT_MONTH), BudgetPlanCarryRejection.PLAN_IS_CURRENT),
            Triple(FamilyMember.VICTOR, budget(updatedAtMs = 0L), BudgetPlanCarryRejection.INVALID_REVISION),
            Triple(FamilyMember.MADDOX, budget(owner = FamilyMember.MADDOX), BudgetPlanCarryRejection.UNSUPPORTED_PROFILE),
        )
        cases.forEach { (profile, candidate, rejection) ->
            val poster = RecordingPoster(success())
            val result = gateway(poster).copyForward(profile, candidate, selectedMonth = null)
            assertEquals(BudgetPlanCarryResult.Rejected(rejection), result)
            assertTrue(poster.bodies.isEmpty())
        }
    }

    @Test
    fun `a server PLAN_EXISTS rejection becomes a named failure`() = runBlocking {
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"error","errorMessage":"x","errorData":{"code":"PLAN_EXISTS"}}""",
            ),
        )
        val result = gateway(poster).copyForward(FamilyMember.VICTOR, budget(), selectedMonth = null)
        assertIs<BudgetPlanCarryResult.Submitted>(result)
        assertEquals(ConvexResult.Failed(DEVICE_PLAN_EXISTS_REASON), result.result)
    }

    private fun gateway(poster: RecordingPoster) = BudgetPlanCarryGateway(
        client = ConvexDeviceMutationClient(
            configSource = MutableConvexConfigSource(
                ConvexConfig("https://budget-carry-test.convex.cloud"),
            ),
            credentialSource = ConvexDeviceCredentialSource {
                ConvexDeviceCredential("test-device", "t".repeat(43))
            },
            http = poster,
        ),
        trustedCurrentMonth = { CURRENT_MONTH },
    )

    private fun budget(
        owner: FamilyMember = FamilyMember.VICTOR,
        month: String = "2026-08",
        updatedAtMs: Long = REVISION,
    ) = Budget(
        month = month,
        categories = listOf(BudgetCategory("Groceries", 90_000L, 0L)),
        owner = owner,
        updatedAtMs = updatedAtMs,
    )

    private fun success() = HttpTextResponse(
        200,
        """{"status":"success","value":{"ok":true,"outcome":"copied","sourceFile":"budget","fromMonth":"2026-08","toMonth":"2026-09","categoryCount":1,"updatedAtMs":1787654321001}}""",
    )

    private companion object {
        const val CURRENT_MONTH = "2026-09"
        const val REVISION = 1_787_654_321_000L
    }
}
