import { describe, expect, it } from "vitest"

import { buildSanitizedFixtureEnvelope } from "../src/renderer/data/fixtures.ts"
import {
  EMPTY_MUTATION_CONTROLLER,
  applyOptimisticMutation,
  beginMutation,
  finishRefresh,
  isEntityPending,
  mutationResultMessage,
  optimisticEnvelope,
  settleMutation,
  type RendererMutationRequest,
  type RendererMutationResult,
} from "../src/renderer/data/mutations.ts"
import { taskToggleRequest } from "../src/renderer/pages/tasks/index.tsx"

const request: RendererMutationRequest = {
  kind: "todo.upsert",
  requestId: "request-1",
  actor: "victor",
  id: "todo-optimistic",
  owner: "victor",
  title: "Optimistic task",
  done: false,
  flagged: false,
}

const success: RendererMutationResult = {
  status: "ok",
  requestId: request.requestId,
  kind: request.kind,
  outcome: "inserted",
  entityId: request.id,
}

describe("renderer mutation controller", () => {
  it("serializes one entity and preserves the exact rollback snapshot identity", () => {
    const data = buildSanitizedFixtureEnvelope("victor")
    const started = beginMutation(EMPTY_MUTATION_CONTROLLER, request, data, "victor", 7)
    expect(started.status).toBe("started")
    if (started.status !== "started") return
    expect(started.pending.snapshot).toBeUndefined()

    const busy = beginMutation(started.state, { ...request, requestId: "request-2" }, data, "victor", 7)
    expect(busy.status).toBe("busy")

    const optimistic = optimisticEnvelope(data, started.state, "victor", 7)
    expect(optimistic.todos.value[0]?.id).toBe("todo-optimistic")
    const failed = settleMutation(
      started.state,
      started.pending,
      { status: "failed", requestId: request.requestId, kind: request.kind, code: "unavailable" },
      "victor",
      7,
    )
    const rolledBack = optimisticEnvelope(data, failed, "victor", 7)
    expect(rolledBack).toBe(data)
    expect(rolledBack.todos.value).toBe(data.todos.value)
  })

  it("ignores stale responses and responses from another profile generation", () => {
    const data = buildSanitizedFixtureEnvelope("victor")
    const started = beginMutation(EMPTY_MUTATION_CONTROLLER, request, data, "victor", 7)
    if (started.status !== "started") return
    const stale = settleMutation(
      started.state,
      started.pending,
      { ...success, requestId: "older-request" },
      "victor",
      7,
    )
    expect(stale).toBe(started.state)
    expect(optimisticEnvelope(data, started.state, "rachel", 8)).toBe(data)
  })

  it("keeps a successful optimistic write when refresh alone fails", () => {
    const data = buildSanitizedFixtureEnvelope("victor")
    const started = beginMutation(EMPTY_MUTATION_CONTROLLER, request, data, "victor", 7)
    if (started.status !== "started") return
    const committed = settleMutation(started.state, started.pending, success, "victor", 7)
    expect(committed.committed).toHaveLength(1)
    const refreshFailed = finishRefresh(committed, "victor", 7, false)
    expect(refreshFailed.committed).toHaveLength(1)
    expect(refreshFailed.notice?.tone).toBe("warning")
    expect(optimisticEnvelope(data, refreshFailed, "victor", 7).todos.value[0]?.id)
      .toBe("todo-optimistic")
    expect(isEntityPending(
      refreshFailed,
      "todo.upsert",
      "victor",
      request.id,
    )).toBe(true)
    expect(beginMutation(
      refreshFailed,
      { ...request, requestId: "request-after-failed-refresh" },
      data,
      "victor",
      7,
    ).status).toBe("busy")

    const refreshed = finishRefresh(refreshFailed, "victor", 7, true)
    expect(refreshed.committed).toHaveLength(0)
    expect(beginMutation(
      refreshed,
      { ...request, requestId: "request-after-refresh" },
      data,
      "victor",
      7,
    ).status).toBe("started")
  })

  it("clears only the mutation covered by a concurrent refresh snapshot", () => {
    const data = buildSanitizedFixtureEnvelope("victor")
    const first = beginMutation(
      EMPTY_MUTATION_CONTROLLER,
      request,
      data,
      "victor",
      7,
    )
    if (first.status !== "started") return
    const firstCommitted = settleMutation(
      first.state,
      first.pending,
      success,
      "victor",
      7,
    )
    const secondRequest: RendererMutationRequest = {
      ...request,
      requestId: "request-2",
      id: "todo-optimistic-2",
    }
    const second = beginMutation(
      firstCommitted,
      secondRequest,
      data,
      "victor",
      7,
    )
    if (second.status !== "started") return
    const bothCommitted = settleMutation(
      second.state,
      second.pending,
      {
        ...success,
        requestId: secondRequest.requestId,
        entityId: secondRequest.id,
      },
      "victor",
      7,
    )

    const firstRefresh = finishRefresh(
      bothCommitted,
      "victor",
      7,
      true,
      [request.requestId],
    )
    expect(firstRefresh.committed.map((entry) => entry.request.requestId))
      .toEqual([secondRequest.requestId])
    expect(isEntityPending(
      firstRefresh,
      "todo.upsert",
      "victor",
      secondRequest.id,
    )).toBe(true)
  })

  it("applies exact optimistic values without editing derived fields", () => {
    const data = buildSanitizedFixtureEnvelope("victor")
    const changed = applyOptimisticMutation(data, {
      kind: "budgetCategory.upsert",
      requestId: "budget-1",
      actor: "victor",
      owner: "victor",
      month: data.budget.value!.month,
      name: "Groceries",
      budgetCents: 123_45n,
    })
    const before = data.budget.value!.categories.find((row) => row.name === "Groceries")!
    const after = changed.budget.value!.categories.find((row) => row.name === "Groceries")!
    expect(after.budget).toBe(123_45n)
    expect(after.spent).toBe(before.spent)
  })

  it("serializes rapid completion toggles and rolls a failed reopen back exactly", () => {
    const data = buildSanitizedFixtureEnvelope("victor")
    const open = data.todos.value.find((todo) => !todo.done)!
    const complete = taskToggleRequest(
      open,
      "rachel",
      { done: true },
      () => new Date("2032-01-02T03:04:05.006Z"),
      "rapid-complete",
    )
    const startedComplete = beginMutation(
      EMPTY_MUTATION_CONTROLLER,
      complete,
      data,
      "rachel",
      12,
    )
    expect(startedComplete.status).toBe("started")
    if (startedComplete.status !== "started") return

    const completedOverlay = optimisticEnvelope(data, startedComplete.state, "rachel", 12)
    const completedTodo = completedOverlay.todos.value.find((todo) => todo.id === open.id)!
    expect(completedTodo).toMatchObject({
      done: true,
      updatedAt: "2032-01-02T03:04:05.006Z",
      completedAt: "2032-01-02T03:04:05.006Z",
      owner: open.owner,
    })

    const impatientReopen = taskToggleRequest(
      { ...completedTodo, updatedAtMs: open.updatedAtMs + 1 },
      "rachel",
      { done: false },
      () => new Date("2032-01-02T03:04:05.007Z"),
      "rapid-reopen-busy",
    )
    expect(beginMutation(
      startedComplete.state,
      impatientReopen,
      completedOverlay,
      "rachel",
      12,
    ).status).toBe("busy")

    const refreshedData = {
      ...completedOverlay,
      todos: {
        ...completedOverlay.todos,
        value: completedOverlay.todos.value.map((todo) =>
          todo.id === open.id ? { ...todo, updatedAtMs: open.updatedAtMs + 1 } : todo
        ),
      },
    }
    const refreshedTodo = refreshedData.todos.value.find((todo) => todo.id === open.id)!
    const reopen = taskToggleRequest(
      refreshedTodo,
      "rachel",
      { done: false },
      () => new Date("2032-01-02T03:04:06.000Z"),
      "rapid-reopen",
    )
    expect(reopen).toMatchObject({
      actor: "rachel",
      owner: open.owner,
      baseUpdatedAtMs: open.updatedAtMs + 1,
    })
    expect(reopen).not.toHaveProperty("completedAt")

    const startedReopen = beginMutation(
      EMPTY_MUTATION_CONTROLLER,
      reopen,
      refreshedData,
      "rachel",
      13,
    )
    expect(startedReopen.status).toBe("started")
    if (startedReopen.status !== "started") return
    const reopenedOverlay = optimisticEnvelope(refreshedData, startedReopen.state, "rachel", 13)
    expect(reopenedOverlay.todos.value.find((todo) => todo.id === open.id)?.completedAt).toBeNull()

    const failed = settleMutation(
      startedReopen.state,
      startedReopen.pending,
      {
        status: "failed",
        requestId: reopen.requestId,
        kind: reopen.kind,
        code: "unavailable",
      },
      "rachel",
      13,
    )
    expect(optimisticEnvelope(refreshedData, failed, "rachel", 13)).toBe(refreshedData)
  })

  it("uses local recovery text for profile binding and revision failures", () => {
    expect(mutationResultMessage({
      status: "failed",
      requestId: "request-profile-binding",
      kind: "todo.upsert",
      code: "PROFILE_BINDING_REQUIRED",
    })).toContain("Pair this profile again")
    expect(mutationResultMessage({
      status: "failed",
      requestId: "request-revision-required",
      kind: "todo.upsert",
      code: "REVISION_REQUIRED",
    })).toContain("authoritative server revision")
  })

  it("rolls an offline delete back to the exact cached row and permits an exact retry", () => {
    const data = buildSanitizedFixtureEnvelope("mason")
    const todo = data.todos.value[0]!
    const deletion: RendererMutationRequest = {
      kind: "todo.delete",
      requestId: "request-delete-offline",
      actor: "mason",
      id: todo.id,
      owner: todo.owner,
      baseUpdatedAtMs: todo.updatedAtMs,
    }
    const started = beginMutation(EMPTY_MUTATION_CONTROLLER, deletion, data, "mason", 3)
    expect(started.status).toBe("started")
    if (started.status !== "started") return
    expect(optimisticEnvelope(data, started.state, "mason", 3).todos.value)
      .not.toContain(todo)

    const failed = settleMutation(started.state, started.pending, {
      status: "failed",
      requestId: deletion.requestId,
      kind: deletion.kind,
      code: "unavailable",
    }, "mason", 3)
    expect(optimisticEnvelope(data, failed, "mason", 3)).toBe(data)
    const retry = beginMutation(failed, deletion, data, "mason", 3)
    expect(retry.status).toBe("started")
    if (retry.status === "started") expect(retry.pending.request).toBe(deletion)
  })

  it("does not invent an optimistic replacement for capsule-backed restore", () => {
    const data = buildSanitizedFixtureEnvelope("mason")
    const restore: RendererMutationRequest = {
      kind: "todo.restore",
      requestId: "request-restore-capsule",
      actor: "mason",
      id: "deleted-task-01",
      owner: "mason",
      baseUpdatedAtMs: 1_787_702_400_456,
    }
    const started = beginMutation(EMPTY_MUTATION_CONTROLLER, restore, data, "mason", 4)
    expect(started.status).toBe("started")
    if (started.status !== "started") return
    expect(started.pending.snapshot).toBeUndefined()
    expect(optimisticEnvelope(data, started.state, "mason", 4)).toBe(data)
  })
})
