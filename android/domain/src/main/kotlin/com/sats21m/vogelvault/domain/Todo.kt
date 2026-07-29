package com.sats21m.vogelvault.domain

import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * The Vogel Vault — shared todo contract, Kotlin mirror.
 *
 * Todos are the one legacy `dataFiles` collection the clients *write* as well as read, so
 * unlike transactions or budgets they need a canonical normaliser for the
 * dual-field superset the compatibility blob emits, a last-write-wins merge, and tombstone
 * application. Those rules live on the server in `convex/todoNormalize.ts` and
 * `convex/dataFiles.ts`; this file and `shared/domain/src/todo.ts` are the
 * client-side halves, pinned to each other by
 * `shared/domain/fixtures/todo-cases.json`, which both test suites load.
 *
 * Field-level truth, in order of authority:
 *   - the Apple compatibility todo DTO owns
 *     which aliases exist and how ownership resolves.
 *   - `convex/todoNormalize.ts` owns what gets emitted.
 * Where the two disagree, the divergences are listed in the fixture's
 * `$divergences` block and reproduced deliberately, never accidentally.
 *
 * HARD RULE (repo AGENTS.md): owner resolution goes through
 * [FamilyMember.coerceOwner] and visibility through [visibleTo]. Adult compatibility
 * records default to "victor", so a strict `owner == activeMember` check empties
 * Rachel's todo list. That bug shipped in v0.3.
 */
enum class TodoLane(val key: String) {
    WORK("work"),
    PERSONAL("personal"),
    SATS("sats");

    companion object {
        /** Trim-and-lowercase, then match. Anything else is not a lane. */
        fun fromValueOrNull(value: Any?): TodoLane? {
            if (value == null) return null
            val normalized = value.toString().trim().lowercase()
            return entries.firstOrNull { it.key == normalized }
        }
    }
}

/**
 * A fully normalized todo.
 *
 * Single-field and typed — the snake/camel duality only exists on the wire and
 * is re-emitted by [Todo.wireRecord]. Keeping it out of the domain type is the
 * point: a screen reading `dueDate` can never disagree with one reading
 * `due_date`.
 */
data class CanonicalTodo(
    val id: String,
    val title: String,
    /** Legacy `dataFiles` alias for [title]. Kept because the server round-trips both. */
    val text: String,
    val lane: TodoLane,
    /** Raw `type`, which is usually but not always the lane. */
    val type: String,
    val status: String,
    val done: Boolean,
    val priority: Int,
    /** ISO `yyyy-MM-dd`, or "" when there is no due date. */
    val dueDate: String,
    /** ISO-8601 instant, or "" when timestamps were not defaulted. */
    val createdAt: String,
    val updatedAt: String,
    val flagged: Boolean,
    val project: String,
    val area: String,
    /** Free text — may be a person, "vogel-vault", or an address. Not an owner. */
    val assignee: String,
    override val owner: FamilyMember,
    val notes: String,
    val source: String,
    val createdBy: String,
    val syncSource: String,
    val completedAt: String?,
    val completedBy: String?,
) : Owned

/** A delete that has to outlive the record it deleted (SAT-1327). */
data class TodoTombstone(val id: String, val deletedAtMillis: Long)

object Todo {

    /** An untagged todo lands in the Sats lane, matching the server default. */
    val DEFAULT_LANE: TodoLane = TodoLane.SATS

    /**
     * Due-date aliases, highest precedence first.
     *
     * The first two are what the server reads; the rest are Swift's
     * `effectiveDueDate` chain, appended *below* them so any input the server
     * understands normalizes identically here. `when` is a Things bucket that is
     * often a word rather than a date, which is why the result is validated.
     */
    private val DUE_DATE_KEYS = listOf("dueDate", "due_date", "due", "date", "deadline", "when")

    /** Words legacy todo payloads sometimes put in `priority`. Port of Swift's decodePriority. */
    private val PRIORITY_WORDS = mapOf(
        "urgent" to 1,
        "high" to 1,
        "medium" to 2,
        "normal" to 2,
        "low" to 3,
    )

    // ── Lanes and identity ──────────────────────────────────────────────────

    fun normalizeLane(value: Any?): TodoLane? = TodoLane.fromValueOrNull(value)

