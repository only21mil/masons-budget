// Closed payment-source list for the transaction form.
//
// Bound to shared/domain/fixtures/payment-source-cases.json. The wire string is
// the stable id and is what gets persisted; the display label is presentation
// only and never reaches a row. Fixture order is the picker order.
//
// Eight sources write a transaction row and set `card` to their wire value.
// River Bitcoin Bill Pay is not a transaction at all: it writes a btcBillPays
// row with platform "river_bitcoin_bill_pay", and the server debits the
// canonical River account inside that mutation. Nothing here fakes a card
// transaction for River.
//
// Rows the list does not recognise are never rewritten: an unknown or legacy
// `card` string round-trips verbatim through the form.

/** Wire values, persisted verbatim. Never store or match on the label. */
export type PaymentSource =
  | "river"
  | "zeus_lightning"
  | "zeus_on_chain"
  | "strike"
  | "coinbase_card"
  | "aven"
  | "sofi_card"
  | "capital_one_vx"
  | "river_bitcoin_bill_pay"

/** Display order is the product order and is not sorted or derived. */
export const PAYMENT_SOURCES: readonly PaymentSource[] = [
  "river",
  "zeus_lightning",
  "zeus_on_chain",
  "strike",
  "coinbase_card",
  "aven",
  "sofi_card",
  "capital_one_vx",
  "river_bitcoin_bill_pay",
]

export const PAYMENT_SOURCE_LABELS: Readonly<Record<PaymentSource, string>> = {
  river: "River",
  zeus_lightning: "Zeus Lightning",
  zeus_on_chain: "Zeus On-chain",
  strike: "Strike",
  coinbase_card: "Coinbase Card",
  aven: "Aven",
  sofi_card: "SoFi Card",
  capital_one_vx: "Capital One VX",
  river_bitcoin_bill_pay: "River Bitcoin Bill Pay",
}

/** Which table a source writes to. Only River Bitcoin Bill Pay leaves transactions. */
export type PaymentSourceRoute = "transaction" | "billPay"
export type PaymentSourceClassification = "bitcoin_native" | "fiat_card" | "bill_pay"
export type PaymentSourceActivity = "spend" | "income" | "transfer" | "btc_bill_pay"

interface PaymentSourceMapping {
  readonly route: PaymentSourceRoute
  readonly classification: PaymentSourceClassification
  readonly supportedActivities: readonly PaymentSourceActivity[]
}

// CONTRACT NOTE binding: this table is the only place a source's row route and
// BTC field requirements are decided.
const PAYMENT_SOURCE_MAPPING: Readonly<Record<PaymentSource, PaymentSourceMapping>> = {
  river: {
    route: "transaction",
    classification: "bitcoin_native",
    supportedActivities: ["spend", "income", "transfer"],
  },
  zeus_lightning: {
    route: "transaction",
    classification: "bitcoin_native",
    supportedActivities: ["spend", "income", "transfer"],
  },
  zeus_on_chain: {
    route: "transaction",
    classification: "bitcoin_native",
    supportedActivities: ["spend", "income", "transfer"],
  },
  strike: {
    route: "transaction",
    classification: "bitcoin_native",
    supportedActivities: ["spend", "income", "transfer"],
  },
  coinbase_card: {
    route: "transaction",
    classification: "fiat_card",
    supportedActivities: ["spend"],
  },
  aven: {
    route: "transaction",
    classification: "fiat_card",
    supportedActivities: ["spend"],
  },
  sofi_card: {
    route: "transaction",
    classification: "fiat_card",
    supportedActivities: ["spend"],
  },
  capital_one_vx: {
    route: "transaction",
    classification: "fiat_card",
    supportedActivities: ["spend"],
  },
  river_bitcoin_bill_pay: {
    route: "billPay",
    classification: "bill_pay",
    supportedActivities: ["btc_bill_pay"],
  },
}

