// Strict Convex row transport. MAIN PROCESS ONLY.
//
// This module owns the untrusted HTTP-to-IPC transition. It accepts one closed
// request union, sends one fixed query path per request, decodes Convex int64s,
// and constructs public DTOs field-by-field. Remote bodies, server-authored text,
// deployment configuration, Convex internals, and migration fields never leave it.

import { Buffer } from "node:buffer"

import {
  SHARES_DECIMAL_MAX_LENGTH,
  assertSharesDecimal,
  type SharesDecimalOptions,
} from "@vogel-vault/domain/money"

import type {
  VogelVaultBtcAccountRow,
  VogelVaultBtcBalanceDocument,
  VogelVaultBillPayBudgetEffect,
  VogelVaultBtcBillPayRow,
  VogelVaultBtcBuyRow,
  VogelVaultBtcTransferRow,
  VogelVaultBtcScope,
  VogelVaultBtcSnapshotMeta,
  VogelVaultFiatValuation,
  VogelVaultFinanceAccount,
  VogelVaultFinanceDocument,
  VogelVaultFinanceHolding,
  VogelVaultFinanceLot,
  VogelVaultBudgetCategory,
  VogelVaultBudgetDocument,
  VogelVaultBudgetHistoryEntry,
  VogelVaultBudgetIncome,
  VogelVaultBudgetPaycheck,
  VogelVaultMember,
  VogelVaultIncomeRow,
  VogelVaultMarketQuote,
  VogelVaultMarketQuoteSnapshot,
  VogelVaultRowRequest,
  VogelVaultRowCounts,
  VogelVaultRowResult,
  VogelVaultTodoRow,
  VogelVaultTransactionRow,
} from "../shared/ipc.ts"
import type {
  JsonPostResponse,
  JsonPoster,
  RemoteReadConfiguration,
} from "./convexRead.ts"

/** Isolated here so integration can adjust a provisional backend name in one edit. */
export const ROW_QUERY_PATHS = {
  rowCounts: "tables:rowCounts",
  transactions: "tables:listTransactions",
  income: "tables:listIncome",
  todos: "tables:listTodos",
  btcBuys: "tables:listBtcBuys",
  btcAccounts: "tables:listBtcAccounts",
  btcBillPays: "tables:listBtcBillPays",
  btcTransfers: "tables:listBtcTransfers",
  budget: "tables:getBudgetDocument",
  btcSnapshotMeta: "tables:getBtcSnapshotMetadata",
  btcBalanceDocuments: "tables:listBtcBalanceDocuments",
  finance: "tables:getFinanceDocument",
  marketQuotes: "marketQuotes:getSnapshot",
} as const

export const CONVEX_ROW_LIMITS = {
  maxResponseBytes: 4 * 1_048_576,
  maxTransactions: 2_000,
  maxIncome: 2_000,
  maxTodos: 1_000,
  maxBtcBuys: 1_000,
  maxBtcAccounts: 256,
  maxBtcBillPays: 1_000,
  maxBtcTransfers: 1_000,
  maxBtcBalanceDocuments: 256,
  maxBudgetCategories: 256,
  maxBudgetPaychecks: 512,
  maxBudgetHistory: 240,
  maxFinanceAccounts: 64,
  maxFinanceHoldings: 512,
  maxFinanceLots: 2_000,
  maxStringLength: 16_384,
  cacheMs: 5_000,
  maxCachedRequests: 64,
  // One renderer refresh may fan out to twelve independent row queries after
  // rowCounts. Keep the guard large enough for that single trusted load.
  maxInFlightRequests: 12,
} as const

const MEMBERS = ["victor", "rachel", "mason", "maddox"] as const
const ADULTS: ReadonlySet<VogelVaultMember> = new Set(["victor", "rachel"])
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const BUDGET_MONTH = /^(?:\d{4}-(?:0[1-9]|1[0-2])|(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4})$/
const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/
const BASE64_INT64 = /^(?:[A-Za-z0-9+/]{4}){2}[A-Za-z0-9+/]{3}=$/
const TWO_64 = 1n << 64n
const SIGN_64 = 1n << 63n
const MARKET_SYMBOLS = ["BTC", "VOO", "IBIT"] as const
// The one category a credit-card bill pay is allowed to carry. Declared here
// rather than imported so the read transport keeps its own closed vocabulary;
// convexMutations.ts pins the identical string on the write side.
const CREDIT_CARD_PAYMENT_CATEGORY = "Credit Card Payment"
const MARKET_STATUSES = ["live", "stale", "unavailable"] as const
const CANONICAL_ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/

type UnscopedRowRequest = Extract<
  VogelVaultRowRequest,
  { readonly kind: "rowCounts" | "marketQuotes" }
>
type ProfileScopedRowRequest = Exclude<VogelVaultRowRequest, UnscopedRowRequest>
type ResolvedRowRequest =
  | UnscopedRowRequest
  | (ProfileScopedRowRequest & { readonly viewer: VogelVaultMember })

class InvalidValue extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidValue()
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  if (keys.some((key) => !allowed.has(key))) throw new InvalidValue()
  if (required.some((key) => !Object.hasOwn(value, key))) throw new InvalidValue()
  return value
}

/** Server objects are extensible: validate fields we consume and ignore the rest. */
function responseObject(
  value: unknown,
  required: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidValue()
  if (required.some((key) => !Object.hasOwn(value, key))) throw new InvalidValue()
  return value
}

function text(
  record: Record<string, unknown>,
  key: string,
  max: number = CONVEX_ROW_LIMITS.maxStringLength,
): string {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new InvalidValue()
  return value
}

function optionalText(record: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined
  return text(record, key)
}

function booleanValue(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== "boolean") throw new InvalidValue()
  return value
}

function finiteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InvalidValue()
  return value
}

function integerValue(record: Record<string, unknown>, key: string): number {
  const value = finiteNumber(record, key)
  if (!Number.isSafeInteger(value)) throw new InvalidValue()
  return value
}

function timestampValue(record: Record<string, unknown>, key = "updatedAtMs"): number {
  const value = integerValue(record, key)
  if (value < 0) throw new InvalidValue()
  return value
}

function member(record: Record<string, unknown>, key = "owner"): VogelVaultMember {
  const value = record[key]
  if (typeof value !== "string" || !(MEMBERS as readonly string[]).includes(value)) throw new InvalidValue()
  return value as VogelVaultMember
}

