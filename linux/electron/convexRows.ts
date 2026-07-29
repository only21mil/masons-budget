// Strict Convex row transport. MAIN PROCESS ONLY.
//
// This module owns the untrusted HTTP-to-IPC transition. It accepts one closed
// request union, sends one fixed query path per request, decodes Convex int64s,
// and constructs public DTOs field-by-field. Remote bodies, server-authored text,
// deployment configuration, Convex internals, and migration fields never leave it.

import { Buffer } from "node:buffer"

import type {
  VogelVaultBtcAccountRow,
  VogelVaultBtcBalanceDocument,
  VogelVaultBtcBillPayRow,
  VogelVaultBtcBuyRow,
  VogelVaultBtcScope,
  VogelVaultBtcSnapshotMeta,
  VogelVaultBudgetCategory,
  VogelVaultBudgetDocument,
  VogelVaultBudgetHistoryEntry,
  VogelVaultBudgetIncome,
  VogelVaultBudgetPaycheck,
  VogelVaultMember,
  VogelVaultIncomeRow,
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
  budget: "tables:getBudgetDocument",
  btcSnapshotMeta: "tables:getBtcSnapshotMetadata",
  btcBalanceDocuments: "tables:listBtcBalanceDocuments",
} as const

export const CONVEX_ROW_LIMITS = {
  maxResponseBytes: 4 * 1_048_576,
  maxTransactions: 2_000,
  maxIncome: 2_000,
  maxTodos: 1_000,
  maxBtcBuys: 1_000,
  maxBtcAccounts: 256,
  maxBtcBillPays: 1_000,
  maxBtcBalanceDocuments: 256,
  maxBudgetCategories: 256,
  maxBudgetPaychecks: 512,
  maxBudgetHistory: 240,
  maxStringLength: 16_384,
  cacheMs: 5_000,
  maxCachedRequests: 64,
  // One renderer refresh fans out to nine independent row queries after
  // rowCounts. Keep the guard large enough for that single trusted load.
  maxInFlightRequests: 9,
} as const

