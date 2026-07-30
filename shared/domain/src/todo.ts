// The Vogel Vault — shared todo contract.
//
// Todos are written by approved clients as well as read from Convex row tables.
// Unlike transactions or budgets they need three things the read model alone
// cannot give them: a canonical normaliser for the retained dual-field wire
// shape, a last-write-wins merge, and tombstone application. Those rules live on
// the server in convex/todoNormalize.ts + convex/dataFiles.ts. This file is the
// client-side half of the same contract, pinned against the server semantics by
// ../fixtures/todo-cases.json, which the TypeScript and Kotlin suites both load.
//
// Field-level truth, in order of authority:
//   - The retained Swift todo DTO is the compatibility authority for which
//     aliases exist and how ownership resolves.
//   - convex/todoNormalize.ts is the source of truth for what gets *emitted*.
// Where the two disagree, the divergences are enumerated in the fixture's
// $comment blocks and reproduced deliberately here, never accidentally.
//
// HARD RULE (repo AGENTS.md): owner resolution goes through coerceOwner and
// visibility through canSeeDataOwnedBy. Untagged adult records default to
// "victor", so a strict `owner === activeMember` check empties Rachel's todo
// list. That bug shipped in v0.3.

import { DEFAULT_OWNER, type FamilyMember, coerceOwner } from "./family.ts"
import type { TodoItem } from "./readModel.ts"

// ── Lanes ───────────────────────────────────────────────────────────────────

/** The three todo lanes. Port of VALID_TODO_LANES in convex/todoNormalize.ts. */
export const TODO_LANES = ["work", "personal", "sats"] as const

export type TodoLane = (typeof TODO_LANES)[number]

/** An untagged todo lands in the Sats lane, matching the server default. */
export const DEFAULT_TODO_LANE: TodoLane = "sats"

export function normalizeTodoLane(value: unknown): TodoLane | null {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim().toLowerCase()
  return (TODO_LANES as readonly string[]).includes(normalized) ? (normalized as TodoLane) : null
}

export interface TodoLaneInput {
  readonly category?: unknown
  readonly type?: unknown
  /** Retained records pass `project` here; the server calls the argument `list`. */
  readonly list?: unknown
}

export function resolveTodoLane(input: TodoLaneInput = {}): TodoLane | null {
  return (
    normalizeTodoLane(input.category) ?? normalizeTodoLane(input.type) ?? normalizeTodoLane(input.list)
  )
}

// ── Retained raw wire shape ─────────────────────────────────────────────────

/** A todo straight off the wire, before normalization. Keys are the superset. */
export type RawTodo = Readonly<Record<string, unknown>>

/**
 * A fully normalized todo.
 *
 * Single-field, camelCase and typed — the dual-field snake/camel superset only
 * exists on the wire, and is re-emitted by todoWireRecord. Keeping the duality
 * out of the domain type is the whole point: a screen that reads `dueDate` can
 * never disagree with one that reads `due_date`.
 */
export interface CanonicalTodo {
  readonly id: string
  readonly title: string
  /** Legacy alias for title. Kept because the server round-trips both. */
  readonly text: string
  readonly lane: TodoLane
  /** Raw `type`, which is usually but not always the lane. */
  readonly type: string
  readonly status: string
  readonly done: boolean
  readonly priority: number
  /** ISO `yyyy-MM-dd`, or "" when there is no due date. */
  readonly dueDate: string
  /** ISO-8601 instant, or "" when timestamps were not defaulted. */
  readonly createdAt: string
  readonly updatedAt: string
  readonly flagged: boolean
  readonly project: string
  readonly area: string
  /** Free text — may be a person, "vogel-vault", or an address. Not an owner. */
  readonly assignee: string
  readonly owner: FamilyMember
  readonly notes: string
  readonly source: string
  readonly createdBy: string
  readonly syncSource: string
  readonly completedAt: string | null
  readonly completedBy: string | null
}

export interface NormalizeTodoOptions {
  /**
   * Clock, in epoch ms. Required, unlike the server's `now` which defaults to
   * Date.now(): normalization stamps timestamps and mints ids, so a hidden clock
   * would make the same input produce different output on two clients.
   */
  readonly nowMillis: number
  /**
   * When false, absent timestamps stay "" instead of being stamped with now.
   * Used on the pull side, where "missing" must survive so LWW stays honest.
   */
  readonly defaultTimestamps?: boolean
}

