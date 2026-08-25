package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.RecordingPoster
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class TodoDeviceMutationGatewayTest {
    private val todo = TodoItem(
        id = "safe-todo-1",
        title = "Keep every field",
        owner = FamilyMember.MASON,
        lane = "school",
        notes = "private",
        priority = 3,
        updatedAtMs = 1_800_000_000_000,
    )

    @Test
    fun `update sends device auth owner source and original base revision`() = runBlocking {
        val poster = RecordingPoster(upsertSuccess("updated"))
        val result = gateway(poster).upsert(FamilyMember.MASON, todo.copy(title = "Changed"), todo.updatedAtMs)
        val wire = sent(poster)
        val args = wire["args"]!!.jsonObject

        assertEquals("tables:upsertTodoFromDevice", wire["path"]!!.jsonPrimitive.content)
        assertEquals("mason", args["owner"]!!.jsonPrimitive.content)
        assertEquals("todos", args["sourceFile"]!!.jsonPrimitive.content)
        assertEquals(todo.updatedAtMs.toString(), args["baseUpdatedAtMs"]!!.jsonPrimitive.content)
        assertEquals("test-device", args["deviceId"]!!.jsonPrimitive.content)
        assertEquals("Changed", args["todo"]!!.jsonObject["title"]!!.jsonPrimitive.content)
        assertIs<ConvexResult.Ok<TodoUpsertReceipt>>(result)
        assertEquals(TodoUpsertOutcome.UPDATED, result.value.outcome)
    }

    @Test
    fun `new todo omits base revision while delete and restore require it`() = runBlocking {
        val insertPoster = RecordingPoster(upsertSuccess("inserted"))
        gateway(insertPoster).upsert(FamilyMember.MASON, todo, null)
        assertFalse(sent(insertPoster)["args"]!!.jsonObject.containsKey("baseUpdatedAtMs"))

        val deletePoster = RecordingPoster(deleteSuccess(removed = false))
        val deleted = gateway(deletePoster).delete(FamilyMember.MASON, todo)
        val deleteWire = sent(deletePoster)
        assertEquals("tables:deleteTodoFromDevice", deleteWire["path"]!!.jsonPrimitive.content)
        assertEquals(todo.updatedAtMs.toString(), deleteWire["args"]!!.jsonObject["baseUpdatedAtMs"]!!.jsonPrimitive.content)
        assertFalse(assertIs<ConvexResult.Ok<TodoDeleteReceipt>>(deleted).value.removed)

        val restorePoster = RecordingPoster(restoreSuccess())
        val restored = gateway(restorePoster).restore(FamilyMember.MASON, todo)
        val restoreWire = sent(restorePoster)
        assertEquals("tables:restoreTodoFromDevice", restoreWire["path"]!!.jsonPrimitive.content)
        assertEquals(todo.updatedAtMs.toString(), restoreWire["args"]!!.jsonObject["baseUpdatedAtMs"]!!.jsonPrimitive.content)
        assertEquals(1_800_000_000_001, assertIs<ConvexResult.Ok<TodoRestoreReceipt>>(restored).value.updatedAtMs)
    }

    @Test
    fun `structured device failures remain distinct and server text stays redacted`() = runBlocking {
        val expected = mapOf(
            "DEVICE_UNAUTHORIZED" to ConvexResult.Unauthorized,
            "ENTITY_CONFLICT" to ConvexResult.Failed("task changed on another device"),
            "ENTITY_DELETED" to ConvexResult.Failed("task was deleted on another device"),
            "ENTITY_NOT_FOUND" to ConvexResult.Failed("task no longer exists"),
            "OWNER_MISMATCH" to ConvexResult.Failed("task owner was rejected"),
            "VALIDATION_FAILED" to ConvexResult.Failed("task was rejected as invalid"),
        )
        expected.forEach { (code, outcome) ->
            val secretServerText = "server detail for $code"
            val poster = RecordingPoster(
                HttpTextResponse(
                    200,
                    """{"status":"error","errorData":{"code":"$code","message":"$secretServerText"}}""",
                ),
            )
            val result = gateway(poster).delete(FamilyMember.MASON, todo)
            assertEquals(outcome, result, code)
            assertFalse(result.toString().contains(secretServerText))
        }
    }

    @Test
    fun `wrong entity or malformed receipt is never accepted`() = runBlocking {
        val wrong = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"success","value":{"ok":true,"entityId":"other","removed":true}}""",
            ),
        )
        assertEquals(
            ConvexResult.Failed("invalid write response"),
            gateway(wrong).delete(FamilyMember.MASON, todo),
        )
    }

    @Test
    fun `adult cannot mutate another adult profile todo`() = runBlocking {
        val poster = RecordingPoster(upsertSuccess("updated"))

        assertFailsWith<IllegalArgumentException> {
            gateway(poster).upsert(FamilyMember.RACHEL, todo.copy(owner = FamilyMember.VICTOR), todo.updatedAtMs)
        }
        assertTrue(poster.bodies.isEmpty())
    }

    @Test
    fun `paired credential format is validated before storage`() {
        val parsed = ConvexDeviceCredential.parse("test-device.${"t".repeat(43)}")
        assertEquals("test-device", parsed.deviceId)
        assertTrue(parsed.deviceToken.length >= 32)
    }

    private fun gateway(poster: RecordingPoster) = TodoMutationGateway(
        ConvexDeviceMutationClient(
            configSource = MutableConvexConfigSource(
                ConvexConfig(deploymentUrl = "https://todo-device-test.convex.cloud"),
            ),
            credentialSource = ConvexDeviceCredentialSource {
                ConvexDeviceCredential("test-device", "t".repeat(43))
            },
            http = poster,
        ),
    )

    private fun sent(poster: RecordingPoster) =
        Json.parseToJsonElement(poster.bodies.single()).jsonObject

    private fun upsertSuccess(outcome: String) = HttpTextResponse(
        200,
        """{"status":"success","value":{"ok":true,"entityId":"${todo.id}","outcome":"$outcome"}}""",
    )

    private fun deleteSuccess(removed: Boolean) = HttpTextResponse(
        200,
        """{"status":"success","value":{"ok":true,"entityId":"${todo.id}","removed":$removed}}""",
    )

    private fun restoreSuccess() = HttpTextResponse(
        200,
        """{"status":"success","value":{"ok":true,"entityId":"${todo.id}","updatedAtMs":1800000000001}}""",
    )
}
