import { describe, expect, it } from "vitest"

import { buildSanitizedFixtureEnvelope } from "../src/renderer/data/fixtures.ts"

describe("sanitized fallback fixture freshness", () => {
  it("never claims disabled remote reads are live or synced", () => {
    const data = buildSanitizedFixtureEnvelope("victor")
    const slices = [
      data.transactions,
      data.budget,
      data.btcAccounts,
      data.btcBuys,
      data.billPays,
      data.todos,
    ]

    expect(slices.every((slice) => slice.status === "demo")).toBe(true)
    expect(slices.every((slice) => slice.updatedAt === null)).toBe(true)
  })
})
