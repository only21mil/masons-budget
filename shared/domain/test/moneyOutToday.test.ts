import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import type { FamilyMember } from "../src/family.ts"
import { deriveMoneyOutToday } from "../src/moneyOutToday.ts"
import type { BTCBillPay, Transaction } from "../src/readModel.ts"

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/money-out-today-cases.json", import.meta.url), "utf8"),
) as {
  contractVersion: number
  date: string
  transactions: Array<{ id: string; date: string; amountCents: string; category: string; owner: FamilyMember }>
  billPays: Array<{ id: string; date: string; principalCents: string; feeUsdCents: string; owner: FamilyMember; budgetEffect?: "budget_category" | "credit_card_payment" }>
  cases: Array<{ activeProfile: FamilyMember; expectedOwner: FamilyMember; expectedTotalCents: string; expectedSourceIds: string[] }>
}

const transactions: Transaction[] = fixture.transactions.map((row) => ({
  id: row.id,
  updatedAtMs: 1,
  date: row.date,
  merchant: row.id,
  amount: BigInt(row.amountCents),
  category: row.category,
  card: null,
  note: null,
  owner: row.owner,
}))

const billPays: BTCBillPay[] = fixture.billPays.map((row) => ({
  id: row.id,
  updatedAtMs: 1,
  date: row.date,
  merchant: row.id,
  category: "Bills",
  budgetEffect: row.budgetEffect ?? "budget_category",
  amountUsd: BigInt(row.principalCents),
  btcSpentSats: 1n,
  btcPrice: 1n,
  platform: "River",
  note: null,
  feeUsd: BigInt(row.feeUsdCents),
  reference: null,
  owner: row.owner,
}))

test("Money Out Today uses the canonical adult ledger and exact child ledger", () => {
  assert.equal(fixture.contractVersion, 1)
  for (const row of fixture.cases) {
    const result = deriveMoneyOutToday({
      activeProfile: row.activeProfile,
      date: fixture.date,
      transactions,
      billPays,
    })
    assert.equal(result.owner, row.expectedOwner)
    assert.equal(result.totalCents, BigInt(row.expectedTotalCents))
    assert.deepEqual(result.sources.map((source) => source.row.id), row.expectedSourceIds)
  }
})

test("Money Out Today excludes Income and credit-card payments, keeps refunds negative, and adds bill-pay fee once", () => {
  const result = deriveMoneyOutToday({
    activeProfile: "victor",
    date: fixture.date,
    transactions,
    billPays,
  })
  assert.equal(result.sources.some((source) => source.row.id === "adult-income"), false)
  assert.equal(result.sources.some((source) => source.row.id === "adult-credit-card-payment"), false)
  assert.equal(result.sources.find((source) => source.row.id === "adult-refund")?.contributionCents, -3000n)
  const billPay = result.sources.find((source) => source.kind === "btc_bill_pay")
  assert.ok(billPay && billPay.kind === "btc_bill_pay")
  assert.equal(billPay.principalCents, 1000n)
  assert.equal(billPay.feeUsdCents, 25n)
  assert.equal(billPay.contributionCents, 1025n)
})

test("Money Out Today excludes Income case-insensitively", () => {
  const result = deriveMoneyOutToday({
    activeProfile: "victor",
    date: fixture.date,
    transactions: [{ ...transactions[0]!, category: "iNcOmE" }],
    billPays: [],
  })
  assert.equal(result.totalCents, 0n)
  assert.deepEqual(result.sources, [])
})

test("Money Out Today excludes credit-card payment transactions case-insensitively", () => {
  const result = deriveMoneyOutToday({
    activeProfile: "victor",
    date: fixture.date,
    transactions: [{ ...transactions[0]!, category: "cReDiT CaRd PaYmEnT" }],
    billPays: [],
  })
  assert.equal(result.totalCents, 0n)
  assert.deepEqual(result.sources, [])
})

test("Money Out Today validates the injected day and never clamps a negative result", () => {
  assert.throws(
    () => deriveMoneyOutToday({ activeProfile: "victor", date: "2026-02-30", transactions, billPays }),
    RangeError,
  )
  const negative = deriveMoneyOutToday({
    activeProfile: "victor",
    date: "2026-08-26",
    transactions: [{ ...transactions[0]!, date: "2026-08-26", amount: -500n }],
    billPays: [],
  })
  assert.equal(negative.totalCents, -500n)
})

test("Money Out Today fails closed on signed-int64 overflow", () => {
  assert.throws(
    () => deriveMoneyOutToday({
      activeProfile: "victor",
      date: fixture.date,
      transactions: [
        { ...transactions[0]!, amount: (1n << 63n) - 1n },
        { ...transactions[0]!, id: "overflow", amount: 1n },
      ],
      billPays: [],
    }),
    RangeError,
  )
})