// ── Identity ────────────────────────────────────────────────────────────────

export function canonicalTodoId(
  raw: RawTodo,
  options: { readonly nowMillis: number; readonly lane?: TodoLane },
): string {
  const existing = raw.id
  if (existing !== null && existing !== undefined && String(existing).trim() !== "") {
    return String(existing)
  }
  const lane =
    options.lane ??
    resolveTodoLane({ category: raw.category, type: raw.type, list: raw.project }) ??
    DEFAULT_TODO_LANE
  return `${lane.charAt(0)}${options.nowMillis}`
}

/** True when this todo originated in one of our clients rather than a legacy import. */
export function isAppCreatedTodo(raw: RawTodo): boolean {
  const id = String(raw.id ?? "")
  return (
    id.startsWith("vv-") ||
    String(raw.created_by ?? "") === "vogel-vault" ||
    String(raw.sync_source ?? "") === "vogel-vault"
  )
}

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * Due-date aliases, highest precedence first.
 *
 * The first two are what the server reads; the rest are Swift's
 * `effectiveDueDate` chain, appended *below* them so that any input the server
 * understands normalizes identically here. `when` is a Things bucket that is
 * often a word rather than a date, which is why the result is validated.
 */
const DUE_DATE_KEYS = ["dueDate", "due_date", "due", "date", "deadline", "when"] as const

/** Words retained todo records may put in `priority`. Port of Swift's decodePriority. */
const PRIORITY_WORDS: Readonly<Record<string, number>> = {
  urgent: 1,
  high: 1,
  medium: 2,
  normal: 2,
  low: 3,
}

export function normalizeTodoPriority(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : 0
  const text = String(value).trim().toLowerCase()
  const word = PRIORITY_WORDS[text]
  if (word !== undefined) return word
  const parsed = Number(text)
  // Deliberate divergence from the server, which does `Number(priority || 0)`
  // and yields NaN for "high" — NaN is not a priority and JSON-encodes to null.
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0
}

export function normalizeTodoRecord(raw: RawTodo, options: NormalizeTodoOptions): CanonicalTodo {
  const defaultTimestamps = options.defaultTimestamps !== false
  const nowIso = isoFromMillis(options.nowMillis)

  const lane =
    resolveTodoLane({ category: raw.category, type: raw.type, list: raw.project }) ?? DEFAULT_TODO_LANE
  const id = canonicalTodoId(raw, { nowMillis: options.nowMillis, lane })

  // A present-but-empty title does NOT fall through to text, matching the
  // server: only an absent or null title borrows the alias.
  const title = String(raw.title ?? orEmpty(raw.text)).trim()
  const text = String(raw.text ?? orEmpty(raw.title)).trim()

  const doneFlag = Boolean(raw.done || raw.completed)
  const status = firstPresent(raw, ["status"]) ?? (doneFlag ? "completed" : "pending")
  const done = doneFlag || status === "completed"

  const createdAt = firstPresent(raw, ["createdAt", "created"]) ?? (defaultTimestamps ? nowIso : "")
  const updatedAt =
    firstPresent(raw, ["updated_at", "updatedAt", "completedAt"]) ?? (defaultTimestamps ? nowIso : "")

  const dueDate = resolveDueDate(raw)

  const flagged = Boolean(raw.flag || raw.flagged)

  // Ownership follows Swift's `effectiveOwner`: owner, then assignee, then the
  // legacy default. The server only reads `owner`, so an assignee-only todo
  // would land on Victor there — here it lands on the person it names, which is
  // what the visibility layer has to act on.
  const ownerKey = firstPresent(raw, ["owner", "assignee"])
  const owner = coerceOwner(ownerKey === null ? null : ownerKey.trim().toLowerCase())

  const assignee = firstPresent(raw, ["assignee", "owner"]) ?? DEFAULT_OWNER

  return {
    id,
    title,
    text,
    lane,
    type: firstPresent(raw, ["type"]) ?? lane,
    status,
    done,
    priority: normalizeTodoPriority(raw.priority),
    dueDate,
    createdAt,
    updatedAt,
    flagged,
    project: firstPresent(raw, ["project"]) ?? "Inbox",
    area: firstPresent(raw, ["area"]) ?? "",
    assignee,
    owner,
    notes: firstPresent(raw, ["notes", "note"]) ?? "",
    source: firstPresent(raw, ["source"]) ?? "",
    createdBy: firstPresent(raw, ["created_by"]) ?? "",
    syncSource: firstPresent(raw, ["sync_source"]) ?? "",
    completedAt: firstPresent(raw, ["completedAt"]),
    completedBy: firstPresent(raw, ["completed_by"]),
  }
}