function monthValue(record: Record<string, unknown>, key = "month"): string {
  const value = text(record, key, 7)
  if (!MONTH.test(value)) throw new InvalidValue()
  return value
}

function budgetMonthValue(record: Record<string, unknown>, key = "month"): string {
  const value = text(record, key, 14)
  if (!BUDGET_MONTH.test(value)) throw new InvalidValue()
  return value
}

function dateValue(record: Record<string, unknown>, key = "date"): string {
  const value = text(record, key, 10)
  if (!DATE.test(value)) throw new InvalidValue()
  return value
}

function dateAndMonth(record: Record<string, unknown>): { readonly date: string; readonly month: string } {
  const date = dateValue(record)
  const month = monthValue(record)
  if (date.slice(0, 7) !== month) throw new InvalidValue()
  return { date, month }
}

function canonicalIsoInstant(value: string): boolean {
  if (!CANONICAL_ISO_INSTANT.test(value)) return false
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) return false
  const normalized = new Date(millis).toISOString()
  return value === normalized || value === normalized.replace(".000Z", "Z")
}

function scopeValue(value: unknown): VogelVaultBtcScope {
  if (value !== "visible" && value !== "netWorth") throw new InvalidValue()
  return value
}

/** Canonical Convex v.int64 wire decoder. */
export function decodeConvexInt64(value: unknown): bigint {
  const wrapper = exactObject(value, ["$integer"])
  const encoded = wrapper["$integer"]
  if (typeof encoded !== "string" || !BASE64_INT64.test(encoded)) throw new InvalidValue()

  const bytes = Buffer.from(encoded, "base64")
  if (bytes.byteLength !== 8 || bytes.toString("base64") !== encoded) throw new InvalidValue()

  let unsigned = 0n
  for (let index = 0; index < bytes.byteLength; index += 1) {
    unsigned |= BigInt(bytes[index] ?? 0) << BigInt(index * 8)
  }
  return unsigned >= SIGN_64 ? unsigned - TWO_64 : unsigned
}

function int64(record: Record<string, unknown>, key: string): bigint {
  return decodeConvexInt64(record[key])
}

function optionalInt64(record: Record<string, unknown>, key: string): bigint | undefined {
  if (!Object.hasOwn(record, key)) return undefined
  return int64(record, key)
}

function fiatValuation(
  record: Record<string, unknown>,
  sats: bigint,
  legacyFiatCents: bigint | undefined,
): VogelVaultFiatValuation | null {
  if (!Object.hasOwn(record, "fiatValuation")) {
    if (legacyFiatCents === undefined || (sats > 0n && legacyFiatCents === 0n)) return null
    return { cents: legacyFiatCents }
  }

  const value = record["fiatValuation"]
  if (value === null) return null
  const valuation = responseObject(value, ["cents"])
  return {
    cents: int64(valuation, "cents"),
    ...optionalField("priceCents", optionalInt64(valuation, "priceCents")),
    ...optionalField("quotedAt", optionalText(valuation, "quotedAt")),
    ...optionalField("source", optionalText(valuation, "source")),
    ...optionalField("confidence", optionalText(valuation, "confidence")),
  }
}

function safeInt64Number(record: Record<string, unknown>, key: string): number {
  const value = int64(record, key)
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidValue()
  }
  return Number(value)
}

function optionalField<T>(key: string, value: T | undefined): { readonly [name: string]: T } | Record<string, never> {
  return value === undefined ? {} : { [key]: value }
}

function maySee(viewer: VogelVaultMember, owner: VogelVaultMember, scope: VogelVaultBtcScope): boolean {
  if (viewer === owner) return true
  if (scope === "visible") return ADULTS.has(viewer)
  return ADULTS.has(viewer) && ADULTS.has(owner)
}

function assertVisible(
  viewer: VogelVaultMember,
  owner: VogelVaultMember,
  scope: VogelVaultBtcScope = "visible",
): void {
  if (!maySee(viewer, owner, scope)) throw new InvalidValue()
}

function assertBudgetOwner(viewer: VogelVaultMember, owner: VogelVaultMember): void {
  const expected = ADULTS.has(viewer) ? "victor" : viewer
  if (owner !== expected) throw new InvalidValue()
}

function transaction(value: unknown, viewer: VogelVaultMember): VogelVaultTransactionRow {
  const row = responseObject(
    value,
    [
      "txId", "owner", "date", "month", "merchant", "amountCents", "category",
      "updatedAtMs",
    ],
  )
  const owner = member(row)
  assertVisible(viewer, owner)
  const { date, month } = dateAndMonth(row)
  const amountCents = int64(row, "amountCents")
  const category = text(row, "category")
  const amountSats = optionalInt64(row, "amountSats")
  const bitcoinAccountKey = optionalText(row, "bitcoinAccountKey")
  const balancePostingVersion = optionalInt64(row, "balancePostingVersion")
  // A Bitcoin-native spend is a positive-sats row with a non-Income category and
  // an account key. The write path accepts it and the ledger posts it, so the
  // read side must decode it too. The one newly-admitted shape is positive sats
  // on a non-Income category; positivity and the account requirement are kept
  // for every other case so the decoder stays a defensive boundary.
  if (
    amountSats !== undefined &&
    (amountSats <= 0n || (category !== "Income" && bitcoinAccountKey === undefined))
  ) {
    throw new InvalidValue()
  }
  if (
    balancePostingVersion !== undefined &&
    (balancePostingVersion !== 1n || amountSats === undefined || bitcoinAccountKey === undefined)
  ) {
    throw new InvalidValue()
  }
  const spendAmount = category === "Income"
    ? 0n
    : amountCents
  const displaySpendAmount = spendAmount < 0n ? -spendAmount : spendAmount
  const hasOppositeSpendSign = spendAmount < 0n
  return {
    txId: text(row, "txId", 256),
    owner,
    date,
    month,
    merchant: text(row, "merchant"),
    amountCents,
    spendAmount,
    displaySpendAmount,
    hasOppositeSpendSign,
    category,
    ...optionalField("card", optionalText(row, "card")),
    ...optionalField("note", optionalText(row, "note")),
    ...optionalField("amountSats", amountSats),
    ...optionalField("bitcoinAccountKey", bitcoinAccountKey),
    ...optionalField("balancePostingVersion", balancePostingVersion),
    updatedAtMs: timestampValue(row),
  }
}

