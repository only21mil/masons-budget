package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.ConvexValue
import com.sats21m.vogelvault.domain.TodoItem
import java.io.IOException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Todo writes over the one shared Convex mutation transport.
 *
 * The whole result is handed back rather than a Boolean. "Switched off", "no
 * deployment", "credential rejected" and "the server refused the row" are four
 * different problems with four different fixes, and a Boolean turns all of them
 * into the same shrug.
 */
internal class TodoMutationGateway(
    private val client: ConvexMutationClient,
) {
    suspend fun upsert(todo: TodoItem): ConvexResult<ConvexValue> =
        client.mutate(ConvexMutation.UpsertTodo(todo.toMutationJson()))

    suspend fun delete(todoId: String): ConvexResult<ConvexValue> =
        client.mutate(ConvexMutation.DeleteTodo(todoId))
}

/** What the user just tried to do, so a failure can name the action it lost. */
internal enum class TodoWriteAction(val summary: String) {
    ADD("Task not added"),
    UPDATE("Change not saved"),
    DELETE("Task not deleted"),
    RESTORE("Task not restored"),
}

/**
 * The sentence to show when a todo write did not succeed, null when it did.
 *
 * Every [ConvexResult] case gets its own wording. The reason inside
 * [ConvexResult.Failed] is a string this app authored itself — never server
 * text, which can carry the household's data into a snackbar.
 */
internal fun todoWriteFailureMessage(
    action: TodoWriteAction,
    result: ConvexResult<*>,
): String? = when (result) {
    is ConvexResult.Ok -> null
    ConvexResult.Disabled -> "${action.summary}: live sync is switched off"
    ConvexResult.NotConfigured -> "${action.summary}: no Convex deployment is configured"
    ConvexResult.Unauthorized -> "${action.summary}: the sync credential is missing or was rejected"
    ConvexResult.Missing -> "${action.summary}: Convex returned no write result"
    is ConvexResult.Failed -> "${action.summary} (${result.reason})"
}

/**
 * Shown when the process exposes no write transport at all.
 *
 * Only a preview or a non-application test host reaches this. It still gets its
 * own sentence instead of a silent no-op, because a control that quietly does
 * nothing is the failure this file exists to remove.
 */
internal fun todoWriteUnavailableMessage(action: TodoWriteAction): String =
    "${action.summary}: this build has no write transport"

internal sealed interface TodoDeleteFeedback<out T> {
    data class Deleted<T>(val snackbarResult: T) : TodoDeleteFeedback<T>
    data class Failed(val message: String) : TodoDeleteFeedback<Nothing>
}

/**
 * Publishes delete success only after the mutation has returned Ok.
 *
 * [delete] returns null exclusively for ConvexResult.Ok. Keeping the snackbar
 * callback behind that result prevents an eventual failure from first reading
 * as a successful deletion.
 */
internal suspend fun <T> awaitTodoDeleteFeedback(
    delete: suspend () -> String?,
    deletedMessage: String,
    showDeleted: suspend (String) -> T,
): TodoDeleteFeedback<T> {
    val failure = delete()
    return if (failure == null) {
        TodoDeleteFeedback.Deleted(showDeleted(deletedMessage))
    } else {
        TodoDeleteFeedback.Failed(failure)
    }
}

/** Why storing the write credential failed, one distinct cause at a time. */
internal fun credentialSaveFailureMessage(error: Throwable): String = when (error) {
    is IllegalArgumentException -> "Enter the sync credential before saving"
    is IOException -> "Encrypted storage refused the credential, so nothing was saved"
    is IllegalStateException -> "The credential was written but could not be read back"
    else -> "The credential was not saved (${error.javaClass.simpleName})"
}

/** Why removing the write credential failed, without exposing stored content. */
internal fun credentialRemovalFailureMessage(error: Throwable): String = when (error) {
    is IOException -> "Encrypted storage refused to remove the credential"
    is IllegalStateException -> "The credential was removed but remained readable"
    else -> "The credential was not removed (${error.javaClass.simpleName})"
}

/**
 * Preserve every field Android received. Omitting metadata here would make a
 * title edit confidently erase priority, notes, lane, or timestamps.
 */
internal fun TodoItem.toMutationJson(): JsonObject =
    buildMap<String, JsonElement> {
        put("id", JsonPrimitive(id))
        put("title", JsonPrimitive(title))
        put("text", JsonPrimitive(title))
        put("done", JsonPrimitive(done))
        put("status", JsonPrimitive(if (done) "completed" else "open"))
        put("flag", JsonPrimitive(flagged))
        put("flagged", JsonPrimitive(flagged))
        put("owner", JsonPrimitive(owner.key))
        project?.let { put("project", JsonPrimitive(it)) }
        area?.let { put("area", JsonPrimitive(it)) }
        due?.let {
            put("dueDate", JsonPrimitive(it))
            put("due_date", JsonPrimitive(it))
        }
        lane?.let {
            put("category", JsonPrimitive(it))
            put("type", JsonPrimitive(it))
        }
        notes?.let { put("notes", JsonPrimitive(it)) }
        priority?.let { put("priority", JsonPrimitive(it)) }
        createdAt?.let {
            put("createdAt", JsonPrimitive(it))
            put("created", JsonPrimitive(it.take(10)))
        }
        updatedAt?.let {
            put("updatedAt", JsonPrimitive(it))
            put("updated_at", JsonPrimitive(it))
        }
        completedAt?.let { put("completedAt", JsonPrimitive(it)) }
        put("created_by", JsonPrimitive("android-app"))
        put("sync_source", JsonPrimitive("android-app"))
    }.let(::JsonObject)