/**
 * Re-emit the dual-field superset exactly as convex/todoNormalize.ts does.
 *
 * Both spellings of every dual field are written from the *same* normalized
 * value, so a consumer that reads either one gets the same answer. `completedAt`
 * and `completed_by` are omitted rather than nulled when absent, because the
 * server omits them and a null would reopen a completed todo on the round trip.
 */
export function todoWireRecord(todo: CanonicalTodo): Record<string, string | number | boolean> {
  const record: Record<string, string | number | boolean> = {
    id: todo.id,
    title: todo.title,
    text: todo.text,
    category: todo.lane,
    type: todo.type,
    status: todo.status,
    done: todo.done,
    priority: todo.priority,
    dueDate: todo.dueDate,
    due_date: todo.dueDate,
    createdAt: todo.createdAt,
    created: todo.createdAt === "" ? "" : todo.createdAt.slice(0, 10),
    updatedAt: todo.updatedAt,
    updated_at: todo.updatedAt,
    flag: todo.flagged,
    flagged: todo.flagged,
    project: todo.project,
    area: todo.area,
    assignee: todo.assignee,
    owner: todo.owner,
    notes: todo.notes,
    source: todo.source,
    created_by: todo.createdBy,
    sync_source: todo.syncSource,
  }
  if (todo.completedAt !== null) record.completedAt = todo.completedAt
  if (todo.completedBy !== null) record.completed_by = todo.completedBy
  return record
}

/** Normalize and immediately re-emit — the shape a client sends to Convex. */
export function normalizeTodoWire(
  raw: RawTodo,
  options: NormalizeTodoOptions,
): Record<string, string | number | boolean> {
  return todoWireRecord(normalizeTodoRecord(raw, options))
}

// ── Last-write-wins ─────────────────────────────────────────────────────────

/**
 * Epoch ms for a raw todo's update stamp; 0 when missing or unparseable.
 *
 * Zero is deliberate and load-bearing: an unstamped record must lose every
 * comparison rather than silently win one, so a client that forgets to stamp
 * cannot clobber a real edit.
 */
export function todoUpdatedMillis(raw: RawTodo): number {
  const value = firstPresent(raw, ["updated_at", "updatedAt", "completedAt"])
  return value === null ? 0 : isoToMillis(value)
}

export function canonicalTodoUpdatedMillis(todo: CanonicalTodo): number {
  const stamp = todo.updatedAt !== "" ? todo.updatedAt : todo.completedAt
  return stamp === null || stamp === undefined ? 0 : isoToMillis(stamp)
}

/**
 * Resolve two versions of the same todo.
 *
 * Ties go to the incoming record, matching the server's `>=`: the incoming write
 * is the one a human just made, and a tie means the same millisecond.
 * `nowMillis` stands in for an unstamped incoming record, mirroring the server's
 * `todoUpdatedMs(normalized) || now`.
 */
export function mergeTodo(existing: CanonicalTodo, incoming: CanonicalTodo, nowMillis: number): CanonicalTodo {
  const existingMillis = canonicalTodoUpdatedMillis(existing)
  const incomingMillis = canonicalTodoUpdatedMillis(incoming) || nowMillis
  return incomingMillis >= existingMillis ? incoming : existing
}

/** Upsert one todo into a list by id, preserving position and list order. */
export function upsertTodo(
  todos: readonly CanonicalTodo[],
  incoming: CanonicalTodo,
  nowMillis: number,
): CanonicalTodo[] {
  const index = todos.findIndex((todo) => todo.id === incoming.id)
  if (index < 0) return [...todos, incoming]
  const next = [...todos]
  // Non-null: findIndex just proved the slot exists, but noUncheckedIndexedAccess
  // cannot see that.
  next[index] = mergeTodo(todos[index] as CanonicalTodo, incoming, nowMillis)
  return next
}

