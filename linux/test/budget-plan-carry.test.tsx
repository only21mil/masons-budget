// @vitest-environment happy-dom

import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { VogelVaultRowRequest, VogelVaultRowResult } from "../shared/ipc.ts"
import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import { budgetPlanCarryRequest } from "../src/renderer/data/budgetPlanCarry.ts"
import {
  EMPTY_MUTATION_CONTROLLER, beginMutation, finishRefresh, optimisticEnvelope, settleMutation,
  type RendererMutationAdapter, type RendererMutationRequest, type RendererMutationResult,
} from "../src/renderer/data/mutations.ts"
import { ALL_PAGES } from "../src/renderer/pages/index.ts"
import { liveEnvelope } from "./support/renderRoute.ts"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = liveEnvelope()
const budget = { ...base.budget.value!, month: "2026-08", updatedAtMs: 100 }
const data = { ...base, budget: { ...base.budget, value: budget } }
const capabilities = ["budgetPlan.copyForward"] as const
const page = ALL_PAGES.find((candidate) => candidate.id === "budget")!
const input = { activeProfile: "rachel" as const, budget, currentMonth: "2026-09", requestId: "request-copy" }
const request = budgetPlanCarryRequest(input)!

function Probe() {
  const { selectedMonth, switchProfile, activeProfile, data: current, mutationNotice } = useAppState()
  return <>
    <output>{`${activeProfile}|${selectedMonth}|${current.budget.value?.month}|${mutationNotice?.text ?? ""}`}</output>
    <button onClick={() => switchProfile("mason")}>Switch profile</button>
    {createElement(page.Component)}
  </>
}

function provider(mutate: RendererMutationAdapter["mutateConvexRow"], overrides = {}) {
  const adapter: RendererMutationAdapter = {
    getPairingStatus: async () => ({ status: "paired", pairedAt: 1, capabilities, writesEnabled: true }),
    pairDevice: async () => ({ status: "paired", pairedAt: 1, capabilities }),
    unpairDevice: async () => ({ status: "ok", revoked: true }),
    mutateConvexRow: mutate,
  }
  return createElement(AppStateProvider, {
    initialProfile: "rachel", initialRoute: "budget", initialData: data,
    initialDataOrigin: "remote", initialSelectedMonth: "2026-08", initialCurrentMonth: "2026-09",
    initialMutationCapabilities: capabilities, mutationAdapter: adapter,
    ...overrides, children: createElement(Probe),
  })
}

async function mount(mutate: RendererMutationAdapter["mutateConvexRow"]) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(provider(mutate)))
  const button = (text: string) => [...document.querySelectorAll("button")].find((node) => node.textContent === text)!
  return { host, root, button }
}

function ok(req: RendererMutationRequest): RendererMutationResult {
  return { status: "ok", kind: req.kind, requestId: req.requestId, outcome: "copied", entityId: "2026-09", updatedAtMs: 101 }
}

afterEach(() => {
  document.body.replaceChildren()
  window.localStorage.clear()
  Reflect.deleteProperty(window, "vogelVault")
})