/** Row fields a source drives, discriminated by the table it writes to. */
export type PaymentSourceRowFields =
  | {
      readonly route: "transaction"
      readonly card: PaymentSource
      readonly amountSats?: bigint
      readonly bitcoinAccountKey?: string
    }
  | {
      readonly route: "billPay"
      readonly platform: "river_bitcoin_bill_pay"
      readonly btcSpentSats?: bigint
    }

export function paymentSourceLabel(source: PaymentSource): string {
  return PAYMENT_SOURCE_LABELS[source]
}

export function isPaymentSource(value: unknown): value is PaymentSource {
  return typeof value === "string" && Object.hasOwn(PAYMENT_SOURCE_MAPPING, value)
}

export function isRetiredBitcoinSource(value: unknown): value is "lightning" | "on_chain" {
  return value === "lightning" || value === "on_chain"
}

/** True when the source posts Bitcoin and therefore needs exact sats. */
export function isBitcoinDenominatedSource(source: PaymentSource): boolean {
  return PAYMENT_SOURCE_MAPPING[source].classification !== "fiat_card"
}

export function paymentSourceRoute(source: PaymentSource): PaymentSourceRoute {
  return PAYMENT_SOURCE_MAPPING[source].route
}

export function paymentSourceClassification(source: PaymentSource): PaymentSourceClassification {
  return PAYMENT_SOURCE_MAPPING[source].classification
}

export function paymentSourceSupportedActivities(
  source: PaymentSource,
): readonly PaymentSourceActivity[] {
  return PAYMENT_SOURCE_MAPPING[source].supportedActivities
}

/** The source-choice state that owns the form's Bitcoin-only fields. */
export interface PaymentSourceChoiceState {
  readonly sourceChoice: string
  readonly sats: string
  readonly bitcoinAccountKey: string
}

export interface StoredLegacyPaymentSource {
  /** The select value representing this stored legacy row. */
  readonly choice: string
  /** The exact stored card string, before any picker transition. */
  readonly card?: string | null
  readonly amountSats?: bigint | null
  readonly bitcoinAccountKey?: string | null
}

/** Apply a payment-source select transition to the form's source fields. */
export function paymentSourceChoiceTransition(
  state: PaymentSourceChoiceState,
  next: string,
  storedLegacy?: StoredLegacyPaymentSource,
): PaymentSourceChoiceState {
  if (
    storedLegacy !== undefined &&
    next === storedLegacy.choice &&
    isRetiredBitcoinSource(storedLegacy.card)
  ) {
    return {
      sourceChoice: next,
      // Restore the posting that came from the row, not values typed for the
      // source the user is leaving. Convex will compare these exact fields.
      sats: storedLegacy.amountSats?.toString() ?? "",
      bitcoinAccountKey: storedLegacy.bitcoinAccountKey ?? "",
    }
  }
  const nextSource = isPaymentSource(next) ? next : null
  const keepsBitcoinFields = nextSource !== null &&
    isBitcoinDenominatedSource(nextSource) &&
    paymentSourceRoute(nextSource) === "transaction"
  return {
    sourceChoice: next,
    sats: keepsBitcoinFields ? state.sats : "",
    bitcoinAccountKey: keepsBitcoinFields ? state.bitcoinAccountKey : "",
  }
}

/**
 * Project a chosen source onto the fields of the row it writes.
 *
 * `amountSats` and `bitcoinAccountKey` are emitted only for BTC-denominated
 * sources and only when the caller supplies them; the form refuses to submit
 * those sources without both, so a gap here is an upstream programming error
 * rather than a silently zero-sat spend.
 */
export function paymentSourceToRowFields(
  source: PaymentSource,
  options: {
    readonly amountSats?: bigint | null
    readonly bitcoinAccountKey?: string | null
  } = {},
): PaymentSourceRowFields {
  const mapping = PAYMENT_SOURCE_MAPPING[source]
  const sats = options.amountSats ?? null
  const positiveSats = sats !== null && sats > 0n ? sats : null
  if (mapping.route === "billPay") {
    return {
      route: "billPay",
      platform: "river_bitcoin_bill_pay",
      ...(positiveSats === null ? {} : { btcSpentSats: positiveSats }),
    }
  }
  const accountKey = options.bitcoinAccountKey?.trim() ?? ""
  return {
    route: "transaction",
    card: source,
    ...(mapping.classification === "bitcoin_native" && positiveSats !== null
      ? { amountSats: positiveSats }
      : {}),
    ...(mapping.classification === "bitcoin_native" && accountKey
      ? { bitcoinAccountKey: accountKey }
      : {}),
  }
}

