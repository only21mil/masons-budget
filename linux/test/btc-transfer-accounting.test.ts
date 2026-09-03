// Acceptance cover for transfers between Bitcoin accounts (Buzz cf40be87).
//
// The contract's accounting rule is `from -= sats + feeSats, to += sats`. The
// principal is a move, so it must leave income, budget spending, the total
// stack and net worth exactly where they were; only a nonzero fee moves the
// total, and by exactly the fee. The backend owns that arithmetic — what is
// pinned here is that the Linux read model reports the result once and never
// mistakes a transfer for income or spend.

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { BTCSnapshot } from "@vogel-vault/domain/readModel"
import { parseBtcToSats, parseCents, satsToUsdCents } from "@vogel-vault/domain/money"

import { validateMutationRequest } from "../electron/convexMutations.ts"
import { AppStateProvider } from "../src/renderer/app/AppState.tsx"
import {
  type BtcTransferRecord,
  type FixtureEnvelope,
  buildSanitizedFixtureEnvelope,
} from "../src/renderer/data/fixtures.ts"
import { selectFinanceNetWorth } from "../src/renderer/data/financeReadModel.ts"
import type { RendererMutationAdapter } from "../src/renderer/data/mutations.ts"
import { deriveBudgetSpend } from "@vogel-vault/domain/readModel"
import { dashboardIncomeMtd } from "../src/renderer/pages/finance/index.tsx"
import { ALL_PAGES } from "../src/renderer/pages/index.ts"
import { TaskClockProvider } from "../src/renderer/pages/tasks/taskClock.tsx"

const FROM = "canonical-exchange"
const TO = "canonical-cold"
const SATS = 12_345n
const FEE = 21n

const TRANSFER: BtcTransferRecord = {
  id: "transfer-acceptance-1",
  updatedAtMs: 99,
  date: "2026-07-26",
  month: "2026-07",
  fromAccountKey: FROM,
  toAccountKey: TO,
  sats: SATS,
  feeSats: FEE,
  note: "Move to cold storage",
  owner: "victor",
}

/** The balance document the backend returns after posting one transfer. */
function afterTransfer(before: BTCSnapshot, feeSats: bigint): BTCSnapshot {
  const accounts = before.accounts.map((account) => {
    if (account.key === FROM) return { ...account, sats: account.sats - (SATS + feeSats) }
    if (account.key === TO) return { ...account, sats: account.sats + SATS }
    return account
  })
  const sats = accounts.reduce((total, account) => total + account.sats, 0n)
  return {
    ...before,
    accounts,
    totals: {
      ...before.totals,
      sats,
      exchangeSats: accounts
        .filter((account) => account.custody === "exchange")
        .reduce((total, account) => total + account.sats, 0n),
      selfCustodySats: accounts
        .filter((account) => account.custody === "self_custody")
        .reduce((total, account) => total + account.sats, 0n),
    },
  }
}

function envelopeWith(document: BTCSnapshot, transfers: readonly BtcTransferRecord[]): FixtureEnvelope {
  const base = buildSanitizedFixtureEnvelope("victor")
  return {
    ...base,
    transactions: { ...base.transactions, status: "live" },
    income: { ...base.income, status: "live" },
    budget: { ...base.budget, status: "live" },
    btcAccounts: { ...base.btcAccounts, status: "live" },
    btcBalanceDocument: { ...base.btcBalanceDocument, status: "live", value: document },
    btcBuys: { ...base.btcBuys, status: "live" },
    billPays: { ...base.billPays, status: "live" },
    btcTransfers: { ...base.btcTransfers, status: "live", value: transfers },
    todos: { ...base.todos, status: "live" },
  }
}

const capabilities = [
  "transaction.upsert",
  "transaction.delete",
  "budgetCategory.upsert",
  "btcBuy.upsert",
  "btcAccount.upsert",
  "btcTransfer.upsert",
  "btcTransfer.delete",
] as const

const adapter: RendererMutationAdapter = {
  getPairingStatus: async () => ({
    status: "paired",
    pairedAt: 1,
    capabilities: [...capabilities],
    writesEnabled: true,
  }),
  pairDevice: async () => ({ status: "paired", pairedAt: 1, capabilities: [...capabilities] }),
  mutateConvexRow: async (request) => ({
    status: "ok",
    requestId: request.requestId,
    kind: request.kind,
    outcome: "updated",
    entityId: "id" in request ? request.id : "key" in request ? request.key : request.name,
  }),
  unpairDevice: async () => ({ status: "ok", revoked: true }),
}

function renderRoute(route: string, data: FixtureEnvelope): string {
  const page = ALL_PAGES.find((candidate) => candidate.id === route)!
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: "victor",
      initialRoute: route,
      initialData: data,
      initialDataOrigin: "remote",
      initialMutationCapabilities: [...capabilities],
      mutationAdapter: adapter,
      children: createElement(
        TaskClockProvider,
        { now: () => new Date(2026, 6, 26, 12, 0, 0) },
        createElement(page.Component),
      ),
    }),
  )
}

const BEFORE = buildSanitizedFixtureEnvelope("victor").btcBalanceDocument.value!