function income(value: unknown, viewer: VogelVaultMember): VogelVaultIncomeRow {
  const row = responseObject(
    value,
    ["incomeId", "owner", "date", "month", "amountCents", "source", "updatedAtMs"],
  )
  const owner = member(row)
  assertVisible(viewer, owner)
  const { date, month } = dateAndMonth(row)
  return {
    incomeId: text(row, "incomeId", 256),
    owner,
    date,
    month,
    amountCents: int64(row, "amountCents"),
    source: text(row, "source"),
    ...optionalField("loggedBy", optionalText(row, "loggedBy")),
    ...optionalField("note", optionalText(row, "note")),
    ...optionalField("archimedesRequestId", optionalText(row, "archimedesRequestId")),
    updatedAtMs: timestampValue(row),
  }
}

function todo(value: unknown, viewer: VogelVaultMember): VogelVaultTodoRow {
  const row = responseObject(
    value,
    ["todoId", "owner", "title", "done", "flagged", "updatedAtMs"],
  )
  const owner = member(row)
  assertVisible(viewer, owner)
  return {
    todoId: text(row, "todoId", 256),
    owner,
    title: text(row, "title"),
    done: booleanValue(row, "done"),
    flagged: booleanValue(row, "flagged"),
    ...optionalField("lane", optionalText(row, "lane")),
    ...optionalField("project", optionalText(row, "project")),
    ...optionalField("area", optionalText(row, "area")),
    ...optionalField("due", optionalText(row, "due")),
    ...optionalField("notes", optionalText(row, "notes")),
    ...optionalField("priority", optionalInt64(row, "priority")),
    ...optionalField("createdAt", optionalText(row, "createdAt")),
    ...optionalField("updatedAt", optionalText(row, "updatedAt")),
    ...optionalField("completedAt", optionalText(row, "completedAt")),
    updatedAtMs: timestampValue(row),
  }
}

function btcBuy(value: unknown, viewer: VogelVaultMember, scope: VogelVaultBtcScope): VogelVaultBtcBuyRow {
  const row = responseObject(
    value,
    ["buyId", "owner", "date", "month", "source", "sats", "priceUsdCents", "usdCents", "updatedAtMs"],
  )
  const owner = member(row)
  assertVisible(viewer, owner, scope)
  const { date, month } = dateAndMonth(row)
  return {
    buyId: text(row, "buyId", 256),
    owner,
    date,
    month,
    source: text(row, "source"),
    sats: int64(row, "sats"),
    priceUsdCents: int64(row, "priceUsdCents"),
    usdCents: int64(row, "usdCents"),
    ...optionalField("note", optionalText(row, "note")),
    ...optionalField("status", optionalText(row, "status")),
    ...optionalField("costBasisStatus", optionalText(row, "costBasisStatus")),
    ...optionalField("loggedBy", optionalText(row, "loggedBy")),
    ...optionalField("archimedesRequestId", optionalText(row, "archimedesRequestId")),
    updatedAtMs: timestampValue(row),
  }
}

function btcAccount(
  value: unknown,
  viewer: VogelVaultMember,
  scope: VogelVaultBtcScope,
): VogelVaultBtcAccountRow {
  const row = responseObject(
    value,
    ["key", "owner", "label", "custody", "sats", "asOf", "schemaVersion", "updatedAtMs"],
  )
  const owner = member(row)
  assertVisible(viewer, owner, scope)
  const custody = row["custody"]
  if (custody !== "exchange" && custody !== "self_custody") throw new InvalidValue()
  const sats = int64(row, "sats")
  const legacyFiatCents = optionalInt64(row, "fiatCents")
  const valuation = fiatValuation(row, sats, legacyFiatCents)
  return {
    key: text(row, "key", 256),
    owner,
    label: text(row, "label"),
    custody,
    sats,
    fiatCents: legacyFiatCents ?? valuation?.cents ?? 0n,
    fiatValuation: valuation,
    asOf: text(row, "asOf"),
    schemaVersion: int64(row, "schemaVersion"),
    updatedAtMs: timestampValue(row),
  }
}

/**
 * Absent stays absent; present is closed.
 *
 * A pre-amendment row carries no property at all, and the renderer defaults
 * that case to credit_card_payment. A property that IS present is server-
 * authored data this boundary must read exactly: an unrecognised value, or a
 * credit-card payment under any category but the canonical one, is a malformed
 * row and is rejected like every other unreadable field, never coerced into the
 * legacy default.
 */
function billPayBudgetEffect(
  record: Record<string, unknown>,
  category: string,
): VogelVaultBillPayBudgetEffect | undefined {
  if (!Object.hasOwn(record, "budgetEffect")) return undefined
  const value = record["budgetEffect"]
  if (value !== "budget_category" && value !== "credit_card_payment") throw new InvalidValue()
  if (value === "credit_card_payment" && category !== CREDIT_CARD_PAYMENT_CATEGORY) {
    throw new InvalidValue()
  }
  return value
}

function btcBillPay(
  value: unknown,
  viewer: VogelVaultMember,
  scope: VogelVaultBtcScope,
): VogelVaultBtcBillPayRow {
  const row = responseObject(
    value,
    [
      "billPayId", "owner", "date", "month", "merchant", "category", "amountUsdCents",
      "btcSpentSats", "btcPriceCents", "feeUsdCents", "updatedAtMs",
    ],
  )
  const owner = member(row)
  assertVisible(viewer, owner, scope)
  const { date, month } = dateAndMonth(row)
  const category = text(row, "category")
  return {
    billPayId: text(row, "billPayId", 256),
    owner,
    date,
    month,
    merchant: text(row, "merchant"),
    category,
    ...optionalField("budgetEffect", billPayBudgetEffect(row, category)),
    amountUsdCents: int64(row, "amountUsdCents"),
    btcSpentSats: int64(row, "btcSpentSats"),
    btcPriceCents: int64(row, "btcPriceCents"),
    ...optionalField("platform", optionalText(row, "platform")),
    ...optionalField("note", optionalText(row, "note")),
    feeUsdCents: int64(row, "feeUsdCents"),
    ...optionalField("reference", optionalText(row, "reference")),
    updatedAtMs: timestampValue(row),
  }
}

