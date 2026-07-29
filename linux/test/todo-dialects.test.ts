// One todo, every retained wire spelling, one rendering.
//
// The shared fixture (shared/domain/fixtures/todo-cases.json) pins the
// normaliser; it says nothing about the screen. This suite pins the other half:
// that the Tasks page reads todos ONLY through normalizeTodoRecord/toTodoItem,
// so a todo that arrives as `{done, due_date, flag, title}` and the same todo
// as `{completed, when, flagged, text}` produce byte-identical cells and land in
// exactly the same views.
//
// It is written against the page's exported columns and filters rather than a
// full route render because that is the whole surface: if a dialect survives
// this, no Tasks view can disagree about it.
//
// createElement rather than JSX, matching routes.test.ts — tsconfig type-checks
// test/**/*.ts, and a .tsx test would silently fall outside `npm run typecheck`.

import assert from "node:assert/strict"
import { test } from "vitest"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { TodoItem } from "@vogel-vault/domain/readModel"
import { type RawTodo, normalizeTodoRecord, toTodoItem } from "@vogel-vault/domain/todo"

import { buildSanitizedFixtureEnvelope } from "../src/renderer/data/fixtures.ts"
import { UNFILED_PROJECT, filingOf, taskFilters, todoColumns } from "../src/renderer/pages/tasks/index.tsx"

/** The fixture clock, so a minted id or stamped timestamp cannot drift a run. */
const NOW = Date.UTC(2026, 6, 26, 14, 30, 0)

function read(raw: RawTodo): TodoItem {
  return toTodoItem(normalizeTodoRecord(raw, { nowMillis: NOW }))
}

/** Every cell the Tasks table would draw for this todo, as one markup string. */
function renderCells(todo: TodoItem): string {
  return todoColumns
    .map((column) => renderToStaticMarkup(createElement("td", { key: column.key }, column.render(todo))))
    .join("")
}

/** Which views a todo appears in, in a stable order. */
function viewsFor(todo: TodoItem): string[] {
  return Object.entries(taskFilters)
    .filter(([, matches]) => matches(todo))
    .map(([name]) => name)
    .sort()
}

interface DialectGroup {
  readonly name: string
  /** What the views must agree on, so a wrong-but-consistent read still fails. */
  readonly views: readonly string[]
  readonly dialects: Readonly<Record<string, RawTodo>>
}

const GROUPS: readonly DialectGroup[] = [
  {
    name: "open, flagged, due tomorrow, filed under an area",
    views: ["flagged", "upcoming"],
    dialects: {
      "snake case, as the Convex emitter writes it": {
        id: "d-1",
        title: "Reconcile July statements",
        area: "Finance",
        due_date: "2026-07-27",
        flag: true,
        owner: "victor",
      },
      "legacy camel-case shape": {
        id: "d-1",
        title: "Reconcile July statements",
        area: "Finance",
        dueDate: "2026-07-27",
        flagged: true,
        owner: "victor",
      },
      "Things aliases: text, deadline, and a wall-clock stamp": {
        id: "d-1",
        text: "Reconcile July statements",
        area: "Finance",
        deadline: "2026-07-27 09:00",
        flag: true,
        owner: "victor",
      },
      "both spellings of every pair, agreeing": {
        id: "d-1",
        title: "Reconcile July statements",
        text: "Reconcile July statements",
        area: "Finance",
        due: "2026-07-27",
        due_date: "2026-07-27",
        dueDate: "2026-07-27",
        flag: true,
        flagged: true,
        done: false,
        completed: false,
        owner: "victor",
      },
    },
  },
  {
    name: "completed, filed under a project",
    views: [],
    dialects: {
      done: { id: "d-2", title: "File receipts", project: "Tax Prep", done: true, owner: "victor" },
      completed: { id: "d-2", title: "File receipts", project: "Tax Prep", completed: true, owner: "victor" },
      "status only": {
        id: "d-2",
        title: "File receipts",
        project: "Tax Prep",
        status: "completed",
        owner: "victor",
      },
      "text alias, and both done spellings agreeing": {
        id: "d-2",
        text: "File receipts",
        project: "Tax Prep",
        done: true,
        completed: true,
        status: "completed",
        owner: "victor",
      },
    },
  },
  {
    name: "unfiled and undated — the Inbox",
    views: ["inbox"],
    dialects: {
      "nothing but a title": { id: "d-3", title: "Sort out the garage shelving", owner: "victor" },
      // `when` is a Things bucket word. It is not a date and must not become one,
      // and an unfiled todo must not be dragged into Today by it.
      "when: anytime": {
        id: "d-3",
        title: "Sort out the garage shelving",
        when: "anytime",
        owner: "victor",
      },
      "explicit legacy default project": {
        id: "d-3",
        text: "Sort out the garage shelving",
        project: UNFILED_PROJECT,
        owner: "victor",
      },
      // Ownership resolves through assignee when owner is absent — the v0.3 bug.
      "assignee instead of owner": { id: "d-3", title: "Sort out the garage shelving", assignee: "Victor" },
    },
  },
  {
    name: "overdue and owned by a child",
    views: ["today"],
    dialects: {
      "due, plain date": { id: "d-4", title: "Finish reading assignment", area: "School", due: "2026-07-20", owner: "mason" },
      "date, with a time": {
        id: "d-4",
        title: "Finish reading assignment",
        area: "School",
        date: "2026-07-20 16:00",
        owner: "mason",
      },
      "dueDate, full instant": {
        id: "d-4",
        text: "Finish reading assignment",
        area: "School",
        dueDate: "2026-07-20T16:00:00Z",
        owner: "mason",
      },
    },
  },
]

