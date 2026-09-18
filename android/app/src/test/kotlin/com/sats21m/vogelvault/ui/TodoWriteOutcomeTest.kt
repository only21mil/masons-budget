package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.ConvexValue
import com.sats21m.vogelvault.data.DEVICE_PROFILE_BINDING_REQUIRED_REASON
import com.sats21m.vogelvault.data.DEVICE_REVISION_REQUIRED_REASON
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive

/**
 * The failure a user reads has to name the problem they can act on.
 *
 * This screen used to collapse every outcome into one Boolean, so "sync is off",
 * "no deployment", "credential rejected" and "the server refused this row" all
 * produced the same sentence and none of them could be fixed from it.
 */
class TodoWriteOutcomeTest {

    private val ok = ConvexResult.Ok(
        ConvexValue(parsed = JsonPrimitive("written"), rawResponseJson = """{"status":"success"}"""),
    )

    private val nonOkResults: List<ConvexResult<*>> = listOf(
        ConvexResult.Disabled,
        ConvexResult.NotConfigured,
        ConvexResult.Unauthorized,
        ConvexResult.Missing,
        ConvexResult.Failed("http 500"),
    )

    @Test
    fun `a successful write has no message at all`() {
        for (action in TodoWriteAction.entries) {
            assertNull(todoWriteFailureMessage(action, ok), "$action must stay silent when it worked")
        }
    }

    @Test
    fun `every non-ok result gets its own sentence`() {
        val messages = nonOkResults.map { assertNotNull(todoWriteFailureMessage(TodoWriteAction.ADD, it)) }

        assertEquals(5, messages.size)
        assertEquals(messages.size, messages.distinct().size, "each cause needs distinct wording: $messages")
        assertEquals(6, nonOkResults.size + 1, "Ok plus five non-ok cases is the whole sealed result")
    }

    @Test
    fun `the lost action is named, so add, edit, delete and undo never blur together`() {
        val perAction = TodoWriteAction.entries.map {
            assertNotNull(todoWriteFailureMessage(it, ConvexResult.Unauthorized))
        }

        assertEquals(perAction.size, perAction.distinct().size, "one sentence per action: $perAction")
        assertTrue(
            perAction.all { it.contains("paired-device credential") },
            "the shared cause still has to name the todo credential",
        )
    }

    @Test
    fun `a rejected credential is not reported as a transport failure`() {
        val unauthorized = assertNotNull(todoWriteFailureMessage(TodoWriteAction.UPDATE, ConvexResult.Unauthorized))
        val failed = assertNotNull(
            todoWriteFailureMessage(TodoWriteAction.UPDATE, ConvexResult.Failed("transport failure (IOException)")),
        )

        assertTrue(unauthorized.contains("paired-device credential is missing or was rejected"))
        assertTrue(failed.contains("transport failure (IOException)"))
    }

    @Test
    fun `profile binding and revision requirements stay visible by exact code`() {
        val profile = assertNotNull(
            todoWriteFailureMessage(
                TodoWriteAction.ADD,
                ConvexResult.Failed(DEVICE_PROFILE_BINDING_REQUIRED_REASON),
            ),
        )
        val revision = assertNotNull(
            todoWriteFailureMessage(
                TodoWriteAction.UPDATE,
                ConvexResult.Failed(DEVICE_REVISION_REQUIRED_REASON),
            ),
        )

        assertTrue(profile.contains("PROFILE_BINDING_REQUIRED"))
        assertTrue(revision.contains("REVISION_REQUIRED"))
    }

    @Test
    fun `a build with no write transport still says so instead of doing nothing`() {
        val unavailable = TodoWriteAction.entries.map { todoWriteUnavailableMessage(it) }
        val convexMessages = nonOkResults.mapNotNull { todoWriteFailureMessage(TodoWriteAction.ADD, it) }

        assertEquals(unavailable.size, unavailable.distinct().size)
        assertTrue(
            unavailable.none { it in convexMessages },
            "a missing transport must not be mistaken for a Convex answer",
        )
    }

    @Test
    fun `a failed delete never publishes the deleted success message`() = runBlocking {
        val deleted = "Deleted \"Pay electric bill\""
        val published = mutableListOf<String>()
        val failure = assertNotNull(
            todoWriteFailureMessage(TodoWriteAction.DELETE, ConvexResult.Failed("http 500")),
        )

        val feedback = awaitTodoDeleteFeedback(
            delete = { failure },
            deletedMessage = deleted,
            showDeleted = { message ->
                published += message
                Unit
            },
        )

        assertIs<TodoDeleteFeedback.Failed>(feedback)
        assertEquals(failure, feedback.message)
        assertFalse(deleted in published, "failed delete published optimistic success: $published")
    }

    @Test
    fun `each credential removal failure names its own cause`() {
        val storage = credentialRemovalFailureMessage(IOException("not persisted"))
        val readback = credentialRemovalFailureMessage(IllegalStateException("still readable"))
        val unexpected = credentialRemovalFailureMessage(RuntimeException("boom"))
        val all = listOf(storage, readback, unexpected)

        assertEquals(all.size, all.distinct().size, "distinct causes: $all")
        assertTrue(all.none { it.formatArgument == "not persisted" || it.formatArgument == "still readable" })
        assertEquals("RuntimeException", unexpected.formatArgument, "an unexpected cause is still identifiable")
    }
}
