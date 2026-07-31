import { describe, expect, it } from "vitest"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { FamilyMember } from "@vogel-vault/domain/family"
import type { Transaction } from "@vogel-vault/domain/readModel"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import {
  type FixtureEnvelope,
  buildSanitizedFixtureEnvelope,
} from "../src/renderer/data/fixtures.ts"
import type { RendererMutationAdapter } from "../src/renderer/data/mutations.ts"
import { budgetCategoryTransactions } from "../src/renderer/data/transactionAmounts.ts"
import { BudgetCategoryTransactionsDialog } from "../src/renderer/pages/finance/index.tsx"
import { resolvePage } from "../src/renderer/pages/index.ts"

function tx(
  id: string,
  owner: FamilyMember,
  date: string,
  category: string,
  amount: bigint,
): Transaction {
  return {
    id,
    updatedAtMs: 1,
    owner,
    date,
    category,
    amount,
    merchant: id,
    card: null,
    note: null,
  }
}

const ROWS: readonly Transaction[] = [
  tx("Adult spend", "victor", "2026-07-02", "Groceries", 5_000n),
  tx("Adult credit", "rachel", "2026-07-03", "Groceries", -1_000n),
  tx("Child spend", "mason", "2026-07-04", "Groceries", 2_000n),
  tx("Other category", "victor", "2026-07-05", "Utilities", 3_000n),
  tx("Other month", "victor", "2026-06-30", "Groceries", 9_000n),
]

function dataWith(rows: readonly Transaction[]): FixtureEnvelope {
  const data = buildSanitizedFixtureEnvelope("victor")
  return {
    ...data,
    transactions: {
      ...data.transactions,
      status: "live",
      value: rows,
    },
  }
}

const adapter: RendererMutationAdapter = {
  async getPairingStatus() {
    return {
      status: "paired",
      pairedAt: 1,
      capabilities: ["transaction.upsert"],
      writesEnabled: true,
    }
  },
  async pairDevice() {
    return { status: "failed", code: "unavailable" }
  },
  async mutateConvexRow(request) {
    return {
      status: "failed",
      requestId: request.requestId,
      kind: request.kind,
      code: "unavailable",
    }
  },
  async unpairDevice() {
    return { status: "unavailable" }
  },
}

function BudgetHarness() {
  const { activeProfile } = useAppState()
  const page = resolvePage("budget", activeProfile)
  return page ? createElement(page.Component) : null
}

function renderDialog(profile: FamilyMember, origin: "remote" | "fixture" = "remote"): string {
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: profile,
      initialData: dataWith(ROWS),
      initialDataOrigin: origin,
      mutationAdapter: adapter,
      initialMutationCapabilities: ["transaction.upsert"],
      children: createElement(BudgetCategoryTransactionsDialog, {
        open: true,
        category: "Groceries",
        month: "2026-07",
        onClose: () => undefined,
      }),
    }),
  )
}

describe("Budget category transaction drilldown", () => {
  it("filters to the selected category", () => {
    const rows = budgetCategoryTransactions("victor", ROWS, "2026-07", "Utilities")
    expect(rows.map((row) => row.id)).toEqual(["Other category"])
  })

  it("filters to the selected month", () => {
    const rows = budgetCategoryTransactions("victor", ROWS, "2026-06", "Groceries")
    expect(rows.map((row) => row.id)).toEqual(["Other month"])
  })

  it("keeps the adult shared-budget scope narrower than oversight visibility", () => {
    const rows = budgetCategoryTransactions("victor", ROWS, "2026-07", "Groceries")
    expect(rows.map((row) => row.id)).toEqual(["Adult spend", "Adult credit"])
  })

  it("keeps a child drilldown self-only", () => {
    const rows = budgetCategoryTransactions("mason", ROWS, "2026-07", "Groceries")
    expect(rows.map((row) => row.id)).toEqual(["Child spend"])
  })

  it("preserves signed cents for purchases and credits", () => {
    const rows = budgetCategoryTransactions("rachel", ROWS, "2026-07", "Groceries")
    expect(rows.map((row) => row.amount)).toEqual([5_000n, -1_000n])
  })

  it("renders scoped USD rows with an enabled edit path only on remote capable data", () => {
    const remote = renderDialog("victor")
    expect(remote).toContain("Groceries · July 2026")
    expect(remote).toContain("2 transactions · $40.00 signed actual")
    expect(remote).toContain("Adult spend")
    expect(remote).toContain("Adult credit")
    expect(remote).not.toContain("Child spend")
    expect(remote).not.toContain("Other category")
    expect(remote).not.toContain("Other month")
    expect(remote).toContain("credit / check sign")

    const enabledEdit = remote.match(/<button[^>]*aria-label="Edit Adult spend"[^>]*>/)?.[0]
    expect(enabledEdit).toBeDefined()
    expect(enabledEdit).not.toContain("disabled")

    const fixture = renderDialog("victor", "fixture")
    const disabledEdit = fixture.match(/<button[^>]*aria-label="Edit Adult spend"[^>]*>/)?.[0]
    expect(disabledEdit).toContain("disabled")
  })

  it("exposes each Budget category as a month-labelled drilldown control", () => {
    const markup = renderToStaticMarkup(
      createElement(AppStateProvider, {
        initialSelectedMonth: "2026-06",
        children: createElement(BudgetHarness),
      }),
    )
    expect(markup).toContain('aria-label="Open Groceries transactions for June 2026"')
  })
})
