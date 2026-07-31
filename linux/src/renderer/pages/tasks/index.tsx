// Tasks page slice.
//
// Task lists are profile-owned. Adults see the household's tasks (including the
// kids'); a child sees only their own. That is the same canSeeDataOwnedBy rule
// the finance pages use — there is deliberately no second visibility model.

import { useMemo, useState } from "react"

import { visibleTo } from "@vogel-vault/domain/family"
import type { TodoItem } from "@vogel-vault/domain/readModel"

import { useAppState } from "../../app/AppState.tsx"
import {
  Badge,
  Button,
  type Column,
  DataTable,
  DeleteConfirmDialog,
  FreshnessTag,
  MutationNotice,
  PageHeader,
  Panel,
  StateBlock,
  StatusBanner,
  TextInput,
  TodoFormDialog,
  Toolbar,
} from "../../components/index.ts"
import { type MutationGate, stableId } from "../../data/mutations.ts"
import type { PageManifest } from "../types.ts"

const TODAY = "2026-07-26"

/**
 * The retained default project for a todo nobody filed.
 *
 * normalizeTodoRecord defaults `project` to this string, mirroring the Convex
 * emitter, so the read model never hands us a null project. "Inbox" therefore
 * means the absence of a filing, not a project a human created — and a view that
 * treats it as one buries every unfiled task under a fake project heading.
 * Spelled out here rather than re-derived per view: one interpretation, one
 * place, same as the contract itself.
 */
export const UNFILED_PROJECT = "Inbox"

/** Where a todo is filed: its project, else its area, else nowhere. */
export function filingOf(todo: TodoItem): string | null {
  const project = todo.project === UNFILED_PROJECT ? null : todo.project
  return project ?? todo.area
}

/**
 * The task views, as predicates over the read model.
 *
 * Exported so linux/test/todo-dialects.test.ts can prove that the same todo
 * spelled in different legacy wire dialects lands in the same views. A dialect that
 * routes differently is invisible to the shared parity fixture, which pins the
 * normaliser rather than the screens.
 */
export const taskFilters = {
  today: (todo: TodoItem) => !todo.done && todo.due !== null && todo.due <= TODAY,
  inbox: (todo: TodoItem) => !todo.done && filingOf(todo) === null,
  upcoming: (todo: TodoItem) => !todo.done && todo.due !== null && todo.due > TODAY,
  flagged: (todo: TodoItem) => todo.flagged && !todo.done,
} satisfies Record<string, (todo: TodoItem) => boolean>

function useVisibleTodos(): readonly TodoItem[] {
  const { activeProfile, data } = useAppState()
  return useMemo(() => visibleTo(activeProfile, data.todos.value), [activeProfile, data.todos.value])
}

function tableState(status: string): "normal" | "empty" | "error" | "stale" | "loading" {
  if (status === "loading" || status === "error" || status === "empty") return status
  return "normal"
}

export function taskWriteStatusMessage(
  upsertGate: MutationGate,
  deleteGate: MutationGate,
): string | null {
  if (upsertGate.allowed && deleteGate.allowed) return null
  if (!upsertGate.allowed && !deleteGate.allowed && upsertGate.reason === deleteGate.reason) {
    return `Editing and deleting tasks are unavailable: ${upsertGate.reason ?? "This action is unavailable."}`
  }
  const reasons: string[] = []
  if (!upsertGate.allowed) {
    reasons.push(`Editing tasks: ${upsertGate.reason ?? "This action is unavailable."}`)
  }
  if (!deleteGate.allowed) {
    reasons.push(`Deleting tasks: ${deleteGate.reason ?? "This action is unavailable."}`)
  }
  return reasons.join(" ")
}

function TaskWriteStatus() {
  const { activeProfile, data, mutationGate } = useAppState()
  const message = taskWriteStatusMessage(
    mutationGate("todo.upsert", data.todos.status, activeProfile),
    mutationGate("todo.delete", data.todos.status, activeProfile),
  )
  if (!message) return null
  return <StatusBanner tone="warning" title="Task actions are limited" detail={message} />
}

