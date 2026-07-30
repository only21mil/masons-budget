import { describe, expect, it } from "vitest"

import {
  formatCentsInput,
  mutationGate,
  parseExactCents,
  parseExactSats,
} from "../src/renderer/data/mutations.ts"

describe("exact renderer mutation forms", () => {
  it.each([
    ["0", 0n],
    ["12", 1_200n],
    ["12.3", 1_230n],
    ["12.34", 1_234n],
    ["-0.01", -1n],
    ["+9.99", 999n],
  ])("parses %s as exact cents", (input, expected) => {
    expect(parseExactCents(input)).toBe(expected)
    expect(formatCentsInput(expected)).toMatch(/^-?\d+\.\d{2}$/)
  })

  it.each(["", ".50", "1.234", "1e2", "NaN", "Infinity", "1,000"])(
    "rejects inexact or floating money spelling %s",
    (input) => expect(parseExactCents(input)).toBeNull(),
  )

  it("accepts only non-negative whole sats spelling", () => {
    expect(parseExactSats("100000000")).toBe(100_000_000n)
    expect(parseExactSats("-1")).toBeNull()
    expect(parseExactSats("0.1")).toBeNull()
    expect(parseExactSats("1e8")).toBeNull()
  })

  it("requires remote origin, bridge, capability, usable rows, owner scope, and current month", () => {
    const base = {
      dataOrigin: "remote" as const,
      bridgeAvailable: true,
      capabilities: ["budgetCategory.upsert"] as const,
      kind: "budgetCategory.upsert" as const,
      actor: "victor" as const,
      owner: "victor" as const,
      freshness: "live",
      selectedMonth: "2026-07",
      persistedMonth: "2026-07",
    }
    expect(mutationGate(base)).toEqual({ allowed: true, reason: null })
    expect(mutationGate({ ...base, dataOrigin: "fixture" }).allowed).toBe(false)
    expect(mutationGate({ ...base, bridgeAvailable: false }).allowed).toBe(false)
    expect(mutationGate({ ...base, capabilities: [] }).allowed).toBe(false)
    expect(mutationGate({ ...base, freshness: "loading" }).allowed).toBe(false)
    expect(mutationGate({ ...base, actor: "mason", owner: "victor" }).allowed).toBe(false)
    expect(mutationGate({ ...base, selectedMonth: "2026-06" }).allowed).toBe(false)
  })
})
