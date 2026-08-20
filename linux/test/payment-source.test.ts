import { describe, expect, it } from "vitest"

import {
  PAYMENT_SOURCES,
  isBitcoinDenominatedSource,
  isPaymentSource,
  paymentSourceBlockReason,
  paymentSourceDisplay,
  paymentSourceFromRow,
  paymentSourceLabel,
  paymentSourceRoute,
  paymentSourceToRowFields,
  transactionSourceFields,
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
      paymentSourceBlockReason({ source: "lightning", bitcoinAccountKey: ACCOUNT }),
    ).toMatch(/exact sats/)
    expect(
      paymentSourceBlockReason({
        source: "lightning",
        amountSats: 0n,
        bitcoinAccountKey: ACCOUNT,
      }),
    ).toMatch(/exact sats/)
    expect(
      paymentSourceBlockReason({ source: "on_chain", amountSats: SATS }),
    ).toMatch(/account it leaves/)
    expect(
      paymentSourceBlockReason({ source: "on_chain", amountSats: SATS, bitcoinAccountKey: " " }),
    ).toMatch(/account it leaves/)
  })

  it("contributes nothing for a blocked Bitcoin spend", () => {
    expect(transactionSourceFields({ source: "lightning", amountSats: null })).toEqual({})
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