export const todoColumns: ReadonlyArray<Column<TodoItem>> = [
  {
    key: "done",
    header: "",
    width: "34px",
    render: (row) => (
      <span aria-label={row.done ? "Done" : "Open"} className={row.done ? "vv-positive" : "vv-dim"}>
        {row.done ? "[x]" : "[ ]"}
      </span>
    ),
  },
  {
    key: "title",
    header: "Task",
    render: (row) => (
      <span className={row.done ? "vv-dim" : undefined}>
        {row.title}
        {row.flagged ? (
          <>
            {" "}
            <Badge tone="warning" icon="flag">
              Flagged
            </Badge>
          </>
        ) : null}
      </span>
    ),
  },
  { key: "project", header: "Project", render: (row) => filingOf(row) ?? "—", secondary: true },
  { key: "due", header: "Due", render: (row) => row.due ?? "—", width: "112px" },
  { key: "owner", header: "Owner", render: (row) => <Badge>{row.owner}</Badge>, secondary: true },
]

function TodoActionsCell({ todo }: { todo: TodoItem }) {
  const {
    activeProfile,
    data,
    isMutationPending,
    mutationGate,
    submitMutation,
  } = useAppState()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const upsertGate = mutationGate("todo.upsert", data.todos.status, todo.owner)
  const deleteGate = mutationGate("todo.delete", data.todos.status, todo.owner)
  const pending = isMutationPending("todo.upsert", todo.owner, todo.id)

  async function update(changes: Partial<Pick<TodoItem, "done" | "flagged">>) {
    if (!upsertGate.allowed) return
    await submitMutation({
      kind: "todo.upsert",
      requestId: stableId("request"),
      actor: activeProfile,
      id: todo.id,
      owner: todo.owner,
      title: todo.title,
      done: changes.done ?? todo.done,
      flagged: changes.flagged ?? todo.flagged,
      project: todo.project ?? undefined,
      area: todo.area ?? undefined,
      due: todo.due ?? undefined,
      notes: todo.notes ?? undefined,
      lane: todo.lane ?? undefined,
      priority: todo.priority ?? undefined,
      createdAt: todo.createdAt ?? undefined,
      updatedAt: todo.updatedAt ?? undefined,
      completedAt: todo.completedAt ?? undefined,
      baseUpdatedAtMs: todo.updatedAtMs,
    })
  }

  async function remove() {
    if (!deleteGate.allowed) return
    setDeleting(true)
    const result = await submitMutation({
      kind: "todo.delete",
      requestId: stableId("request"),
      actor: activeProfile,
      id: todo.id,
      owner: todo.owner,
      baseUpdatedAtMs: todo.updatedAtMs,
    })
    setDeleting(false)
    if (result.status === "ok") setConfirming(false)
  }

  return (
    <>
      <div className="vv-row-actions" aria-busy={pending || deleting || undefined}>
        <Button
          variant="ghost"
          onClick={() => void update({ done: !todo.done })}
          disabled={!upsertGate.allowed || pending}
          title={!upsertGate.allowed ? upsertGate.reason ?? undefined : undefined}
          aria-label={`${todo.done ? "Reopen" : "Complete"} ${todo.title}`}
        >
          {todo.done ? "Reopen" : "Complete"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => void update({ flagged: !todo.flagged })}
          disabled={!upsertGate.allowed || pending}
          title={!upsertGate.allowed ? upsertGate.reason ?? undefined : undefined}
          aria-pressed={todo.flagged}
          aria-label={`${todo.flagged ? "Unflag" : "Flag"} ${todo.title}`}
        >
          {todo.flagged ? "Unflag" : "Flag"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setEditing(true)}
          disabled={!upsertGate.allowed || pending}
          title={!upsertGate.allowed ? upsertGate.reason ?? undefined : undefined}
          aria-label={`Edit ${todo.title}`}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          onClick={() => setConfirming(true)}
          disabled={!deleteGate.allowed || deleting}
          title={!deleteGate.allowed ? deleteGate.reason ?? undefined : undefined}
          aria-label={`Delete ${todo.title}`}
        >
          Delete
        </Button>
      </div>
      <TodoFormDialog open={editing} todo={todo} onClose={() => setEditing(false)} />
      <DeleteConfirmDialog
        open={confirming}
        label={todo.title}
        busy={deleting}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove()}
      />
    </>
  )
}

