package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexMutationClient
import com.sats21m.vogelvault.domain.TodoItem
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal class TodoMutationGateway(
    private val client: ConvexMutationClient,
) {
    suspend fun upsert(todo: TodoItem): Boolean =
        client.mutate(ConvexMutation.UpsertTodo(todo.toMutationJson())).isOk

    suspend fun delete(todoId: String): Boolean =
        client.mutate(ConvexMutation.DeleteTodo(todoId)).isOk
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