    /** Legacy todo payloads pass `project` as [list]; the server calls it that too. */
    fun resolveLane(category: Any? = null, type: Any? = null, list: Any? = null): TodoLane? =
        normalizeLane(category) ?: normalizeLane(type) ?: normalizeLane(list)

    fun canonicalId(raw: Map<String, Any?>, nowMillis: Long, lane: TodoLane? = null): String {
        val existing = raw["id"]
        if (existing != null && existing.wireString().trim().isNotEmpty()) return existing.wireString()
        val resolved = lane
            ?: resolveLane(raw["category"], raw["type"], raw["project"])
            ?: DEFAULT_LANE
        return "${resolved.key.first()}$nowMillis"
    }

    /** True when this todo originated in one of our clients rather than the legacy import. */
    fun isAppCreated(raw: Map<String, Any?>): Boolean {
        val id = raw["id"].wireString()
        return id.startsWith("vv-") ||
            raw["created_by"].wireString() == "vogel-vault" ||
            raw["sync_source"].wireString() == "vogel-vault"
    }

    // ── Normalization ───────────────────────────────────────────────────────

    fun normalizePriority(value: Any?): Int = when {
        value == null -> 0
        value is Number -> if (value.toDouble().isFinite()) value.toDouble().toInt() else 0
        else -> {
            val text = value.toString().trim().lowercase()
            when {
                text.isEmpty() -> 0
                PRIORITY_WORDS.containsKey(text) -> PRIORITY_WORDS.getValue(text)
                // Deliberate divergence from the server, which does
                // Number(priority || 0) and yields NaN for "high" — NaN is not a
                // priority and JSON-encodes to null.
                else -> text.toDoubleOrNull()?.takeIf { it.isFinite() }?.toInt() ?: 0
            }
        }
    }

    /**
     * @param nowMillis the clock, in epoch ms. Required, unlike the server's
     *   `now` which defaults to Date.now(): normalization stamps timestamps and
     *   mints ids, so a hidden clock would make the same input produce different
     *   output on two clients.
     * @param defaultTimestamps when false, absent timestamps stay "" instead of
     *   being stamped with now. Used on the pull side, where "missing" must
     *   survive so last-write-wins stays honest.
     */
    fun normalize(
        raw: Map<String, Any?>,
        nowMillis: Long,
        defaultTimestamps: Boolean = true,
    ): CanonicalTodo {
        val nowIso = isoFromMillis(nowMillis)

        val lane = resolveLane(raw["category"], raw["type"], raw["project"]) ?: DEFAULT_LANE
        val id = canonicalId(raw, nowMillis, lane)

        // A present-but-empty title does NOT fall through to text, matching the
        // server: only an absent or null title borrows the alias.
        val title = (raw["title"] ?: falsyToEmpty(raw["text"])).wireString().trim()
        val text = (raw["text"] ?: falsyToEmpty(raw["title"])).wireString().trim()

        val doneFlag = truthy(raw["done"]) || truthy(raw["completed"])
        val status = raw["status"]?.wireString() ?: if (doneFlag) "completed" else "pending"
        val done = doneFlag || status == "completed"

        val fallbackStamp = if (defaultTimestamps) nowIso else ""
        val createdAt = firstPresent(raw, "createdAt", "created") ?: fallbackStamp
        val updatedAt = firstPresent(raw, "updated_at", "updatedAt", "completedAt") ?: fallbackStamp

        // Ownership follows Swift's effectiveOwner: owner, then assignee, then
        // the compatibility default. The server only reads `owner`, so an assignee-only
        // todo would land on Victor there — here it lands on the person it
        // names, which is what the visibility layer has to act on.
        val ownerKey = firstPresent(raw, "owner", "assignee")
        val owner = FamilyMember.coerceOwner(ownerKey?.trim()?.lowercase())

        return CanonicalTodo(
            id = id,
            title = title,
            text = text,
            lane = lane,
            type = firstPresent(raw, "type") ?: lane.key,
            status = status,
            done = done,
            priority = normalizePriority(raw["priority"]),
            dueDate = resolveDueDate(raw),
            createdAt = createdAt,
            updatedAt = updatedAt,
            flagged = truthy(raw["flag"]) || truthy(raw["flagged"]),
            project = firstPresent(raw, "project") ?: "Inbox",
            area = firstPresent(raw, "area") ?: "",
            assignee = firstPresent(raw, "assignee", "owner") ?: FamilyMember.DEFAULT_OWNER.key,
            owner = owner,
            notes = firstPresent(raw, "notes", "note") ?: "",
            source = firstPresent(raw, "source") ?: "",
            createdBy = firstPresent(raw, "created_by") ?: "",
            syncSource = firstPresent(raw, "sync_source") ?: "",
            completedAt = firstPresent(raw, "completedAt"),
            completedBy = firstPresent(raw, "completed_by"),
        )
    }