function useInteractiveTodoColumns(): ReadonlyArray<Column<TodoItem>> {
  return useMemo(
    () => [
      ...todoColumns,
      {
        key: "actions",
        header: "Task actions",
        render: (row: TodoItem) => <TodoActionsCell todo={row} />,
        width: "284px",
      },
    ],
    [],
  )
}

/** Shared list page — the five task views differ only by filter and copy. */
function TodoListPage({
  title,
  subtitle,
  filter,
  emptyTitle,
  emptyDetail,
  showComposer = false,
}: {
  title: string
  subtitle?: string
  filter: (todo: TodoItem) => boolean
  emptyTitle: string
  emptyDetail: string
  showComposer?: boolean
}) {
  const {
    activeProfile,
    data,
    mutationGate,
    mutationNotice,
    refresh,
    submitMutation,
  } = useAppState()
  const todos = useVisibleTodos()
  const [draft, setDraft] = useState("")
  const [adding, setAdding] = useState(false)
  const [quickError, setQuickError] = useState<string | null>(null)
  const columns = useInteractiveTodoColumns()

  const rows = todos.filter(filter)
  const addGate = mutationGate("todo.upsert", data.todos.status, activeProfile)

  async function quickAdd() {
    if (!draft.trim() || !addGate.allowed) return
    const result = await submitMutation({
      kind: "todo.upsert",
      requestId: stableId("request"),
      actor: activeProfile,
      id: stableId("todo"),
      owner: activeProfile,
      title: draft.trim(),
      done: false,
      flagged: false,
      due: title === "Today" ? TODAY : undefined,
    })
    if (result.status === "ok") {
      setDraft("")
      setQuickError(null)
    } else {
      setQuickError("The task was not saved. Your draft is still here.")
    }
  }

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => setAdding(true)}
              disabled={!addGate.allowed}
              title={addGate.reason ?? undefined}
            >
              Add task
            </Button>
            <FreshnessTag status={data.todos.status} updatedAt={data.todos.updatedAt} />
          </>
        }
      />
      <MutationNotice notice={mutationNotice} onRetry={() => void refresh()} />
      <TaskWriteStatus />
      {showComposer ? (
        <Toolbar>
          <TextInput
            aria-label="New task"
            placeholder="Add a task…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            icon="check"
            disabled={!addGate.allowed || !draft.trim()}
            title={addGate.reason ?? undefined}
            onClick={() => void quickAdd()}
          >
            Add
          </Button>
          {quickError ? <span role="alert" className="vv-negative">{quickError}</span> : null}
        </Toolbar>
      ) : null}
      <Panel source={data.todos.source} flush>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          state={tableState(data.todos.status)}
          emptyTitle={emptyTitle}
          emptyDetail={emptyDetail}
          footer={`${rows.length} shown · ${todos.length} visible to this profile`}
          caption={`${title} tasks with task actions`}
          className="vv-task-table"
        />
      </Panel>
      <TodoFormDialog
        open={adding}
        todo={null}
        defaultDue={title === "Today" ? TODAY : undefined}
        onClose={() => setAdding(false)}
      />
    </>
  )
}

function TodayPage() {
  return (
    <TodoListPage
      title="Today"
      subtitle="Due today or overdue"
      filter={taskFilters.today}
      emptyTitle="Nothing due today"
      emptyDetail="No open tasks are due on or before today for this profile."
      showComposer
    />
  )
}

