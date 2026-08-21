# Todo contract adoption — Android

Where the legacy `dataFiles` todo shape is allowed to be interpreted in this app, and where it
is not. Written down because the rule is invisible in the code that obeys it:
a screen that reads `todo.due` looks the same whether or not something upstream
did the normalising.

## The rule

`Todo.normalize` in `android/domain/.../Todo.kt` is the only thing in this app
that may look at the legacy dual-field superset — `done`/`completed`,
`due_date`/`dueDate`/`due`/`date`/`deadline`/`when`, `flag`/`flagged`,
`title`/`text`, `owner`/`assignee`. It is the Kotlin mirror of
`shared/domain/src/todo.ts`, and the two are pinned to each other by
`shared/domain/fixtures/todo-cases.json`, which both test suites load.

Everything downstream reads `TodoItem`, which has one spelling per field. A
second reading of an alias anywhere else is a bug even when it happens to agree
today, because the fixture cannot see it and the two readings will drift.

Boundary shape, in one line:

    raw legacy map -> Todo.normalize(raw, nowMillis) -> CanonicalTodo -> toTodoItem() -> TodoItem -> UI

## Status, 2026-07-26

- **`ui/TodoScreen.kt`, the Today screen** — adopted. It filters on the single
  canonical `due` spelling and knows nothing about field aliases. (`ui/TodayLogic.kt`
  filters the same rows with `isDueBy`, the contract's own open-and-due rule, for
  read-only surfaces; the editable screen is deliberately wider, because a
  completed task has to stay visible to be reopened.) The one thing the screen
  interprets is `UNFILED_TODO_PROJECT`: the
  normaliser fills `project` with `"Inbox"` for an unfiled todo rather than
  leaving it unset, so the row treats that value as "not filed" and falls through
  to the area. The Linux client's Tasks page carries the identical rule
  (`filingOf` in `linux/src/renderer/pages/tasks/index.tsx`), and its dialect
  suite pins it.
- **`domain/Fixtures.kt`** — not yet. It hand-builds `TodoItem`s, so the sample
  data never exercises the normaliser. The Linux fixtures now author raw legacy
  dialects and route them through `normalizeTodoRecord`; this is the same change
  in Kotlin, and it belongs to whoever owns `android/domain` next.
- **The legacy Convex blob path** — still raw. A todo map decoded from the
  `dataFiles` blob must go through `Todo.normalize(...).toTodoItem()` and
  nothing else. Do not add a second alias reader in a repository or view model.
- **The public Convex row path (`tables:listTodos`)** — adopted by the transport.
  The server projects the already-canonical row schema (`todoId`, `title`,
  `done`, and the single canonical spelling of every optional field), so
  `RowQueryRepository` validates that projection directly and maps it to
  `TodoItem`. It must not run the canonical row back through the raw legacy alias
  normalizer. Unknown owners or any malformed row reject the whole envelope;
  the transport never drops a bad todo and presents a plausible partial list.
- **Writeback (`ui/TodoMutationGateway.kt`)** — partly adopted. `toMutationJson`
  emits the same dual-spelling wire record as `Todo.wireRecord` and carries every
  metadata field the row arrived with, so an edit cannot erase notes, priority,
  lane or timestamps. It is not yet routed through `Todo.normalizeWire(...)`, which
  is where it belongs, and single-row writes here do not merge: the server's own
  `>=` last-write-wins decides. Multi-row convergence still owes
  `mergeTodos`/`reconcileTodos`.

## Why the fixture, not the unit test, is the contract

`TodoParityTest` reads `shared/domain/fixtures/todo-cases.json`; so does the
TypeScript suite. Changing the semantics means changing the fixture, which
breaks both clients at once and forces the decision to be made deliberately. A
Kotlin-only assertion would let Android drift from Linux and iOS silently, which
is how the dual-field shape became a problem in the first place.