function btcTransfer(
  value: unknown,
  viewer: VogelVaultMember,
  scope: VogelVaultBtcScope,
): VogelVaultBtcTransferRow {
  const row = responseObject(
    value,
    [
      "transferId", "owner", "date", "month", "fromAccountKey",
      "toAccountKey", "sats", "feeSats", "updatedAtMs",
    ],
  )
  const owner = member(row)
  assertVisible(viewer, owner, scope)
  const { date, month } = dateAndMonth(row)
  const sats = int64(row, "sats")
  const feeSats = int64(row, "feeSats")
  if (sats <= 0n || feeSats < 0n) throw new InvalidValue()
  const fromAccountKey = text(row, "fromAccountKey", 256)
  const toAccountKey = text(row, "toAccountKey", 256)
  if (fromAccountKey === toAccountKey) throw new InvalidValue()
  return {
    transferId: text(row, "transferId", 256),
    owner,
    date,
    month,
    fromAccountKey,
    toAccountKey,
    sats,
    feeSats,
    ...optionalField("note", optionalText(row, "note")),
    updatedAtMs: timestampValue(row),
  }
}

function budgetCategory(value: unknown): VogelVaultBudgetCategory {
  const row = responseObject(value, ["name", "budgetCents"])
  return {
    name: text(row, "name"),
    ...optionalField("icon", optionalText(row, "icon")),
    budgetCents: int64(row, "budgetCents"),
  }
}

function budgetPaycheck(value: unknown): VogelVaultBudgetPaycheck {
  const row = responseObject(value, ["date", "amountCents", "netCents"])
  return {
    date: text(row, "date"),
    ...optionalField("platform", optionalText(row, "platform")),
    ...optionalField("source", optionalText(row, "source")),
    amountCents: int64(row, "amountCents"),
    netCents: int64(row, "netCents"),
    ...optionalField("note", optionalText(row, "note")),
  }
}

function budgetIncome(value: unknown): VogelVaultBudgetIncome {
  const row = responseObject(
    value,
    [
      "weeklyGrossCents", "weeklyStrikeCents", "weeklyRiverCents", "monthlyGrossCents",
      "mtdIncomeCents", "ytdIncomeCents", "paychecks",
    ],
  )
  const paychecks = row["paychecks"]
  if (!Array.isArray(paychecks) || paychecks.length > CONVEX_ROW_LIMITS.maxBudgetPaychecks) throw new InvalidValue()
  return {
    weeklyGrossCents: int64(row, "weeklyGrossCents"),
    weeklyStrikeCents: int64(row, "weeklyStrikeCents"),
    weeklyRiverCents: int64(row, "weeklyRiverCents"),
    ...optionalField("payFrequency", optionalText(row, "payFrequency")),
    monthlyGrossCents: int64(row, "monthlyGrossCents"),
    mtdIncomeCents: int64(row, "mtdIncomeCents"),
    ytdIncomeCents: int64(row, "ytdIncomeCents"),
    paychecks: paychecks.map(budgetPaycheck),
  }
}

function budgetHistory(value: unknown): VogelVaultBudgetHistoryEntry {
  const row = responseObject(value, ["month", "incomeCents", "expensesCents", "savingsBps"])
  return {
    month: budgetMonthValue(row),
    incomeCents: int64(row, "incomeCents"),
    expensesCents: int64(row, "expensesCents"),
    savingsBps: safeInt64Number(row, "savingsBps"),
  }
}

function budgetDocument(value: unknown, viewer: VogelVaultMember): VogelVaultBudgetDocument | null {
  if (value === null) return null
  const row = responseObject(
    value,
    [
      "owner", "month", "coinbaseOneBalanceCents", "categories", "mtdIncomeCents",
      "ytdIncomeCents", "monthlyHistory", "updatedAtMs",
    ],
  )
  const owner = member(row)
  assertBudgetOwner(viewer, owner)
  const categories = row["categories"]
  const history = row["monthlyHistory"]
  if (!Array.isArray(categories) || categories.length > CONVEX_ROW_LIMITS.maxBudgetCategories) throw new InvalidValue()
  if (!Array.isArray(history) || history.length > CONVEX_ROW_LIMITS.maxBudgetHistory) throw new InvalidValue()
  const income = Object.hasOwn(row, "income") ? budgetIncome(row["income"]) : undefined
  return {
    owner,
    month: budgetMonthValue(row),
    coinbaseOneBalanceCents: int64(row, "coinbaseOneBalanceCents"),
    categories: categories.map(budgetCategory),
    ...optionalField("effectiveApr", optionalText(row, "effectiveApr")),
    ...optionalField("strategyNote", optionalText(row, "strategyNote")),
    ...optionalField("income", income),
    mtdIncomeCents: int64(row, "mtdIncomeCents"),
    ytdIncomeCents: int64(row, "ytdIncomeCents"),
    monthlyHistory: history.map(budgetHistory),
    updatedAtMs: timestampValue(row),
  }
}

/**
 * Read one canonical share quantity, with the transport's own length cap kept
 * in step with the shared contract's.
 *
 * A signed lot spends one extra character on the leading minus, so the cap here
 * has to move with the flag — otherwise a legitimate 26-character
 * reconciliation lot is refused by the transport before the shared assertion
 * ever sees it, and one refused lot fails the whole finance query.
 */
function decimalText(
  record: Record<string, unknown>,
  key: string,
  options: SharesDecimalOptions = {},
): string {
  const maxLength = options.signed === true
    ? SHARES_DECIMAL_MAX_LENGTH + 1
    : SHARES_DECIMAL_MAX_LENGTH
  try {
    return assertSharesDecimal(text(record, key, maxLength), options)
  } catch {
    throw new InvalidValue()
  }
}

function financeLot(value: unknown): VogelVaultFinanceLot {
  const row = responseObject(
    value,
    ["date", "type", "pricePerShareCents", "sharesDecimal", "amountInvestedCents"],
  )
  return {
    date: text(row, "date"),
    type: text(row, "type"),
    pricePerShareCents: int64(row, "pricePerShareCents"),
    // A statement-reconciliation lot removes shares and arrives negative.
    sharesDecimal: decimalText(row, "sharesDecimal", { signed: true }),
    amountInvestedCents: int64(row, "amountInvestedCents"),
    ...optionalField("note", optionalText(row, "note")),
  }
}

