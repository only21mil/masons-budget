import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  WriteContractError,
  buildTransactionWriteRequest,
  canWriteDataOwnedBy,
  parseWriteInt64,
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
