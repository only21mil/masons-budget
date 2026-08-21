import assert from "node:assert/strict"
import { test } from "node:test"

import { normalizeBTCBillPay, normalizeTransaction } from "../src/readModel.ts"

// The Transaction type has carried amountSats/bitcoinAccountKey/
// balancePostingVersion since the Bitcoin ledger landed, but the normalizer
// dropped them. Every consumer that normalizes a row — optimistic client rows
// included — therefore saw a posted sat-Income row as an ordinary one, which is
// how a Bitcoin amount silently disappears between the wire and the UI.

test("normalizeTransaction preserves the Bitcoin posting fields", () => {
  const row = normalizeTransaction({
    id: "tx-1",
    date: "2026-08-01",
    merchant: "Payroll",
    amount: 1000,
    category: "Income",
    owner: "victor",
    updatedAtMs: 5,
    amountSats: 50_000n,
    bitcoinAccountKey: "river",
    balancePostingVersion: 1n,
  })

  assert.equal(row.amountSats, 50_000n)
  assert.equal(row.bitcoinAccountKey, "river")
  assert.equal(row.balancePostingVersion, 1n)
})

test("normalizeTransaction accepts snake_case and integer-string sats", () => {
  const row = normalizeTransaction({
    id: "tx-2",
    date: "2026-08-01",
    merchant: "Payroll",
    amount: 1000,
    category: "Income",
    owner: "victor",
    updatedAtMs: 5,
    amount_sats: "50000",
    bitcoin_account_key: "coldcard",
    balance_posting_version: 1,
  })

  assert.equal(row.amountSats, 50_000n)
  assert.equal(row.bitcoinAccountKey, "coldcard")
  assert.equal(row.balancePostingVersion, 1n)
})

test("normalizeTransaction leaves a row with no Bitcoin fields absent, never zero", () => {
  const row = normalizeTransaction({
    id: "tx-3",
    date: "2026-08-01",
    merchant: "Groceries",
    amount: -1000,
    category: "Other",
    owner: "victor",
    updatedAtMs: 5,
  })

  assert.equal(row.amountSats, undefined)
  assert.equal(row.bitcoinAccountKey, undefined)
  assert.equal(row.balancePostingVersion, undefined)
})

test("normalizeTransaction refuses a fractional sats value rather than rounding it", () => {
  const row = normalizeTransaction({
    id: "tx-4",
    date: "2026-08-01",
    merchant: "Payroll",
    amount: 1000,
    category: "Income",
    owner: "victor",
    updatedAtMs: 5,
    amountSats: 1.5,
  })

  assert.equal(row.amountSats, undefined)
})

test("normalizeBTCBillPay keeps a closed budget effect and defaults legacy rows to excluded", () => {
  const budgeted = normalizeBTCBillPay({
    id: "bill-budgeted",
    date: "2026-08-20",
    merchant: "Utility",
    category: "Utilities",
    budgetEffect: "budget_category",
    amountUsdCents: 7_500n,
    btcSpentSats: 10_000n,
    btcPriceCents: 7_500_000n,
    feeUsdCents: 0n,
    owner: "victor",
  })
  assert.equal(budgeted.budgetEffect, "budget_category")
  assert.equal(budgeted.category, "Utilities")
  assert.equal(budgeted.amountUsd, 7_500n)

  const legacy = normalizeBTCBillPay({
    id: "bill-legacy",
    date: "2026-08-20",
    merchant: "Aven",
    category: "Bills",
    amount_usd: "75",
    btc_spent: "0.001",
    btc_price: "75000",
    fee_usd: "0",
    owner: "victor",
  })
  assert.equal(legacy.budgetEffect, "credit_card_payment")
  assert.equal(legacy.category, "Credit Card Payment")
})
