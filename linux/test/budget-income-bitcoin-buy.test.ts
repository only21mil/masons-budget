// Budget-tab income, and income recorded as a Bitcoin buy (Buzz 4947b46d).
//
// The paired write is one `btcBuy.upsert` carrying `linkedIncome`, and both
// rows share one id. That shared id is the whole linkage, so the read marker
// below is a lookup rather than a join column, and a reload that returns both
// rows shows one income row wearing one badge.

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { BTCBuy } from "@vogel-vault/domain/readModel"
import { parseBtcToSats, parseCents } from "@vogel-vault/domain/money"

import { TransactionFormDialog } from "../src/renderer/components/MutationForms.tsx"
import { AppStateProvider } from "../src/renderer/app/AppState.tsx"
import {
  type FixtureEnvelope,
  type IncomeRecord,
  buildSanitizedFixtureEnvelope,
} from "../src/renderer/data/fixtures.ts"
import type { RendererMutationAdapter } from "../src/renderer/data/mutations.ts"
import { budgetIncomeRows } from "../src/renderer/pages/finance/index.tsx"
import { ALL_PAGES } from "../src/renderer/pages/index.ts"

const SHARED_ID = "transaction-linked-01"

const LINKED_INCOME: IncomeRecord = {
  id: SHARED_ID,
  date: "2026-07-24",
  month: "2026-07",
  amount: parseCents("2500.00"),
  source: "Employer",
  loggedBy: null,
  note: null,
  owner: "victor",
}

const PLAIN_INCOME: IncomeRecord = {
  id: "income-plain-01",
  date: "2026-07-20",
  month: "2026-07",
  amount: parseCents("1200.00"),
  source: "Side work",
  loggedBy: null,
  note: null,
  owner: "victor",
}

const CHILD_INCOME: IncomeRecord = {
  id: "income-child-01",
  date: "2026-07-22",
  month: "2026-07",
  amount: parseCents("40.00"),
  source: "Allowance",
  loggedBy: null,
  note: null,
  owner: "mason",
}

const LAST_MONTH_INCOME: IncomeRecord = {
  ...PLAIN_INCOME,
  id: "income-june-01",
  date: "2026-06-20",
  month: "2026-06",
  source: "June work",
}

const LINKED_BUY: BTCBuy = {
  id: SHARED_ID,
  updatedAtMs: 1,
  date: "2026-07-24",
  // The buy names the account it credits; its income names the payer.
  source: "River",
  sats: parseBtcToSats("0.00270000"),
  priceUsd: parseCents("92592.59"),
  usd: parseCents("2500.00"),
  feeUsd: 0n,
  note: null,
  status: "settled",
  costBasisStatus: "confirmed",
  loggedBy: null,
  archimedesRequestId: null,
  owner: "victor",
}

const capabilities = ["transaction.upsert", "btcBuy.upsert", "budgetCategory.upsert"] as const

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
    outcome: "inserted",
    entityId: "id" in request ? request.id : "key" in request ? request.key : request.name,
  }),
  unpairDevice: async () => ({ status: "ok", revoked: true }),
}

function liveEnvelope(
  income: readonly IncomeRecord[],
  buys: readonly BTCBuy[],
): FixtureEnvelope {
  const base = buildSanitizedFixtureEnvelope("victor")
  return {
    ...base,
    transactions: { ...base.transactions, status: "live" },
    budget: { ...base.budget, status: "live" },
    income: { ...base.income, status: "live", value: income },
    btcBuys: { ...base.btcBuys, status: "live", value: buys },
    btcBalanceDocument: { ...base.btcBalanceDocument, status: "live" },
  }
}

function renderBudget(data: FixtureEnvelope): string {
  const page = ALL_PAGES.find((candidate) => candidate.id === "budget")!
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: "victor",
      initialRoute: "budget",
      initialSelectedMonth: "2026-07",
      initialData: data,
      initialDataOrigin: "remote",
      initialMutationCapabilities: [...capabilities],
      mutationAdapter: adapter,
      children: createElement(page.Component),
    }),
  )
}

