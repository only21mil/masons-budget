package com.sats21m.vogelvault

import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.HttpPoster
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.AddTaskDraft
import com.sats21m.vogelvault.ui.prepareTask
import com.sats21m.vogelvault.ui.launchTaskCreateSave
import com.sats21m.vogelvault.ui.TodoMutationGateway
import com.sats21m.vogelvault.ui.toMutationJson
import com.sats21m.vogelvault.ui.todoDraftIdScope
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive

class AddTaskSheetTest {
    @Test
    fun `prepared task keeps canonical owner and all supplied fields`() {
        val task = prepareTask(
            AddTaskDraft(
                title = "  Book dentist  ",
                project = "Health",
                area = "Family",
                due = "2026-08-03",
                flagged = true,
                owner = FamilyMember.MASON,
            ),
            id = "android-task-1",
            now = Instant.parse("2026-07-31T12:00:00Z"),
        ).getOrThrow()
        val payload = task.toMutationJson()

        assertEquals("android-task-1", task.id)
        assertEquals("Book dentist", task.title)
        assertEquals(FamilyMember.MASON, task.owner)
        assertEquals("Health", task.project)
        assertEquals("Family", task.area)
        assertEquals("2026-08-03", task.due)
        assertTrue(task.flagged)
        assertFalse(task.done)
        assertEquals("Book dentist", payload["text"]?.jsonPrimitive?.content)
        assertEquals("2026-08-03", payload["due_date"]?.jsonPrimitive?.content)
        assertEquals("android-app", payload["sync_source"]?.jsonPrimitive?.content)
    }

    @Test
    fun `prepared task canonicalizes device timestamps to fixed milliseconds`() {
        val task = prepareTask(
            AddTaskDraft("Pay bill", "", "", "", false, FamilyMember.VICTOR),
            id = "android-task-precision",
            now = Instant.parse("2026-08-01T12:03:02.123456789Z"),
        ).getOrThrow()

        assertEquals("2026-08-01T12:03:02.123Z", task.createdAt)
        assertEquals("2026-08-01T12:03:02.123Z", task.updatedAt)
    }

    @Test
    fun `optional filing fields are omitted instead of inventing adult data`() {
        val task = prepareTask(
            AddTaskDraft(
                title = "Homework",
                project = " ",
                area = "",
                due = "",
                flagged = false,
                owner = FamilyMember.MADDOX,
            ),
            id = "android-task-2",
        ).getOrThrow()

        assertEquals(FamilyMember.MADDOX, task.owner)
        assertEquals(null, task.project)
        assertEquals(null, task.area)
        assertEquals(null, task.due)
    }

    @Test
    fun `invalid title and date are rejected before mutation`() {
        val invalidTitle = prepareTask(
            AddTaskDraft("", "", "", "", false, FamilyMember.VICTOR),
        )
        val invalidDate = prepareTask(
            AddTaskDraft("Pay bill", "", "", "08/03/2026", false, FamilyMember.VICTOR),
        )

        assertTrue(invalidTitle.isFailure)
        assertEquals("Enter a task title", invalidTitle.exceptionOrNull()?.message)
        assertTrue(invalidDate.isFailure)
        assertEquals("Enter the due date as YYYY-MM-DD", invalidDate.exceptionOrNull()?.message)
    }

    @Test
    fun `accepted create refreshes and rotates the lease even when the sheet is gone`() =
        runBlocking {
            val todoDraftIds = TransactionDraftIdStore()
            val leaseScope = todoDraftIdScope(FamilyMember.MASON)
            val leasedId = todoDraftIds.currentId(leaseScope)
            val poster = SequentialTaskPoster(
                acceptedCreateResponse(leasedId),
            )
            val task = prepareTask(
                AddTaskDraft("Finish homework", "", "", "", false, FamilyMember.MASON),
                id = leasedId,
            ).getOrThrow()
            val errors = mutableListOf<Throwable>()
            val scope = CoroutineScope(
                SupervisorJob() + Dispatchers.Default + CoroutineExceptionHandler { _, e -> errors += e },
            )
            var refreshes = 0
            var uiResults = 0

            try {
                val save = launchTaskCreateSave(
                    scope = scope,
                    task = task,
                    gateway = testGateway(poster),
                    todoDraftIds = todoDraftIds,
                    leaseScope = leaseScope,
                    isUiActive = { false },
                    onWriteSucceeded = { refreshes += 1 },
                ) { uiResults += 1 }
                save.join()

                assertTrue(errors.isEmpty(), errors.toString())
                assertEquals(1, refreshes, "an accepted create must refresh the ledger even after dismissal")
                assertEquals(0, uiResults, "a disposed sheet must suppress only its UI callbacks")
                assertFalse(
                    todoDraftIds.currentId(leaseScope) == leasedId,
                    "a confirmed acceptance must release the lease for the next task",
                )
            } finally {
                scope.cancel()
            }
        }

