import { describe, expect, it } from "vitest"

import { buildSanitizedFixtureEnvelope } from "../src/renderer/data/fixtures.ts"
import {
  EMPTY_MUTATION_CONTROLLER,
  applyOptimisticMutation,
  beginMutation,
  finishRefresh,
  optimisticEnvelope,
  settleMutation,
  type RendererMutationRequest,
  type RendererMutationResult,
} from "../src/renderer/data/mutations.ts"

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

    const refreshed = finishRefresh(refreshFailed, "victor", 7, true)
    expect(refreshed.committed).toHaveLength(0)
  })

  it("applies exact optimistic values without editing derived fields", () => {
    const data = buildSanitizedFixtureEnvelope("victor")
    const changed = applyOptimisticMutation(data, {
      kind: "budgetCategory.upsert",
      requestId: "budget-1",
      actor: "victor",
      month: data.budget.value!.month,
      name: "Groceries",
      budgetCents: 123_45n,
    })
    const before = data.budget.value!.categories.find((row) => row.name === "Groceries")!
    const after = changed.budget.value!.categories.find((row) => row.name === "Groceries")!
    expect(after.budget).toBe(123_45n)
    expect(after.spent).toBe(before.spent)
  })
})
