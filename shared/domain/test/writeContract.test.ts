import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  WriteContractError,
  PAYMENT_SOURCES,
  buildBtcBillPayWriteRequest,
  buildTransactionWriteRequest,
  canWriteDataOwnedBy,
  isPaymentSource,
  parseWriteInt64,
  paymentSourceRoute,
  type PaymentSource,
  type WriteContractErrorCode,
} from "../src/writeContract.ts"

interface AcceptedCase {
  name: string
  actor: unknown
  input: unknown
  expected: unknown
}

interface RejectedCase {
  name: string
  actor: unknown
  input: unknown
  errorCode: WriteContractErrorCode
}

interface Fixtures {
  contractVersion: number
  path: string
  format: string
  signConvention: {
    purchase: string
    refund: string
    scope: string
  }
  accepted: AcceptedCase[]
  rejected: RejectedCase[]
}

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/write-payload-cases.json", import.meta.url), "utf8"),
) as Fixtures

const paymentSourceFixtures = JSON.parse(
  readFileSync(new URL("../fixtures/payment-source-cases.json", import.meta.url), "utf8"),
) as {
  contractVersion: number
  sources: Array<{ wire: PaymentSource; route: "transaction" | "btc_bill_pay" }>
  bitcoinSpend: {
    paymentSource: PaymentSource
    card: string
    amountSats: string
    bitcoinAccountKey: string
  }
  cardSpend: { paymentSource: PaymentSource; card: string }
  billPay: {
    paymentSource: PaymentSource
    route: "btc_bill_pay"
    platform: string
    budgetEffects: string[]
  }
}

test("golden write payloads encode exact signed int64 minor units", () => {
  assert.equal(fixtures.contractVersion, 2)
  assert.equal(fixtures.path, "tables:upsertTransaction")
  assert.equal(fixtures.format, "convex_encoded_json")
  assert.deepEqual(fixtures.signConvention, {
    purchase: "positive",
    refund: "negative",
    scope: "every-owner",
  })

  for (const testCase of fixtures.accepted) {
    assert.deepEqual(
      buildTransactionWriteRequest(testCase.actor, testCase.input),
      testCase.expected,
      testCase.name,
    )
  }
})

test("golden rejection vectors remain strict", () => {
  const requiredRejections = new Set<WriteContractErrorCode>([
    "sign-disagrees",
    "zero-amount",
    "income-must-be-credit",
    "invalid-minor-units",
    "int64-out-of-range",
    "invalid-owner",
    "write-not-authorized",
    "source-owner-mismatch",
    "invalid-date",
  ])
  for (const testCase of fixtures.rejected) {
    requiredRejections.delete(testCase.errorCode)
    assert.throws(
      () => buildTransactionWriteRequest(testCase.actor, testCase.input),
      (error: unknown) =>
        error instanceof WriteContractError && error.code === testCase.errorCode,
      testCase.name,
    )
  }
  assert.deepEqual([...requiredRejections], [], "fixture lost a required rejection class")
})

test("write scope follows household visibility without strict owner equality", () => {
  assert.equal(canWriteDataOwnedBy("rachel", "victor"), true)
  assert.equal(canWriteDataOwnedBy("victor", "mason"), true)
  assert.equal(canWriteDataOwnedBy("mason", "mason"), true)
  assert.equal(canWriteDataOwnedBy("mason", "victor"), false)
  assert.equal(canWriteDataOwnedBy("mason", "maddox"), false)
})

test("minor-unit parser refuses float and unsafe JSON-number fallbacks", () => {
  assert.equal(parseWriteInt64("9007199254740993"), 9_007_199_254_740_993n)
  assert.equal(parseWriteInt64(-800n), -800n)
  assert.throws(() => parseWriteInt64("8.00"), WriteContractError)
  assert.throws(() => parseWriteInt64(9_007_199_254_740_992), WriteContractError)
})

test("Bitcoin-denominated Income carries exact positive sats only", () => {
  const input = {
    id: "income-1",
    date: "2026-08-01",
    merchant: "Bitcoin income",
    amountCents: 1n,
    amountSats: 25_000n,
    kind: "credit",
    category: "Income",
    owner: "victor",
    sourceFile: "transactions",
  }
  assert.deepEqual(
    buildTransactionWriteRequest("victor", input).args.transaction.amountSats,
    { $integer: "qGEAAAAAAAA=" },
  )
  assert.throws(
    () => buildTransactionWriteRequest("victor", {
      ...input,
      category: "Other",
      kind: "spend",
    }),
    (error: unknown) =>
      error instanceof WriteContractError && error.code === "invalid-input",
  )
  assert.throws(
    () => buildTransactionWriteRequest("victor", { ...input, amountSats: 0n }),
    (error: unknown) =>
      error instanceof WriteContractError && error.code === "invalid-input",
  )
})

test("golden write requests never contain a token or decimal dollar field", () => {
  for (const testCase of fixtures.accepted) {
    const serialized = JSON.stringify(testCase.expected)
    assert.equal(serialized.includes('"token"'), false, testCase.name)
    assert.equal(serialized.includes('"amount"'), false, testCase.name)
    assert.equal(serialized.includes('"amountCents":{"$integer":'), true, testCase.name)
  }
})

