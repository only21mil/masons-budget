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
  sources: Array<{
    wire: PaymentSource
    label: string
    route: "transaction" | "btc_bill_pay"
    classification: "bill_pay" | "fiat_card" | "bitcoin_native"
    supportedActivities: Array<"spend" | "income" | "transfer" | "btc_bill_pay">
  }>
  bitcoinSpend: {
    paymentSource: PaymentSource
    card: string
    kind: "spend"
    category: string
    amountCents: string
    amountSats: string
    bitcoinAccountKey: string
  }
  bitcoinIncome: {
    paymentSource: PaymentSource
    card: string
    kind: "credit"
    category: "Income"
    amountCents: string
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

test("payment source fixture pins the complete closed catalogue", () => {
  assert.equal(paymentSourceFixtures.contractVersion, 2)
  assert.deepEqual(
    paymentSourceFixtures.sources.map(({ wire }) => wire),
    PAYMENT_SOURCES,
  )
  for (const { wire, route } of paymentSourceFixtures.sources) {
    assert.equal(isPaymentSource(wire), true)
    assert.equal(paymentSourceRoute(wire), route)
  }
  assert.equal(isPaymentSource("visa"), false)
  assert.equal(isPaymentSource("lightning"), false)
  assert.equal(isPaymentSource("on_chain"), false)
  assert.deepEqual(
    paymentSourceFixtures.sources,
    [
      {
        wire: "river",
        label: "River",
        route: "transaction",
        classification: "bitcoin_native",
        supportedActivities: ["spend", "income", "transfer"],
      },
      {
        wire: "zeus_lightning",
        label: "Zeus Lightning",
        route: "transaction",
        classification: "bitcoin_native",
        supportedActivities: ["spend", "income", "transfer"],
      },
      {
        wire: "zeus_on_chain",
        label: "Zeus On-chain",
        route: "transaction",
        classification: "bitcoin_native",
        supportedActivities: ["spend", "income", "transfer"],
      },
      {
        wire: "strike",
        label: "Strike",
        route: "transaction",
        classification: "bitcoin_native",
        supportedActivities: ["spend", "income", "transfer"],
      },
      {
        wire: "coinbase_card",
        label: "Coinbase Card",
        route: "transaction",
        classification: "fiat_card",
        supportedActivities: ["spend"],
      },
      {
        wire: "aven",
        label: "Aven",
        route: "transaction",
        classification: "fiat_card",
        supportedActivities: ["spend"],
      },
      {
        wire: "sofi_card",
        label: "SoFi Card",
        route: "transaction",
        classification: "fiat_card",
        supportedActivities: ["spend"],
      },
      {
        wire: "capital_one_vx",
        label: "Capital One VX",
        route: "transaction",
        classification: "fiat_card",
        supportedActivities: ["spend"],
      },
      {
        wire: "river_bitcoin_bill_pay",
        label: "River Bitcoin Bill Pay",
        route: "btc_bill_pay",
        classification: "bill_pay",
        supportedActivities: ["btc_bill_pay"],
      },
    ],
  )
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
    kind: paymentSourceFixtures.bitcoinSpend.kind,
    category: paymentSourceFixtures.bitcoinSpend.category,
    amountCents: paymentSourceFixtures.bitcoinSpend.amountCents,
    amountSats: paymentSourceFixtures.bitcoinSpend.amountSats,
    bitcoinAccountKey: paymentSourceFixtures.bitcoinSpend.bitcoinAccountKey,
  }).args.transaction
  assert.equal(bitcoin.card, paymentSourceFixtures.bitcoinSpend.card)
  assert.deepEqual(bitcoin.amountSats, { $integer: "qGEAAAAAAAA=" })
  assert.equal(bitcoin.bitcoinAccountKey, paymentSourceFixtures.bitcoinSpend.bitcoinAccountKey)

  const typedAlias = buildTransactionWriteRequest("victor", {
    ...base,
    paymentSource: paymentSourceFixtures.bitcoinSpend.paymentSource,
    kind: paymentSourceFixtures.bitcoinSpend.kind,
    category: paymentSourceFixtures.bitcoinSpend.category,
    amountCents: paymentSourceFixtures.bitcoinSpend.amountCents,
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
    { ...base, paymentSource: "zeus_lightning" },
    {
      ...base,
      paymentSource: "zeus_on_chain",
      amountSats: 10n,
      bitcoinAccountKey: "",
    },
    { ...base, paymentSource: "aven", amountSats: 10n, bitcoinAccountKey: "river" },
    {
      ...base,
      paymentSource: "coinbase_card",
      kind: "credit" as const,
      category: "Income",
    },
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
      paymentSource: "strike",
      amountSats: 10n,
      bitcoinAccountKey: "mason-stack",
    }),
    WriteContractError,
  )
})

