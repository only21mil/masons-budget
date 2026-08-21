import { describe, expect, it } from "vitest"

import {
  PAYMENT_SOURCES,
  isBitcoinDenominatedSource,
  isPaymentSource,
  paymentSourceBlockReason,
  paymentSourceChoiceTransition,
  paymentSourceDisplay,
  paymentSourceFromRow,
  paymentSourceLabel,
  paymentSourceRoute,
  paymentSourceToRowFields,
  transactionSourceFields,
  transactionSubmission,
  type PaymentSource,
} from "../src/renderer/data/paymentSource.ts"

const SATS = 125_000n
const ACCOUNT = "coldcard"

describe("payment source contract", () => {
  it("keeps the closed list, its order, and its display labels exact", () => {
    expect([...PAYMENT_SOURCES]).toEqual([
      "river_bitcoin_bill_pay",
      "coinbase_card",
      "aven",
      "sofi_card",
      "capital_one_vx",
      "lightning",
      "on_chain",
    ])
    expect(PAYMENT_SOURCES.map(paymentSourceLabel)).toEqual([
      "River Bitcoin Bill Pay",
      "Coinbase Card",
      "Aven",
      "SoFi Card",
      "Capital One VX",
      "Lightning",
      "On-chain",
    ])
  })

  it.each(PAYMENT_SOURCES)("round-trips %s through its row fields", (source) => {
    const fields = paymentSourceToRowFields(source, {
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
    })
    const recovered = fields.route === "billPay"
      ? paymentSourceFromRow({ platform: fields.platform })
      : paymentSourceFromRow({ card: fields.card })
    expect(recovered).toBe(source)
  })

  it("routes only River to the bill-pay table", () => {
    expect(paymentSourceRoute("river_bitcoin_bill_pay")).toBe("billPay")
    for (const source of PAYMENT_SOURCES.filter((s) => s !== "river_bitcoin_bill_pay")) {
      expect(paymentSourceRoute(source)).toBe("transaction")
    }
    expect(paymentSourceToRowFields("river_bitcoin_bill_pay", { amountSats: SATS })).toEqual({
      route: "billPay",
      platform: "river_bitcoin_bill_pay",
      btcSpentSats: SATS,
    })
  })

  it.each(["coinbase_card", "aven", "sofi_card", "capital_one_vx"] as const)(
    "maps the fiat card %s onto card alone",
    (source: PaymentSource) => {
      expect(isBitcoinDenominatedSource(source)).toBe(false)
      expect(
        paymentSourceToRowFields(source, { amountSats: SATS, bitcoinAccountKey: ACCOUNT }),
      ).toEqual({ route: "transaction", card: source })
    },
  )

  it.each(["lightning", "on_chain"] as const)(
    "maps the Bitcoin spend %s onto card, sats, and account",
    (source: PaymentSource) => {
      expect(isBitcoinDenominatedSource(source)).toBe(true)
      expect(
        paymentSourceToRowFields(source, { amountSats: SATS, bitcoinAccountKey: ACCOUNT }),
      ).toEqual({
        route: "transaction",
        card: source,
        amountSats: SATS,
        bitcoinAccountKey: ACCOUNT,
      })
    },
  )

  it("never recognises a display label as a stored value", () => {
    expect(isPaymentSource("On-chain")).toBe(false)
    expect(paymentSourceFromRow({ card: "River Bitcoin Bill Pay" })).toBeNull()
  })

  it("leaves an unknown legacy card string untouched", () => {
    expect(paymentSourceFromRow({ card: "Debit" })).toBeNull()
    expect(paymentSourceFromRow({ card: null })).toBeNull()
    expect(transactionSourceFields({ source: null, legacyCard: "Debit" })).toEqual({
      card: "Debit",
    })
    expect(transactionSourceFields({ source: null, legacyCard: "" })).toEqual({})
  })
})