test("payment source fixture pins the complete closed wire set and routes", () => {
  assert.equal(paymentSourceFixtures.contractVersion, 1)
  assert.deepEqual(
    paymentSourceFixtures.sources.map(({ wire }) => wire),
    PAYMENT_SOURCES,
  )
  for (const { wire, route } of paymentSourceFixtures.sources) {
    assert.equal(isPaymentSource(wire), true)
    assert.equal(paymentSourceRoute(wire), route)
  }
  assert.equal(isPaymentSource("visa"), false)
  assert.deepEqual(paymentSourceFixtures.billPay.budgetEffects, [
    "budget_category",
    "credit_card_payment",
  ])
})

test("payment-source transaction mapping persists cards and Bitcoin spend intent", () => {
  const base = {
    id: "payment-source-1",
    date: "2026-08-20",
    merchant: "Merchant",
    amountCents: 2_500n,
    kind: "spend" as const,
    category: "Shopping",
    owner: "victor" as const,
    sourceFile: "transactions",
  }
  const card = buildTransactionWriteRequest("victor", {
    ...base,
    card: paymentSourceFixtures.cardSpend.card,
  }).args.transaction
  assert.equal(card.card, paymentSourceFixtures.cardSpend.card)
  assert.equal(card.amountSats, undefined)
  assert.equal(card.bitcoinAccountKey, undefined)

  const bitcoin = buildTransactionWriteRequest("victor", {
    ...base,
    card: paymentSourceFixtures.bitcoinSpend.card,
    amountSats: paymentSourceFixtures.bitcoinSpend.amountSats,
    bitcoinAccountKey: paymentSourceFixtures.bitcoinSpend.bitcoinAccountKey,
  }).args.transaction
  assert.equal(bitcoin.card, paymentSourceFixtures.bitcoinSpend.card)
  assert.deepEqual(bitcoin.amountSats, { $integer: "qGEAAAAAAAA=" })
  assert.equal(bitcoin.bitcoinAccountKey, "river")

  const typedAlias = buildTransactionWriteRequest("victor", {
    ...base,
    paymentSource: paymentSourceFixtures.bitcoinSpend.paymentSource,
    amountSats: paymentSourceFixtures.bitcoinSpend.amountSats,
    bitcoinAccountKey: paymentSourceFixtures.bitcoinSpend.bitcoinAccountKey,
  }).args.transaction
  assert.deepEqual(typedAlias, bitcoin)
})

test("payment-source builder rejects wrong routes and field combinations", () => {
  const base = {
    id: "payment-source-reject",
    date: "2026-08-20",
    merchant: "Merchant",
    amountCents: 2_500n,
    kind: "spend" as const,
    category: "Shopping",
    owner: "victor" as const,
    sourceFile: "transactions",
  }
  const rejected = [
    { ...base, paymentSource: "river_bitcoin_bill_pay" },
    { ...base, paymentSource: "lightning" },
    {
      ...base,
      paymentSource: "on_chain",
      amountSats: 10n,
      bitcoinAccountKey: "",
    },
    { ...base, paymentSource: "aven", amountSats: 10n, bitcoinAccountKey: "river" },
    { ...base, paymentSource: "not-a-source" },
  ]
  for (const candidate of rejected) {
    assert.throws(() => buildTransactionWriteRequest("victor", candidate), WriteContractError)
  }
  assert.throws(
    () => buildTransactionWriteRequest("mason", {
      ...base,
      owner: "mason",
      sourceFile: "mason-transactions",
      paymentSource: "lightning",
      amountSats: 10n,
      bitcoinAccountKey: "mason-stack",
    }),
    WriteContractError,
  )
})

test("River bill-pay builder requires budgetEffect and canonicalizes excluded payments", () => {
  const base = {
    id: "river-bill-1",
    date: "2026-08-20",
    merchant: "Aven",
    category: "Bills",
    amountUsdCents: 12_000n,
    btcSpentSats: 180_000n,
    btcPriceCents: 6_666_667n,
    feeUsdCents: 0n,
    owner: "victor" as const,
    sourceFile: "bitcoin-bill-pays" as const,
    paymentSource: "river_bitcoin_bill_pay" as const,
  }
  const budgeted = buildBtcBillPayWriteRequest("rachel", {
    ...base,
    budgetEffect: "budget_category",
  })
  assert.equal(budgeted.path, "tables:upsertBtcBillPay")
  assert.equal(budgeted.args.billPay.category, "Bills")
  assert.equal(budgeted.args.billPay.platform, "river_bitcoin_bill_pay")
  assert.equal(budgeted.args.billPay.budgetEffect, "budget_category")

  const excluded = buildBtcBillPayWriteRequest("victor", {
    ...base,
    budgetEffect: "credit_card_payment",
  })
  assert.equal(excluded.args.billPay.category, "Credit Card Payment")
  const rachel = buildBtcBillPayWriteRequest("rachel", {
    ...base,
    owner: "rachel",
    budgetEffect: "budget_category",
  })
  assert.equal(rachel.args.billPay.owner, "victor")
  assert.throws(
    () => buildBtcBillPayWriteRequest("victor", base),
    WriteContractError,
  )
  assert.throws(
    () => buildBtcBillPayWriteRequest("victor", {
      ...base,
      owner: "mason",
      budgetEffect: "budget_category",
    }),
    WriteContractError,
  )
  assert.throws(
    () => buildBtcBillPayWriteRequest("mason", {
      ...base,
      budgetEffect: "budget_category",
    }),
    WriteContractError,
  )
})
