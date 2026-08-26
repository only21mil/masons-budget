package com.sats21m.vogelvault.domain

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Parity suite for the shared todo contract.
 *
 * Every case is driven by `shared/domain/fixtures/todo-cases.json` — the same
 * file the TypeScript suite loads. The fixture is pinned to the server semantics
 * in `convex/todoNormalize.ts` + `convex/dataFiles.ts` and to the alias and
 * ownership rules in the Apple compatibility DTOs. If either changes, the
 * fixture changes in the same commit and both clients move together.
 */
class TodoParityTest {

    private val fixtures: JsonObject = loadFixtures()

    private fun loadFixtures(): JsonObject {
        // Walk up from the module dir to the repo root so the test works from
        // any Gradle invocation directory.
        var dir: File? = File(System.getProperty("user.dir"))
        while (dir != null) {
            val candidate = File(dir, "shared/domain/fixtures/todo-cases.json")
            if (candidate.isFile) return Gson().fromJson(candidate.readText(), JsonObject::class.java)
            dir = dir.parentFile
        }
        error("Could not locate shared/domain/fixtures/todo-cases.json from ${System.getProperty("user.dir")}")
    }

    private val nowMillis: Long
        get() = fixtures["nowMillis"].asLong

    private fun cases(name: String): List<JsonObject> =
        fixtures.getAsJsonArray(name).map { it.asJsonObject }

    private fun member(key: String): FamilyMember =
        FamilyMember.fromKeyOrNull(key) ?: error("Unknown member in fixture: $key")

    /** Sync-path helper: raw stamps drive the comparison, missing stays missing. */
    private fun pull(raw: JsonElement): CanonicalTodo =
        Todo.normalize(raw.asJsonObject.toRawMap(), nowMillis, defaultTimestamps = false)

    private fun pullAll(array: JsonArray): List<CanonicalTodo> = array.map { pull(it) }

    private fun tombstones(array: JsonArray): List<TodoTombstone> = array.map {
        val entry = it.asJsonObject
        TodoTombstone(entry["id"].asString, entry["deletedAt"].asLong)
    }

    private fun idsAndTitles(todos: List<CanonicalTodo>): List<Pair<String, String>> =
        todos.map { it.id to it.title }

    private fun expectedIdsAndTitles(array: JsonArray): List<Pair<String, String>> = array.map {
        val entry = it.asJsonObject
        entry["id"].asString to entry["title"].asString
    }

    private val sampleTodos: List<CanonicalTodo>
        get() = fixtures.getAsJsonArray("sampleTodos").map {
            Todo.normalize(it.asJsonObject.toRawMap(), nowMillis)
        }

    private fun sample(id: String): CanonicalTodo =
        sampleTodos.firstOrNull { it.id == id } ?: error("sampleTodos is missing $id")

    // ── Lanes and identity ──────────────────────────────────────────────────

    @Test
    fun `lane normalization matches the server's valid set`() {
        for (case in cases("normalizeLane")) {
            val expected = case["expected"].let { if (it.isJsonNull) null else TodoLane.fromValueOrNull(it.asString) }
            assertEquals(expected, Todo.normalizeLane(case["input"].toRawValue()), case["input"].toString())
        }
    }

    @Test
    fun `lane resolution walks category then type then the list`() {
        for (case in cases("resolveLane")) {
            val input = case.getAsJsonObject("input").toRawMap()
            val expected = case["expected"].let { if (it.isJsonNull) null else TodoLane.fromValueOrNull(it.asString) }
            assertEquals(
                expected,
                Todo.resolveLane(input["category"], input["type"], input["list"]),
                input.toString(),
            )
        }
    }

    @Test
    fun `canonical ids are preserved or minted from the lane and the clock`() {
        for (case in cases("canonicalId")) {
            assertEquals(
                case["expected"].asString,
                Todo.canonicalId(case.getAsJsonObject("todo").toRawMap(), nowMillis),
                case.noteOr(case["todo"].toString()),
            )
        }
    }

