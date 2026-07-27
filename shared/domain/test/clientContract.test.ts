import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { decodeConvexInt64 } from "../src/convexInt64.ts"
import { type FamilyMember, isFamilyMember } from "../src/family.ts"
import {
  type Transaction,
  displaySpendAmount,
  hasOppositeSpendSign,
  spendAmount,
} from "../src/readModel.ts"

interface SpendCase {
  name: string
  meaning: string
  input: {
    amountCents: string
    category: string
    owner: FamilyMember
  }
  expected: {
    spendAmount: string
    displaySpendAmount: string
    hasOppositeSpendSign: boolean
  }
}

interface CompatibilityFixtures {
  sampleTransactions: Array<Record<string, unknown>>
  serverResponseCompatibility: {
    rowCounts: {
      response: unknown
      expectedKnownValue: Record<string, number>
    }
    transactionEnvelope: {
      response: unknown
      expectedKnownRow: {
        txId: string
        owner: FamilyMember
        amountCents: string
        spendAmount: string
        displaySpendAmount: string
        hasOppositeSpendSign: boolean
      }
    }
  }
  spendContract: {
    cases: SpendCase[]
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "visibility-cases.json"), "utf8"),
) as CompatibilityFixtures

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object`)
  return value as Record<string, unknown>
}

function successfulValue(response: unknown): unknown {
  const wrapper = record(response, "response")
  assert.equal(wrapper.status, "success")
  assert.ok(Object.hasOwn(wrapper, "value"))
  return wrapper.value
}

test("shared parity fixture itself carries deliberate unknown fields", () => {
  const sample = fixtures.sampleTransactions[0]
  assert.ok(sample)
  assert.ok(Object.hasOwn(sample, "_futureServerRowField"))

  const rowCountsResponse = record(
    fixtures.serverResponseCompatibility.rowCounts.response,
    "rowCounts response",
  )
  assert.ok(Object.hasOwn(rowCountsResponse, "_futureResponseField"))

  const transactionValue = record(
    successfulValue(fixtures.serverResponseCompatibility.transactionEnvelope.response),
    "transaction envelope",
  )
  assert.ok(Object.hasOwn(transactionValue, "_futureEnvelopeField"))
  const rows = transactionValue.rows
  assert.ok(Array.isArray(rows))
  assert.ok(Object.hasOwn(record(rows[0], "transaction row"), "_futureRowField"))
})

test("rowCounts vector selects known fields while accepting server additions", () => {
  const value = record(
    successfulValue(fixtures.serverResponseCompatibility.rowCounts.response),
    "rowCounts value",
  )
  const knownKeys = Object.keys(fixtures.serverResponseCompatibility.rowCounts.expectedKnownValue)
  const decoded = Object.fromEntries(knownKeys.map((key) => {
    const count = value[key]
    assert.ok(Number.isSafeInteger(count) && (count as number) >= 0, `${key} must be a non-negative integer`)
    return [key, count]
  }))

  assert.deepEqual(decoded, fixtures.serverResponseCompatibility.rowCounts.expectedKnownValue)
  assert.ok(Object.keys(value).length > knownKeys.length, "vector must retain added server fields")
})

test("transaction envelope vector ignores unknown objects but keeps closed values and exact int64s", () => {
  const value = record(
    successfulValue(fixtures.serverResponseCompatibility.transactionEnvelope.response),
    "transaction envelope",
  )
  assert.equal(value.complete, true)
  assert.ok(Array.isArray(value.rows))
  assert.equal(value.rows.length, 1)

  const row = record(value.rows[0], "transaction row")
  assert.equal(typeof row.txId, "string")
  assert.ok(isFamilyMember(row.owner), "owner remains a closed union")
  assert.equal(typeof row.hasOppositeSpendSign, "boolean")

  const decoded = {
    txId: row.txId as string,
    owner: row.owner,
    amountCents: String(decodeConvexInt64(row.amountCents)),
    spendAmount: String(decodeConvexInt64(row.spendAmount)),
    displaySpendAmount: String(decodeConvexInt64(row.displaySpendAmount)),
    hasOppositeSpendSign: row.hasOppositeSpendSign as boolean,
  }
  assert.deepEqual(decoded, fixtures.serverResponseCompatibility.transactionEnvelope.expectedKnownRow)
})

test("signed spend contract is pinned by all five language-neutral vectors", () => {
  assert.deepEqual(
    fixtures.spendContract.cases.map((testCase) => testCase.name),
    [
      "adult spend",
      "child spend",
      "income",
      "adult refund",
      "corrupt wrong-sign legacy row",
    ],
  )

  for (const testCase of fixtures.spendContract.cases) {
    const transaction: Transaction = {
      id: testCase.name,
      date: "2026-07-27",
      merchant: testCase.name,
      amount: BigInt(testCase.input.amountCents),
      category: testCase.input.category,
      card: null,
      note: null,
      owner: testCase.input.owner,
    }

    assert.equal(String(spendAmount(transaction)), testCase.expected.spendAmount, testCase.name)
    assert.equal(
      String(displaySpendAmount(transaction)),
      testCase.expected.displaySpendAmount,
      testCase.name,
    )
    assert.equal(
      hasOppositeSpendSign(transaction),
      testCase.expected.hasOppositeSpendSign,
      testCase.name,
    )
  }
})

test("refund and corrupt wrong-sign meanings stay indistinguishable on read", () => {
  const cases = fixtures.spendContract.cases
  const refund = cases.find((entry) => entry.meaning === "valid-refund")
  const corrupt = cases.find((entry) => entry.meaning === "corrupt-wrong-sign")
  assert.ok(refund)
  assert.ok(corrupt)

  for (const testCase of [refund, corrupt]) {
    assert.ok(BigInt(testCase.expected.spendAmount) < 0n)
    assert.ok(BigInt(testCase.expected.displaySpendAmount) > 0n)
    assert.equal(testCase.expected.hasOppositeSpendSign, true)
  }
})