function financeHolding(value: unknown): VogelVaultFinanceHolding {
  const row = responseObject(
    value,
    [
      "name", "category", "valueCents", "costBasisCents", "gainBps",
      "sharesDecimal", "avgCostCents", "currentPricePerShareCents", "isProxy", "lots",
    ],
  )
  const lots = row["lots"]
  if (!Array.isArray(lots) || lots.length > CONVEX_ROW_LIMITS.maxFinanceLots) {
    throw new InvalidValue()
  }
  return {
    name: text(row, "name"),
    category: text(row, "category"),
    ...optionalField("ticker", optionalText(row, "ticker")),
    valueCents: int64(row, "valueCents"),
    costBasisCents: int64(row, "costBasisCents"),
    gainBps: int64(row, "gainBps"),
    sharesDecimal: decimalText(row, "sharesDecimal"),
    avgCostCents: int64(row, "avgCostCents"),
    currentPricePerShareCents: int64(row, "currentPricePerShareCents"),
    isProxy: booleanValue(row, "isProxy"),
    ...optionalField("proxyNote", optionalText(row, "proxyNote")),
    lots: lots.map(financeLot),
  }
}

function financeAccount(
  value: unknown,
  viewer: VogelVaultMember,
  scope: VogelVaultBtcScope,
): VogelVaultFinanceAccount {
  const row = responseObject(
    value,
    [
      "key", "owner", "provider", "totalValueCents", "weeklyContributionCents",
      "holdings",
    ],
  )
  const owner = member(row)
  assertVisible(viewer, owner, scope)
  const holdings = row["holdings"]
  if (!Array.isArray(holdings) || holdings.length > CONVEX_ROW_LIMITS.maxFinanceHoldings) {
    throw new InvalidValue()
  }
  return {
    key: text(row, "key", 256),
    owner,
    provider: text(row, "provider"),
    totalValueCents: int64(row, "totalValueCents"),
    weeklyContributionCents: int64(row, "weeklyContributionCents"),
    ...optionalField("weeklyContributionDay", optionalText(row, "weeklyContributionDay")),
    holdings: holdings.map(financeHolding),
  }
}

function financeDocument(
  value: unknown,
  viewer: VogelVaultMember,
  scope: VogelVaultBtcScope,
): VogelVaultFinanceDocument | null {
  if (value === null) return null
  const row = responseObject(value, ["lastUpdated", "accounts", "updatedAtMs"])
  const accounts = row["accounts"]
  if (!Array.isArray(accounts) || accounts.length > CONVEX_ROW_LIMITS.maxFinanceAccounts) {
    throw new InvalidValue()
  }
  return {
    lastUpdated: text(row, "lastUpdated"),
    ...optionalField("retirementTotalCents", optionalInt64(row, "retirementTotalCents")),
    accounts: accounts.map((account) => financeAccount(account, viewer, scope)),
    updatedAtMs: timestampValue(row),
  }
}

function marketQuote(value: unknown): VogelVaultMarketQuote {
  const row = responseObject(value, ["symbol", "priceCents", "source", "fetchedAt", "status"])
  const symbol = row["symbol"]
  const status = row["status"]
  if (!(MARKET_SYMBOLS as readonly unknown[]).includes(symbol)) throw new InvalidValue()
  if (!(MARKET_STATUSES as readonly unknown[]).includes(status)) throw new InvalidValue()
  const source = text(row, "source")
  const priceCents = row["priceCents"] === null ? null : int64(row, "priceCents")
  const fetchedAt = row["fetchedAt"] === null ? null : text(row, "fetchedAt")
  if (fetchedAt !== null && !canonicalIsoInstant(fetchedAt)) throw new InvalidValue()
  if (status === "unavailable") {
    if (priceCents !== null) throw new InvalidValue()
  } else if (priceCents === null || priceCents <= 0n || fetchedAt === null) {
    throw new InvalidValue()
  }
  return {
    symbol: symbol as VogelVaultMarketQuote["symbol"],
    priceCents,
    source,
    fetchedAt,
    status: status as VogelVaultMarketQuote["status"],
  }
}

function marketQuoteSnapshot(value: unknown): VogelVaultMarketQuoteSnapshot {
  const envelope = responseObject(value, ["quotes", "complete"])
  if (envelope["complete"] !== true) throw new InvalidValue("incomplete")
  const quotes = envelope["quotes"]
  if (!Array.isArray(quotes) || quotes.length !== MARKET_SYMBOLS.length) {
    throw new InvalidValue("incomplete")
  }
  const parsed = quotes.map(marketQuote)
  const symbols = new Set(parsed.map((quote) => quote.symbol))
  if (symbols.size !== MARKET_SYMBOLS.length ||
      MARKET_SYMBOLS.some((symbol) => !symbols.has(symbol))) {
    throw new InvalidValue("incomplete")
  }
  return { quotes: parsed }
}

function snapshotMeta(
  value: unknown,
  viewer: VogelVaultMember,
  scope: VogelVaultBtcScope,
): VogelVaultBtcSnapshotMeta {
  const row = responseObject(
    value,
    ["owner", "schemaVersion", "asOf", "updatedAtMs"],
  )
  const owner = member(row)
  assertVisible(viewer, owner, scope)
  return {
    owner,
    schemaVersion: int64(row, "schemaVersion"),
    asOf: text(row, "asOf"),
    ...optionalField("source", optionalText(row, "source")),
    ...optionalField("basis", optionalText(row, "basis")),
    ...optionalField("confidence", optionalText(row, "confidence")),
    updatedAtMs: timestampValue(row),
  }
}

function btcBalanceAccount(value: unknown): VogelVaultBtcBalanceDocument["accounts"][number] {
  const row = responseObject(value, ["key", "label", "custody", "sats"])
  const custody = row["custody"]
  if (custody !== "exchange" && custody !== "self_custody") throw new InvalidValue()
  const sats = int64(row, "sats")
  const legacyFiatCents = optionalInt64(row, "fiatCents")
  const valuation = fiatValuation(row, sats, legacyFiatCents)
  return {
    key: text(row, "key", 256),
    label: text(row, "label"),
    custody,
    sats,
    fiatCents: legacyFiatCents ?? valuation?.cents ?? 0n,
    fiatValuation: valuation,
  }
}