    @Test
    fun `app-created todos are recognised by id or by provenance`() {
        for (case in cases("appCreated")) {
            assertEquals(
                case["expected"].asBoolean,
                Todo.isAppCreated(case.getAsJsonObject("todo").toRawMap()),
                case["todo"].toString(),
            )
        }
    }

    // ── Timestamps ──────────────────────────────────────────────────────────

    @Test
    fun `isoFromMillis matches the JavaScript toISOString output`() {
        for (case in cases("isoFromMillis")) {
            assertEquals(case["expected"].asString, Todo.isoFromMillis(case["millis"].asLong))
        }
    }

    @Test
    fun `isoToMillis parses strictly and treats a missing zone as UTC`() {
        for (case in cases("isoToMillis")) {
            assertEquals(
                case["expected"].asLong,
                Todo.isoToMillis(case["value"].asString),
                case.noteOr(case["value"].asString),
            )
        }
    }

    @Test
    fun `a zoneless stamp does not depend on the host timezone`() {
        // The bug this guards: a lenient parse reads "2026-07-26T14:30:00" as
        // local time, so two devices order the same two edits differently.
        assertEquals(Todo.isoToMillis("2026-07-26T14:30:00Z"), Todo.isoToMillis("2026-07-26T14:30:00"))
    }

    // ── Normalization ───────────────────────────────────────────────────────

    @Test
    fun `word priorities become numbers instead of NaN`() {
        for (case in cases("priority")) {
            assertEquals(
                case["expected"].asInt,
                Todo.normalizePriority(case["input"].toRawValue()),
                case["input"].toString(),
            )
        }
    }

    @Test
    fun `normalization emits the dual-field superset the server emits`() {
        for (case in cases("normalize")) {
            val name = case["name"].asString
            val expected = case.getAsJsonObject("expected")
            val actual = Todo.normalizeWire(
                case.getAsJsonObject("input").toRawMap(),
                nowMillis,
                defaultTimestamps = case.boolOr("defaultTimestamps", true),
            )

            assertEquals(expected.keySet(), actual.keys, "$name: emitted key set")
            for ((key, element) in expected.entrySet()) {
                val primitive = element.asJsonPrimitive
                val value = actual[key]
                when {
                    primitive.isBoolean -> assertEquals(primitive.asBoolean, value as Boolean, "$name / $key")
                    primitive.isNumber -> assertEquals(primitive.asLong, (value as Number).toLong(), "$name / $key")
                    else -> assertEquals(primitive.asString, value as String, "$name / $key")
                }
            }
        }
    }

    @Test
    fun `both spellings of every dual field always agree`() {
        for (case in cases("normalize")) {
            val wire = Todo.normalizeWire(
                case.getAsJsonObject("input").toRawMap(),
                nowMillis,
                defaultTimestamps = case.boolOr("defaultTimestamps", true),
            )
            val name = case["name"].asString
            assertEquals(wire["dueDate"], wire["due_date"], name)
            assertEquals(wire["updatedAt"], wire["updated_at"], name)
            assertEquals(wire["flag"], wire["flagged"], name)
            assertEquals(wire["created"], (wire["createdAt"] as String).take(10), name)
        }
    }

    @Test
    fun `completedAt and completed_by are omitted rather than nulled`() {
        val open = Todo.normalizeWire(mapOf("id" to "t-1", "title" to "Open"), nowMillis)
        assertFalse(open.containsKey("completedAt"))
        assertFalse(open.containsKey("completed_by"))
    }

    @Test
    fun `normalization is idempotent on its own output`() {
        for (case in cases("normalize")) {
            val defaults = case.boolOr("defaultTimestamps", true)
            val once = Todo.normalizeWire(case.getAsJsonObject("input").toRawMap(), nowMillis, defaults)
            assertEquals(once, Todo.normalizeWire(once, nowMillis, defaults), case["name"].asString)
        }
    }

    @Test
    fun `an untagged todo is owned by the household default rather than dropped`() {
        val todo = Todo.normalize(mapOf("id" to "t-x", "title" to "Untagged"), nowMillis)
        assertEquals(FamilyMember.VICTOR, todo.owner)
    }

    // ── Last-write-wins ─────────────────────────────────────────────────────