describe("Budget income rows", () => {
  it("scopes to net worth and to the reported month, newest first", () => {
    const rows = budgetIncomeRows("victor", "2026-07", [
      PLAIN_INCOME,
      LINKED_INCOME,
      CHILD_INCOME,
      LAST_MONTH_INCOME,
    ])
    expect(rows.map((row) => row.id)).toEqual([LINKED_INCOME.id, PLAIN_INCOME.id])
    // Visible to an adult, but a child's income is not household income.
    expect(rows).not.toContainEqual(CHILD_INCOME)
  })

  it("marks the income row its Bitcoin buy funded, once, and leaves the rest bare", () => {
    const markup = renderBudget(liveEnvelope([LINKED_INCOME, PLAIN_INCOME], [LINKED_BUY]))
    expect(markup).toContain("Employer")
    expect(markup).toContain("Side work")
    expect(markup.split("Bitcoin buy ·")).toHaveLength(2)
    // The group separator is the renderer's, so match around it rather than
    // hard-coding which space character the locale picked.
    expect(markup).toMatch(/Bitcoin buy · 270.000 sats/)
  })

  it("shows no marker when the income funded no purchase", () => {
    const markup = renderBudget(liveEnvelope([PLAIN_INCOME], []))
    expect(markup).toContain("Side work")
    expect(markup).not.toContain("Bitcoin buy ·")
  })

  it("survives a reload that returns both rows without duplicating either", () => {
    const data = liveEnvelope([LINKED_INCOME, LINKED_INCOME], [LINKED_BUY, LINKED_BUY])
    // Two identical rows would be a backend bug, not a client one; the point is
    // that the shared id lookup still resolves to a single buy per income row.
    const rows = budgetIncomeRows("victor", "2026-07", data.income.value)
    expect(rows.filter((row) => row.id === SHARED_ID)).toHaveLength(2)
    const markup = renderBudget(liveEnvelope([LINKED_INCOME], [LINKED_BUY, LINKED_BUY]))
    expect(markup.split("Bitcoin buy ·")).toHaveLength(2)
  })

  it("offers an add-income flow on the Budget tab", () => {
    const markup = renderBudget(liveEnvelope([PLAIN_INCOME], []))
    expect(markup).toContain("Add income")
    expect(markup).toContain("<dialog")
  })
})

describe("the Bitcoin buy option on the income form", () => {
  function renderForm(props: Parameters<typeof TransactionFormDialog>[0]): string {
    return renderToStaticMarkup(
      createElement(AppStateProvider, {
        initialProfile: "victor",
        initialData: liveEnvelope([], []),
        initialDataOrigin: "remote",
        initialMutationCapabilities: [...capabilities],
        mutationAdapter: adapter,
        children: createElement(TransactionFormDialog, props),
      }),
    )
  }

  it("offers the option when adding income, alongside the sat-denominated field", () => {
    const markup = renderForm({
      open: true,
      transaction: null,
      defaultCategory: "Income",
      onClose: () => undefined,
    })
    expect(markup).toContain("Record as Bitcoin buy")
    expect(markup).toContain("One save records the income and the purchase together.")
    expect(markup).toContain("Bitcoin received (sats)")
    // Untoggled, the form is still an ordinary transaction form: the closed
    // payment-source list is there beside the Bitcoin option.
    expect(markup).toContain("Payment source")
    expect(markup).toContain("Capital One VX")
  })

  it("withholds the option outside income", () => {
    const markup = renderForm({ open: true, transaction: null, onClose: () => undefined })
    expect(markup).not.toContain("Record as Bitcoin buy")
  })

  it("withholds the option when editing a stored row, which cannot take the shared id", () => {
    const markup = renderForm({
      open: true,
      transaction: {
        id: "transaction-existing",
        updatedAtMs: 5,
        owner: "victor",
        date: "2026-07-24",
        merchant: "Employer",
        amount: parseCents("2500.00"),
        category: "Income",
        card: null,
        note: null,
      },
      onClose: () => undefined,
    })
    expect(markup).toContain("Bitcoin received (sats)")
    expect(markup).not.toContain("Record as Bitcoin buy")
  })
})
