// The Vogel Vault — shared Convex row-write contract.
//
// This module validates client intent before a real mutation reaches Convex.
// Convex independently enforces auth, wire shape, closed owners, and signs.
// Actor scope and transaction source/owner alignment are client-side policy
// until the mutation accepts actor identity and performs the same checks.
// Credentials are intentionally outside this contract: clients inject the sync
// token at runtime after building and validating the non-secret request body.

import { encodeConvexInt64, type ConvexInt64WireValue } from "./convexInt64.ts"
import {
  type FamilyMember,
  canSeeDataOwnedBy,
  isAdult,
  isFamilyMember,
  ledgerOwner,
  transactionsDataFileName,
} from "./family.ts"
import { isIsoDate } from "./todo.ts"

export const CONVEX_WRITE_FORMAT = "convex_encoded_json" as const
export const UPSERT_TRANSACTION_PATH = "tables:upsertTransaction" as const
export const UPSERT_BTC_BILL_PAY_PATH = "tables:upsertBtcBillPay" as const

export const PAYMENT_SOURCES = [
  "river_bitcoin_bill_pay",
  "coinbase_card",
  "aven",
  "sofi_card",
  "capital_one_vx",
  "lightning",
  "on_chain",
] as const

export type PaymentSource = (typeof PAYMENT_SOURCES)[number]
export type PaymentSourceRoute = "transaction" | "btc_bill_pay"

const BITCOIN_SPEND_SOURCES: ReadonlySet<PaymentSource> = new Set([
  "lightning",
  "on_chain",
])

export function isPaymentSource(value: unknown): value is PaymentSource {
  return typeof value === "string" && (PAYMENT_SOURCES as readonly string[]).includes(value)
}

export function paymentSourceRoute(source: PaymentSource): PaymentSourceRoute {
  return source === "river_bitcoin_bill_pay" ? "btc_bill_pay" : "transaction"
}

export type TransactionWriteKind = "spend" | "credit"
export const BTC_BILL_PAY_WRITE_BUDGET_EFFECTS = [
  "budget_category",
  "credit_card_payment",
] as const
export type BtcBillPayBudgetEffect = (typeof BTC_BILL_PAY_WRITE_BUDGET_EFFECTS)[number]

export type WriteContractErrorCode =
  | "invalid-actor"
  | "invalid-date"
  | "invalid-input"
  | "invalid-owner"
  | "write-not-authorized"
  | "invalid-minor-units"
  | "int64-out-of-range"
  | "zero-amount"
  | "income-must-be-credit"
  | "invalid-payment-source"
  | "payment-source-fields"
  | "payment-source-route-mismatch"
  | "sign-disagrees"
  | "source-owner-mismatch"

export class WriteContractError extends Error {
  readonly code: WriteContractErrorCode

  constructor(code: WriteContractErrorCode, message: string) {
    super(message)
    this.name = "WriteContractError"
    this.code = code
  }
}

export interface TransactionWriteInput {
  readonly id: string
  readonly date: string
  readonly merchant: string
  /** Exact signed integer cents. Never dollars and never a JSON number. */
  readonly amountCents: string | bigint
  readonly kind: TransactionWriteKind
  readonly category: string
  readonly owner: FamilyMember
  readonly sourceFile: string
  readonly card?: string
  /** Closed source intent. The builder maps it onto the retained `card` field. */
  readonly paymentSource?: PaymentSource
  readonly note?: string
  /** Exact sats for Bitcoin Income or a Lightning/on-chain spend. */
  readonly amountSats?: string | bigint
  readonly bitcoinAccountKey?: string
}

export interface TransactionWriteWire {
  readonly id: string
  readonly date: string
  readonly merchant: string
  readonly amountCents: ConvexInt64WireValue
  readonly kind: TransactionWriteKind
  readonly category: string
  readonly owner: FamilyMember
  readonly card?: string
  readonly note?: string
  readonly amountSats?: ConvexInt64WireValue
  readonly bitcoinAccountKey?: string
}

export interface TransactionWriteRequest {
  readonly path: typeof UPSERT_TRANSACTION_PATH
  readonly format: typeof CONVEX_WRITE_FORMAT
  readonly args: {
    readonly transaction: TransactionWriteWire
    readonly sourceFile: string
  }
}