    @Test
    fun `update stamps read snake then camel then completedAt`() {
        for (case in cases("updatedMillis")) {
            assertEquals(
                case["expected"].asLong,
                Todo.updatedMillis(case.getAsJsonObject("todo").toRawMap()),
                case.noteOr(case["todo"].toString()),
            )
        }
    }

    @Test
    fun `last-write-wins resolves the way the server resolves it`() {
        for (case in cases("lastWriteWins")) {
            val winner = Todo.merge(pull(case["existing"]), pull(case["incoming"]), nowMillis)
            assertEquals(case["expectedTitle"].asString, winner.title, case["name"].asString)
        }
    }

    @Test
    fun `upsert preserves position and rejects stale edits`() {
        for (case in cases("upsert")) {
            val result = pullAll(case.getAsJsonArray("base")).upsertTodo(pull(case["incoming"]), nowMillis)
            assertEquals(
                expectedIdsAndTitles(case.getAsJsonArray("expected")),
                idsAndTitles(result),
                case["name"].asString,
            )
        }
    }

    @Test
    fun `merging two lists keeps local order and appends unseen remotes`() {
        for (case in cases("mergeLists")) {
            val result = pullAll(case.getAsJsonArray("local"))
                .mergeTodos(pullAll(case.getAsJsonArray("remote")), nowMillis)
            assertEquals(
                expectedIdsAndTitles(case.getAsJsonArray("expected")),
                idsAndTitles(result),
                case["name"].asString,
            )
        }
    }

    @Test
    fun `merging is stable - a second identical merge changes nothing`() {
        for (case in cases("mergeLists")) {
            val remote = pullAll(case.getAsJsonArray("remote"))
            val once = pullAll(case.getAsJsonArray("local")).mergeTodos(remote, nowMillis)
            assertEquals(once, once.mergeTodos(remote, nowMillis), case["name"].asString)
        }
    }

    // ── Tombstones ──────────────────────────────────────────────────────────

    @Test
    fun `tombstones remove deleted todos without resurrecting later edits`() {
        for (case in cases("tombstones")) {
            val result = pullAll(case.getAsJsonArray("todos"))
                .applyTombstones(tombstones(case.getAsJsonArray("tombstones")))
            assertEquals(
                case.getAsJsonArray("expectedIds").map { it.asString },
                result.map { it.id },
                case["name"].asString,
            )
        }
    }

    @Test
    fun `tombstone sets union to the latest delete per id`() {
        for (case in cases("mergeTombstones")) {
            assertEquals(
                tombstones(case.getAsJsonArray("expected")),
                mergeTodoTombstones(
                    tombstones(case.getAsJsonArray("left")),
                    tombstones(case.getAsJsonArray("right")),
                ),
                case["name"].asString,
            )
        }
    }

    @Test
    fun `a pull merges and then honours the tombstones`() {
        for (case in cases("reconcile")) {
            val result = reconcileTodos(
                local = pullAll(case.getAsJsonArray("local")),
                remote = pullAll(case.getAsJsonArray("remote")),
                tombstones = tombstones(case.getAsJsonArray("tombstones")),
                nowMillis = nowMillis,
            )
            assertEquals(
                expectedIdsAndTitles(case.getAsJsonArray("expected")),
                idsAndTitles(result),
                case["name"].asString,
            )
        }
    }

    @Test
    fun `a deleted todo cannot come back on the next pull`() {
        val case = cases("reconcile").first()
        val remote = pullAll(case.getAsJsonArray("remote"))
        val graves = tombstones(case.getAsJsonArray("tombstones"))
        var state = reconcileTodos(pullAll(case.getAsJsonArray("local")), remote, graves, nowMillis)
        state = reconcileTodos(state, remote, graves, nowMillis)
        assertEquals(
            case.getAsJsonArray("expected").map { it.asJsonObject["id"].asString },
            state.map { it.id },
        )
    }

    // ── Visibility ──────────────────────────────────────────────────────────