for (const group of GROUPS) {
  test(`dialects render identically — ${group.name}`, () => {
    const entries = Object.entries(group.dialects)
    const [baselineName, baselineRaw] = entries[0] as [string, RawTodo]
    const baseline = read(baselineRaw)

    assert.deepEqual(
      viewsFor(baseline),
      [...group.views].sort(),
      `${baselineName} does not land in the expected views`,
    )

    const expectedCells = renderCells(baseline)
    for (const [name, raw] of entries.slice(1)) {
      const todo = read(raw)
      assert.deepEqual(todo, baseline, `${name} normalizes to a different read model than ${baselineName}`)
      assert.equal(renderCells(todo), expectedCells, `${name} renders differently from ${baselineName}`)
      assert.deepEqual(viewsFor(todo), viewsFor(baseline), `${name} lands in different views`)
    }
  })
}

test("an unfiled todo is not filed under a project called Inbox", () => {
  const unfiled = read({ id: "d-5", title: "Book the dentist", owner: "victor" })

  // The contract fills `project` in rather than leaving it unset, so a view that
  // trusts the field verbatim would invent an "Inbox" project heading and empty
  // the Inbox list at the same time.
  assert.equal(unfiled.project, UNFILED_PROJECT)
  assert.equal(filingOf(unfiled), null)
  assert.equal(taskFilters.inbox(unfiled), true)

  const filed = read({ id: "d-6", title: "Book the dentist", project: "Health Admin", owner: "victor" })
  assert.equal(filingOf(filed), "Health Admin")
  assert.equal(taskFilters.inbox(filed), false)
})

test("the fixture envelope is built through the contract, not around it", () => {
  const todos = buildSanitizedFixtureEnvelope("victor").todos.value

  // Every fixture todo carries a project because normalizeTodoRecord guarantees
  // one. A null here means something bypassed the normaliser on the way in.
  assert.ok(todos.length > 0)
  for (const todo of todos) assert.notEqual(todo.project, null)

  // And the mixed dialects in the fixture actually reach the views they should.
  assert.ok(todos.some((todo) => taskFilters.inbox(todo)), "no fixture todo reaches the Inbox view")
  assert.ok(todos.some((todo) => taskFilters.flagged(todo)), "no fixture todo reaches the Flagged view")
  assert.ok(todos.some((todo) => todo.done), "no fixture todo is complete")

  // todo-0004 carries `when: "anytime"`. A Things bucket word is not a due date.
  const bucketed = todos.find((todo) => todo.id === "todo-0004")
  assert.equal(bucketed?.due, null)

  // todo-0003 has no `owner`, only `assignee: "rachel"`.
  assert.equal(todos.find((todo) => todo.id === "todo-0003")?.owner, "rachel")
})
