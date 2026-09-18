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

## Status, 2026-09-18

- **`ui/TaskListsScreen.kt`** is the live task destination. It consumes canonical
  `TodoItem` rows, including completed tasks that can be reopened. The retired
  Today screen and its money-out projection have been removed.
- **`domain/Fixtures.kt`** builds `TodoItem` samples directly. Legacy normalization
  is covered separately by the shared parity fixtures.
- **The legacy Convex blob reader** remains compatibility code with no live
  Android caller. If a legacy todo blob is consumed, its maps must pass through
  `Todo.normalize(...).toTodoItem()`; do not introduce another alias reader.
- **The public Convex row path (`tables:listTodos`)** serves live Android reads.
  `RowQueryRepository` validates the canonical server projection and maps it to
  `TodoItem` without running it through the legacy alias normalizer. Unknown
  owners or malformed rows reject the envelope rather than hide missing tasks.
- **Writeback (`ui/TodoMutationGateway.kt`)** uses the paired-device mutation
  client. Its retained `toMutationJson` compatibility helper is test-only; it is
  not the live task write path. Shared parity tests continue to pin legacy wire
  normalization and merge rules.

## Why the fixture, not the unit test, is the contract

`TodoParityTest` reads `shared/domain/fixtures/todo-cases.json`; so does the
TypeScript suite. Changing the semantics means changing the fixture, which
breaks both clients at once and forces the decision to be made deliberately. A
Kotlin-only assertion would let Android drift from Linux and iOS silently, which
is how the dual-field shape became a problem in the first place.
