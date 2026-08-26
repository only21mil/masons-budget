package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.DEVICE_PROFILE_BINDING_REQUIRED_REASON
import com.sats21m.vogelvault.data.DEVICE_REVISION_REQUIRED_REASON
import com.sats21m.vogelvault.data.HttpPoster
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.RecordingPoster
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import java.io.IOException
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
        val result = gateway(poster).update(FamilyMember.MASON, todo.copy(title = "Changed"), todo.updatedAtMs)
        val wire = sent(poster)
        val args = wire["args"]!!.jsonObject

        assertEquals("tables:upsertTodoFromDevice", wire["path"]!!.jsonPrimitive.content)
        assertEquals("mason", args["activeProfile"]!!.jsonPrimitive.content)
        assertEquals("mason", args["owner"]!!.jsonPrimitive.content)
        assertEquals("todos", args["sourceFile"]!!.jsonPrimitive.content)
        assertEquals("update", args["operation"]!!.jsonPrimitive.content)
        assertEquals(todo.updatedAtMs.toString(), args["baseUpdatedAtMs"]!!.jsonPrimitive.content)
        assertEquals("test-device", args["deviceId"]!!.jsonPrimitive.content)
        assertEquals("Changed", args["todo"]!!.jsonObject["title"]!!.jsonPrimitive.content)
        assertIs<ConvexResult.Ok<TodoUpsertReceipt>>(result)
        assertEquals(TodoUpsertOutcome.UPDATED, result.value.outcome)
    }

    @Test
    fun `new todo omits base revision while delete and restore require it`() = runBlocking {
        val insertPoster = RecordingPoster(upsertSuccess("inserted"))
        gateway(insertPoster).create(FamilyMember.MASON, todo)
        val createArgs = sent(insertPoster)["args"]!!.jsonObject
        assertEquals("create", createArgs["operation"]!!.jsonPrimitive.content)
        assertEquals("mason", createArgs["activeProfile"]!!.jsonPrimitive.content)
        assertFalse(createArgs.containsKey("baseUpdatedAtMs"))

        val deletePoster = RecordingPoster(deleteSuccess(removed = false))
        val deleted = gateway(deletePoster).delete(FamilyMember.MASON, todo)
        val deleteWire = sent(deletePoster)
        assertEquals("tables:deleteTodoFromDevice", deleteWire["path"]!!.jsonPrimitive.content)
        val deleteArgs = deleteWire["args"]!!.jsonObject
        assertEquals("mason", deleteArgs["activeProfile"]!!.jsonPrimitive.content)
        assertEquals(todo.updatedAtMs.toString(), deleteArgs["baseUpdatedAtMs"]!!.jsonPrimitive.content)
        assertFalse(assertIs<ConvexResult.Ok<TodoDeleteReceipt>>(deleted).value.removed)

        val restorePoster = RecordingPoster(restoreSuccess())
        val restored = gateway(restorePoster).restore(FamilyMember.MASON, todo)
        val restoreWire = sent(restorePoster)
        assertEquals("tables:restoreTodoFromDevice", restoreWire["path"]!!.jsonPrimitive.content)
        val restoreArgs = restoreWire["args"]!!.jsonObject
        assertEquals(
            setOf(
                "entityId",
                "activeProfile",
                "owner",
                "sourceFile",
                "baseUpdatedAtMs",
                "deviceId",
                "deviceToken",
            ),
            restoreArgs.keys,
        )
        assertEquals(todo.id, restoreArgs["entityId"]!!.jsonPrimitive.content)
        assertEquals("mason", restoreArgs["activeProfile"]!!.jsonPrimitive.content)
        assertEquals(todo.updatedAtMs.toString(), restoreArgs["baseUpdatedAtMs"]!!.jsonPrimitive.content)
        assertFalse(restoreArgs.containsKey("todo"), "restore must use the server-owned capsule")
        assertEquals(1_800_000_000_001, assertIs<ConvexResult.Ok<TodoRestoreReceipt>>(restored).value.updatedAtMs)
    }

    @Test
    fun `revisionless update fails closed without becoming create`() = runBlocking {
        val poster = RecordingPoster(upsertSuccess("inserted"))

        val result = gateway(poster).update(FamilyMember.MASON, todo, null)

        assertEquals(ConvexResult.Failed(DEVICE_REVISION_REQUIRED_REASON), result)
        assertTrue(poster.bodies.isEmpty())
    }

    @Test
    fun `structured device failures remain distinct and server text stays redacted`() = runBlocking {
        val expected = mapOf(
            "DEVICE_UNAUTHORIZED" to ConvexResult.Unauthorized,
            "PROFILE_BINDING_REQUIRED" to ConvexResult.Failed(DEVICE_PROFILE_BINDING_REQUIRED_REASON),
            "REVISION_REQUIRED" to ConvexResult.Failed(DEVICE_REVISION_REQUIRED_REASON),
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
    fun `missing credential never sends a task request`() = runBlocking {
        val poster = RecordingPoster(upsertSuccess("updated"))
        val gateway = TodoMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(
                    ConvexConfig(deploymentUrl = "https://todo-device-test.convex.cloud"),
                ),
                credentialSource = ConvexDeviceCredentialSource { null },
                http = poster,
            ),
        )

        assertEquals(
            ConvexResult.Unauthorized,
            gateway.update(FamilyMember.MASON, todo, todo.updatedAtMs),
        )
        assertTrue(poster.bodies.isEmpty())
    }

    @Test
    fun `offline retry preserves the exact cached authoritative revision and identity`() = runBlocking {
        val poster = RetryPoster(upsertSuccess("updated"))
        val gateway = gateway(poster)

        val offline = gateway.update(FamilyMember.MASON, todo.copy(title = "Changed"), todo.updatedAtMs)
        val retried = gateway.update(FamilyMember.MASON, todo.copy(title = "Changed"), todo.updatedAtMs)

        assertEquals(ConvexResult.Failed("transport failure (IOException)"), offline)
        assertIs<ConvexResult.Ok<TodoUpsertReceipt>>(retried)
        assertEquals(2, poster.bodies.size)
        assertEquals(poster.bodies[0], poster.bodies[1], "retry changed the revision-fenced request")
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
            gateway(poster).update(FamilyMember.RACHEL, todo.copy(owner = FamilyMember.VICTOR), todo.updatedAtMs)
        }
        assertTrue(poster.bodies.isEmpty())
    }

    @Test
    fun `paired credential format is validated before storage`() {
        val parsed = ConvexDeviceCredential.parse("test-device.${"t".repeat(43)}")
        assertEquals("test-device", parsed.deviceId)
        assertTrue(parsed.deviceToken.length >= 32)
    }

    private fun gateway(poster: HttpPoster) = TodoMutationGateway(
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

    private class RetryPoster(private val response: HttpTextResponse) : HttpPoster {
        val bodies = mutableListOf<String>()
        private var attempts = 0

        override suspend fun postJson(url: String, body: String): HttpTextResponse {
            bodies += body
            attempts += 1
            if (attempts == 1) throw IOException("offline")
            return response
        }
    }

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