test("every Bitcoin-native source supports debit spend and credit Income", () => {
  const base = {
    id: "bitcoin-source-contract",
    date: "2026-08-20",
    merchant: "Bitcoin merchant",
    owner: "victor" as const,
    sourceFile: "transactions",
  }
  const bitcoinSources = paymentSourceFixtures.sources.filter(
    (source) => source.classification === "bitcoin_native",
  )
  assert.equal(bitcoinSources.length, 4)

  for (const { wire } of bitcoinSources) {
    const spend = buildTransactionWriteRequest("victor", {
      ...base,
      paymentSource: wire,
      kind: paymentSourceFixtures.bitcoinSpend.kind,
      category: paymentSourceFixtures.bitcoinSpend.category,
      amountCents: paymentSourceFixtures.bitcoinSpend.amountCents,
      amountSats: paymentSourceFixtures.bitcoinSpend.amountSats,
      bitcoinAccountKey: paymentSourceFixtures.bitcoinSpend.bitcoinAccountKey,
    }).args.transaction
    assert.equal(spend.card, wire)
    assert.equal(spend.kind, paymentSourceFixtures.bitcoinSpend.kind)
    assert.equal(spend.category, paymentSourceFixtures.bitcoinSpend.category)
    assert.deepEqual(spend.amountSats, { $integer: "qGEAAAAAAAA=" })
    assert.equal(spend.bitcoinAccountKey, paymentSourceFixtures.bitcoinSpend.bitcoinAccountKey)

    const income = buildTransactionWriteRequest("victor", {
      ...base,
      id: `bitcoin-income-${wire}`,
      paymentSource: wire,
      kind: paymentSourceFixtures.bitcoinIncome.kind,
      category: paymentSourceFixtures.bitcoinIncome.category,
      amountCents: paymentSourceFixtures.bitcoinIncome.amountCents,
      amountSats: paymentSourceFixtures.bitcoinIncome.amountSats,
      bitcoinAccountKey: paymentSourceFixtures.bitcoinIncome.bitcoinAccountKey,
    }).args.transaction
    assert.equal(income.card, wire)
    assert.equal(income.kind, paymentSourceFixtures.bitcoinIncome.kind)
    assert.equal(income.category, paymentSourceFixtures.bitcoinIncome.category)
    assert.deepEqual(income.amountSats, { $integer: "qGEAAAAAAAA=" })
    assert.equal(income.bitcoinAccountKey, paymentSourceFixtures.bitcoinIncome.bitcoinAccountKey)

    assert.throws(
      () => buildTransactionWriteRequest("victor", {
        ...base,
        id: `bitcoin-income-without-account-${wire}`,
        amountCents: paymentSourceFixtures.bitcoinIncome.amountCents,
        kind: paymentSourceFixtures.bitcoinIncome.kind,
        category: paymentSourceFixtures.bitcoinIncome.category,
        paymentSource: wire,
        amountSats: paymentSourceFixtures.bitcoinIncome.amountSats,
        bitcoinAccountKey: undefined,
      }),
      (error: unknown) =>
        error instanceof WriteContractError && error.code === "payment-source-fields",
    )

    assert.throws(
      () => buildTransactionWriteRequest("victor", {
        ...base,
        paymentSource: wire,
        kind: "credit",
        category: paymentSourceFixtures.bitcoinSpend.category,
        amountCents: -2_500n,
        amountSats: paymentSourceFixtures.bitcoinSpend.amountSats,
        bitcoinAccountKey: paymentSourceFixtures.bitcoinSpend.bitcoinAccountKey,
      }),
      (error: unknown) =>
        error instanceof WriteContractError && error.code === "payment-source-fields",
    )
    assert.throws(
      () => buildTransactionWriteRequest("victor", {
        ...base,
        paymentSource: wire,
        kind: "spend",
        category: "Income",
        amountCents: paymentSourceFixtures.bitcoinIncome.amountCents,
        amountSats: paymentSourceFixtures.bitcoinIncome.amountSats,
        bitcoinAccountKey: paymentSourceFixtures.bitcoinIncome.bitcoinAccountKey,
      }),
      (error: unknown) =>
        error instanceof WriteContractError && error.code === "income-must-be-credit",
    )
    assert.throws(
      () => buildTransactionWriteRequest("victor", {
        ...base,
        paymentSource: wire,
        kind: paymentSourceFixtures.bitcoinSpend.kind,
        category: paymentSourceFixtures.bitcoinSpend.category,
        amountCents: paymentSourceFixtures.bitcoinSpend.amountCents,
        amountSats: 0n,
        bitcoinAccountKey: paymentSourceFixtures.bitcoinSpend.bitcoinAccountKey,
      }),
      (error: unknown) =>
        error instanceof WriteContractError && error.code === "payment-source-fields",
    )
    assert.throws(
      () => buildTransactionWriteRequest("victor", {
        ...base,
        paymentSource: wire,
        kind: paymentSourceFixtures.bitcoinSpend.kind,
        category: paymentSourceFixtures.bitcoinSpend.category,
        amountCents: paymentSourceFixtures.bitcoinSpend.amountCents,
        amountSats: paymentSourceFixtures.bitcoinSpend.amountSats,
        bitcoinAccountKey: undefined,
      }),
      (error: unknown) =>
        error instanceof WriteContractError && error.code === "payment-source-fields",
    )
    assert.throws(
      () => buildTransactionWriteRequest("mason", {
        ...base,
        owner: "mason",
        sourceFile: "mason-transactions",
        paymentSource: wire,
        kind: paymentSourceFixtures.bitcoinSpend.kind,
        category: paymentSourceFixtures.bitcoinSpend.category,
        amountCents: paymentSourceFixtures.bitcoinSpend.amountCents,
        amountSats: paymentSourceFixtures.bitcoinSpend.amountSats,
        bitcoinAccountKey: paymentSourceFixtures.bitcoinSpend.bitcoinAccountKey,
      }),
      (error: unknown) =>
        error instanceof WriteContractError && error.code === "write-not-authorized",
    )
  }
})

test("retired source wires remain untyped card values but are not selectable", () => {
  const base = {
    id: "retired-source-round-trip",
    date: "2026-08-20",
    merchant: "Legacy merchant",
    amountCents: 2_500n,
    kind: "spend" as const,
    category: "Shopping",
    owner: "victor" as const,
    sourceFile: "transactions",
  }

  for (const card of ["lightning", "on_chain"]) {
    assert.equal(isPaymentSource(card), false)
    assert.equal(
      buildTransactionWriteRequest("victor", { ...base, card }).args.transaction.card,
      card,
    )
    assert.throws(
      () => buildTransactionWriteRequest("victor", { ...base, paymentSource: card }),
      (error: unknown) =>
        error instanceof WriteContractError && error.code === "invalid-payment-source",
    )
  }
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
