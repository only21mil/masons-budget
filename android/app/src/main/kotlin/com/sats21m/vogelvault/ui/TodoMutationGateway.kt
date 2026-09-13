package com.sats21m.vogelvault.ui

import android.content.Context
import androidx.annotation.StringRes
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.DEVICE_REVISION_REQUIRED_REASON
import com.sats21m.vogelvault.data.TodoWriteOperation
import com.sats21m.vogelvault.data.toConvexInt64
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.isAccessibleTo
import java.io.IOException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * Todo writes over the capability-scoped Convex device transport.
 *
 * The whole result is handed back rather than a Boolean. "Switched off", "no
 * deployment", "credential rejected" and "the server refused the row" are four
 * different problems with four different fixes, and a Boolean turns all of them
 * into the same shrug.
 */
internal class TodoMutationGateway(
    private val client: ConvexDeviceMutationClient,
) {
    suspend fun upsert(
        activeProfile: FamilyMember,
        todo: TodoItem,
        baseUpdatedAtMs: Long?,
    ): ConvexResult<TodoUpsertReceipt> =
        if (baseUpdatedAtMs == null) {
            create(activeProfile, todo)
        } else {
            update(activeProfile, todo, baseUpdatedAtMs)
        }

    suspend fun create(
        activeProfile: FamilyMember,
        todo: TodoItem,
    ): ConvexResult<TodoUpsertReceipt> =
        write(activeProfile, todo, TodoWriteOperation.CREATE, null)

    suspend fun update(
        activeProfile: FamilyMember,
        todo: TodoItem,
        baseUpdatedAtMs: Long?,
    ): ConvexResult<TodoUpsertReceipt> {
        if (baseUpdatedAtMs == null) {
            return ConvexResult.Failed(DEVICE_REVISION_REQUIRED_REASON)
        }
        return write(activeProfile, todo, TodoWriteOperation.UPDATE, baseUpdatedAtMs)
    }

    private suspend fun write(
        activeProfile: FamilyMember,
        todo: TodoItem,
        operation: TodoWriteOperation,
        baseUpdatedAtMs: Long?,
    ): ConvexResult<TodoUpsertReceipt> {
        require(todo.isAccessibleTo(activeProfile)) { "todo owner must match the active profile" }
        return client.mutate(
            ConvexMutation.UpsertTodoFromDevice(
                activeProfile = activeProfile,
                owner = todo.owner,
                operation = operation,
                todo = todo.toDeviceMutationJson(),
                baseUpdatedAtMs = baseUpdatedAtMs,
            ),
        ).mapSuccess { value ->
            val objectValue = value.parsed as? JsonObject ?: return@mapSuccess null
            val entityId = objectValue.string("entityId") ?: return@mapSuccess null
            val outcome = objectValue.string("outcome") ?: return@mapSuccess null
            if (objectValue.boolean("ok") != true || entityId != todo.id) return@mapSuccess null
            val parsedOutcome = when (outcome) {
                "inserted" -> TodoUpsertOutcome.INSERTED
                "updated" -> TodoUpsertOutcome.UPDATED
                else -> return@mapSuccess null
            }
            TodoUpsertReceipt(entityId, parsedOutcome)
        }
    }

    suspend fun delete(
        activeProfile: FamilyMember,
        todo: TodoItem,
    ): ConvexResult<TodoDeleteReceipt> {
        require(todo.isAccessibleTo(activeProfile)) { "todo owner must match the active profile" }
        return client.mutate(
            ConvexMutation.DeleteTodoFromDevice(
                todoId = todo.id,
                activeProfile = activeProfile,
                owner = todo.owner,
                baseUpdatedAtMs = todo.updatedAtMs,
            ),
        ).mapSuccess { value ->
            val objectValue = value.parsed as? JsonObject ?: return@mapSuccess null
            val entityId = objectValue.string("entityId") ?: return@mapSuccess null
            val removed = objectValue.boolean("removed") ?: return@mapSuccess null
            if (objectValue.boolean("ok") != true || entityId != todo.id) return@mapSuccess null
            TodoDeleteReceipt(entityId, removed)
        }
    }

    suspend fun restore(
        activeProfile: FamilyMember,
        todo: TodoItem,
    ): ConvexResult<TodoRestoreReceipt> {
        require(todo.isAccessibleTo(activeProfile)) { "todo owner must match the active profile" }
        return client.mutate(
            ConvexMutation.RestoreTodoFromDevice(
                todoId = todo.id,
                activeProfile = activeProfile,
                owner = todo.owner,
                baseUpdatedAtMs = todo.updatedAtMs,
            ),
        ).mapSuccess { value ->
            val objectValue = value.parsed as? JsonObject ?: return@mapSuccess null
            val entityId = objectValue.string("entityId") ?: return@mapSuccess null
            val updatedAtNumber = (objectValue["updatedAtMs"] as? JsonPrimitive)
                ?.contentOrNull?.toDoubleOrNull() ?: return@mapSuccess null
            if (
                !updatedAtNumber.isFinite() ||
                updatedAtNumber % 1.0 != 0.0 ||
                updatedAtNumber < 0.0 ||
                updatedAtNumber > Long.MAX_VALUE.toDouble()
            ) return@mapSuccess null
            val updatedAtMs = updatedAtNumber.toLong()
            if (objectValue.boolean("ok") != true || entityId != todo.id) return@mapSuccess null
            TodoRestoreReceipt(entityId, updatedAtMs)
        }
    }
}