    /**
     * Re-emit the dual-field superset exactly as `convex/todoNormalize.ts` does.
     *
     * Both spellings of every dual field are written from the *same* normalized
     * value, so a consumer reading either gets the same answer. `completedAt`
     * and `completed_by` are omitted rather than nulled when absent, because the
     * server omits them and a null would reopen a completed todo on the round
     * trip.
     */
    fun wireRecord(todo: CanonicalTodo): Map<String, Any> {
        val record = LinkedHashMap<String, Any>()
        record["id"] = todo.id
        record["title"] = todo.title
        record["text"] = todo.text
        record["category"] = todo.lane.key
        record["type"] = todo.type
        record["status"] = todo.status
        record["done"] = todo.done
        record["priority"] = todo.priority
        record["dueDate"] = todo.dueDate
        record["due_date"] = todo.dueDate
        record["createdAt"] = todo.createdAt
        record["created"] = if (todo.createdAt.isEmpty()) "" else todo.createdAt.take(10)
        record["updatedAt"] = todo.updatedAt
        record["updated_at"] = todo.updatedAt
        record["flag"] = todo.flagged
        record["flagged"] = todo.flagged
        record["project"] = todo.project
        record["area"] = todo.area
        record["assignee"] = todo.assignee
        record["owner"] = todo.owner.key
        record["notes"] = todo.notes
        record["source"] = todo.source
        record["created_by"] = todo.createdBy
        record["sync_source"] = todo.syncSource
        todo.completedAt?.let { record["completedAt"] = it }
        todo.completedBy?.let { record["completed_by"] = it }
        return record
    }

    /** Normalize and immediately re-emit — the shape a client sends to Convex. */
    fun normalizeWire(
        raw: Map<String, Any?>,
        nowMillis: Long,
        defaultTimestamps: Boolean = true,
    ): Map<String, Any> = wireRecord(normalize(raw, nowMillis, defaultTimestamps))

    // ── Last-write-wins ─────────────────────────────────────────────────────

    /**
     * Epoch ms for a raw todo's update stamp; 0 when missing or unparseable.
     *
     * Zero is deliberate and load-bearing: an unstamped record must lose every
     * comparison rather than silently win one, so a client that forgets to stamp
     * cannot clobber a real edit.
     */
    fun updatedMillis(raw: Map<String, Any?>): Long =
        isoToMillis(firstPresent(raw, "updated_at", "updatedAt", "completedAt"))

    fun updatedMillis(todo: CanonicalTodo): Long =
        isoToMillis(if (todo.updatedAt.isNotEmpty()) todo.updatedAt else todo.completedAt)

    /**
     * Resolve two versions of the same todo.
     *
     * Ties go to the incoming record, matching the server's `>=`: the incoming
     * write is the one a human just made, and a tie means the same millisecond.
     * [nowMillis] stands in for an unstamped incoming record, mirroring the
     * server's `todoUpdatedMs(normalized) || now`.
     */
    fun merge(existing: CanonicalTodo, incoming: CanonicalTodo, nowMillis: Long): CanonicalTodo {
        val existingMillis = updatedMillis(existing)
        val incomingMillis = updatedMillis(incoming).let { if (it == 0L) nowMillis else it }
        return if (incomingMillis >= existingMillis) incoming else existing
    }

    // ── Timestamps ──────────────────────────────────────────────────────────

    // Three explicit fraction digits, matching JavaScript's Date#toISOString.
    // ISO_INSTANT would drop ".000" and the two clients would emit different
    // strings for the same instant.
    private val ISO_MILLIS: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    fun isoFromMillis(millis: Long): String = ISO_MILLIS.format(Instant.ofEpochMilli(millis))

