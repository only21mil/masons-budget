import { describe, expect, it } from "vitest"

import type { FamilyMember } from "@vogel-vault/domain/family"
import type { Budget } from "@vogel-vault/domain/readModel"

import type { LinuxBillPay } from "../src/renderer/data/billPayBudgetEffect.ts"
import {
  budgetBillPaysFor,
  deriveBudgetSpend,
} from "@vogel-vault/domain/readModel"

const BUDGET: Budget = {
  updatedAtMs: 1,
  month: "2026-07",
  coinbaseOneBalance: 0n,
  categories: [
    { name: "Utilities", icon: null, budget: 20_000n, spent: 99_999n },
    { name: "Credit Card Payment", icon: null, budget: 0n, spent: 99_999n },
  ],
  effectiveApr: null,
  strategyNote: null,
  income: null,
  mtdIncome: 0n,
  ytdIncome: 0n,
  monthlyHistory: [],
  owner: "victor",
}

function billPay(
  id: string,
  owner: FamilyMember,
  budgetEffect: LinuxBillPay["budgetEffect"],
  category = "Utilities",
  date = "2026-07-15",
  amountUsd = 7_500n,
): LinuxBillPay {
  return {
    id,
    updatedAtMs: 1,
    date,
    merchant: id,
    category,
    budgetEffect,
    amountUsd,
    btcSpentSats: 1n,
    btcPrice: 1n,
    platform: "river_bitcoin_bill_pay",
    note: null,
    feeUsd: 0n,
    reference: null,
    owner,
  }
}

describe("Linux budget actuals", () => {
  it("moves Actual and Remaining for a budget-category bill pay", () => {
    const spend = deriveBudgetSpend(BUDGET, [], [
      billPay("internet", "victor", "budget_category"),
    ])

    expect(spend.categories[0]).toMatchObject({ spent: 7_500n, remaining: 12_500n })
    expect(spend.actual).toBe(7_500n)
    expect(spend.remaining).toBe(12_500n)
  })

  it("keeps a credit-card-payment bill pay out of budget spend", () => {
    const spend = deriveBudgetSpend(BUDGET, [], [
      billPay(
        "card-payment",
        "victor",
        "credit_card_payment",
        "Credit Card Payment",
      ),
    ])

    expect(spend.categories[1]).toMatchObject({ spent: 0n, remaining: 0n })
    expect(spend.actual).toBe(0n)
    expect(spend.remaining).toBe(20_000n)
  })

  it("uses household scope for adults and self-only scope for children", () => {
    const rows = [
      billPay("victor", "victor", "budget_category"),
      billPay("rachel", "rachel", "budget_category"),
      billPay("mason", "mason", "budget_category"),
      billPay("maddox", "maddox", "budget_category"),
    ]

    expect(budgetBillPaysFor("rachel", rows).map((row) => row.id)).toEqual([
      "victor",
      "rachel",
    ])
    expect(budgetBillPaysFor("mason", rows).map((row) => row.id)).toEqual(["mason"])
  })

  it("ignores budgeted bill pays outside the selected month", () => {
    const spend = deriveBudgetSpend(BUDGET, [], [
      billPay("august", "victor", "budget_category", "Utilities", "2026-08-01"),
    ])

    expect(spend.actual).toBe(0n)
    expect(spend.remaining).toBe(20_000n)
  })
})