export interface BtcBillPayWriteInput {
  readonly id: string
  readonly date: string
  readonly merchant: string
  readonly category: string
  readonly budgetEffect: BtcBillPayBudgetEffect
  readonly amountUsdCents: string | bigint
  readonly btcSpentSats: string | bigint
  readonly btcPriceCents: string | bigint
  readonly feeUsdCents: string | bigint
  readonly owner: FamilyMember
  readonly sourceFile: "bitcoin-bill-pays"
  readonly paymentSource: "river_bitcoin_bill_pay"
  readonly note?: string
  readonly reference?: string
}

export interface BtcBillPayWriteRequest {
  readonly path: typeof UPSERT_BTC_BILL_PAY_PATH
  readonly format: typeof CONVEX_WRITE_FORMAT
  readonly args: {
    readonly sourceFile: "bitcoin-bill-pays"
    readonly billPay: {
      readonly id: string
      readonly date: string
      readonly merchant: string
      readonly category: string
      readonly budgetEffect: BtcBillPayBudgetEffect
      readonly amountUsdCents: ConvexInt64WireValue
      readonly btcSpentSats: ConvexInt64WireValue
      readonly btcPriceCents: ConvexInt64WireValue
      readonly feeUsdCents: ConvexInt64WireValue
      readonly owner: "victor"
      readonly platform: "river_bitcoin_bill_pay"
      readonly note?: string
      readonly reference?: string
    }
  }
}

/**
 * Write scope deliberately matches household visibility: adults may write the
 * shared household and either child's data; children may write only their own.
 * The sync token still gates the mutation at the transport/server boundary.
 */
export function canWriteDataOwnedBy(actor: FamilyMember, owner: FamilyMember): boolean {
  return canSeeDataOwnedBy(actor, owner)
}

/** Parse an exact integer minor-unit value without passing through float. */
export function parseWriteInt64(value: unknown): bigint {
  if (typeof value === "bigint") {
    return assertInt64Range(value)
  }
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value)) {
    throw new WriteContractError(
      "invalid-minor-units",
      "Minor units must be an exact base-10 integer string or bigint",
    )
  }

  return assertInt64Range(BigInt(value))
}

/**
 * Validate and encode one `tables:upsertTransaction` request.
 *
 * The returned args intentionally omit `token`; transport code must inject the
 * runtime secret centrally so fixtures and domain values never carry it.
 */
export function buildTransactionWriteRequest(
  actor: unknown,
  candidate: unknown,
): TransactionWriteRequest {
  if (!isFamilyMember(actor)) {
    throw new WriteContractError("invalid-actor", "Write actor must be a known family member")
  }
  if (!isRecord(candidate)) {
    throw new WriteContractError("invalid-input", "Transaction write input must be an object")
  }

  const owner = candidate.owner
  if (!isFamilyMember(owner)) {
    throw new WriteContractError("invalid-owner", "Transaction owner must be a known family member")
  }
  if (!canWriteDataOwnedBy(actor, owner)) {
    throw new WriteContractError(
      "write-not-authorized",
      `${actor} may not write data owned by ${owner}`,
    )
  }
  const sourceFile = requiredString(candidate.sourceFile, "sourceFile")
  const expectedSource = transactionsDataFileName(owner)
  if (sourceFile !== expectedSource) {
    throw new WriteContractError(
      "source-owner-mismatch",
      `Transaction source "${sourceFile}" does not belong to ${owner}; expected "${expectedSource}"`,
    )
  }

  const amountCents = parseWriteInt64(candidate.amountCents)
  const kind = transactionKind(candidate.kind)
  const category = requiredString(candidate.category, "category")
  requireTransactionSign(amountCents, owner, kind, category)
  const amountSats = candidate.amountSats === undefined
    ? undefined
    : parseWriteInt64(candidate.amountSats)
  const paymentSource = candidate.paymentSource === undefined
    ? undefined
    : requirePaymentSource(candidate.paymentSource)
  const bitcoinAccountKey = candidate.bitcoinAccountKey === undefined
    ? undefined
    : requiredTrimmedString(candidate.bitcoinAccountKey, "bitcoinAccountKey")
  const paymentFields = transactionPaymentFields(
    candidate,
    paymentSource,
    owner,
    kind,
    category,
    amountSats,
    bitcoinAccountKey,
  )

  const transaction: TransactionWriteWire = {
    id: requiredString(candidate.id, "id"),
    date: requiredIsoDate(candidate.date),
    merchant: requiredString(candidate.merchant, "merchant"),
    amountCents: encodeConvexInt64(amountCents),
    kind,
    category,
    owner,
    ...paymentFields,
    ...optionalWireString(candidate, "note"),
    ...(amountSats === undefined
      ? {}
      : { amountSats: encodeConvexInt64(amountSats) }),
    ...(bitcoinAccountKey === undefined ? {} : { bitcoinAccountKey }),
  }

  return {
    path: UPSERT_TRANSACTION_PATH,
    format: CONVEX_WRITE_FORMAT,
    args: { transaction, sourceFile },
  }
}