internal enum class TodoUpsertOutcome { INSERTED, UPDATED }
internal data class TodoUpsertReceipt(val entityId: String, val outcome: TodoUpsertOutcome)
internal data class TodoDeleteReceipt(val entityId: String, val removed: Boolean)
internal data class TodoRestoreReceipt(val entityId: String, val updatedAtMs: Long)

private inline fun <T, R> ConvexResult<T>.mapSuccess(transform: (T) -> R?): ConvexResult<R> = when (this) {
    is ConvexResult.Ok -> transform(value)?.let { ConvexResult.Ok(it) }
        ?: ConvexResult.Failed("invalid write response")
    ConvexResult.Disabled -> ConvexResult.Disabled
    ConvexResult.NotConfigured -> ConvexResult.NotConfigured
    ConvexResult.Unauthorized -> ConvexResult.Unauthorized
    ConvexResult.Missing -> ConvexResult.Missing
    is ConvexResult.Failed -> this
}

private fun JsonObject.string(key: String): String? =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.boolean(key: String): Boolean? =
    (get(key) as? JsonPrimitive)?.booleanOrNull

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
    ConvexResult.NotConfigured -> "${action.summary}: this phone is not connected"
    ConvexResult.Unauthorized -> "${action.summary}: the paired-device credential is missing or was rejected"
    ConvexResult.Missing -> "${action.summary}: household sync returned no write result"
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

internal data class CredentialFailureMessage(
    @StringRes val resourceId: Int,
    val formatArgument: String? = null,
) {
    fun resolve(context: Context): String =
        formatArgument?.let { context.getString(resourceId, it) } ?: context.getString(resourceId)
}

/** Why storing the write credential failed, one distinct cause at a time. */
internal fun credentialSaveFailureMessage(error: Throwable): CredentialFailureMessage = when (error) {
    is IllegalArgumentException -> CredentialFailureMessage(R.string.write_credential_blank)
    is IOException -> CredentialFailureMessage(R.string.convex_sync_token_save_failed)
    is IllegalStateException -> CredentialFailureMessage(R.string.write_credential_save_readback_failed)
    else ->
        CredentialFailureMessage(
            R.string.write_credential_save_unexpected,
            error.javaClass.simpleName,
        )
}

/** Why removing the write credential failed, without exposing stored content. */
internal fun credentialRemovalFailureMessage(error: Throwable): CredentialFailureMessage = when (error) {
    is IOException -> CredentialFailureMessage(R.string.convex_sync_token_remove_failed)
    is IllegalStateException -> CredentialFailureMessage(R.string.write_credential_remove_readback_failed)
    else ->
        CredentialFailureMessage(
            R.string.write_credential_remove_unexpected,
            error.javaClass.simpleName,
        )
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

/** Exact payload accepted by `tables:upsertTodoFromDevice`. */
internal fun TodoItem.toDeviceMutationJson(): JsonObject =
    buildMap<String, JsonElement> {
        put("id", JsonPrimitive(id))
        put("owner", JsonPrimitive(owner.key))
        put("title", JsonPrimitive(title))
        put("done", JsonPrimitive(done))
        put("flagged", JsonPrimitive(flagged))
        lane?.let { put("lane", JsonPrimitive(it)) }
        project?.let { put("project", JsonPrimitive(it)) }
        area?.let { put("area", JsonPrimitive(it)) }
        due?.let { put("due", JsonPrimitive(it)) }
        notes?.let { put("notes", JsonPrimitive(it)) }
        priority?.let { put("priority", it.toConvexInt64()) }
        createdAt?.let { put("createdAt", JsonPrimitive(it)) }
        updatedAt?.let { put("updatedAt", JsonPrimitive(it)) }
        completedAt?.let { put("completedAt", JsonPrimitive(it)) }
    }.let(::JsonObject)
