import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  WriteContractError,
  buildLinkedIncomeBuyWriteRequest,
} from "../src/index.ts"

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/income-buy-write-cases.json", import.meta.url),
    "utf8",
  ),
) as {
  contractVersion: number
  actor: unknown
  input: Record<string, unknown>
  expected: unknown
}

test("paired income-buy golden payload uses one id and canonical adult ownership", () => {
  assert.equal(fixture.contractVersion, 2)
  assert.deepEqual(
    buildLinkedIncomeBuyWriteRequest(fixture.actor, fixture.input),
    fixture.expected,
  )
})

test("paired income-buy contract rejects divergent linkage fields", () => {
  const linkedIncome = fixture.input.linkedIncome as Record<string, unknown>
  for (const replacement of [
    { id: "different-id" },
    { date: "2026-08-19" },
    { owner: "mason" },
    { amountCents: "24" },
  ]) {
    assert.throws(
      () => buildLinkedIncomeBuyWriteRequest("victor", {
        ...fixture.input,
        linkedIncome: { ...linkedIncome, ...replacement },
      }),
      WriteContractError,
    )
  }
})

test("paired income-buy contract is adult-only and keeps credentials out of the payload", () => {
  assert.throws(
    () => buildLinkedIncomeBuyWriteRequest("mason", fixture.input),
    (error: unknown) =>
      error instanceof WriteContractError && error.code === "write-not-authorized",
  )
  const serialized = JSON.stringify(
    buildLinkedIncomeBuyWriteRequest("victor", fixture.input),
  )
  assert.equal(serialized.includes('"token"'), false)
  assert.equal(serialized.includes('"amountSats"'), false)
})