describe("transfers between Bitcoin accounts", () => {
  it("refuses the same account, a non-positive amount, and a negative fee at the boundary", () => {
    const base = {
      kind: "btcTransfer.upsert" as const,
      requestId: "request_transfer_guard",
      actor: "victor" as const,
      id: "transfer-guard",
      owner: "victor" as const,
      date: "2026-07-26",
      fromAccountKey: FROM,
      toAccountKey: TO,
      sats: SATS,
      feeSats: FEE,
    }
    expect(validateMutationRequest(base)).toMatchObject({ fromAccountKey: FROM, toAccountKey: TO })
    // A zero fee is the ordinary case, not a rejection.
    expect(validateMutationRequest({ ...base, feeSats: 0n })).toMatchObject({ feeSats: 0n })
    expect(validateMutationRequest({ ...base, toAccountKey: FROM })).toBeNull()
    expect(validateMutationRequest({ ...base, sats: 0n })).toBeNull()
    expect(validateMutationRequest({ ...base, sats: -1n })).toBeNull()
    expect(validateMutationRequest({ ...base, feeSats: -1n })).toBeNull()
  })

  it("requires the revision it read before changing a posted transfer", () => {
    const remove = {
      kind: "btcTransfer.delete" as const,
      requestId: "request_transfer_delete",
      actor: "victor" as const,
      id: TRANSFER.id,
      owner: "victor" as const,
      baseUpdatedAtMs: TRANSFER.updatedAtMs,
    }
    expect(validateMutationRequest(remove)).toMatchObject({ baseUpdatedAtMs: 99 })
    const unfenced: Record<string, unknown> = { ...remove }
    delete unfenced["baseUpdatedAtMs"]
    expect(validateMutationRequest(unfenced)).toBeNull()
  })

  it("moves the two legs and leaves the total stack alone when there is no fee", () => {
    const after = afterTransfer(BEFORE, 0n)
    const from = after.accounts.find((account) => account.key === FROM)!
    const to = after.accounts.find((account) => account.key === TO)!
    expect(from.sats).toBe(BEFORE.accounts.find((a) => a.key === FROM)!.sats - SATS)
    expect(to.sats).toBe(BEFORE.accounts.find((a) => a.key === TO)!.sats + SATS)
    expect(after.totals.sats).toBe(BEFORE.totals.sats)
  })

  it("reduces the total stack and net worth by exactly the fee, and by nothing else", () => {
    const after = afterTransfer(BEFORE, FEE)
    expect(BEFORE.totals.sats - after.totals.sats).toBe(FEE)
    expect(after.accounts.find((account) => account.key === FROM)!.sats).toBe(
      BEFORE.accounts.find((account) => account.key === FROM)!.sats - (SATS + FEE),
    )

    const priceCents = parseCents("95000.00")
    const model = {
      finance: { status: "empty", value: null },
      marketQuotes: {
        status: "live",
        value: {
          quotes: [{
            symbol: "BTC" as const,
            priceCents,
            source: "test",
            fetchedAt: "2026-07-26T12:00:00.000Z",
            status: "live" as const,
          }],
        },
      },
    } as const
    const worthBefore = selectFinanceNetWorth({
      viewer: "victor",
      bitcoinSats: BEFORE.totals.sats,
      model,
    })
    const worthAfter = selectFinanceNetWorth({
      viewer: "victor",
      bitcoinSats: after.totals.sats,
      model,
    })
    expect(worthBefore.bitcoinValueCents! - worthAfter.bitcoinValueCents!).toBe(
      satsToUsdCents(BEFORE.totals.sats, priceCents) - satsToUsdCents(after.totals.sats, priceCents),
    )
    expect(worthAfter.bitcoinSats).toBe(BEFORE.totals.sats - FEE)
  })

  it("keeps a posted transfer out of income and out of budget spending", () => {
    const withTransfer = envelopeWith(afterTransfer(BEFORE, FEE), [TRANSFER])
    const withoutTransfer = envelopeWith(afterTransfer(BEFORE, FEE), [])
    const month = "2026-07"

    for (const [label, data] of [["with", withTransfer], ["without", withoutTransfer]] as const) {
      const income = dashboardIncomeMtd("victor", month, data.income.status, data.income.value)
      const spend = deriveBudgetSpend({ ...data.budget.value!, month }, data.transactions.value)
      expect({ label, income }).toEqual({
        label,
        income: dashboardIncomeMtd(
          "victor",
          month,
          withoutTransfer.income.status,
          withoutTransfer.income.value,
        ),
      })
      expect(spend.actual).toBe(
        deriveBudgetSpend(
          { ...withoutTransfer.budget.value!, month },
          withoutTransfer.transactions.value,
        ).actual,
      )
    }

    // Nothing in the transfer slice can reach either total: the rows are not
    // transactions and not income records.
    expect(withTransfer.transactions.value.some((row) => row.id === TRANSFER.id)).toBe(false)
    expect(withTransfer.income.value.some((row) => row.id === TRANSFER.id)).toBe(false)
  })

  it("lists one posted transfer exactly once and never as an Activity row", () => {
    const data = envelopeWith(afterTransfer(BEFORE, FEE), [TRANSFER])
    const bitcoin = renderRoute("bitcoin", data)
    const route = "Canonical Exchange → Canonical Cold Storage"
    expect(bitcoin.split(route)).toHaveLength(2)
    expect(bitcoin.split("Move to cold storage")).toHaveLength(2)

    const activity = renderRoute("activity", data)
    expect(activity).not.toContain(route)
    expect(activity).not.toContain("Move to cold storage")
  })

  it("reports the transferred sats on the accounts table without double counting", () => {
    const after = afterTransfer(BEFORE, FEE)
    const markup = renderRoute("bitcoin", envelopeWith(after, [TRANSFER]))
    // Both legs are reported once each, from the one document the backend
    // patched — not by the renderer replaying the transfer onto a stale one.
    for (const account of after.accounts) {
      expect(markup).toContain(account.label)
    }
    expect(after.totals.sats).toBe(
      after.accounts.reduce((total, account) => total + account.sats, 0n),
    )
    expect(after.totals.sats).toBe(parseBtcToSats("1.23456789") - FEE)
  })
})
