import { describe, expect, it } from "vitest"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { FamilyMember } from "@vogel-vault/domain/family"
import type { Freshness, Transaction } from "@vogel-vault/domain/readModel"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import {
  type FixtureEnvelope,
  buildSanitizedFixtureEnvelope,
} from "../src/renderer/data/fixtures.ts"
import type { RendererMutationAdapter } from "../src/renderer/data/mutations.ts"
import { TransactionFormDialog } from "../src/renderer/components/MutationForms.tsx"
import {
  BudgetCategoryTransactionsDialog,
  budgetDrilldownTransactionEditGate,
} from "../src/renderer/pages/finance/index.tsx"
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

function dataWith(rows: readonly Transaction[], status: Freshness): FixtureEnvelope {
  const data = buildSanitizedFixtureEnvelope("victor")
  return {
    ...data,
    transactions: {
      ...data.transactions,
      status,
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

function renderDialog(
  profile: FamilyMember,
  origin: "remote" | "fixture" = "remote",
  status: Freshness = "live",
): string {
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: profile,
      initialData: dataWith(ROWS, status),
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
  it("renders shared-scoped signed USD rows with an enabled edit path on live remote data", () => {
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

  it("uses shared child visibility in the rendered drilldown", () => {
    const markup = renderDialog("mason")
    expect(markup).toContain("Child spend")
    expect(markup).not.toContain("Adult spend")
    expect(markup).not.toContain("Adult credit")
  })

  it("discloses stale transaction rows and disables editing", () => {
    const markup = renderDialog("victor", "remote", "stale")
    expect(markup).toContain("Transaction rows are stale")
    expect(markup).toContain("Editing stays disabled until live rows return")
    const edit = markup.match(/<button[^>]*aria-label="Edit Adult spend"[^>]*>/)?.[0]
    expect(edit).toContain("disabled")
    expect(edit).toContain("aria-describedby")
    expect(markup).toContain("Current live transaction rows are required before editing.")
  })

  it("re-checks freshness before an edit opened live can submit", () => {
    const writeGate = { allowed: true, reason: null }
    expect(budgetDrilldownTransactionEditGate("live", writeGate)).toEqual(writeGate)
    const staleGate = budgetDrilldownTransactionEditGate("stale", writeGate)
    expect(staleGate).toEqual({
      allowed: false,
      reason: "Current live transaction rows are required before editing.",
    })

    const markup = renderToStaticMarkup(
      createElement(AppStateProvider, {
        children: createElement(TransactionFormDialog, {
          open: true,
          transaction: ROWS[0]!,
          submissionGate: staleGate,
          onClose: () => undefined,
        }),
      }),
    )
    const save = markup.match(/<button[^>]*type="submit"[^>]*>/)?.[0]
    expect(save).toContain("disabled")
    expect(save).toContain("aria-describedby")
    expect(markup).toContain("Current live transaction rows are required before editing.")
  })

  it("discloses transaction read errors inside the drilldown", () => {
    const markup = renderDialog("victor", "remote", "error")
    expect(markup).toContain("Transactions could not load")
    expect(markup).toContain("No category detail is available")
    expect(markup).toContain("Could not load")
    expect(markup).toContain("Transaction details unavailable.")
    expect(markup).not.toContain("2 transactions")
    expect(markup).not.toContain("$40.00 signed actual")
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