    @Test
    fun `ambiguous create retries the same leased id until the server confirms`() = runBlocking {
        val todoDraftIds = TransactionDraftIdStore()
        val leaseScope = todoDraftIdScope(FamilyMember.MASON)
        val leasedId = todoDraftIds.currentId(leaseScope)
        val poster = SequentialTaskPoster(
            // The response was lost after the server processed the request:
            // no usable receipt, so the write is ambiguous.
            """{"status":"success","value":{"ok":false}}""",
            acceptedCreateResponse(leasedId),
        )
        val task = prepareTask(
            AddTaskDraft("Finish homework", "", "", "", false, FamilyMember.MASON),
            id = leasedId,
        ).getOrThrow()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val errors = mutableListOf<Throwable>()
        var refreshes = 0
        var acceptedUiResults = 0

        try {
            val first = launchTaskCreateSave(
                scope = scope,
                task = task,
                gateway = testGateway(poster),
                todoDraftIds = todoDraftIds,
                leaseScope = leaseScope,
                isUiActive = { false },
                onWriteSucceeded = { refreshes += 1 },
            ) { acceptedUiResults += 1 }
            first.join()

            assertEquals(0, refreshes)
            assertEquals(
                leasedId,
                todoDraftIds.currentId(leaseScope),
                "an ambiguous create must keep its lease so the retry supersedes the same row",
            )

            val second = launchTaskCreateSave(
                scope = scope,
                task = task,
                gateway = testGateway(poster),
                todoDraftIds = todoDraftIds,
                leaseScope = leaseScope,
                isUiActive = { true },
                onWriteSucceeded = { refreshes += 1 },
            ) { outcome ->
                if (outcome is DraftIdWriteOutcome.Accepted) acceptedUiResults += 1
            }
            second.join()

            assertEquals(1, refreshes)
            assertEquals(1, acceptedUiResults)
            assertEquals(
                listOf(leasedId, leasedId),
                poster.requestIds(),
                "every retry must address the same server row id",
            )
        } finally {
            scope.cancel()
        }
    }

    private fun testGateway(poster: HttpPoster): TodoMutationGateway =
        TodoMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(
                    ConvexConfig(deploymentUrl = "https://task-lease-test.convex.cloud"),
                ),
                credentialSource = ConvexDeviceCredentialSource {
                    ConvexDeviceCredential("test-device", "t".repeat(43), FamilyMember.MASON)
                },
                http = poster,
            ),
        )

    private fun acceptedCreateResponse(id: String): String =
        """{"status":"success","value":{"ok":true,"entityId":"$id","outcome":"inserted"}}"""
}

private fun taskIdFromBody(body: String): String =
    Regex("\"id\":\"([^\"]+)\"").find(body)?.groupValues?.get(1)
        ?: error("task request had no id")

/** Answers each task-create request with the next pre-queued response body. */
private class SequentialTaskPoster(private vararg val responses: String) : HttpPoster {
    private val requests = mutableListOf<String>()

    fun requestIds(): List<String> = requests.map(::taskIdFromBody)

    override suspend fun postJson(url: String, body: String): HttpTextResponse {
        requests += body
        val index = requests.size - 1
        check(index in responses.indices) { "Unexpected task-create request $index" }
        return HttpTextResponse(200, responses[index])
    }
}