    private val ISO_DATE = Regex("""^(\d{4})-(\d{2})-(\d{2})$""")
    private val ISO_DATETIME = Regex(
        """^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}:?\d{2})?$""",
    )

    /**
     * Strict ISO-8601 to epoch ms; 0 for anything this parser does not recognise.
     *
     * Deliberately not a lenient parse. A zoneless datetime is *local* time under
     * JavaScript's rules, which would make last-write-wins resolve differently on
     * a laptop in Chicago and a phone in London — for a sync contract that is a
     * correctness bug, not a formatting one. Here a missing zone means UTC on
     * every client.
     */
    fun isoToMillis(value: String?): Long {
        val raw = value?.trim() ?: return 0L
        if (raw.isEmpty()) return 0L

        val dateOnly = ISO_DATE.matchEntire(raw)
        if (dateOnly != null) {
            val days = daysFromCivil(
                dateOnly.groupValues[1].toInt(),
                dateOnly.groupValues[2].toInt(),
                dateOnly.groupValues[3].toInt(),
            ) ?: return 0L
            return days * 86_400_000L
        }

        val match = ISO_DATETIME.matchEntire(raw) ?: return 0L
        val days = daysFromCivil(
            match.groupValues[1].toInt(),
            match.groupValues[2].toInt(),
            match.groupValues[3].toInt(),
        ) ?: return 0L

        val hours = match.groupValues[4].toInt()
        val minutes = match.groupValues[5].toInt()
        val seconds = match.groupValues[6].ifEmpty { "0" }.toInt()
        if (hours > 23 || minutes > 59 || seconds > 59) return 0L

        val fraction = match.groupValues[7]
        val millis = if (fraction.isEmpty()) 0L else fraction.take(3).padEnd(3, '0').toLong()

        val utc = days * 86_400_000L +
            hours * 3_600_000L +
            minutes * 60_000L +
            seconds * 1_000L +
            millis
        return utc - offsetMillis(match.groupValues[8])
    }

    fun isIsoDate(value: String): Boolean {
        val match = ISO_DATE.matchEntire(value) ?: return false
        return daysFromCivil(
            match.groupValues[1].toInt(),
            match.groupValues[2].toInt(),
            match.groupValues[3].toInt(),
        ) != null
    }

    private fun offsetMillis(offset: String): Long {
        if (offset.isEmpty() || offset == "Z" || offset == "z") return 0L
        val sign = if (offset.startsWith("-")) -1L else 1L
        val digits = offset.substring(1).replace(":", "")
        val hours = digits.substring(0, 2).toLong()
        val minutes = if (digits.length >= 4) digits.substring(2, 4).toLong() else 0L
        return sign * (hours * 3_600_000L + minutes * 60_000L)
    }

