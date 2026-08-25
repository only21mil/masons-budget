// Parity suite for the shared todo contract.
//
// Every case is driven by ../fixtures/todo-cases.json, which is the same file
// the Android (Kotlin) suite loads. The fixture is pinned to the server
// semantics in convex/todoNormalize.ts + convex/dataFiles.ts and to the alias
// and ownership rules in the legacy Swift compatibility DTO. If either changes,
// update the fixture in the same commit and both clients move together.

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { type FamilyMember } from "../src/family.ts"
import {
  type CanonicalTodo,
  type RawTodo,
  type TodoLane,
  type TodoTombstone,
  applyTodoTombstones,
  canonicalTodoId,
  canonicalTodoUpdatedMillis,
  isAppCreatedTodo,
  isTodoDueBy,
  isoFromMillis,
  isoToMillis,
  mergeTodo,
  mergeTodoLists,
  mergeTodoTombstones,
  normalizeTodoLane,
  normalizeTodoPriority,
  normalizeTodoRecord,
  normalizeTodoWire,
  reconcileTodos,
  resolveTodoLane,
  todosForActiveProfile,
  todoUpdatedMillis,
  toTodoItem,
  upsertTodo,
} from "../src/todo.ts"

// The fixture is language-neutral JSON, so it arrives untyped. Describing its
// shape here keeps the suite type-checked rather than silently `any`, and makes
// a fixture edit that breaks the contract a compile error.
type WireValue = string | number | boolean
type RawTombstone = { id: string; deletedAt: number }

interface NormalizeCase {
  name: string
  input: RawTodo
  defaultTimestamps?: boolean
  expected: Record<string, WireValue>
  note?: string
}
interface PairCase {
  name: string
  existing: RawTodo
  incoming: RawTodo
  expectedTitle: string
  note?: string
}
interface UpsertCase {
  name: string
  base: RawTodo[]
  incoming: RawTodo
  expected: { id: string; title: string }[]
}
interface MergeCase {
  name: string
  local: RawTodo[]
  remote: RawTodo[]
  expected: { id: string; title: string }[]
  note?: string
}
interface TombstoneCase {
  name: string
  todos: RawTodo[]
  tombstones: RawTombstone[]
  expectedIds: string[]
  note?: string
}
interface ReconcileCase extends MergeCase {
  tombstones: RawTombstone[]
}

interface Fixtures {
  nowMillis: number
  nowIso: string
  defaultLane: TodoLane
  lanes: TodoLane[]
  normalizeLane: { input: string | null; expected: TodoLane | null }[]
  resolveLane: { input: Record<string, unknown>; expected: TodoLane | null; note?: string }[]
  canonicalId: { todo: RawTodo; expected: string; note?: string }[]
  appCreated: { todo: RawTodo; expected: boolean }[]
  isoFromMillis: { millis: number; expected: string }[]
  isoToMillis: { value: string; expected: number; note?: string }[]
  priority: { input: string | number | null; expected: number; note?: string }[]
  normalize: NormalizeCase[]
  updatedMillis: { todo: RawTodo; expected: number; note?: string }[]
  lastWriteWins: PairCase[]
  upsert: UpsertCase[]
  mergeLists: MergeCase[]
  tombstones: TombstoneCase[]
  mergeTombstones: { name: string; left: RawTombstone[]; right: RawTombstone[]; expected: RawTombstone[] }[]
  reconcile: ReconcileCase[]
  sampleTodos: RawTodo[]
  visibility: { viewer: FamilyMember; expectedIds: string[]; note?: string }[]
  dueBy: { todoId: string; date: string; expected: boolean; note?: string }[]
  readModel: {
    todoId: string
    expected: {
      id: string
      title: string
      done: boolean
      project: string | null
      area: string | null
      due: string | null
      flagged: boolean
      owner: FamilyMember
    }
    note?: string
  }[]
}

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "todo-cases.json"), "utf8"),
) as Fixtures

const NOW = fixtures.nowMillis

/** Sync-path helper: raw stamps drive the comparison, missing stays missing. */
function pull(raw: RawTodo): CanonicalTodo {
  return normalizeTodoRecord(raw, { nowMillis: NOW, defaultTimestamps: false })
}

