# Todo contract adoption — Android

Where the MC2 todo shape is allowed to be interpreted in this app, and where it
is not. Written down because the rule is invisible in the code that obeys it:
a screen that reads `todo.due` looks the same whether or not something upstream
did the normalising.

## The rule

`Todo.normalize` in `android/domain/.../Todo.kt` is the only thing in this app
that may look at MC2's dual-field superset — `done`/`completed`,
`due_date`/`dueDate`/`due`/`date`/`deadline`/`when`, `flag`/`flagged`,
`title`/`text`, `owner`/`assignee`. It is the Kotlin mirror of
`shared/domain/src/todo.ts`, and the two are pinned to each other by
`shared/domain/fixtures/todo-cases.json`, which both test suites load.

Everything downstream reads `TodoItem`, which has one spelling per field. A
second reading of an alias anywhere else is a bug even when it happens to agree
today, because the fixture cannot see it and the two readings will drift.

Boundary shape, in one line:

    raw MC2 map -> Todo.normalize(raw, nowMillis) -> CanonicalTodo -> toTodoItem() -> TodoItem -> UI

## Status, 2026-07-26

- **`ui/Screens.kt`, tasks section (`today()`)** — adopted. It filters with
  `isDueBy`, the contract's own open-and-due rule, and knows nothing about field
  aliases. The one thing it does interpret is `MC2_DEFAULT_PROJECT`: the
  normaliser fills `project` with `"Inbox"` for an unfiled todo rather than
  leaving it unset, so the row treats that value as "not filed" and falls through
  to the area. The Linux client's Tasks page carries the identical rule
  (`filingOf` in `linux/src/renderer/pages/tasks/index.tsx`), and its dialect
  suite pins it.
- **`domain/Fixtures.kt`** — not yet. It hand-builds `TodoItem`s, so the sample
  data never exercises the normaliser. The Linux fixtures now author raw MC2
  dialects and route them through `normalizeTodoRecord`; this is the same change
  in Kotlin, and it belongs to whoever owns `android/domain` next.
- **The Convex read path (B6, behind a flag)** — not yet, and this is the one
  that matters. When it starts returning todos, the rows arrive as raw maps.
  They must go through `Todo.normalize(...).toTodoItem()` and nothing else. Do
  not add a per-field read in the repository or the view model.
- **Writeback** — not wired. When it is, it sends `Todo.normalizeWire(...)`, and
  merges use `mergeTodos`/`reconcileTodos` rather than a local last-write-wins.

## Why the fixture, not the unit test, is the contract

`TodoParityTest` reads `shared/domain/fixtures/todo-cases.json`; so does the
TypeScript suite. Changing the semantics means changing the fixture, which
breaks both clients at once and forces the decision to be made deliberately. A
Kotlin-only assertion would let Android drift from Linux and iOS silently, which
is how the dual-field shape became a problem in the first place.