    @Test
    fun `todo lists use exact profile ownership`() {
        for (viewer in FamilyMember.entries) {
            assertEquals(
                sampleTodos.filter { it.owner == viewer }.map { it.id },
                sampleTodos.todosFor(viewer).map { it.id },
                viewer.key,
            )
        }
    }

    @Test
    fun `an untagged todo defaults to Victor without leaking to Rachel`() {
        val untagged = sample("t-5")
        assertEquals(FamilyMember.VICTOR, untagged.owner)
        assertTrue(sampleTodos.todosFor(FamilyMember.VICTOR).any { it.id == untagged.id })
        assertFalse(sampleTodos.todosFor(FamilyMember.RACHEL).any { it.id == untagged.id })
    }

    @Test
    fun `empty collections do not throw`() {
        assertTrue(emptyList<CanonicalTodo>().applyTombstones(emptyList()).isEmpty())
        assertTrue(emptyList<CanonicalTodo>().mergeTodos(emptyList(), nowMillis).isEmpty())
        assertTrue(emptyList<CanonicalTodo>().todosFor(FamilyMember.MASON).isEmpty())
    }

    // ── Read-model projection ───────────────────────────────────────────────

    @Test
    fun `due-by is open-and-on-or-before comparing ISO strings lexically`() {
        for (case in cases("dueBy")) {
            val todoId = case["todoId"].asString
            assertEquals(
                case["expected"].asBoolean,
                sample(todoId).isDueBy(case["date"].asString),
                case.noteOr("$todoId by ${case["date"].asString}"),
            )
        }
    }

    @Test
    fun `the read-model projection turns wire empties into nulls`() {
        for (case in cases("readModel")) {
            val expected = case.getAsJsonObject("expected")
            val item = sample(case["todoId"].asString).toTodoItem()
            assertEquals(expected["id"].asString, item.id)
            assertEquals(expected["title"].asString, item.title)
            assertEquals(expected["done"].asBoolean, item.done)
            assertEquals(expected.stringOrNull("project"), item.project)
            assertEquals(expected.stringOrNull("area"), item.area)
            assertEquals(expected.stringOrNull("due"), item.due)
            assertEquals(expected["flagged"].asBoolean, item.flagged)
            assertEquals(member(expected["owner"].asString), item.owner)
        }
    }

    @Test
    fun `canonical and raw update stamps agree`() {
        for (element in fixtures.getAsJsonArray("sampleTodos")) {
            val raw = element.asJsonObject.toRawMap()
            assertEquals(Todo.updatedMillis(raw), Todo.updatedMillis(Todo.normalize(raw, nowMillis, false)))
        }
    }
}

// ── Fixture decoding ────────────────────────────────────────────────────────
//
// The fixture is language-neutral JSON, so it has to be walked rather than
// deserialized into a type. Numbers collapse to Long when they are integral,
// because JSON has one number type and the contract's ids and clocks are
// integers — decoding 42 as 42.0 would silently change every minted id.

private fun JsonObject.toRawMap(): Map<String, Any?> {
    val map = LinkedHashMap<String, Any?>()
    for ((key, value) in entrySet()) map[key] = value.toRawValue()
    return map
}

private fun JsonElement.toRawValue(): Any? = when {
    isJsonNull -> null
    isJsonPrimitive -> asJsonPrimitive.let { primitive ->
        when {
            primitive.isBoolean -> primitive.asBoolean
            primitive.isNumber -> primitive.asBigDecimal.let { number ->
                if (number.stripTrailingZeros().scale() <= 0) number.toLong() else number.toDouble()
            }
            else -> primitive.asString
        }
    }
    else -> toString()
}

private fun JsonObject.stringOrNull(key: String): String? {
    val element = get(key)
    return if (element == null || element.isJsonNull) null else element.asString
}

private fun JsonObject.boolOr(key: String, fallback: Boolean): Boolean {
    val element = get(key)
    return if (element == null || element.isJsonNull) fallback else element.asBoolean
}

/** Fixture notes make an assertion failure say *why* the case exists. */
private fun JsonObject.noteOr(fallback: String): String {
    val note = stringOrNull("note")
    return if (note == null) fallback else "$fallback ($note)"
}