function tombstonesOf(raws: readonly RawTombstone[]): TodoTombstone[] {
  return raws.map((raw) => ({ id: raw.id, deletedAtMillis: raw.deletedAt }))
}

const sampleTodos = fixtures.sampleTodos.map((raw) => normalizeTodoRecord(raw, { nowMillis: NOW }))

function sample(id: string): CanonicalTodo {
  const todo = sampleTodos.find((candidate) => candidate.id === id)
  assert.ok(todo, `sampleTodos is missing ${id}`)
  return todo
}

// ── Lanes and identity ──────────────────────────────────────────────────────

test("lane normalization matches the server's valid set", () => {
  for (const testCase of fixtures.normalizeLane) {
    assert.equal(normalizeTodoLane(testCase.input), testCase.expected, JSON.stringify(testCase.input))
  }
})

test("lane resolution walks category, then type, then the list", () => {
  for (const testCase of fixtures.resolveLane) {
    assert.equal(resolveTodoLane(testCase.input), testCase.expected, JSON.stringify(testCase.input))
  }
})

test("canonical ids are preserved, or minted from the lane and the clock", () => {
  for (const testCase of fixtures.canonicalId) {
    assert.equal(canonicalTodoId(testCase.todo, { nowMillis: NOW }), testCase.expected, testCase.note ?? "")
  }
})

test("app-created todos are recognised by id or by provenance", () => {
  for (const testCase of fixtures.appCreated) {
    assert.equal(isAppCreatedTodo(testCase.todo), testCase.expected, JSON.stringify(testCase.todo))
  }
})

// ── Timestamps ──────────────────────────────────────────────────────────────

test("isoFromMillis matches Date#toISOString so Kotlin can match it too", () => {
  for (const testCase of fixtures.isoFromMillis) {
    assert.equal(isoFromMillis(testCase.millis), testCase.expected)
    assert.equal(isoFromMillis(testCase.millis), new Date(testCase.millis).toISOString())
  }
})

test("isoToMillis parses strictly and treats a missing zone as UTC", () => {
  for (const testCase of fixtures.isoToMillis) {
    assert.equal(isoToMillis(testCase.value), testCase.expected, `${testCase.value} ${testCase.note ?? ""}`)
  }
})

test("a zoneless stamp does not depend on the host timezone", () => {
  // The bug this guards: new Date("2026-07-26T14:30:00") is local time, so two
  // devices would order the same two edits differently.
  assert.equal(isoToMillis("2026-07-26T14:30:00"), isoToMillis("2026-07-26T14:30:00Z"))
})

// ── Normalization ───────────────────────────────────────────────────────────

test("word priorities become numbers instead of NaN", () => {
  for (const testCase of fixtures.priority) {
    assert.equal(normalizeTodoPriority(testCase.input), testCase.expected, String(testCase.input))
  }
})

test("normalization emits the dual-field superset the server emits", () => {
  for (const testCase of fixtures.normalize) {
    const actual = normalizeTodoWire(testCase.input, {
      nowMillis: NOW,
      defaultTimestamps: testCase.defaultTimestamps !== false,
    })
    assert.deepEqual(actual, testCase.expected, testCase.name)
  }
})

test("both spellings of every dual field always agree", () => {
  for (const testCase of fixtures.normalize) {
    const wire = normalizeTodoWire(testCase.input, {
      nowMillis: NOW,
      defaultTimestamps: testCase.defaultTimestamps !== false,
    })
    assert.equal(wire.dueDate, wire.due_date, testCase.name)
    assert.equal(wire.updatedAt, wire.updated_at, testCase.name)
    assert.equal(wire.flag, wire.flagged, testCase.name)
    assert.equal(wire.created, String(wire.createdAt).slice(0, 10), testCase.name)
  }
})

test("completedAt and completed_by are omitted rather than nulled", () => {
  const open = normalizeTodoWire({ id: "t-1", title: "Open" }, { nowMillis: NOW })
  assert.ok(!("completedAt" in open))
  assert.ok(!("completed_by" in open))
})

test("normalization is idempotent on its own output", () => {
  for (const testCase of fixtures.normalize) {
    const options = { nowMillis: NOW, defaultTimestamps: testCase.defaultTimestamps !== false }
    const once = normalizeTodoWire(testCase.input, options)
    assert.deepEqual(normalizeTodoWire(once, options), once, testCase.name)
  }
})

