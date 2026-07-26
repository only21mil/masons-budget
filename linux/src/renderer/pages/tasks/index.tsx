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
  FreshnessTag,
  PageHeader,
  Panel,
  StateBlock,
  TextInput,
  Toolbar,
} from "../../components/index.ts"
import type { PageManifest } from "../types.ts"

const TODAY = "2026-07-26"

function useVisibleTodos(): readonly TodoItem[] {
  const { activeProfile, data } = useAppState()
  return useMemo(() => visibleTo(activeProfile, data.todos.value), [activeProfile, data.todos.value])
}

function tableState(status: string): "normal" | "empty" | "error" | "stale" | "loading" {
  if (status === "loading" || status === "error" || status === "empty") return status
  return "normal"
}

const todoColumns: ReadonlyArray<Column<TodoItem>> = [
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
  { key: "project", header: "Project", render: (row) => row.project ?? row.area ?? "—", secondary: true },
  { key: "due", header: "Due", render: (row) => row.due ?? "—", width: "112px" },
  { key: "owner", header: "Owner", render: (row) => <Badge>{row.owner}</Badge>, secondary: true },
]

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
  const { data } = useAppState()
  const todos = useVisibleTodos()
  const [draft, setDraft] = useState("")

  const rows = todos.filter(filter)

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={<FreshnessTag status={data.todos.status} updatedAt={data.todos.updatedAt} />}
      />
      {showComposer ? (
        <Toolbar>
          <TextInput
            aria-label="New task"
            placeholder="Add a task…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {/*
            Writeback is not wired. The Convex write path is credential-gated and
            owned by the approved app-writeback lane, so this control is disabled
            rather than pretending to save and silently dropping the task.
          */}
          <Button icon="check" disabled title="Writeback is not enabled in this build">
            Add
          </Button>
        </Toolbar>
      ) : null}
      <Panel source={data.todos.source} flush>
        <DataTable
          columns={todoColumns}
          rows={rows}
          rowKey={(row) => row.id}
          state={tableState(data.todos.status)}
          emptyTitle={emptyTitle}
          emptyDetail={emptyDetail}
          footer={`${rows.length} shown · ${todos.length} visible to this profile`}
        />
      </Panel>
    </>
  )
}

function TodayPage() {
  return (
    <TodoListPage
      title="Today"
      subtitle="Due today or overdue"
      filter={(todo) => !todo.done && todo.due !== null && todo.due <= TODAY}
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
      subtitle="Unsorted — no project, no area"
      filter={(todo) => !todo.done && todo.project === null && todo.area === null}
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
      filter={(todo) => !todo.done && todo.due !== null && todo.due > TODAY}
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
      filter={(todo) => todo.flagged && !todo.done}
      emptyTitle="Nothing flagged"
      emptyDetail="No open tasks are currently flagged for this profile."
    />
  )
}

function ProjectsPage() {
  const { data } = useAppState()
  const todos = useVisibleTodos()

  const groups = useMemo(() => {
    const byProject = new Map<string, TodoItem[]>()
    for (const todo of todos) {
      const key = todo.project ?? todo.area ?? "Unfiled"
      const bucket = byProject.get(key)
      if (bucket) bucket.push(todo)
      else byProject.set(key, [todo])
    }
    return [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [todos])

  if (data.todos.status === "loading") {
    return (
      <>
        <PageHeader title="Projects" />
        <StateBlock state="loading" />
      </>
    )
  }

  if (groups.length === 0) {
    return (
      <>
        <PageHeader title="Projects" />
        <StateBlock
          state={data.todos.status === "error" ? "error" : "empty"}
          title="No projects"
          detail="No tasks visible to this profile are grouped under a project or area."
        />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Grouped by project, then area"
        actions={<FreshnessTag status={data.todos.status} updatedAt={data.todos.updatedAt} />}
      />
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
                columns={todoColumns}
                rows={items}
                rowKey={(row) => row.id}
                state="normal"
              />
            </Panel>
          )
        })}
      </div>
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
