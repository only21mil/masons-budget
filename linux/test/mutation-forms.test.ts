import { describe, expect, it } from "vitest"

import type { BTCBuy } from "@vogel-vault/domain/readModel"

import {
  type BitcoinBuyLinkInput,
  applyOptimisticMutation,
  bitcoinBuyLinkFor,
  formatCentsInput,
  linkedBitcoinBuyFor,
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
import { buildSanitizedFixtureEnvelope } from "../src/renderer/data/fixtures.ts"

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

describe("income recorded as a Bitcoin buy", () => {
  const base: BitcoinBuyLinkInput = {
    recordAsBitcoinBuy: true,
    requestId: "request_income_buy",
    id: "transaction-linked-01",
    actor: "victor",
    owner: "victor",
    date: "2026-08-03",
    category: "Income",
    amountCents: 250_000n,
    buySource: "River",
    incomeSource: "Employer",
    sats: 270_000n,
    priceUsdCents: 9_259_259_00n,
  }

  it("builds one buy carrying the income beside it, never a second sat-denominated row", () => {
    const link = bitcoinBuyLinkFor(base)
    expect(link).toEqual({
      kind: "btcBuy.upsert",
      requestId: "request_income_buy",
      actor: "victor",
      id: "transaction-linked-01",
      owner: "victor",
      date: "2026-08-03",
      // The buy names the account it credits; existing buy rows read that way.
      source: "River",
      sats: 270_000n,
      priceUsdCents: 9_259_259_00n,
      usdCents: 250_000n,
      linkedIncome: {
        id: "transaction-linked-01",
        owner: "victor",
        date: "2026-08-03",
        amountCents: 250_000n,
        // The income names the payer, as every other income row does.
        source: "Employer",
      },
    })
    // The server's equality requirements, restated where the payload is built.
    // Source is deliberately not among them.
    expect(link!.linkedIncome!.id).toBe(link!.id)
    expect(link!.linkedIncome!.owner).toBe(link!.owner)
    expect(link!.linkedIncome!.date).toBe(link!.date)
    expect(link!.linkedIncome!.amountCents).toBe(link!.usdCents)
    expect(link!.linkedIncome!.source).not.toBe(link!.source)
    expect(link).not.toHaveProperty("amountSats")
  })

  it("routes Rachel's linked income onto the canonical household owner", () => {
    const link = bitcoinBuyLinkFor({ ...base, actor: "rachel", owner: "rachel" })
    expect(link?.owner).toBe("victor")
    expect(link?.linkedIncome?.owner).toBe("victor")
    expect(link?.actor).toBe("rachel")
  })

  it("reuses one id across retries so an exact replay stays a no-op", () => {
    const first = bitcoinBuyLinkFor(base)
    const retry = bitcoinBuyLinkFor({ ...base, requestId: "request_income_buy_retry" })
    expect(retry?.id).toBe(first?.id)
    expect(retry?.linkedIncome?.id).toBe(first?.id)
  })

  it.each<[string, Partial<BitcoinBuyLinkInput>]>([
    ["the option is off", { recordAsBitcoinBuy: false }],
    ["the category is not Income", { category: "Groceries" }],
    ["the amount is not positive", { amountCents: 0n }],
    ["the sats are missing", { sats: null }],
    ["the sats are not positive", { sats: 0n }],
    ["the price is missing", { priceUsdCents: null }],
    ["the price is not positive", { priceUsdCents: 0n }],
    ["the buy source is blank", { buySource: "   " }],
    ["the income source is blank", { incomeSource: "   " }],
    ["the id is blank", { id: "" }],
    ["the date is blank", { date: "" }],
    ["this wave excludes the owner", { owner: "mason" }],
  ])("returns no link when %s", (_reason, overrides) => {
    expect(bitcoinBuyLinkFor({ ...base, ...overrides })).toBeNull()
  })

  it("marks the funded income row from the shared id alone", () => {
    const buy = { id: "transaction-linked-01", sats: 270_000n } as BTCBuy
    expect(linkedBitcoinBuyFor("transaction-linked-01", [buy])).toBe(buy)
    expect(linkedBitcoinBuyFor("transaction-other", [buy])).toBeNull()
  })

  it("shows both rows once optimistically, and replays without duplicating either", () => {
    const link = bitcoinBuyLinkFor(base)!
    const once = applyOptimisticMutation(buildSanitizedFixtureEnvelope("victor"), link)
    const twice = applyOptimisticMutation(once, link)

    for (const envelope of [once, twice]) {
      const buys = envelope.btcBuys.value.filter((row) => row.id === link.id)
      const income = envelope.income.value.filter((row) => row.id === link.id)
      expect(buys).toHaveLength(1)
      expect(income).toHaveLength(1)
      expect(buys[0]!.sats).toBe(270_000n)
      expect(income[0]!.amount).toBe(250_000n)
      expect(income[0]!.month).toBe("2026-08")
    }
  })
})