function btcBalanceDocument(
  value: unknown,
  viewer: VogelVaultMember,
  scope: VogelVaultBtcScope,
): VogelVaultBtcBalanceDocument {
  const row = responseObject(
    value,
    ["owner", "schemaVersion", "asOf", "accounts", "totals", "updatedAtMs"],
  )
  const owner = member(row)
  assertVisible(viewer, owner, scope)
  const accounts = row["accounts"]
  if (!Array.isArray(accounts) || accounts.length > CONVEX_ROW_LIMITS.maxBtcAccounts) {
    throw new InvalidValue()
  }
  const totals = responseObject(
    row["totals"],
    ["sats", "exchangeSats", "selfCustodySats"],
  )
  const totalSats = int64(totals, "sats")
  const legacyTotalFiatCents = optionalInt64(totals, "fiatCents")
  const totalValuation = fiatValuation(totals, totalSats, legacyTotalFiatCents)
  return {
    owner,
    schemaVersion: int64(row, "schemaVersion"),
    asOf: text(row, "asOf"),
    accounts: accounts.map(btcBalanceAccount),
    totals: {
      sats: totalSats,
      fiatCents: legacyTotalFiatCents ?? totalValuation?.cents ?? 0n,
      fiatValuation: totalValuation,
      exchangeSats: int64(totals, "exchangeSats"),
      selfCustodySats: int64(totals, "selfCustodySats"),
    },
    ...optionalField("source", optionalText(row, "source")),
    ...optionalField("basis", optionalText(row, "basis")),
    ...optionalField(
      "balanceConfidence",
      optionalText(row, "balanceConfidence") ?? optionalText(row, "confidence"),
    ),
    ...optionalField("confidence", optionalText(row, "confidence")),
    updatedAtMs: timestampValue(row),
  }
}

function positiveLimit(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new InvalidValue()
  return value as number
}

function rowCounts(value: unknown): VogelVaultRowCounts {
  const row = responseObject(value, [
    "transactions",
    "todos",
    "btcBuys",
    "btcBillPays",
    "btcAccounts",
    "income",
    "balanceDocuments",
    "budgetDocuments",
    "btcBalanceDocuments",
    "financeDocuments",
  ])
  return {
    transactions: nonNegativeInteger(row, "transactions"),
    todos: nonNegativeInteger(row, "todos"),
    btcBuys: nonNegativeInteger(row, "btcBuys"),
    btcBillPays: nonNegativeInteger(row, "btcBillPays"),
    // Older deployed backends predate transfer rows. Treat the missing count as
    // zero during the coordinated client/backend rollout; the list query still
    // remains strict once requested.
    btcTransfers: Object.hasOwn(row, "btcTransfers")
      ? nonNegativeInteger(row, "btcTransfers")
      : 0,
    btcAccounts: nonNegativeInteger(row, "btcAccounts"),
    income: nonNegativeInteger(row, "income"),
    balanceDocuments: nonNegativeInteger(row, "balanceDocuments"),
    budgetDocuments: nonNegativeInteger(row, "budgetDocuments"),
    btcBalanceDocuments: nonNegativeInteger(row, "btcBalanceDocuments"),
    financeDocuments: nonNegativeInteger(row, "financeDocuments"),
  }
}

function nonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = integerValue(record, key)
  if (value < 0) throw new InvalidValue()
  return value
}

/** Rejects prototypes, unknown keys, extra choices, and invalid argument ranges. */
export function validateRowRequest(value: unknown): VogelVaultRowRequest | null {
  try {
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new InvalidValue()
    const kind = value["kind"]

    switch (kind) {
      case "rowCounts":
        exactObject(value, ["kind"])
        return { kind }
      case "transactions": {
        const row = exactObject(value, ["kind"], ["month", "limit"])
        return {
          kind,
          ...optionalField("month", Object.hasOwn(row, "month") ? monthValue(row) : undefined),
          ...optionalField(
            "limit",
            Object.hasOwn(row, "limit") ? positiveLimit(row["limit"], CONVEX_ROW_LIMITS.maxTransactions) : undefined,
          ),
        }
      }
      case "income": {
        const row = exactObject(value, ["kind"], ["month", "limit"])
        return {
          kind,
          ...optionalField("month", Object.hasOwn(row, "month") ? monthValue(row) : undefined),
          ...optionalField(
            "limit",
            Object.hasOwn(row, "limit") ? positiveLimit(row["limit"], CONVEX_ROW_LIMITS.maxIncome) : undefined,
          ),
        }
      }
      case "todos": {
        const row = exactObject(value, ["kind"], ["done", "limit"])
        const done = Object.hasOwn(row, "done") ? booleanValue(row, "done") : undefined
        return {
          kind,
          ...optionalField("done", done),
          ...optionalField(
            "limit",
            Object.hasOwn(row, "limit") ? positiveLimit(row["limit"], CONVEX_ROW_LIMITS.maxTodos) : undefined,
          ),
        }
      }
      case "btcBuys": {
        const row = exactObject(value, ["kind", "scope"], ["month", "limit"])
        return {
          kind,
          scope: scopeValue(row["scope"]),
          ...optionalField("month", Object.hasOwn(row, "month") ? monthValue(row) : undefined),
          ...optionalField(
            "limit",
            Object.hasOwn(row, "limit") ? positiveLimit(row["limit"], CONVEX_ROW_LIMITS.maxBtcBuys) : undefined,
          ),
        }
      }
      case "btcAccounts": {
        const row = exactObject(value, ["kind", "scope"])
        return { kind, scope: scopeValue(row["scope"]) }
      }
      case "btcBillPays": {
        const row = exactObject(value, ["kind", "scope"], ["month", "limit"])
        return {
          kind,
          scope: scopeValue(row["scope"]),
          ...optionalField("month", Object.hasOwn(row, "month") ? monthValue(row) : undefined),
          ...optionalField(
            "limit",
            Object.hasOwn(row, "limit") ? positiveLimit(row["limit"], CONVEX_ROW_LIMITS.maxBtcBillPays) : undefined,
          ),
        }
      }
      case "btcTransfers": {
        const row = exactObject(value, ["kind", "scope"], ["month", "limit"])
        return {
          kind,
          scope: scopeValue(row["scope"]),
          ...optionalField("month", Object.hasOwn(row, "month") ? monthValue(row) : undefined),
          ...optionalField(
            "limit",
            Object.hasOwn(row, "limit") ? positiveLimit(row["limit"], CONVEX_ROW_LIMITS.maxBtcTransfers) : undefined,
          ),
        }
      }
      case "budget": {
        const row = exactObject(value, ["kind", "scope"])
        if (row["scope"] !== "netWorth") throw new InvalidValue()
        return { kind, scope: "netWorth" }
      }
      case "btcSnapshotMeta": {
        const row = exactObject(value, ["kind", "scope"])
        return { kind, scope: scopeValue(row["scope"]) }
      }
      case "btcBalanceDocuments": {
        const row = exactObject(value, ["kind", "scope"])
        return { kind, scope: scopeValue(row["scope"]) }
      }
      case "finance": {
        const row = exactObject(value, ["kind", "scope"])
        if (row["scope"] !== "netWorth") throw new InvalidValue()
        return { kind, scope: "netWorth" }
      }
      case "marketQuotes":
        exactObject(value, ["kind"])
        return { kind }
      default:
        throw new InvalidValue()
    }
  } catch {
    return null
  }
}

