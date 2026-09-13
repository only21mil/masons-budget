package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.*
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.IncomeEntry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertFalse

class IncomeMutationGatewayTest {
    private fun entry(owner: FamilyMember) = IncomeEntry("income-id", "2026-09-13", "2026-09", 12345L, "Pay", null, owner)
    private fun gateway(poster: RecordingPoster) = IncomeMutationGateway(ConvexDeviceMutationClient(
        configSource = MutableConvexConfigSource(ConvexConfig(deploymentUrl = "https://income-test.convex.cloud")),
        credentialSource = ConvexDeviceCredentialSource { ConvexDeviceCredential("test-device", "t".repeat(43)) },
        http = poster,
    ))
    @Test fun `each owner writes standalone income without a transaction or linked buy`() = runBlocking {
        for (owner in listOf(FamilyMember.VICTOR, FamilyMember.MASON, FamilyMember.MADDOX)) {
            val poster = RecordingPoster(HttpTextResponse(200,
                """{"status":"success","value":{"ok":true,"entityId":"income-id","outcome":"inserted"}}"""))
            assertIs<ConvexResult.Ok<String>>(gateway(poster).upsert(entry(owner)))
            val wire = Json.parseToJsonElement(poster.bodies.single()).jsonObject
            assertEquals("tables:upsertIncomeFromDevice", wire["path"]!!.jsonPrimitive.content)
            val args = wire["args"]!!.jsonObject
            assertEquals(owner.key, args["owner"]!!.jsonPrimitive.content)
            assertEquals("income", args["sourceFile"]!!.jsonPrimitive.content)
            assertFalse(args["income"]!!.jsonObject.containsKey("sourceFile"))
            assertFalse(args.containsKey("baseUpdatedAtMs"))
        }
    }
    @Test fun `wrong receipt id cannot dismiss a draft as accepted`() = runBlocking {
        val poster = RecordingPoster(HttpTextResponse(200,
            """{"status":"success","value":{"ok":true,"entityId":"different","outcome":"inserted"}}"""))
        assertIs<ConvexResult.Failed>(gateway(poster).upsert(entry(FamilyMember.VICTOR)))
        Unit
    }
}
