import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  WriteContractError,
  buildBtcBillPayWriteRequest,
  buildLinkedIncomeBuyWriteRequest,
  normalizeBTCBillPay,
  normalizeBTCBuy,
  parseManualFeeUsdCents,
} from "../src/index.ts"

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/manual-fee-cases.json", import.meta.url), "utf8"),
) as {
  contractVersion: number
  accepted: Array<{ name: string; input?: unknown; expected: string }>
  rejected: Array<{ name: string; input: unknown }>
}

const buyInput = {
  sourceFile: "bitcoin-buys",
  buy: {
    id: "fee-buy",
    owner: "victor",
    date: "2026-08-25",
    source: "River",
    sats: "1000",
    priceUsdCents: "6000000",
    usdCents: "60",
  },
  linkedIncome: {
    id: "fee-buy",
    owner: "victor",
    date: "2026-08-25",
    amountCents: "60",
    source: "Payroll",
    sourceFile: "income",
  },
}

const billPayInput = {
  id: "fee-bill",
  date: "2026-08-25",
  merchant: "Utility",
  category: "Utilities",
  budgetEffect: "budget_category",
  amountUsdCents: "1000",
  btcSpentSats: "15000",
  btcPriceCents: "6666667",
  owner: "victor",
  sourceFile: "bitcoin-bill-pays",
  paymentSource: "river_bitcoin_bill_pay",
}

test("manual fee fixture defaults missing and null to exact zero", () => {
  assert.equal(fixture.contractVersion, 1)
  for (const row of fixture.accepted) {
    assert.equal(parseManualFeeUsdCents(row.input), BigInt(row.expected), row.name)
  }
})

test("manual fee refuses negative, fractional, unsafe-number, and int64 overflow inputs", () => {
  for (const row of fixture.rejected) {
    assert.throws(() => parseManualFeeUsdCents(row.input), RangeError, row.name)
  }
})

test("buy and bill-pay descriptions always encode an explicit fee, including zero", () => {
  assert.deepEqual(
    buildLinkedIncomeBuyWriteRequest("victor", buyInput).args.buy.feeUsdCents,
    { $integer: "AAAAAAAAAAA=" },
  )
  assert.deepEqual(
    buildBtcBillPayWriteRequest("victor", billPayInput).args.billPay.feeUsdCents,
    { $integer: "AAAAAAAAAAA=" },
  )
  assert.deepEqual(
    buildLinkedIncomeBuyWriteRequest("victor", {
      ...buyInput,
      buy: { ...buyInput.buy, feeUsdCents: "125" },
    }).args.buy.feeUsdCents,
    { $integer: "fQAAAAAAAAA=" },
  )
})

test("write descriptions map invalid manual fees onto write-contract failures", () => {
  for (const input of fixture.rejected.map((row) => row.input)) {
    assert.throws(
      () => buildBtcBillPayWriteRequest("victor", { ...billPayInput, feeUsdCents: input }),
      WriteContractError,
    )
    assert.throws(
      () => buildLinkedIncomeBuyWriteRequest("victor", {
        ...buyInput,
        buy: { ...buyInput.buy, feeUsdCents: input },
      }),
      WriteContractError,
    )
  }
})

test("read normalization defaults missing and null fees without changing legacy fee_usd", () => {
  assert.equal(normalizeBTCBuy({ usd: "1", owner: "victor" }).feeUsd, 0n)
  assert.equal(normalizeBTCBuy({ usd: "1", feeUsdCents: null, owner: "victor" }).feeUsd, 0n)
  assert.equal(normalizeBTCBillPay({ owner: "victor", feeUsdCents: null }).feeUsd, 0n)
  assert.equal(normalizeBTCBillPay({ owner: "victor", fee_usd: "1.25" }).feeUsd, 125n)
})