/**
 * Recover the source from a stored row, transaction or bill pay.
 *
 * `platform` identifies a River bill pay; `card` identifies the eight transaction
 * sources and is matched against the wire value, never the label. Anything else
 * — including every legacy card string — is not one of ours and returns null so
 * callers preserve it untouched.
 */
export function paymentSourceFromRow(row: {
  readonly card?: string | null
  readonly platform?: string | null
}): PaymentSource | null {
  // Classification matches the RAW stored string. Trimming decides only whether
  // a value is present at all: " coinbase_card " is text some other writer put
  // there, not our wire value, and treating it as ours would silently rewrite
  // the row on the next save.
  const platform = row.platform ?? ""
  if (platform.trim()) return isPaymentSource(platform) ? platform : null
  const card = row.card ?? ""
  if (!card.trim() || !isPaymentSource(card)) return null
  return card
}

/** What the transaction form knows about the source the user picked. */
export interface PaymentSourceSelection {
  readonly source: PaymentSource | null
  /** A stored card string the list does not know, kept verbatim. */
  readonly legacyCard?: string
  readonly amountSats?: bigint | null
  readonly bitcoinAccountKey?: string | null
  /** The transaction direction. Bitcoin-native sources support spend and Income. */
  readonly kind?: "spend" | "credit"
  /** The row's category. Only "Income" changes what a source may be. */
  readonly category?: string
}

/** The category that receives Bitcoin rather than spending it. */
export const INCOME_CATEGORY = "Income"

/**
 * Why this selection may not be saved as a transaction, or null when it may.
 *
 * River is refused outright: it belongs in btcBillPays, and writing a card
 * transaction for it would record the spend without debiting River.
 */
export function paymentSourceBlockReason(selection: PaymentSourceSelection): string | null {
  const source = selection.source
  const category = selection.category?.trim() ?? ""
  if (source === null) {
    const legacy = selection.legacyCard ?? ""
    if (!isRetiredBitcoinSource(legacy)) return null
    if (selection.kind !== "spend" || category === INCOME_CATEGORY) {
      return `${legacy} is retired and may only preserve an existing Bitcoin spend.`
    }
    const sats = selection.amountSats ?? null
    if (sats === null || sats <= 0n) {
      return `${legacy} is retired. Restore its exact positive sats amount before saving.`
    }
    if (!selection.bitcoinAccountKey?.trim()) {
      return `${legacy} is retired. Restore its exact Bitcoin account before saving.`
    }
    return null
  }
  if (paymentSourceRoute(source) === "billPay") {
    return `${paymentSourceLabel(source)} is recorded on the Bills page so the River balance ` +
      "is debited. Add it there instead of as a transaction."
  }
  const isSpend = selection.kind === "spend" && category !== INCOME_CATEGORY
  const isIncome = selection.kind === "credit" && category === INCOME_CATEGORY
  const classification = paymentSourceClassification(source)
  // A fiat card is metadata on the base transaction shape. Its direction and
  // category follow that base contract; only Bitcoin posting fields are barred.
  if (classification === "fiat_card") return null
  if (!isSpend && !isIncome) {
    return `${paymentSourceLabel(source)} requires a spend outside Income or a credit in Income.`
  }
  const sats = selection.amountSats ?? null
  if (sats === null || sats <= 0n) {
    return `${paymentSourceLabel(source)} posts Bitcoin. Enter the exact sats amount.`
  }
  if (!selection.bitcoinAccountKey?.trim()) {
    const direction = isIncome ? "enters" : "leaves"
    return `${paymentSourceLabel(source)} posts Bitcoin. Choose the account it ${direction}.`
  }
  return null
}