describe("payment source submission payloads", () => {
  it("submits a fiat card as card only", () => {
    const selection = { source: "coinbase_card" as const, amountSats: null }
    expect(paymentSourceBlockReason(selection)).toBeNull()
    expect(transactionSourceFields(selection)).toEqual({ card: "coinbase_card" })
  })

  it("refuses River as a transaction and points at Bills", () => {
    const selection = {
      source: "river_bitcoin_bill_pay" as const,
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
    }
    expect(paymentSourceBlockReason(selection)).toMatch(/Bills page/)
    expect(transactionSourceFields(selection)).toEqual({})
  })

  it("submits an on-chain spend with exact sats and the chosen account", () => {
    const selection = {
      source: "on_chain" as const,
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      kind: "spend" as const,
    }
    expect(paymentSourceBlockReason(selection)).toBeNull()
    expect(transactionSourceFields(selection)).toEqual({
      card: "on_chain",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
    })
  })

  it("blocks a Bitcoin spend that is missing sats or an account", () => {
    expect(
      paymentSourceBlockReason({ source: "lightning", bitcoinAccountKey: ACCOUNT, kind: "spend" }),
    ).toMatch(/exact sats/)
    expect(
      paymentSourceBlockReason({
        source: "lightning",
        amountSats: 0n,
        bitcoinAccountKey: ACCOUNT,
        kind: "spend",
      }),
    ).toMatch(/exact sats/)
    expect(
      paymentSourceBlockReason({ source: "on_chain", amountSats: SATS, kind: "spend" }),
    ).toMatch(/account it leaves/)
    expect(
      paymentSourceBlockReason({
        source: "on_chain",
        amountSats: SATS,
        bitcoinAccountKey: " ",
        kind: "spend",
      }),
    ).toMatch(/account it leaves/)
  })

  it("contributes nothing for a blocked Bitcoin spend", () => {
    expect(transactionSourceFields({ source: "lightning", amountSats: null, kind: "spend" }))
      .toEqual({})
  })
})

describe("payment source display", () => {
  it("renders the label for a stored wire value", () => {
    expect(paymentSourceDisplay({ card: "capital_one_vx" })).toBe("Capital One VX")
    expect(paymentSourceDisplay({ card: "lightning" })).toBe("Lightning")
    expect(paymentSourceDisplay({ platform: "river_bitcoin_bill_pay" })).toBe(
      "River Bitcoin Bill Pay",
    )
  })

  it("renders an unknown legacy card verbatim and an absent one as nothing", () => {
    expect(paymentSourceDisplay({ card: "Debit" })).toBe("Debit")
    expect(paymentSourceDisplay({ card: null })).toBeNull()
    expect(paymentSourceDisplay({ card: "  " })).toBeNull()
  })
})

// Classification reads the RAW stored string; trimming decides only emptiness.
// A padded wire value belongs to whoever wrote it, and normalising it here would
// silently rewrite their row the next time the form saved.
describe("legacy card strings, whitespace and all", () => {
  it("never classifies a padded wire value as one of ours", () => {
    expect(isPaymentSource(" coinbase_card ")).toBe(false)
    expect(paymentSourceFromRow({ card: " coinbase_card " })).toBeNull()
    expect(paymentSourceFromRow({ platform: " river_bitcoin_bill_pay " })).toBeNull()
  })

  it("round-trips a padded legacy string byte for byte", () => {
    expect(transactionSourceFields({ source: null, legacyCard: " Debit " })).toEqual({
      card: " Debit ",
    })
    expect(transactionSourceFields({ source: null, legacyCard: " coinbase_card " })).toEqual({
      card: " coinbase_card ",
    })
    expect(paymentSourceDisplay({ card: " Debit " })).toBe(" Debit ")
    expect(paymentSourceDisplay({ card: " coinbase_card " })).toBe(" coinbase_card ")
  })

  it("still treats whitespace alone as no card at all", () => {
    expect(transactionSourceFields({ source: null, legacyCard: "   " })).toEqual({})
    expect(paymentSourceFromRow({ card: "   " })).toBeNull()
  })
})