    /**
     * Days since the Unix epoch, or null if the date is not real.
     *
     * `LocalDate.of` rejects 2026-02-30 rather than rolling it into March, which
     * is what the TypeScript side hand-rolls to match.
     */
    private fun daysFromCivil(year: Int, month: Int, day: Int): Long? = try {
        LocalDate.of(year, month, day).toEpochDay()
    } catch (_: DateTimeException) {
        null
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private fun resolveDueDate(raw: Map<String, Any?>): String {
        for (key in DUE_DATE_KEYS) {
            val value = raw[key] ?: continue
            // Slice first: legacy todo payloads sometimes carry "2026-07-27 09:00" or a full
            // instant, and the due date is a calendar day on every client.
            val candidate = value.wireString().trim().take(10)
            // Validated, unlike the server: `when` is a Things bucket
            // ("anytime"), and a non-date rendered into a due chip looks like
            // data rather than noise.
            if (isIsoDate(candidate)) return candidate
        }
        return ""
    }

    /** First key that is neither absent nor null, as a string. */
    private fun firstPresent(raw: Map<String, Any?>, vararg keys: String): String? {
        for (key in keys) {
            val value = raw[key]
            if (value != null) return value.wireString()
        }
        return null
    }

    /** The server's `x || ""` idiom, so falsy aliases behave identically. */
    private fun falsyToEmpty(value: Any?): Any = if (truthy(value)) value!! else ""

    /** JavaScript truthiness, which is what the server's `||` chains rely on. */
    private fun truthy(value: Any?): Boolean = when (value) {
        null -> false
        is Boolean -> value
        is Number -> value.toDouble() != 0.0 && !value.toDouble().isNaN()
        is String -> value.isNotEmpty()
        else -> true
    }

    /**
     * `String(value)` as JavaScript would render it.
     *
     * JSON has one number type, so a decoder can hand back 42.0 where the wire
     * said 42. Rendering that as "42.0" would change ids and timestamps, so
     * integral doubles collapse to their integer form.
     */
    private fun Any?.wireString(): String = when (this) {
        null -> ""
        is Double -> if (isFinite() && this == Math.floor(this)) toLong().toString() else toString()
        is Float -> toDouble().let { if (it.isFinite() && it == Math.floor(it)) it.toLong().toString() else it.toString() }
        else -> toString()
    }
}

// ── Collection operations ───────────────────────────────────────────────────

/** Upsert one todo by id, preserving position and list order. */
fun List<CanonicalTodo>.upsertTodo(incoming: CanonicalTodo, nowMillis: Long): List<CanonicalTodo> {
    val index = indexOfFirst { it.id == incoming.id }
    if (index < 0) return this + incoming
    return mapIndexed { position, todo ->
        if (position == index) Todo.merge(todo, incoming, nowMillis) else todo
    }
}

/** Fold [remote] into this list id by id. Local order wins; new remotes append. */
fun List<CanonicalTodo>.mergeTodos(
    remote: List<CanonicalTodo>,
    nowMillis: Long,
): List<CanonicalTodo> = remote.fold(this) { merged, todo -> merged.upsertTodo(todo, nowMillis) }

/**
 * Drop every todo whose tombstone is strictly newer than its update stamp.
 *
 * Strictly newer, not newer-or-equal — the server comment is "deletedAt is newer
 * than its local updated_at", and an equal stamp means the edit and the delete
 * are indistinguishable, in which case keeping the user's content is the safer
 * of the two mistakes.
 */
fun List<CanonicalTodo>.applyTombstones(tombstones: List<TodoTombstone>): List<CanonicalTodo> {
    if (tombstones.isEmpty()) return toList()
    val deletedAt = tombstones.associate { it.id to it.deletedAtMillis }
    return filter { todo ->
        val stamp = deletedAt[todo.id]
        stamp == null || stamp <= Todo.updatedMillis(todo)
    }
}

/** Union two tombstone sets, keeping the latest delete per id. Sorted by id. */
fun mergeTodoTombstones(
    left: List<TodoTombstone>,
    right: List<TodoTombstone>,
): List<TodoTombstone> {
    val latest = LinkedHashMap<String, Long>()
    for (tombstone in left + right) {
        val known = latest[tombstone.id]
        if (known == null || tombstone.deletedAtMillis > known) {
            latest[tombstone.id] = tombstone.deletedAtMillis
        }
    }
    return latest.map { TodoTombstone(it.key, it.value) }.sortedBy { it.id }
}

/** One pull: merge what the server sent, then honour its tombstones. */
fun reconcileTodos(
    local: List<CanonicalTodo>,
    remote: List<CanonicalTodo>,
    tombstones: List<TodoTombstone>,
    nowMillis: Long,
): List<CanonicalTodo> = local.mergeTodos(remote, nowMillis).applyTombstones(tombstones)

// ── Read-model projection ───────────────────────────────────────────────────

/**
 * Project a canonical todo onto the read model the screens already render.
 *
 * Empty strings become null here rather than in the normaliser: "" is what the
 * wire format uses for absent and null is what the UI uses, and conflating the
 * two is how a blank due-date chip gets rendered.
 */
fun CanonicalTodo.toTodoItem(): TodoItem = TodoItem(
    id = id,
    title = title,
    done = done,
    project = project.ifEmpty { null },
    area = area.ifEmpty { null },
    due = dueDate.ifEmpty { null },
    flagged = flagged,
    owner = owner,
)

/** Open and due on or before [date], comparing ISO strings lexically. */
fun CanonicalTodo.isDueBy(date: String): Boolean {
    if (done || dueDate.isEmpty()) return false
    return dueDate <= date
}
