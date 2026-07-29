import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { normalizeBTCSnapshot } from "../src/readModel.ts"

interface AvailabilityCase {
  name: string
  input: Record<string, unknown>
  expected: {
    sats: string
    fiatAvailable: boolean
    fiatCents: string | null
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "btc-fiat-availability-cases.json"), "utf8"),
) as { cases: AvailabilityCase[] }

test("BTC fiat availability is independent from sats balance confidence", () => {
  for (const fixture of fixtures.cases) {
    const snapshot = normalizeBTCSnapshot(
      {
        schemaVersion: 2,
        asOf: "2026-07-16T01:56:49Z",
        accounts: { account: fixture.input },
        totals: fixture.input,
        metadata: {
          source: "authoritative balance reconciliation",
          basis: "self-custody screenshot",
          confidence: "high",
        },
      },
      "victor",
    )
    const account = snapshot.accounts[0]
    assert.ok(account)
    const valuation = account.fiatValuation ?? null

    assert.equal(String(account.sats), fixture.expected.sats, fixture.name)
    assert.equal(valuation !== null, fixture.expected.fiatAvailable, fixture.name)
    assert.equal(
      valuation === null ? null : String(valuation.cents),
      fixture.expected.fiatCents,
      fixture.name,
    )
    assert.equal(snapshot.balanceConfidence, "high", fixture.name)
    assert.equal(valuation?.confidence ?? null, fixture.input.fiatValuation ? "verified" : null)
  }
})
