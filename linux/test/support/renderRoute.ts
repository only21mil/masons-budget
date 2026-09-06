// One provider wiring for every test that renders a real page against a real
// envelope. Route tests and mutation-gate tests both need it, and two copies
// would let the gate tests drift into asserting something the pages never do.

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { AppStateProvider } from "../../src/renderer/app/AppState.tsx"
import type { FixtureEnvelope } from "../../src/renderer/data/fixtures.ts"
import { buildSanitizedFixtureEnvelope } from "../../src/renderer/data/fixtures.ts"
import type {
  RendererMutationAdapter,
  RendererMutationKind,
} from "../../src/renderer/data/mutations.ts"
import { ALL_PAGES } from "../../src/renderer/pages/index.ts"
import { TaskClockProvider } from "../../src/renderer/pages/tasks/taskClock.tsx"

export type RenderProfile = "victor" | "rachel" | "mason" | "maddox"

export const capabilities: readonly RendererMutationKind[] = [
  "transaction.upsert",
  "transaction.delete",
  "todo.upsert",
  "todo.delete",
  "budgetCategory.upsert",
  "budgetCategory.delete",
  "btcBuy.upsert",
  "btcBuy.delete",
  "btcBillPay.upsert",
  "btcBillPay.delete",
  "btcAccount.upsert",
  "btcAccount.delete",
  "btcTransfer.upsert",
  "btcTransfer.delete",
]

export const adapter: RendererMutationAdapter = {
  getPairingStatus: async () => ({
    status: "paired",
    pairedAt: 1,
    capabilities,
    writesEnabled: true,
  }),
  pairDevice: async () => ({ status: "paired", pairedAt: 1, capabilities }),
  mutateConvexRow: async (request) => ({
    status: "ok",
    requestId: request.requestId,
    kind: request.kind,
    outcome: request.kind.endsWith(".delete") ? "deleted" : "updated",
    entityId: "id" in request ? request.id : "key" in request ? request.key : "name" in request ? request.name : request.toMonth,
  }),
  unpairDevice: async () => ({ status: "ok", revoked: true }),
}

export const fixtureNow = () => new Date(2026, 6, 26, 12, 0, 0)

/** The sanitized fixture envelope with every slice reporting a successful read. */
export function liveEnvelope(profile: RenderProfile = "victor"): FixtureEnvelope {
  const data = buildSanitizedFixtureEnvelope(profile)
  return {
    ...data,
    transactions: { ...data.transactions, status: "live" as const },
    budget: { ...data.budget, status: "live" as const },
    btcAccounts: { ...data.btcAccounts, status: "live" as const },
    btcBalanceDocument: { ...data.btcBalanceDocument, status: "live" as const },
    btcBuys: { ...data.btcBuys, status: "live" as const },
    billPays: { ...data.billPays, status: "live" as const },
    btcTransfers: {
      ...data.btcTransfers,
      status: "live" as const,
      value: [{
        id: "transfer-test-1",
        updatedAtMs: 99,
        date: "2026-07-26",
        month: "2026-07",
        fromAccountKey: "canonical-exchange",
        toAccountKey: "canonical-cold",
        sats: 12_345n,
        feeSats: 21n,
        note: "Move to cold storage",
        owner: "victor" as const,
      }],
    },
    todos: { ...data.todos, status: "live" as const },
  }
}

export function renderRoute(
  route: string,
  profile: RenderProfile = "victor",
  data: FixtureEnvelope = liveEnvelope(profile),
): string {
  const page = ALL_PAGES.find((candidate) => candidate.id === route)!
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: profile,
      initialRoute: route,
      initialData: data,
      initialDataOrigin: "remote",
      initialMutationCapabilities: capabilities,
      mutationAdapter: adapter,
      children: createElement(
        TaskClockProvider,
        { now: fixtureNow },
        createElement(page.Component),
      ),
    }),
  )
}