export function buildBtcBillPayWriteRequest(
  actor: unknown,
  candidate: unknown,
): BtcBillPayWriteRequest {
  if (!isFamilyMember(actor) || !isAdult(actor)) {
    throw new WriteContractError(
      "write-not-authorized",
      "River Bitcoin Bill Pay is available only to an adult household actor",
    )
  }
  if (!isRecord(candidate)) {
    throw new WriteContractError("invalid-input", "Bitcoin bill-pay input must be an object")
  }
  const owner = candidate.owner
  if (!isFamilyMember(owner) || !isAdult(owner)) {
    throw new WriteContractError(
      "invalid-owner",
      "Bitcoin bill-pay owner must be an adult household member",
    )
  }
  if (!canWriteDataOwnedBy(actor, owner)) {
    throw new WriteContractError(
      "write-not-authorized",
      `${actor} may not write data owned by ${owner}`,
    )
  }
  const canonicalOwner = ledgerOwner(owner)
  if (canonicalOwner !== "victor") {
    throw new WriteContractError("invalid-owner", "River bill pay requires the adult ledger")
  }
  if (candidate.sourceFile !== "bitcoin-bill-pays") {
    throw new WriteContractError(
      "source-owner-mismatch",
      'Bitcoin bill pays require sourceFile "bitcoin-bill-pays"',
    )
  }
  if (candidate.paymentSource !== "river_bitcoin_bill_pay") {
    throw new WriteContractError(
      "payment-source-route-mismatch",
      "tables:upsertBtcBillPay requires river_bitcoin_bill_pay",
    )
  }
  if (
    candidate.budgetEffect !== "budget_category" &&
    candidate.budgetEffect !== "credit_card_payment"
  ) {
    throw new WriteContractError(
      "invalid-input",
      "budgetEffect must be budget_category or credit_card_payment",
    )
  }
  const budgetEffect = candidate.budgetEffect
  const category = budgetEffect === "credit_card_payment"
    ? "Credit Card Payment"
    : requiredString(candidate.category, "category")
  const amountUsdCents = positiveWriteInt64(candidate.amountUsdCents, "amountUsdCents")
  const btcSpentSats = positiveWriteInt64(candidate.btcSpentSats, "btcSpentSats")
  const btcPriceCents = positiveWriteInt64(candidate.btcPriceCents, "btcPriceCents")
  const feeUsdCents = parseWriteInt64(candidate.feeUsdCents)
  if (feeUsdCents < 0n) {
    throw new WriteContractError("invalid-input", "feeUsdCents must be nonnegative")
  }

  const optional = (field: "note" | "reference") => {
    const value = candidate[field]
    if (value === undefined) return {}
    if (typeof value !== "string") {
      throw new WriteContractError("invalid-input", `${field} must be a string when present`)
    }
    return { [field]: value }
  }
  return {
    path: UPSERT_BTC_BILL_PAY_PATH,
    format: CONVEX_WRITE_FORMAT,
    args: {
      sourceFile: "bitcoin-bill-pays",
      billPay: {
        id: requiredString(candidate.id, "id"),
        date: requiredIsoDate(candidate.date),
        merchant: requiredString(candidate.merchant, "merchant"),
        category,
        budgetEffect,
        amountUsdCents: encodeConvexInt64(amountUsdCents),
        btcSpentSats: encodeConvexInt64(btcSpentSats),
        btcPriceCents: encodeConvexInt64(btcPriceCents),
        feeUsdCents: encodeConvexInt64(feeUsdCents),
        owner: canonicalOwner,
        platform: "river_bitcoin_bill_pay",
        ...optional("note"),
        ...optional("reference"),
      },
    },
  }
}

function positiveWriteInt64(value: unknown, field: string): bigint {
  const parsed = parseWriteInt64(value)
  if (parsed <= 0n) {
    throw new WriteContractError("invalid-input", `${field} must be positive`)
  }
  return parsed
}

function requirePaymentSource(value: unknown): PaymentSource {
  if (isPaymentSource(value)) return value
  throw new WriteContractError(
    "invalid-payment-source",
    `paymentSource must be one of ${PAYMENT_SOURCES.join(", ")}`,
  )
}