test("an untagged todo is owned by the household default, never dropped", () => {
  const todo = normalizeTodoRecord({ id: "t-x", title: "Untagged" }, { nowMillis: NOW })
  assert.equal(todo.owner, "victor")
})

/**
 * Fields where this contract knowingly departs from convex/todoNormalize.ts,
 * with the reason recorded in the fixture's $divergences block. Anything not
 * listed here must come out byte-identical to the server.
 */
const SERVER_DIVERGENCES: ReadonlySet<string> = new Set([
  "owner", // Swift's effectiveOwner (owner ?? assignee), coerced to a FamilyMember
  "priority", // the server yields NaN for retained word priorities
  "dueDate", // extra Swift aliases, and the result must be a real calendar day
  "due_date",
])

interface ServerNormalizer {
  normalizeTodoRecord: (
    todo: Record<string, unknown>,
    options: { now: number; defaultTimestamps: boolean },
  ) => Record<string, unknown>
}

const serverModulePath = join(here, "..", "..", "..", "convex", "todoNormalize.ts")

test("every field the server also computes is byte-identical to the server", async (t) => {
  // Loaded at runtime by path rather than statically imported. convex/ is not a
  // dependency of this package and does not compile under its stricter tsconfig,
  // but convex/todoNormalize.ts is itself a hand-synced mirror that warns it can
  // drift — so something has to actually compare the two, and this is it.
  if (!existsSync(serverModulePath)) {
    t.skip(`convex/todoNormalize.ts not present at ${serverModulePath}`)
    return
  }
  const server = (await import(pathToFileURL(serverModulePath).href)) as ServerNormalizer

  for (const testCase of fixtures.normalize) {
    const defaultTimestamps = testCase.defaultTimestamps !== false
    const mine = normalizeTodoWire(testCase.input, { nowMillis: NOW, defaultTimestamps })
    const theirs = server.normalizeTodoRecord({ ...testCase.input }, { now: NOW, defaultTimestamps })

    assert.deepEqual(
      Object.keys(mine).sort(),
      Object.keys(theirs).sort(),
      `${testCase.name}: the emitted key set must match the server exactly`,
    )
    for (const key of Object.keys(mine)) {
      if (SERVER_DIVERGENCES.has(key)) continue
      assert.deepEqual(mine[key], theirs[key], `${testCase.name}: ${key}`)
    }
  }
})

// ── Last-write-wins ─────────────────────────────────────────────────────────

test("update stamps read snake, then camel, then completedAt", () => {
  for (const testCase of fixtures.updatedMillis) {
    assert.equal(todoUpdatedMillis(testCase.todo), testCase.expected, testCase.note ?? JSON.stringify(testCase.todo))
  }
})

test("last-write-wins resolves the way the server resolves it", () => {
  for (const testCase of fixtures.lastWriteWins) {
    const winner = mergeTodo(pull(testCase.existing), pull(testCase.incoming), NOW)
    assert.equal(winner.title, testCase.expectedTitle, testCase.name)
  }
})

test("upsert preserves position and rejects stale edits", () => {
  for (const testCase of fixtures.upsert) {
    const result = upsertTodo(testCase.base.map(pull), pull(testCase.incoming), NOW)
    assert.deepEqual(
      result.map((todo) => ({ id: todo.id, title: todo.title })),
      testCase.expected,
      testCase.name,
    )
  }
})

test("merging two lists keeps local order and appends unseen remotes", () => {
  for (const testCase of fixtures.mergeLists) {
    const result = mergeTodoLists(testCase.local.map(pull), testCase.remote.map(pull), NOW)
    assert.deepEqual(
      result.map((todo) => ({ id: todo.id, title: todo.title })),
      testCase.expected,
      testCase.name,
    )
  }
})

test("merging is stable — a second identical merge changes nothing", () => {
  for (const testCase of fixtures.mergeLists) {
    const local = testCase.local.map(pull)
    const remote = testCase.remote.map(pull)
    const once = mergeTodoLists(local, remote, NOW)
    assert.deepEqual(mergeTodoLists(once, remote, NOW), once, testCase.name)
  }
})