/** Fold `remote` into `local` id by id. Local order wins; new remotes append. */
export function mergeTodoLists(
  local: readonly CanonicalTodo[],
  remote: readonly CanonicalTodo[],
  nowMillis: number,
): CanonicalTodo[] {
  let merged: CanonicalTodo[] = [...local]
  for (const todo of remote) merged = upsertTodo(merged, todo, nowMillis)
  return merged
}

// ── Tombstones ──────────────────────────────────────────────────────────────

/**
 * A delete that has to outlive the record it deleted (SAT-1327).
 *
 * Without this, any pull that still carries the todo resurrects it. The
 * tombstone is compared against the todo's update stamp so a genuine edit made
 * *after* the delete still wins.
 */
export interface TodoTombstone {
  readonly id: string
  readonly deletedAtMillis: number
}

export function normalizeTodoTombstone(raw: Readonly<Record<string, unknown>>): TodoTombstone {
  const deletedAt = raw.deletedAt
  return {
    id: String(raw.id ?? ""),
    deletedAtMillis: typeof deletedAt === "number" && Number.isFinite(deletedAt) ? Math.trunc(deletedAt) : 0,
  }
}

/** Union two tombstone sets, keeping the latest delete per id. Sorted by id. */
export function mergeTodoTombstones(
  left: readonly TodoTombstone[],
  right: readonly TodoTombstone[],
): TodoTombstone[] {
  const latest = new Map<string, number>()
  for (const tombstone of [...left, ...right]) {
    const known = latest.get(tombstone.id)
    if (known === undefined || tombstone.deletedAtMillis > known) {
      latest.set(tombstone.id, tombstone.deletedAtMillis)
    }
  }
  return [...latest.entries()]
    .map(([id, deletedAtMillis]) => ({ id, deletedAtMillis }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Drop every todo whose tombstone is strictly newer than its update stamp.
 *
 * Strictly newer, not newer-or-equal — the server comment is "deletedAt is newer
 * than its local updated_at", and an equal stamp means the edit and the delete
 * are indistinguishable, in which case keeping the user's content is the safer
 * of the two mistakes.
 */
export function applyTodoTombstones(
  todos: readonly CanonicalTodo[],
  tombstones: readonly TodoTombstone[],
): CanonicalTodo[] {
  if (tombstones.length === 0) return [...todos]
  const deletedAt = new Map(tombstones.map((tombstone) => [tombstone.id, tombstone.deletedAtMillis]))
  return todos.filter((todo) => {
    const stamp = deletedAt.get(todo.id)
    if (stamp === undefined) return true
    return stamp <= canonicalTodoUpdatedMillis(todo)
  })
}

/** One pull: merge what the server sent, then honour its tombstones. */
export function reconcileTodos(input: {
  readonly local: readonly CanonicalTodo[]
  readonly remote: readonly CanonicalTodo[]
  readonly tombstones: readonly TodoTombstone[]
  readonly nowMillis: number
}): CanonicalTodo[] {
  return applyTodoTombstones(
    mergeTodoLists(input.local, input.remote, input.nowMillis),
    input.tombstones,
  )
}

// ── Read-model projection ───────────────────────────────────────────────────

/**
 * Project a canonical todo onto the read model the screens already render.
 *
 * Empty strings become null here rather than in the normaliser: "" is what the
 * wire format uses for absent, and null is what the UI uses, and conflating the
 * two is how a blank due-date chip gets rendered.
 */
export function toTodoItem(todo: CanonicalTodo): TodoItem {
  const parsedUpdatedAt = Date.parse(todo.updatedAt)
  return {
    id: todo.id,
    updatedAtMs: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : 0,
    title: todo.title,
    done: todo.done,
    project: emptyToNull(todo.project),
    area: emptyToNull(todo.area),
    due: emptyToNull(todo.dueDate),
    flagged: todo.flagged,
    lane: todo.lane,
    priority: BigInt(todo.priority),
    createdAt: emptyToNull(todo.createdAt),
    updatedAt: emptyToNull(todo.updatedAt),
    completedAt: todo.completedAt,
    notes: emptyToNull(todo.notes),
    owner: todo.owner,
  }
}

/** Open and due on or before `date`, comparing ISO strings lexically. */
export function isTodoDueBy(todo: CanonicalTodo, date: string): boolean {
  if (todo.done || todo.dueDate === "") return false
  return todo.dueDate <= date
}

// ── Timestamps ──────────────────────────────────────────────────────────────

/** `new Date(ms).toISOString()`, spelled out so Kotlin can match it exactly. */
export function isoFromMillis(millis: number): string {
  const date = new Date(millis)
  return date.toISOString()
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}:?\d{2})?$/

/**
 * Strict ISO-8601 to epoch ms; 0 for anything this parser does not recognise.
 *
 * Deliberately not `new Date(value)`. A zoneless datetime is local time under
 * JS's rules, which would make last-write-wins resolve differently on a laptop
 * in Chicago and a phone in London — for a sync contract that is a correctness
 * bug, not a formatting one. Here a missing zone means UTC on every client.
 */
export function isoToMillis(value: string): number {
  const raw = value.trim()
  if (raw === "") return 0

  const dateOnly = ISO_DATE.exec(raw)
  if (dateOnly) {
    const days = daysFromCivil(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]))
    return days === null ? 0 : days * 86_400_000
  }

  const match = ISO_DATETIME.exec(raw)
  if (!match) return 0

  const days = daysFromCivil(Number(match[1]), Number(match[2]), Number(match[3]))
  if (days === null) return 0

  const hours = Number(match[4])
  const minutes = Number(match[5])
  const seconds = match[6] === undefined ? 0 : Number(match[6])
  if (hours > 23 || minutes > 59 || seconds > 59) return 0

  const fraction = match[7] ?? ""
  const millis = fraction === "" ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"))

  const utc =
    days * 86_400_000 + hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + millis

  return utc - offsetMillis(match[8])
}