function transactionPaymentFields(
  candidate: Record<string, unknown>,
  paymentSource: PaymentSource | undefined,
  owner: FamilyMember,
  kind: TransactionWriteKind,
  category: string,
  amountSats: bigint | undefined,
  bitcoinAccountKey: string | undefined,
): Partial<Pick<TransactionWriteWire, "card">> {
  if (paymentSource === undefined) {
    if (amountSats !== undefined && (category !== "Income" || amountSats <= 0n)) {
      throw new WriteContractError(
        "invalid-input",
        "Bitcoin-denominated Income must carry a positive exact sats amount",
      )
    }
    if (bitcoinAccountKey !== undefined && amountSats === undefined) {
      throw new WriteContractError(
        "payment-source-fields",
        "bitcoinAccountKey requires amountSats",
      )
    }
    return optionalWireString(candidate, "card")
  }

  if (paymentSourceRoute(paymentSource) !== "transaction") {
    throw new WriteContractError(
      "payment-source-route-mismatch",
      "river_bitcoin_bill_pay must use tables:upsertBtcBillPay",
    )
  }
  if (candidate.card !== undefined && candidate.card !== paymentSource) {
    throw new WriteContractError(
      "payment-source-fields",
      "card must be omitted or match paymentSource",
    )
  }

  if (BITCOIN_SPEND_SOURCES.has(paymentSource)) {
    if (!isAdult(owner)) {
      throw new WriteContractError(
        "write-not-authorized",
        "Lightning and on-chain spends are available only to the adult household ledger",
      )
    }
    if (
      kind !== "spend" ||
      category === "Income" ||
      amountSats === undefined ||
      amountSats <= 0n ||
      bitcoinAccountKey === undefined
    ) {
      throw new WriteContractError(
        "payment-source-fields",
        "Lightning and on-chain spends require kind spend, a non-Income category, positive amountSats, and bitcoinAccountKey",
      )
    }
  } else if (amountSats !== undefined || bitcoinAccountKey !== undefined) {
    throw new WriteContractError(
      "payment-source-fields",
      "Card payment sources must not carry Bitcoin posting fields",
    )
  }

  return { card: paymentSource }
}

function requireTransactionSign(
  amountCents: bigint,
  owner: FamilyMember,
  kind: TransactionWriteKind,
  category: string,
): void {
  if (amountCents === 0n) {
    throw new WriteContractError("zero-amount", "A zero-value transaction has no sign to check")
  }
  if (category === "Income" && kind !== "credit") {
    throw new WriteContractError(
      "income-must-be-credit",
      'A transaction categorised "Income" must have kind "credit"',
    )
  }

  const expectedNegative = category !== "Income" && kind === "credit"
  if ((amountCents < 0n) !== expectedNegative) {
    throw new WriteContractError(
      "sign-disagrees",
      `A ${kind} for ${owner} must be ${expectedNegative ? "negative" : "positive"}; ` +
        "purchases are positive and refunds are negative for every owner",
    )
  }
}

function assertInt64Range(value: bigint): bigint {
  const minimum = -(1n << 63n)
  const maximum = (1n << 63n) - 1n
  if (value < minimum || value > maximum) {
    throw new WriteContractError("int64-out-of-range", "Minor units must fit signed int64")
  }
  return value
}

function transactionKind(value: unknown): TransactionWriteKind {
  if (value === "spend" || value === "credit") return value
  throw new WriteContractError("invalid-input", 'Transaction kind must be "spend" or "credit"')
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WriteContractError("invalid-input", `${field} must be a non-empty string`)
  }
  return value
}

function requiredTrimmedString(value: unknown, field: string): string {
  const trimmed = requiredString(value, field).trim()
  if (trimmed === "") {
    throw new WriteContractError("invalid-input", `${field} must be a non-empty string`)
  }
  return trimmed
}

function requiredIsoDate(value: unknown): string {
  const date = requiredString(value, "date")
  if (!isIsoDate(date)) {
    throw new WriteContractError(
      "invalid-date",
      `date must be a real ISO calendar date (yyyy-MM-dd), got ${JSON.stringify(date)}`,
    )
  }
  return date
}

function optionalWireString(
  record: Record<string, unknown>,
  field: "card" | "note",
): Partial<Pick<TransactionWriteWire, "card" | "note">> {
  const value = record[field]
  if (value === undefined) return {}
  if (typeof value !== "string") {
    throw new WriteContractError("invalid-input", `${field} must be a string when present`)
  }
  return { [field]: value }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
