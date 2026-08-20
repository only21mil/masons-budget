import { describe, expect, it } from "vitest"

import {
  formatCentsInput,
  mutationOwner,
  mutationGate,
  parseExactCents,
  parseExactSats,
  supportsMutationOwner,
} from "../src/renderer/data/mutations.ts"
import {
  CREDIT_CARD_PAYMENT_CATEGORY,
  billPayBudgetTreatmentFor,
  decodeBillPayBudgetEffect,
} from "../src/renderer/data/billPayBudgetEffect.ts"

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

  it("treats an authoritative empty remote table as a usable base for the first row", () => {
    const base = {
      dataOrigin: "remote" as const,
      bridgeAvailable: true,
      writesEnabled: true,
      capabilities: ["btcBillPay.upsert"] as const,
      kind: "btcBillPay.upsert" as const,
      actor: "rachel" as const,
      owner: "victor" as const,
      freshness: "empty",
    }
    expect(mutationGate(base)).toEqual({ allowed: true, reason: null })
    expect(mutationGate({
      ...base,
      kind: "btcBuy.upsert",
      capabilities: ["btcBuy.upsert"],
    })).toEqual({ allowed: true, reason: null })

    // Only a read that never produced current rows still blocks editing.
    for (const freshness of ["loading", "error"]) {
      expect(mutationGate({ ...base, freshness })).toEqual({
        allowed: false,
        reason: "Wait for current remote rows before editing.",
      })
    }
  })

  // Every slice below reports "empty" at zero remote rows (convexRows.ts passes
  // `rows.length > 0`, or a null document, to populatedSlice), so each one used
  // to make its own first row unreachable. transactions and btcTransfers always
  // report "live" on a successful read and were never affected.
  it.each([
    ["billPays", "btcBillPay.upsert", "btcBillPay.delete"],
    ["btcBuys", "btcBuy.upsert", "btcBuy.delete"],
    ["todos", "todo.upsert", "todo.delete"],
    ["budget", "budgetCategory.upsert", "budgetCategory.delete"],
    ["btcBalanceDocument", "btcAccount.upsert", "btcAccount.delete"],
    ["btcBalanceDocument via transfers", "btcTransfer.upsert", "btcTransfer.delete"],
  ] as const)(
    "%s: an empty-but-live slice allows a first row while loading and error still block",
    (_slice, upsertKind, deleteKind) => {
      for (const kind of [upsertKind, deleteKind]) {
        const base = {
          dataOrigin: "remote" as const,
          bridgeAvailable: true,
          writesEnabled: true,
          capabilities: [kind],
          kind,
          actor: "victor" as const,
          owner: "victor" as const,
          freshness: "empty",
          selectedMonth: "2026-07",
          persistedMonth: "2026-07",
        }
        expect(mutationGate(base)).toEqual({ allowed: true, reason: null })
        for (const freshness of ["loading", "error"]) {
          expect(mutationGate({ ...base, freshness })).toEqual({
            allowed: false,
            reason: "Wait for current remote rows before editing.",
          })
        }
      }
    },
  )
})

describe("bill-pay budget effect", () => {
  it("routes a budget-category payment to the chosen category", () => {
    expect(billPayBudgetTreatmentFor({
      budgetEffect: "budget_category",
      category: "  Utilities  ",
    })).toEqual({
      effect: "budget_category",
      category: "Utilities",
      categorySelectable: true,
      countsTowardBudget: true,
    })
  })

  it("pins a credit-card payment to its canonical category and zero budget spend", () => {
    expect(billPayBudgetTreatmentFor({
      budgetEffect: "credit_card_payment",
      category: "Utilities",
    })).toEqual({
      effect: "credit_card_payment",
      category: CREDIT_CARD_PAYMENT_CATEGORY,
      categorySelectable: false,
      countsTowardBudget: false,
    })
  })

  it("decodes a row written before the amendment as a credit-card payment", () => {
    expect(decodeBillPayBudgetEffect(undefined)).toBe("credit_card_payment")
    expect(decodeBillPayBudgetEffect(null)).toBe("credit_card_payment")
    expect(decodeBillPayBudgetEffect("nonsense")).toBe("credit_card_payment")
    expect(decodeBillPayBudgetEffect("credit_card_payment")).toBe("credit_card_payment")
    expect(decodeBillPayBudgetEffect("budget_category")).toBe("budget_category")
  })
})