/**
 * Transaction-row fields a selection contributes.
 *
 * No source and no legacy string means the row carries no card at all. A
 * selection the block reason rejects contributes nothing, so a caller that
 * ignores the block never writes a half-formed BTC row.
 */
export function transactionSourceFields(selection: PaymentSourceSelection): {
  readonly card?: string
  readonly amountSats?: bigint
  readonly bitcoinAccountKey?: string
} {
  const source = selection.source
  if (source === null) {
    // Verbatim, not trimmed: the stored string is round-tripped exactly as it
    // was found. Trimming only answers "is there one at all".
    const legacy = selection.legacyCard ?? ""
    return legacy.trim() ? { card: legacy } : {}
  }
  if (paymentSourceBlockReason(selection) !== null) return {}
  const fields = paymentSourceToRowFields(source, {
    amountSats: selection.amountSats,
    bitcoinAccountKey: selection.bitcoinAccountKey,
  })
  if (fields.route === "billPay") return {}
  return {
    card: fields.card,
    ...(fields.amountSats === undefined ? {} : { amountSats: fields.amountSats }),
    ...(fields.bitcoinAccountKey === undefined
      ? {}
      : { bitcoinAccountKey: fields.bitcoinAccountKey }),
  }
}

/** Label for a table cell: a known source, else the row's own text verbatim. */
export function paymentSourceDisplay(row: {
  readonly card?: string | null
  readonly platform?: string | null
}): string | null {
  const source = paymentSourceFromRow(row)
  if (source) return paymentSourceLabel(source)
  const card = row.card ?? ""
  return card.trim() ? card : null
}

/** The whole transaction form, as far as the row's source fields are concerned. */
export interface TransactionFormState extends PaymentSourceSelection {
  /** Raw category text. Only "Income" enables the sat-denominated fallback. */
  readonly category: string
}

/** Transaction-row fields the form submits for its current state. */
export interface TransactionSubmissionFields {
  readonly card?: string
  readonly amountSats?: bigint
  readonly bitcoinAccountKey?: string
}

/**
 * Build the source fields of a transaction the form is about to save.
 *
 * This is the whole rule, in one place, so the dialog cannot assemble a
 * payload the block reason never saw:
 *
 * - A chosen source owns every source field. A fiat card therefore carries a
 *   card and nothing else, even when the sats field still holds a value typed
 *   for a Bitcoin source the user has since switched away from. Re-attaching
 *   those sats as Income sats is how a card row grew a Bitcoin balance posting
 *   nobody asked for.
 * - With no chosen source the sat-denominated Income row keeps its existing
 *   shape: sats only, never a Bitcoin account, and only on Income. A preserved
 *   legacy card string rides along verbatim and does not disturb that.
 */
export function transactionSubmission(
  state: TransactionFormState,
): TransactionSubmissionFields {
  if (state.source !== null) return transactionSourceFields(state)
  const legacy = state.legacyCard ?? ""
  const sats = state.amountSats ?? null
  const accountKey = state.bitcoinAccountKey ?? ""
  // The retired wires are not selectable, but an untouched stored posting must
  // still carry its exact source and posting fields back to Convex. Convex owns
  // the existing-row comparison and rejects new or changed legacy writes.
  const retiredBitcoinSource = isRetiredBitcoinSource(legacy)
  const retiredBitcoinPosting = retiredBitcoinSource &&
    sats !== null && sats > 0n && accountKey.trim() !== "" &&
    paymentSourceBlockReason(state) === null
  const satIncome = state.category.trim() === INCOME_CATEGORY && sats !== null && sats > 0n
  return {
    ...(legacy.trim() ? { card: legacy } : {}),
    ...(retiredBitcoinPosting
      ? { amountSats: sats, bitcoinAccountKey: accountKey }
      : satIncome
        ? { amountSats: sats }
        : {}),
  }
}