const MEMBERS = ["victor", "rachel", "mason", "maddox"] as const
const ADULTS: ReadonlySet<VogelVaultMember> = new Set(["victor", "rachel"])
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const BUDGET_MONTH = /^(?:\d{4}-(?:0[1-9]|1[0-2])|(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4})$/
const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/
const BASE64_INT64 = /^(?:[A-Za-z0-9+/]{4}){2}[A-Za-z0-9+/]{3}=$/
const TWO_64 = 1n << 64n
const SIGN_64 = 1n << 63n

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
    ["key", "owner", "label", "custody", "sats", "fiatCents", "asOf", "schemaVersion", "updatedAtMs"],
  )
  const owner = member(row)
  assertVisible(viewer, owner, scope)
  const custody = row["custody"]
  if (custody !== "exchange" && custody !== "self_custody") throw new InvalidValue()
  return {
    key: text(row, "key", 256),
    owner,
    label: text(row, "label"),
    custody,
    sats: int64(row, "sats"),
    fiatCents: int64(row, "fiatCents"),
    asOf: text(row, "asOf"),
    schemaVersion: int64(row, "schemaVersion"),
    updatedAtMs: timestampValue(row),
  }
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
  return {
    billPayId: text(row, "billPayId", 256),
    owner,
    date,
    month,
    merchant: text(row, "merchant"),
    category: text(row, "category"),
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
  const row = responseObject(value, ["key", "label", "custody", "sats", "fiatCents"])
  const custody = row["custody"]
  if (custody !== "exchange" && custody !== "self_custody") throw new InvalidValue()
  return {
    key: text(row, "key", 256),
    label: text(row, "label"),
    custody,
    sats: int64(row, "sats"),
    fiatCents: int64(row, "fiatCents"),
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
    ["sats", "fiatCents", "exchangeSats", "selfCustodySats"],
  )
  return {
    owner,
    schemaVersion: int64(row, "schemaVersion"),
    asOf: text(row, "asOf"),
    accounts: accounts.map(btcBalanceAccount),
    totals: {
      sats: int64(totals, "sats"),
      fiatCents: int64(totals, "fiatCents"),
      exchangeSats: int64(totals, "exchangeSats"),
      selfCustodySats: int64(totals, "selfCustodySats"),
    },
    ...optionalField("source", optionalText(row, "source")),
    ...optionalField("basis", optionalText(row, "basis")),
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
        const viewer = member(value, "viewer")
        const row = exactObject(value, ["kind", "viewer"], ["month", "limit"])
        return {
          kind,
          viewer,
          ...optionalField("month", Object.hasOwn(row, "month") ? monthValue(row) : undefined),
          ...optionalField(
            "limit",
            Object.hasOwn(row, "limit") ? positiveLimit(row["limit"], CONVEX_ROW_LIMITS.maxTransactions) : undefined,
          ),
        }
      }
      case "income": {
        const viewer = member(value, "viewer")
        const row = exactObject(value, ["kind", "viewer"], ["month", "limit"])
        return {
          kind,
          viewer,
          ...optionalField("month", Object.hasOwn(row, "month") ? monthValue(row) : undefined),
          ...optionalField(
            "limit",
            Object.hasOwn(row, "limit") ? positiveLimit(row["limit"], CONVEX_ROW_LIMITS.maxIncome) : undefined,
          ),
        }
      }
      case "todos": {
        const viewer = member(value, "viewer")
        const row = exactObject(value, ["kind", "viewer"], ["done", "limit"])
        const done = Object.hasOwn(row, "done") ? booleanValue(row, "done") : undefined
        return {
          kind,
          viewer,
          ...optionalField("done", done),
          ...optionalField(
            "limit",
            Object.hasOwn(row, "limit") ? positiveLimit(row["limit"], CONVEX_ROW_LIMITS.maxTodos) : undefined,
          ),
        }
      }
      case "btcBuys": {
        const viewer = member(value, "viewer")
        const row = exactObject(value, ["kind", "viewer", "scope"], ["month", "limit"])
        return {
          kind,
          viewer,
          scope: scopeValue(row["scope"]),
          ...optionalField("month", Object.hasOwn(row, "month") ? monthValue(row) : undefined),
          ...optionalField(
            "limit",
            Object.hasOwn(row, "limit") ? positiveLimit(row["limit"], CONVEX_ROW_LIMITS.maxBtcBuys) : undefined,
          ),
        }
      }
      case "btcAccounts": {
        const viewer = member(value, "viewer")
        const row = exactObject(value, ["kind", "viewer", "scope"])
        return { kind, viewer, scope: scopeValue(row["scope"]) }
      }
      case "btcBillPays": {
        const viewer = member(value, "viewer")
        const row = exactObject(value, ["kind", "viewer", "scope"], ["month", "limit"])
        return {
          kind,
          viewer,
          scope: scopeValue(row["scope"]),
          ...optionalField("month", Object.hasOwn(row, "month") ? monthValue(row) : undefined),
          ...optionalField(
            "limit",
            Object.hasOwn(row, "limit") ? positiveLimit(row["limit"], CONVEX_ROW_LIMITS.maxBtcBillPays) : undefined,
          ),
        }
      }
      case "budget": {
        const viewer = member(value, "viewer")
        const row = exactObject(value, ["kind", "viewer", "scope"])
        if (row["scope"] !== "netWorth") throw new InvalidValue()
        return { kind, viewer, scope: "netWorth" }
      }
      case "btcSnapshotMeta": {
        const viewer = member(value, "viewer")
        const row = exactObject(value, ["kind", "viewer", "scope"])
        return { kind, viewer, scope: scopeValue(row["scope"]) }
      }
      case "btcBalanceDocuments": {
        const viewer = member(value, "viewer")
        const row = exactObject(value, ["kind", "viewer", "scope"])
        return { kind, viewer, scope: scopeValue(row["scope"]) }
      }
      default:
        throw new InvalidValue()
    }
  } catch {
    return null
  }
}

function requestArgs(request: VogelVaultRowRequest, credential: string | null): Record<string, unknown> {
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
      args.viewer = request.viewer
      args.scope = request.scope
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
  request: VogelVaultRowRequest,
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
    }
  } catch (error) {
    if (error instanceof InvalidValue && error.message === "incomplete") {
      return { status: "error", code: "incomplete-response" }
    }
    return { status: "error", code: "invalid-response" }
  }
}

export interface ConvexRowRepository {
  query(request: unknown): Promise<VogelVaultRowResult>
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
    query(input: unknown): Promise<VogelVaultRowResult> {
      const request = validateRowRequest(input)
      if (request === null) return Promise.resolve({ status: "error", code: "invalid-request" })

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

      const cacheKey = `${configuration.generation}:${JSON.stringify(request)}`
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
        path: ROW_QUERY_PATHS[request.kind],
        args: requestArgs(request, configuration.settings.credentialOrNull()),
        format: "convex_encoded_json",
      })
      const started = options
        .post(endpoint, body, CONVEX_ROW_LIMITS.maxResponseBytes)
        .then((response) => parseResponse(request, response))
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