function offsetMillis(offset: string | undefined): number {
  if (offset === undefined || offset === "Z" || offset === "z") return 0
  const sign = offset.startsWith("-") ? -1 : 1
  const digits = offset.slice(1).replace(":", "")
  const hours = Number(digits.slice(0, 2))
  const minutes = Number(digits.slice(2, 4))
  return sign * (hours * 3_600_000 + minutes * 60_000)
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * Days since the Unix epoch for a calendar date, or null if the date is not
 * real. Hinnant's civil-from-days, which Kotlin gets for free from LocalDate —
 * spelled out here so both sides reject 2026-02-30 identically instead of
 * rolling it forward the way Date.UTC would.
 */
function daysFromCivil(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1) return null
  const monthLength = (DAYS_IN_MONTH[month - 1] as number) + (month === 2 && isLeapYear(year) ? 1 : 0)
  if (day > monthLength) return null

  const shifted = month <= 2 ? year - 1 : year
  const era = Math.floor(shifted / 400)
  const yearOfEra = shifted - era * 400
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146_097 + dayOfEra - 719_468
}

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value)
  if (!match) return false
  return daysFromCivil(Number(match[1]), Number(match[2]), Number(match[3])) !== null
}

// ── helpers ─────────────────────────────────────────────────────────────────

function resolveDueDate(raw: RawTodo): string {
  for (const key of DUE_DATE_KEYS) {
    const value = raw[key]
    if (value === null || value === undefined) continue
    // Slice first: retained records may carry "2026-07-27 09:00" or a full
    // instant, and the due date is a calendar day on every client.
    const candidate = String(value).trim().slice(0, 10)
    // Validated, unlike the server: `when` is a Things bucket ("anytime"), and a
    // non-date rendered into a due chip looks like data rather than noise.
    if (isIsoDate(candidate)) return candidate
  }
  return ""
}

/** First key that is neither absent nor null, as a string. */
function firstPresent(raw: RawTodo, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = raw[key]
    if (value !== null && value !== undefined) return String(value)
  }
  return null
}

/** The server's `x || ""` idiom, preserved so falsy aliases behave identically. */
function orEmpty(value: unknown): unknown {
  return value ? value : ""
}

function emptyToNull(value: string): string | null {
  return value === "" ? null : value
}