// ── Tombstones ──────────────────────────────────────────────────────────────

test("tombstones remove deleted todos without resurrecting later edits", () => {
  for (const testCase of fixtures.tombstones) {
    const result = applyTodoTombstones(testCase.todos.map(pull), tombstonesOf(testCase.tombstones))
    assert.deepEqual(
      result.map((todo) => todo.id),
      testCase.expectedIds,
      testCase.name,
    )
  }
})

test("tombstone sets union to the latest delete per id", () => {
  for (const testCase of fixtures.mergeTombstones) {
    assert.deepEqual(
      mergeTodoTombstones(tombstonesOf(testCase.left), tombstonesOf(testCase.right)),
      tombstonesOf(testCase.expected),
      testCase.name,
    )
  }
})

test("a pull merges and then honours the tombstones", () => {
  for (const testCase of fixtures.reconcile) {
    const result = reconcileTodos({
      local: testCase.local.map(pull),
      remote: testCase.remote.map(pull),
      tombstones: tombstonesOf(testCase.tombstones),
      nowMillis: NOW,
    })
    assert.deepEqual(
      result.map((todo) => ({ id: todo.id, title: todo.title })),
      testCase.expected,
      testCase.name,
    )
  }
})

test("a deleted todo cannot come back on the next pull", () => {
  const [testCase] = fixtures.reconcile
  assert.ok(testCase, "reconcile fixture is empty")
  const remote = testCase.remote.map(pull)
  const tombstones = tombstonesOf(testCase.tombstones)
  let state = reconcileTodos({ local: testCase.local.map(pull), remote, tombstones, nowMillis: NOW })
  state = reconcileTodos({ local: state, remote, tombstones, nowMillis: NOW })
  assert.deepEqual(
    state.map((todo) => todo.id),
    testCase.expected.map((entry) => entry.id),
  )
})

// ── Visibility ──────────────────────────────────────────────────────────────

test("todo list projection is exact-owner for the active profile", () => {
  for (const testCase of fixtures.visibility) {
    assert.deepEqual(
      todosForActiveProfile(testCase.viewer, sampleTodos).map((todo) => todo.id),
      testCase.expectedIds,
      `${testCase.viewer}${testCase.note ? ` (${testCase.note})` : ""}`,
    )
  }
})

test("an untagged Victor todo is hidden until Victor is the active profile", () => {
  assert.equal(todosForActiveProfile("rachel", sampleTodos).some((todo) => todo.id === "t-5"), false)
  assert.equal(todosForActiveProfile("victor", sampleTodos).some((todo) => todo.id === "t-5"), true)
})

test("empty collections do not throw", () => {
  assert.deepEqual(applyTodoTombstones([], []), [])
  assert.deepEqual(mergeTodoLists([], [], NOW), [])
  assert.deepEqual(todosForActiveProfile("mason", []), [])
})

// ── Read-model projection ───────────────────────────────────────────────────

test("due-by is open-and-on-or-before, comparing ISO strings lexically", () => {
  for (const testCase of fixtures.dueBy) {
    assert.equal(
      isTodoDueBy(sample(testCase.todoId), testCase.date),
      testCase.expected,
      `${testCase.todoId} by ${testCase.date}${testCase.note ? ` (${testCase.note})` : ""}`,
    )
  }
})

test("the read-model projection turns wire empties into nulls", () => {
  for (const testCase of fixtures.readModel) {
    const item = toTodoItem(sample(testCase.todoId))
    assert.equal(item.id, testCase.expected.id)
    assert.equal(item.title, testCase.expected.title)
    assert.equal(item.done, testCase.expected.done)
    assert.equal(item.project, testCase.expected.project)
    assert.equal(item.area, testCase.expected.area)
    assert.equal(item.due, testCase.expected.due)
    assert.equal(item.flagged, testCase.expected.flagged)
    assert.equal(item.owner, testCase.expected.owner)
  }
})

test("canonical and raw update stamps agree", () => {
  for (const raw of fixtures.sampleTodos) {
    const todo = pull(raw)
    assert.equal(canonicalTodoUpdatedMillis(todo), todoUpdatedMillis(raw))
  }
})