function InboxPage() {
  return (
    <TodoListPage
      title="Inbox"
      subtitle="Unsorted — still in the default Inbox"
      filter={taskFilters.inbox}
      emptyTitle="Inbox is clear"
      emptyDetail="Every open task has been filed under a project or area."
      showComposer
    />
  )
}

function UpcomingPage() {
  return (
    <TodoListPage
      title="Upcoming"
      subtitle="Scheduled beyond today"
      filter={taskFilters.upcoming}
      emptyTitle="Nothing scheduled"
      emptyDetail="No open tasks have a due date after today."
    />
  )
}

function FlaggedPage() {
  return (
    <TodoListPage
      title="Flagged"
      subtitle="Marked for attention"
      filter={taskFilters.flagged}
      emptyTitle="Nothing flagged"
      emptyDetail="No open tasks are currently flagged for this profile."
    />
  )
}

function ProjectsPage() {
  const {
    activeProfile,
    data,
    mutationGate,
    mutationNotice,
    refresh,
  } = useAppState()
  const todos = useVisibleTodos()
  const [adding, setAdding] = useState(false)
  const columns = useInteractiveTodoColumns()
  const addGate = mutationGate("todo.upsert", data.todos.status, activeProfile)

  const groups = useMemo(() => {
    const byProject = new Map<string, TodoItem[]>()
    for (const todo of todos) {
      const key = filingOf(todo) ?? "Unfiled"
      const bucket = byProject.get(key)
      if (bucket) bucket.push(todo)
      else byProject.set(key, [todo])
    }
    return [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [todos])

  if (data.todos.status === "loading") {
    return (
      <>
        <PageHeader
          title="Projects"
          actions={<Button disabled title={addGate.reason ?? undefined}>Add task</Button>}
        />
        <TaskWriteStatus />
        <StateBlock state="loading" />
      </>
    )
  }

  if (groups.length === 0) {
    return (
      <>
        <PageHeader
          title="Projects"
          actions={
            <Button
              variant="primary"
              onClick={() => setAdding(true)}
              disabled={!addGate.allowed}
              title={addGate.reason ?? undefined}
            >
              Add task
            </Button>
          }
        />
        <TaskWriteStatus />
        <StateBlock
          state={data.todos.status === "error" ? "error" : "empty"}
          title="No projects"
          detail="No tasks visible to this profile are grouped under a project or area."
        />
        <TodoFormDialog open={adding} todo={null} onClose={() => setAdding(false)} />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Grouped by project, then area"
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => setAdding(true)}
              disabled={!addGate.allowed}
              title={addGate.reason ?? undefined}
            >
              Add task
            </Button>
            <FreshnessTag status={data.todos.status} updatedAt={data.todos.updatedAt} />
          </>
        }
      />
      <MutationNotice notice={mutationNotice} onRetry={() => void refresh()} />
      <TaskWriteStatus />
      <div className="vv-stack">
        {groups.map(([name, items]) => {
          const open = items.filter((item) => !item.done).length
          return (
            <Panel
              key={name}
              title={name}
              source={`${open} open of ${items.length}`}
              flush
            >
              <DataTable
                columns={columns}
                rows={items}
                rowKey={(row) => row.id}
                state="normal"
                caption={`${name} tasks with task actions`}
                className="vv-task-table"
              />
            </Panel>
          )
        })}
      </div>
      <TodoFormDialog open={adding} todo={null} onClose={() => setAdding(false)} />
    </>
  )
}

export const tasksPageManifest: PageManifest = {
  id: "tasks",
  label: "Tasks",
  pages: [
    { id: "today", label: "Today", icon: "today", Component: TodayPage },
    { id: "inbox", label: "Inbox", icon: "inbox", Component: InboxPage },
    { id: "upcoming", label: "Upcoming", icon: "calendar", Component: UpcomingPage },
    { id: "flagged", label: "Flagged", icon: "flag", Component: FlaggedPage },
    { id: "projects", label: "Projects", icon: "projects", Component: ProjectsPage },
  ],
}