function requestArgs(request: ResolvedRowRequest, credential: string | null): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  switch (request.kind) {
    case "rowCounts":
      break
    case "transactions":
    case "income":
      args.viewer = request.viewer
      if (request.month !== undefined) args.month = request.month
      if (request.limit !== undefined) args.limit = request.limit
      break
    case "btcBillPays":
    case "btcTransfers":
      args.viewer = request.viewer
      args.scope = request.scope
      if (request.month !== undefined) args.month = request.month
      if (request.limit !== undefined) args.limit = request.limit
      break
    case "todos":
      args.viewer = request.viewer
      if (request.done !== undefined) args.done = request.done
      if (request.limit !== undefined) args.limit = request.limit
      break
    case "btcBuys":
      args.viewer = request.viewer
      args.scope = request.scope
      if (request.month !== undefined) args.month = request.month
      if (request.limit !== undefined) args.limit = request.limit
      break
    case "btcAccounts":
    case "btcSnapshotMeta":
    case "btcBalanceDocuments":
    case "finance":
      args.viewer = request.viewer
      args.scope = request.scope
      break
    case "marketQuotes":
      break
    case "budget":
      args.viewer = request.viewer
      args.scope = request.scope
      break
  }
  if (credential !== null) args.token = credential
  return args
}

function parseListEnvelope<T>(
  value: unknown,
  requestLimit: number | undefined,
  hardLimit: number,
  parseRow: (row: unknown) => T,
): { rows: T[]; complete: boolean } {
  const envelope = responseObject(value, ["rows", "complete"])
  const rows = envelope["rows"]
  if (!Array.isArray(rows) || typeof envelope["complete"] !== "boolean") throw new InvalidValue()
  if (rows.length > hardLimit || (requestLimit !== undefined && rows.length > requestLimit)) throw new InvalidValue()
  const complete = envelope["complete"]
  if (requestLimit === undefined ? !complete : complete) throw new InvalidValue("incomplete")
  return { rows: rows.map(parseRow), complete }
}

function parseDocumentEnvelope<T>(
  value: unknown,
  key: "document",
  parseDocument: (document: unknown) => T | null,
): T | null {
  const envelope = responseObject(value, [key, "complete"])
  if (envelope["complete"] !== true) throw new InvalidValue("incomplete")
  return parseDocument(envelope[key])
}

function successValue(response: JsonPostResponse): unknown | "unauthorized" {
  if (response.truncated === true || Buffer.byteLength(response.body, "utf8") > CONVEX_ROW_LIMITS.maxResponseBytes) {
    throw new RangeError()
  }
  if (response.httpStatus !== 200) throw new InvalidValue()

  let envelope: unknown
  try {
    envelope = JSON.parse(response.body)
  } catch {
    throw new InvalidValue()
  }
  if (!isRecord(envelope)) throw new InvalidValue()
  if (envelope["status"] === "success") return envelope["value"]
  if (envelope["status"] === "error") {
    const message = envelope["errorData"] ?? envelope["errorMessage"]
    if (typeof message === "string" && /unauthorized/i.test(message)) return "unauthorized"
  }
  throw new InvalidValue()
}