describe("Income and Bitcoin-denominated sources", () => {
  it.each(["lightning", "on_chain"] as const)(
    "refuses %s on an Income row and says what to do instead",
    (source: PaymentSource) => {
      const reason = paymentSourceBlockReason({
        source,
        amountSats: SATS,
        bitcoinAccountKey: ACCOUNT,
        kind: "credit",
        category: "Income",
      })
      expect(reason).toBe(
        "Income cannot use a Bitcoin payment source; record a Bitcoin buy instead.",
      )
      expect(transactionSourceFields({
        source,
        amountSats: SATS,
        bitcoinAccountKey: ACCOUNT,
        kind: "credit",
        category: "Income",
      })).toEqual({})
    },
  )

  it("leaves a Bitcoin spend on any other category alone", () => {
    expect(paymentSourceBlockReason({
      source: "lightning",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      kind: "spend",
      category: "Groceries",
    })).toBeNull()
  })

  it("leaves a fiat card on Income alone", () => {
    expect(paymentSourceBlockReason({
      source: "coinbase_card",
      category: "Income",
    })).toBeNull()
  })

  it.each(["lightning", "on_chain"] as const)(
    "refuses %s on a credit or refund",
    (source: PaymentSource) => {
      const selection = {
        source,
        amountSats: SATS,
        bitcoinAccountKey: ACCOUNT,
        kind: "credit" as const,
        category: "Groceries",
      }
      expect(paymentSourceBlockReason(selection)).toBe(
        `${paymentSourceLabel(source)} can only be used on a spending transaction.`,
      )
      expect(transactionSourceFields(selection)).toEqual({})
    },
  )
})

describe("the transaction submission payload builder", () => {
  it("drops sats and the account when Lightning gives way to a fiat card", () => {
    const lightning = {
      source: "lightning" as const,
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      kind: "spend" as const,
      category: "Groceries",
    }
    expect(transactionSubmission(lightning)).toEqual({
      card: "lightning",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
    })
    // The retained state is exactly what the form still holds mid-switch.
    expect(transactionSubmission({ ...lightning, source: "coinbase_card" })).toEqual({
      card: "coinbase_card",
    })
  })

  it("submits Income on a fiat card as the card alone", () => {
    expect(transactionSubmission({
      source: "coinbase_card",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      category: "Income",
    })).toEqual({ card: "coinbase_card" })
  })

  it("keeps the optional sat-Income row when no source is chosen", () => {
    expect(transactionSubmission({ source: null, amountSats: SATS, category: "Income" }))
      .toEqual({ amountSats: SATS })
    expect(transactionSubmission({ source: null, amountSats: null, category: "Income" }))
      .toEqual({})
    // Sats outside Income are not a payload the form may build.
    expect(transactionSubmission({ source: null, amountSats: SATS, category: "Groceries" }))
      .toEqual({})
    // And they never drag a Bitcoin account along.
    expect(transactionSubmission({
      source: null,
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      category: "Income",
    })).toEqual({ amountSats: SATS })
  })

  it("preserves a legacy card beside the sat-Income behaviour", () => {
    expect(transactionSubmission({
      source: null,
      legacyCard: " Debit ",
      amountSats: SATS,
      category: "Income",
    })).toEqual({ card: " Debit ", amountSats: SATS })
  })

  it("submits nothing for a source the block reason refuses", () => {
    expect(transactionSubmission({
      source: "river_bitcoin_bill_pay",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      category: "Utilities",
    })).toEqual({})
    expect(transactionSubmission({
      source: "on_chain",
      amountSats: SATS,
      category: "Utilities",
    })).toEqual({})
  })
})

describe("payment source transitions", () => {
  it.each([
    ["No source", ""],
    ["the preserved legacy option", "__legacy-card"],
  ] as const)(
    "clears Bitcoin-only state when Lightning gives way to %s",
    (_label, next) => {
      expect(paymentSourceChoiceTransition({
        sourceChoice: "lightning",
        sats: SATS.toString(),
        bitcoinAccountKey: ACCOUNT,
      }, next)).toEqual({
        sourceChoice: next,
        sats: "",
        bitcoinAccountKey: "",
      })
    },
  )
})
