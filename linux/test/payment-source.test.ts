import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import {
  PAYMENT_SOURCES,
  isBitcoinDenominatedSource,
  isPaymentSource,
  isRetiredBitcoinSource,
  paymentSourceBlockReason,
  paymentSourceChoiceTransition,
  paymentSourceClassification,
  paymentSourceDisplay,
  paymentSourceFromRow,
  paymentSourceLabel,
  paymentSourceRoute,
  paymentSourceSupportedActivities,
  paymentSourceToRowFields,
  transactionSourceFields,
  transactionSubmission,
  type PaymentSource,
} from "../src/renderer/data/paymentSource.ts"

const SATS = 125_000n
const ACCOUNT = "coldcard"
const paymentSourceFixture = JSON.parse(
  readFileSync(
    new URL("../../shared/domain/fixtures/payment-source-cases.json", import.meta.url),
    "utf8",
  ),
) as {
  sources: Array<{
    wire: string
    label: string
    route: "transaction" | "btc_bill_pay"
    classification: "bitcoin_native" | "fiat_card" | "bill_pay"
    supportedActivities: string[]
  }>
}

describe("payment source contract", () => {
  it("matches the shared fixture in canonical picker order", () => {
    expect(PAYMENT_SOURCES.map((source) => ({
      wire: source,
      label: paymentSourceLabel(source),
      route: paymentSourceRoute(source) === "billPay" ? "btc_bill_pay" : "transaction",
      classification: paymentSourceClassification(source),
      supportedActivities: [...paymentSourceSupportedActivities(source)],
    }))).toEqual(paymentSourceFixture.sources)
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

  it.each(["river", "zeus_lightning", "zeus_on_chain", "strike"] as const)(
    "maps the Bitcoin-native source %s onto card, sats, and account",
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
    expect(isPaymentSource("Zeus On-chain")).toBe(false)
    expect(paymentSourceFromRow({ card: "River Bitcoin Bill Pay" })).toBeNull()
  })

  it.each(["lightning", "on_chain"])(
    "keeps retired %s non-selectable while recognising it as legacy stored text",
    (source) => {
      expect(PAYMENT_SOURCES).not.toContain(source)
      expect(isPaymentSource(source)).toBe(false)
      expect(isRetiredBitcoinSource(source)).toBe(true)
      expect(paymentSourceFromRow({ card: source })).toBeNull()
      expect(paymentSourceDisplay({ card: source })).toBe(source)
    },
  )

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
    const selection = {
      source: "coinbase_card" as const,
      amountSats: null,
      kind: "spend" as const,
      category: "Shopping",
    }
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

  it("submits a Zeus on-chain spend with exact sats and the chosen account", () => {
    const selection = {
      source: "zeus_on_chain" as const,
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      kind: "spend" as const,
      category: "Shopping",
    }
    expect(paymentSourceBlockReason(selection)).toBeNull()
    expect(transactionSourceFields(selection)).toEqual({
      card: "zeus_on_chain",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
    })
  })

  it("blocks a Bitcoin spend that is missing sats or an account", () => {
    expect(
      paymentSourceBlockReason({
        source: "zeus_lightning",
        bitcoinAccountKey: ACCOUNT,
        kind: "spend",
        category: "Shopping",
      }),
    ).toMatch(/exact sats/)
    expect(
      paymentSourceBlockReason({
        source: "zeus_lightning",
        amountSats: 0n,
        bitcoinAccountKey: ACCOUNT,
        kind: "spend",
        category: "Shopping",
      }),
    ).toMatch(/exact sats/)
    expect(
      paymentSourceBlockReason({
        source: "zeus_on_chain",
        amountSats: SATS,
        kind: "spend",
        category: "Shopping",
      }),
    ).toMatch(/account it leaves/)
    expect(
      paymentSourceBlockReason({
        source: "zeus_on_chain",
        amountSats: SATS,
        bitcoinAccountKey: " ",
        kind: "spend",
        category: "Shopping",
      }),
    ).toMatch(/account it leaves/)
  })

  it("contributes nothing for a blocked Bitcoin spend", () => {
    expect(transactionSourceFields({
      source: "zeus_lightning",
      amountSats: null,
      kind: "spend",
      category: "Shopping",
    })).toEqual({})
  })
})

describe("payment source display", () => {
  it("renders the label for a stored wire value", () => {
    expect(paymentSourceDisplay({ card: "capital_one_vx" })).toBe("Capital One VX")
    expect(paymentSourceDisplay({ card: "zeus_lightning" })).toBe("Zeus Lightning")
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

describe("direction and Bitcoin-native sources", () => {
  it.each(["river", "zeus_lightning", "zeus_on_chain", "strike"] as const)(
    "credits %s Income into the selected account",
    (source: PaymentSource) => {
      const selection = {
        source,
        amountSats: SATS,
        bitcoinAccountKey: ACCOUNT,
        kind: "credit",
        category: "Income",
      } as const
      expect(paymentSourceBlockReason(selection)).toBeNull()
      expect(transactionSourceFields(selection)).toEqual({
        card: source,
        amountSats: SATS,
        bitcoinAccountKey: ACCOUNT,
      })
    },
  )

  it("leaves a Bitcoin spend on any other category alone", () => {
    expect(paymentSourceBlockReason({
      source: "zeus_lightning",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      kind: "spend",
      category: "Groceries",
    })).toBeNull()
  })

  it("requires positive sats and the receiving account for Bitcoin-native Income", () => {
    expect(paymentSourceBlockReason({
      source: "strike",
      bitcoinAccountKey: ACCOUNT,
      kind: "credit",
      category: "Income",
    })).toMatch(/exact sats/)
    expect(paymentSourceBlockReason({
      source: "strike",
      amountSats: SATS,
      kind: "credit",
      category: "Income",
    })).toMatch(/account it enters/)
  })

  it("allows fiat-card spend and refund but blocks Income", () => {
    expect(paymentSourceBlockReason({
      source: "coinbase_card",
      kind: "spend",
      category: "Shopping",
    })).toBeNull()
    expect(paymentSourceBlockReason({
      source: "coinbase_card",
      kind: "credit",
      category: "Shopping",
    })).toBeNull()
    expect(paymentSourceBlockReason({
      source: "coinbase_card",
      kind: "credit",
      category: "Income",
    })).toBe("Coinbase Card supports Spend only.")
  })

  it("blocks malformed or direction-changed retired Bitcoin postings", () => {
    expect(paymentSourceBlockReason({
      source: null,
      legacyCard: "lightning",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      kind: "credit",
      category: "Shopping",
    })).toMatch(/only preserve an existing Bitcoin spend/)
    expect(paymentSourceBlockReason({
      source: null,
      legacyCard: "lightning",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      kind: "credit",
      category: "Income",
    })).toMatch(/only preserve an existing Bitcoin spend/)
    expect(paymentSourceBlockReason({
      source: null,
      legacyCard: "on_chain",
      bitcoinAccountKey: ACCOUNT,
      kind: "spend",
      category: "Shopping",
    })).toMatch(/exact positive sats amount/)
    expect(paymentSourceBlockReason({
      source: null,
      legacyCard: "on_chain",
      amountSats: SATS,
      kind: "spend",
      category: "Shopping",
    })).toMatch(/exact Bitcoin account/)
  })

  it.each(["zeus_lightning", "zeus_on_chain"] as const)(
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
        `${paymentSourceLabel(source)} requires a spend outside Income or a credit in Income.`,
      )
      expect(transactionSourceFields(selection)).toEqual({})
    },
  )
})

describe("the transaction submission payload builder", () => {
  it("drops sats and the account when Zeus Lightning gives way to a fiat card", () => {
    const lightning = {
      source: "zeus_lightning" as const,
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      kind: "spend" as const,
      category: "Groceries",
    }
    expect(transactionSubmission(lightning)).toEqual({
      card: "zeus_lightning",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
    })
    // The retained state is exactly what the form still holds mid-switch.
    expect(transactionSubmission({ ...lightning, source: "coinbase_card" })).toEqual({
      card: "coinbase_card",
    })
  })

  it("blocks Income on a spend-only fiat card", () => {
    const state = {
      source: "coinbase_card" as const,
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      kind: "credit" as const,
      category: "Income",
    }
    expect(paymentSourceBlockReason(state)).toBe("Coinbase Card supports Spend only.")
    expect(transactionSubmission(state)).toEqual({})
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

  it.each(["lightning", "on_chain"] as const)(
    "round-trips an existing retired %s posting without making it selectable",
    (legacyCard) => {
      const storedAccountKey = " stored-account-key "
      expect(transactionSubmission({
        source: null,
        legacyCard,
        amountSats: SATS,
        bitcoinAccountKey: storedAccountKey,
        kind: "spend",
        category: "Shopping",
      })).toEqual({
        card: legacyCard,
        amountSats: SATS,
        bitcoinAccountKey: storedAccountKey,
      })
      expect(isPaymentSource(legacyCard)).toBe(false)
    },
  )

  it("submits nothing for a source the block reason refuses", () => {
    expect(transactionSubmission({
      source: "river_bitcoin_bill_pay",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      category: "Utilities",
    })).toEqual({})
    expect(transactionSubmission({
      source: "zeus_on_chain",
      amountSats: SATS,
      kind: "spend",
      category: "Utilities",
    })).toEqual({})
    expect(transactionSubmission({
      source: null,
      legacyCard: "lightning",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
      kind: "credit",
      category: "Shopping",
    })).toEqual({ card: "lightning" })
  })
})

describe("payment source transitions", () => {
  it.each([
    ["No source", ""],
    ["the preserved legacy option", "__legacy-card"],
  ] as const)(
    "clears Bitcoin-only state when Zeus Lightning gives way to %s",
    (_label, next) => {
      expect(paymentSourceChoiceTransition({
        sourceChoice: "zeus_lightning",
        sats: SATS.toString(),
        bitcoinAccountKey: ACCOUNT,
      }, next)).toEqual({
        sourceChoice: next,
        sats: "",
        bitcoinAccountKey: "",
      })
    },
  )

  it.each(["lightning", "on_chain"] as const)(
    "restores the exact stored %s posting when its legacy option is reselected",
    (card) => {
      expect(paymentSourceChoiceTransition({
        sourceChoice: "zeus_lightning",
        sats: "999999",
        bitcoinAccountKey: "new-account",
      }, "__legacy-card", {
        choice: "__legacy-card",
        card,
        amountSats: SATS,
        bitcoinAccountKey: " stored-account ",
      })).toEqual({
        sourceChoice: "__legacy-card",
        sats: SATS.toString(),
        bitcoinAccountKey: " stored-account ",
      })
    },
  )
})