function parseResponse(
  request: ResolvedRowRequest,
  response: JsonPostResponse,
): VogelVaultRowResult {
  let value: unknown | "unauthorized"
  try {
    value = successValue(response)
  } catch (error) {
    return { status: "error", code: error instanceof RangeError ? "response-too-large" : "invalid-response" }
  }
  if (value === "unauthorized") return { status: "error", code: "unauthorized" }

  try {
    switch (request.kind) {
      case "rowCounts":
        return { status: "ok", kind: request.kind, value: rowCounts(value) }
      case "transactions": {
        const list = parseListEnvelope(
          value,
          request.limit,
          CONVEX_ROW_LIMITS.maxTransactions,
          (row) => transaction(row, request.viewer),
        )
        return { status: "ok", kind: request.kind, ...list }
      }
      case "income": {
        const list = parseListEnvelope(
          value,
          request.limit,
          CONVEX_ROW_LIMITS.maxIncome,
          (row) => income(row, request.viewer),
        )
        return { status: "ok", kind: request.kind, ...list }
      }
      case "todos": {
        const list = parseListEnvelope(
          value,
          request.limit,
          CONVEX_ROW_LIMITS.maxTodos,
          (row) => todo(row, request.viewer),
        )
        return { status: "ok", kind: request.kind, ...list }
      }
      case "btcBuys": {
        const list = parseListEnvelope(
          value,
          request.limit,
          CONVEX_ROW_LIMITS.maxBtcBuys,
          (row) => btcBuy(row, request.viewer, request.scope),
        )
        return { status: "ok", kind: request.kind, ...list }
      }
      case "btcAccounts": {
        const list = parseListEnvelope(
          value,
          undefined,
          CONVEX_ROW_LIMITS.maxBtcAccounts,
          (row) => btcAccount(row, request.viewer, request.scope),
        )
        return { status: "ok", kind: request.kind, ...list }
      }
      case "btcBillPays": {
        const list = parseListEnvelope(
          value,
          request.limit,
          CONVEX_ROW_LIMITS.maxBtcBillPays,
          (row) => btcBillPay(row, request.viewer, request.scope),
        )
        return { status: "ok", kind: request.kind, ...list }
      }
      case "btcTransfers": {
        const list = parseListEnvelope(
          value,
          request.limit,
          CONVEX_ROW_LIMITS.maxBtcTransfers,
          (row) => btcTransfer(row, request.viewer, request.scope),
        )
        return { status: "ok", kind: request.kind, ...list }
      }
      case "budget":
        return {
          status: "ok",
          kind: request.kind,
          value: parseDocumentEnvelope(value, "document", (document) => budgetDocument(document, request.viewer)),
        }
      case "btcSnapshotMeta": {
        const list = parseListEnvelope(
          value,
          undefined,
          CONVEX_ROW_LIMITS.maxBtcAccounts,
          (row) => snapshotMeta(row, request.viewer, request.scope),
        )
        return { status: "ok", kind: request.kind, ...list }
      }
      case "btcBalanceDocuments": {
        const list = parseListEnvelope(
          value,
          undefined,
          CONVEX_ROW_LIMITS.maxBtcBalanceDocuments,
          (row) => btcBalanceDocument(row, request.viewer, request.scope),
        )
        return { status: "ok", kind: request.kind, ...list }
      }
      case "finance":
        return {
          status: "ok",
          kind: request.kind,
          value: parseDocumentEnvelope(
            value,
            "document",
            (document) => financeDocument(document, request.viewer, request.scope),
          ),
        }
      case "marketQuotes":
        return { status: "ok", kind: request.kind, value: marketQuoteSnapshot(value) }
    }
  } catch (error) {
    if (error instanceof InvalidValue && error.message === "incomplete") {
      return { status: "error", code: "incomplete-response" }
    }
    return { status: "error", code: "invalid-response" }
  }
}

export interface ConvexRowRepository {
  query(request: unknown, activeProfile?: unknown): Promise<VogelVaultRowResult>
  /**
   * Drop cached answers for the given request kinds so the next read goes to the
   * server. A write that changes balances must not be followed by a cached
   * pre-write answer, or the saved row appears to vanish for up to `cacheMs`.
   * Passing no kinds clears everything.
   */
  invalidate(kinds?: readonly string[]): void
}

export interface ConvexRowRepositoryOptions {
  readonly configuration: () => RemoteReadConfiguration
  readonly post: JsonPoster
  readonly now?: () => number
}

/**
 * Main-process repository with one cache/in-flight slot per request and config generation.
 * A switch, endpoint, or credential change increments the generation before lookup, so no
 * answer obtained under an old configuration can be reused under the new one.
 */
export function createConvexRowRepository(options: ConvexRowRepositoryOptions): ConvexRowRepository {
  const now = options.now ?? Date.now
  const cache = new Map<string, { expiresAt: number; result: VogelVaultRowResult }>()
  const inFlight = new Map<string, Promise<VogelVaultRowResult>>()
  let activeGeneration = -1

  return {
    invalidate(kinds?: readonly string[]): void {
      if (kinds === undefined || kinds.length === 0) {
        cache.clear()
        return
      }
      // Cache keys embed the serialised request, so a kind match is a substring
      // check against that serialisation rather than a parsed field.
      for (const key of [...cache.keys()]) {
        if (kinds.some((kind) => key.includes(`"kind":"${kind}"`))) cache.delete(key)
      }
    },
    query(input: unknown, activeProfile?: unknown): Promise<VogelVaultRowResult> {
      const request = validateRowRequest(input)
      if (request === null) return Promise.resolve({ status: "error", code: "invalid-request" })
      if (!(MEMBERS as readonly unknown[]).includes(activeProfile)) {
        return Promise.resolve({ status: "error", code: "invalid-request" })
      }
      const resolvedRequest: ResolvedRowRequest = request.kind === "rowCounts" || request.kind === "marketQuotes"
        ? request
        : { ...request, viewer: activeProfile as VogelVaultMember }

      const configuration = options.configuration()
      if (configuration.generation !== activeGeneration) {
        activeGeneration = configuration.generation
        cache.clear()
      }
      switch (configuration.settings.readiness) {
        case "disabled":
          return Promise.resolve({ status: "error", code: "disabled" })
        case "unconfigured":
        case "insecure-endpoint":
          return Promise.resolve({ status: "error", code: "unconfigured" })
        case "ready-unauthenticated":
          return Promise.resolve({ status: "error", code: "unauthorized" })
        case "ready":
          break
      }

      const endpoint = configuration.settings.endpoint
      if (endpoint === null) return Promise.resolve({ status: "error", code: "unconfigured" })

      const cacheKey = `${configuration.generation}:${JSON.stringify(resolvedRequest)}`
      const cached = cache.get(cacheKey)
      const currentTime = now()
      if (cached !== undefined && cached.expiresAt > currentTime) return Promise.resolve(cached.result)
      if (cached !== undefined) cache.delete(cacheKey)
      const pending = inFlight.get(cacheKey)
      if (pending !== undefined) return pending
      if (inFlight.size >= CONVEX_ROW_LIMITS.maxInFlightRequests) {
        return Promise.resolve({ status: "error", code: "unavailable" })
      }

      const body = JSON.stringify({
        path: ROW_QUERY_PATHS[resolvedRequest.kind],
        args: requestArgs(resolvedRequest, configuration.settings.credentialOrNull()),
        format: "convex_encoded_json",
      })
      const started = options
        .post(endpoint, body, CONVEX_ROW_LIMITS.maxResponseBytes)
        .then((response) => parseResponse(resolvedRequest, response))
        .catch((): VogelVaultRowResult => ({ status: "error", code: "unavailable" }))
        .then((result) => {
          cache.set(cacheKey, { expiresAt: now() + CONVEX_ROW_LIMITS.cacheMs, result })
          while (cache.size > CONVEX_ROW_LIMITS.maxCachedRequests) {
            const oldest = cache.keys().next().value
            if (oldest === undefined) break
            cache.delete(oldest)
          }
          return result
        })
        .finally(() => {
          inFlight.delete(cacheKey)
        })
      inFlight.set(cacheKey, started)
      return started
    },
  }
}
