import { describe, expect, it } from "vitest"

import type { Budget, Transaction } from "@vogel-vault/domain/readModel"

import {
  deriveBudgetSpend,
  displaySpendAmount,
  hasOppositeSpendSign,
  spendAmount,
} from "../src/renderer/data/transactionAmounts.ts"

function tx(id: string, owner: Transaction["owner"], amount: bigint): Transaction {
  return {
    id,
    owner,
    amount,
    date: "2026-07-01",
    merchant: "Example",
    category: "Food",
    card: null,
    note: null,
  }
}

const budget: Budget = {
  month: "2026-07",
  coinbaseOneBalance: 0n,
  categories: [{ name: "Food", icon: null, budget: 10_000n, spent: 99_999n }],
  effectiveApr: null,
  strategyNote: null,
  income: null,
  mtdIncome: 0n,
  ytdIncome: 0n,
  monthlyHistory: [],
  owner: "victor",
}

describe("Linux signed transaction amounts", () => {
  it("keeps adult and child spend conventions while preserving credits", () => {
    const adultSpend = tx("adult-spend", "victor", -5_000n)
    const adultCredit = tx("adult-credit", "victor", 1_000n)
    const childSpend = tx("child-spend", "mason", 2_000n)
    const childCredit = tx("child-credit", "mason", -500n)

    expect([
      spendAmount(adultSpend),
      spendAmount(adultCredit),
      spendAmount(childSpend),
      spendAmount(childCredit),
    ]).toEqual([5_000n, -1_000n, 2_000n, -500n])
    expect(displaySpendAmount(adultCredit)).toBe(1_000n)
    expect(hasOppositeSpendSign(adultCredit)).toBe(true)
  })

  it("derives budget actuals from the selected month's signed contributions", () => {
    const result = deriveBudgetSpend(budget, [
      tx("spend", "victor", -5_000n),
      tx("credit", "victor", 1_000n),
      { ...tx("old", "victor", -9_000n), date: "2026-06-30" },
    ])

    expect(result.categories[0]).toMatchObject({
      spent: 4_000n,
      remaining: 6_000n,
    })
    expect(result.actual).toBe(4_000n)
  })
})