describe("Linux budget copy action", () => {
  it("uses the shared owner, revision and one-month destination contract", () => {
    expect(request).toEqual({ kind: "budgetPlan.copyForward", requestId: "request-copy", actor: "rachel", owner: "victor", fromMonth: "2026-08", toMonth: "2026-09", baseUpdatedAtMs: 100 })
    expect(budgetPlanCarryRequest({ ...input, selectedMonth: "2027-01" })?.toMonth).toBe("2026-09")
    expect(budgetPlanCarryRequest({ ...input, budget: { ...budget, month: "2026-12" }, currentMonth: "2027-01" })?.toMonth).toBe("2027-01")
    expect(budgetPlanCarryRequest({ ...input, activeProfile: "mason", budget: { ...budget, owner: "mason" } })?.owner).toBe("mason")
    for (const changed of [
      { activeProfile: "maddox" as const }, { activeProfile: "mason" as const },
      { currentMonth: "2026-08" }, { budget: { ...budget, updatedAtMs: 0 } },
    ]) expect(budgetPlanCarryRequest({ ...input, ...changed })).toBeNull()
  })

  it("renders on the Budget page, withholds stale plans, and disables fixture writes", () => {
    const mutate = vi.fn()
    expect(renderToStaticMarkup(provider(mutate))).toContain("Copy August plan to September")
    expect(renderToStaticMarkup(provider(mutate, { initialData: { ...data, budget: { ...data.budget, status: "stale" } } }))).not.toContain("Copy August plan to September")
    const markup = renderToStaticMarkup(provider(mutate, { initialDataOrigin: "fixture" }))
    expect(markup).toContain("Sample and fallback data cannot be edited.")
    expect(mutate).not.toHaveBeenCalled()
  })

  it("previews and cancels without writing, then confirms once and keeps source while pending", async () => {
    let resolve!: (value: RendererMutationResult) => void
    const mutate = vi.fn((req: RendererMutationRequest) => new Promise<RendererMutationResult>((done) => { resolve = () => done(ok(req)) }))
    const { host, root, button } = await mount(mutate)
    try {
      await act(async () => button("Copy August plan to September").click())
      expect(document.querySelector('dialog[open]')?.textContent).toContain("Transactions and income stay where they were recorded.")
      expect(mutate).not.toHaveBeenCalled()
      await act(async () => button("Keep August").click())
      expect(document.querySelector('dialog[open]')).toBeNull()
      await act(async () => button("Copy August plan to September").click())
      await act(async () => button("Confirm copy to September").click())
      expect(mutate).toHaveBeenCalledTimes(1)
      expect(mutate.mock.calls[0]![0]).toMatchObject({ ...request, requestId: expect.any(String) })
      expect(host.querySelector("output")?.textContent).toContain("rachel|2026-08|2026-08")
      expect(button("Copying…").disabled).toBe(true)
      await act(async () => resolve(ok(request)))
      expect(host.querySelector("output")?.textContent).toContain("rachel|2026-09|2026-08")
      expect(host.textContent).toContain("Saved, but the latest rows could not be refreshed.")
      expect(button("Copy August plan to September").disabled).toBe(true)
    } finally { await act(async () => root.unmount()) }
  })

  it.each(["PLAN_EXISTS", "conflict", "unavailable"] as const)("keeps source month and reports %s", async (code) => {
    const { host, root, button } = await mount(async (req) => ({ status: "failed", requestId: req.requestId, kind: req.kind, code }))
    try {
      await act(async () => button("Copy August plan to September").click())
      await act(async () => button("Confirm copy to September").click())
      expect(host.querySelector("output")?.textContent).toContain("rachel|2026-08|2026-08")
      expect(host.textContent).toContain("Plan not copied")
      expect(button("Copy August plan to September").disabled).toBe(false)
    } finally { await act(async () => root.unmount()) }
  })

  it("refreshes the authoritative destination plan before allowing another copy", async () => {
    const { host, root, button } = await mount(async (req) => ok(req))
    const query = vi.fn(async (req: VogelVaultRowRequest): Promise<VogelVaultRowResult> => {
      switch (req.kind) {
        case "rowCounts": return { status: "ok", kind: req.kind, value: {
          transactions: 0, todos: 0, income: 0, btcBuys: 0, btcBillPays: 0,
          btcTransfers: 0, btcAccounts: 0, balanceDocuments: 0, budgetDocuments: 1,
          btcBalanceDocuments: 0, financeDocuments: 0,
        } }
        case "budget": return { status: "ok", kind: req.kind, value: {
          owner: "victor", month: "2026-09", updatedAtMs: 101,
          coinbaseOneBalanceCents: 0n,
          categories: budget.categories.map((row) => ({ name: row.name, budgetCents: row.budget })),
          mtdIncomeCents: 0n, ytdIncomeCents: 0n, monthlyHistory: [],
        } }
        case "finance": return { status: "ok", kind: req.kind, value: null }
        case "marketQuotes": return { status: "ok", kind: req.kind, value: { quotes: [
          { symbol: "BTC", priceCents: null, source: "test", fetchedAt: null, status: "unavailable" },
          { symbol: "VOO", priceCents: null, source: "test", fetchedAt: null, status: "unavailable" },
          { symbol: "IBIT", priceCents: null, source: "test", fetchedAt: null, status: "unavailable" },
        ] } }
        default: return { status: "ok", kind: req.kind, complete: true, rows: [] }
      }
    })
    Object.defineProperty(window, "vogelVault", { configurable: true, value: {
      setReadProfile: async (profile: string) => ({ status: "active", profile }),
      queryConvexRows: query,
    } })
    try {
      await act(async () => button("Copy August plan to September").click())
      await act(async () => button("Confirm copy to September").click())
      expect(query).toHaveBeenCalledWith({ kind: "budget", scope: "netWorth" })
      expect(host.querySelector("output")?.textContent).toContain("rachel|2026-09|2026-09")
      expect(host.textContent).not.toContain("could not be refreshed")
      expect(host.textContent).not.toContain("Copy August plan to September")
    } finally { await act(async () => root.unmount()) }
  })

  it("does not select the completed copy's month after a profile switch", async () => {
    let resolve!: () => void
    const { host, root, button } = await mount((req) => new Promise((done) => { resolve = () => done(ok(req)) }))
    try {
      await act(async () => button("Copy August plan to September").click())
      await act(async () => button("Confirm copy to September").click())
      await act(async () => button("Switch profile").click())
      await act(async () => resolve())
      expect(host.querySelector("output")?.textContent).toContain("mason|null|")
    } finally { await act(async () => root.unmount()) }
  })

  it("holds committed copies until refresh and never fabricates next-month rows", () => {
    const started = beginMutation(EMPTY_MUTATION_CONTROLLER, request, data, "rachel", 1)
    expect(started.status).toBe("started")
    if (started.status !== "started") throw new Error("mutation did not begin")
    expect(optimisticEnvelope(data, started.state, "rachel", 1)).toBe(data)
    const saved = settleMutation(started.state, started.pending, ok(request), "rachel", 1)
    expect(beginMutation(saved, request, data, "rachel", 1).status).toBe("busy")
    const refreshed = finishRefresh(saved, "rachel", 1, true)
    expect(refreshed.committed).toHaveLength(0)
    expect(optimisticEnvelope(data, refreshed, "rachel", 1).transactions).toBe(data.transactions)
  })
})
