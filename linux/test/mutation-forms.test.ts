import { describe, expect, it } from "vitest"

import {
  formatCentsInput,
  mutationOwner,
  mutationGate,
  parseExactCents,
  parseExactSats,
  supportsMutationOwner,
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

  it("rejects values outside Convex signed int64", () => {
    expect(parseExactCents("92233720368547758.07")).toBe(9_223_372_036_854_775_807n)
    expect(parseExactCents("92233720368547758.08")).toBeNull()
    expect(parseExactCents("-92233720368547758.08")).toBe(-9_223_372_036_854_775_808n)
    expect(parseExactCents("-92233720368547758.09")).toBeNull()
    expect(parseExactSats("9223372036854775807")).toBe(9_223_372_036_854_775_807n)
    expect(parseExactSats("9223372036854775808")).toBeNull()
  })

  it("keeps Rachel as actor while routing financial writes to Victor", () => {
    expect(mutationOwner("transaction.upsert", "rachel")).toBe("victor")
    expect(mutationOwner("btcBillPay.delete", "rachel")).toBe("victor")
    expect(mutationOwner("todo.upsert", "rachel")).toBe("rachel")
  })

  it("rejects financial operations that have no closed child source", () => {
    expect(supportsMutationOwner("transaction.upsert", "maddox")).toBe(true)
    expect(supportsMutationOwner("btcBuy.upsert", "mason")).toBe(true)
    expect(supportsMutationOwner("btcBuy.upsert", "maddox")).toBe(false)
    expect(supportsMutationOwner("btcBillPay.upsert", "mason")).toBe(false)
    expect(supportsMutationOwner("btcBillPay.delete", "maddox")).toBe(false)
    expect(supportsMutationOwner("btcAccount.upsert", "mason")).toBe(true)
    expect(supportsMutationOwner("btcAccount.upsert", "maddox")).toBe(false)
    expect(supportsMutationOwner("budgetCategory.upsert", "maddox")).toBe(false)
  })

  it("requires remote origin, bridge, capability, usable rows, owner scope, and current month", () => {
    const base = {
      dataOrigin: "remote" as const,
      bridgeAvailable: true,
      writesEnabled: true,
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
    expect(mutationGate({ ...base, writesEnabled: false }).allowed).toBe(false)
    expect(mutationGate({ ...base, capabilities: [] }).allowed).toBe(false)
    expect(mutationGate({ ...base, freshness: "loading" }).allowed).toBe(false)
    expect(mutationGate({ ...base, actor: "mason", owner: "victor" }).allowed).toBe(false)
    expect(mutationGate({ ...base, selectedMonth: "2026-06" }).allowed).toBe(false)
    expect(mutationGate({
      ...base,
      kind: "btcBillPay.upsert",
      capabilities: ["btcBillPay.upsert"],
      actor: "mason",
      owner: "mason",
    })).toEqual({
      allowed: false,
      reason: "This profile has no supported durable source for that operation.",
    })
  })
})
