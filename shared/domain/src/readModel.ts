// The Vogel Vault — MC2 read model.
//
// Convex stores each MC2 JSON file verbatim in `dataFiles` (name, data, version,
// updatedAt) and the app decodes it client-side. These types mirror
// MasonsBudget/MasonsBudget/Services/MC2DTOs.swift.
//
// Conventions carried over from AGENTS.md:
//   - MC2 JSON is snake_case; this layer exposes camelCase.
//   - Money never touches float — raw values are kept lexically and converted to
//     integer minor units via ./money.
//   - Optional in the DTO means "may be absent in JSON". Default in the
//     normalizer, never in the type.

import { type FamilyMember, coerceOwner } from "./family.ts"
import { type Cents, type Sats, parseBtcToSats, parseCents } from "./money.ts"

/** Every MC2 file the clients read. Mirrors MC2Reader / MC2SyncService. */
export const MC2_FILES = [
  "transactions",
  "budget",
  "bitcoin-buys",
  "bitcoin-bill-pays",
  "btc-balance-snapshot",
  "finances",
  "todos",
  "mason-transactions",
  "mason-budget",
  "mason-bitcoin-buys",
  "maddox-transactions",
  "son-balances",
] as const

export type MC2FileName = (typeof MC2_FILES)[number]

/** Freshness of a slice of the read model, surfaced explicitly in the UI. */
export type Freshness = "live" | "stale" | "error" | "empty" | "loading"

export interface DataFileEnvelope<T> {
  readonly name: string
  readonly data: T
  readonly version: number
  readonly updatedAt: number
}

export interface SliceState<T> {
  readonly status: Freshness
  readonly value: T
  /** Unix ms of the MC2 write this slice came from; null when never loaded. */
  readonly updatedAt: number | null
  readonly source: string
  readonly error?: string
}

export function emptySlice<T>(value: T, source: string): SliceState<T> {
  return { status: "empty", value, updatedAt: null, source }
}

// ── Transactions ────────────────────────────────────────────────────────────

export interface Transaction {
  readonly id: string
  readonly date: string
  readonly merchant: string
  /** Signed, as MC2 reports it. Negative is money out for adult files. */
  readonly amount: Cents
  readonly category: string
  readonly card: string | null
  readonly note: string | null
  readonly owner: FamilyMember
}

/**
 * Spend magnitude for budget maths.
 *
 * Adult MC2 files sign spending negative and income positive. The child files
 * record spending as a positive magnitude, which is why the Swift tests expect
 * Mason's 60 "Game Store" row to count as 60 of spend rather than income. Taking
 * the magnitude of anything that is not an Income row reproduces that on both
 * shapes without needing to know which file it came from.
 */
export function spendAmount(transaction: Transaction): Cents {
  if (transaction.category === "Income") return 0n
  return transaction.amount < 0n ? -transaction.amount : transaction.amount
}

export function isSpend(transaction: Transaction): boolean {
  return spendAmount(transaction) > 0n
}

export function normalizeTransaction(raw: Record<string, unknown>, fallbackOwner?: FamilyMember): Transaction {
  return {
    id: String(raw.id ?? ""),
    date: String(raw.date ?? ""),
    merchant: String(raw.merchant ?? ""),
    amount: parseCents(raw.amount),
    category: String(raw.category ?? "Other"),
    card: optionalString(raw.card),
    note: optionalString(raw.note),
    owner: raw.owner === undefined && fallbackOwner ? fallbackOwner : coerceOwner(raw.owner),
  }
}

// ── Budget ──────────────────────────────────────────────────────────────────

export interface BudgetCategory {
  readonly name: string
  readonly icon: string | null
  readonly budget: Cents
  readonly spent: Cents
}

export interface Paycheck {
  readonly date: string
  readonly platform: string | null
  readonly source: string | null
  readonly amount: Cents
  readonly net: Cents
  readonly note: string | null
}

export interface BudgetIncome {
  readonly weeklyGross: Cents
  readonly weeklyStrike: Cents
  readonly weeklyRiver: Cents
  readonly payFrequency: string | null
  readonly monthlyGross: Cents
  readonly mtdIncome: Cents
  readonly ytdIncome: Cents
  readonly paychecks: readonly Paycheck[]
}

export interface MonthlyHistoryEntry {
  readonly month: string
  readonly income: Cents
  readonly expenses: Cents
  /** Savings rate in basis points; MC2 reports a percentage. */
  readonly savingsBps: number
}

export interface Budget {
  readonly month: string
  readonly coinbaseOneBalance: Cents
  readonly categories: readonly BudgetCategory[]
  readonly effectiveApr: string | null
  readonly strategyNote: string | null
  readonly income: BudgetIncome | null
  readonly mtdIncome: Cents
  readonly ytdIncome: Cents
  readonly monthlyHistory: readonly MonthlyHistoryEntry[]
  readonly owner: FamilyMember
}

export function normalizeBudget(raw: Record<string, unknown>, owner: FamilyMember): Budget {
  const strategy = asRecord(raw.strategy)
  const income = asRecord(raw.income)
  return {
    month: String(raw.month ?? ""),
    coinbaseOneBalance: parseCents(raw.coinbase_one_balance),
    categories: asArray(raw.categories).map((entry) => ({
      name: String(entry.name ?? ""),
      icon: optionalString(entry.icon),
      budget: parseCents(entry.budget),
      spent: parseCents(entry.spent),
    })),
    effectiveApr: strategy ? optionalString(strategy.effective_apr) : null,
    strategyNote: strategy ? optionalString(strategy.strategy_note) : null,
    income: income
      ? {
          weeklyGross: parseCents(income.weekly_gross),
          weeklyStrike: parseCents(income.weekly_strike),
          weeklyRiver: parseCents(income.weekly_river),
          payFrequency: optionalString(income.pay_frequency),
          monthlyGross: parseCents(income.monthly_gross),
          mtdIncome: parseCents(income.mtd_income),
          ytdIncome: parseCents(income.ytd_income),
          paychecks: asArray(income.paychecks).map((entry) => ({
            date: String(entry.date ?? ""),
            platform: optionalString(entry.platform),
            source: optionalString(entry.source),
            amount: parseCents(entry.amount),
            net: parseCents(entry.net),
            note: optionalString(entry.note),
          })),
        }
      : null,
    mtdIncome: parseCents(raw.mtd_income),
    ytdIncome: parseCents(raw.ytd_income),
    monthlyHistory: asArray(raw.monthly_history).map((entry) => ({
      month: String(entry.month ?? ""),
      income: parseCents(entry.income),
      expenses: parseCents(entry.expenses),
      savingsBps: Number(parseCents(entry.savings_pct)),
    })),
    owner,
  }
}

// ── Bitcoin ─────────────────────────────────────────────────────────────────

export type BTCCustody = "exchange" | "self_custody"

export interface BTCAccount {
  readonly key: string
  readonly label: string
  readonly custody: BTCCustody
  readonly sats: Sats
  readonly fiat: Cents
  readonly owner: FamilyMember
}

export interface BTCTotals {
  readonly sats: Sats
  readonly fiat: Cents
  readonly exchangeSats: Sats
  readonly selfCustodySats: Sats
}

export interface BTCSnapshot {
  readonly schemaVersion: number
  readonly asOf: string
  readonly accounts: readonly BTCAccount[]
  readonly totals: BTCTotals
  readonly source: string | null
  readonly basis: string | null
  readonly confidence: string | null
}

export interface BTCBuy {
  readonly id: string
  readonly date: string
  readonly source: string
  readonly sats: Sats
  readonly priceUsd: Cents
  readonly usd: Cents
  readonly note: string | null
  readonly status: string | null
  readonly costBasisStatus: string | null
  readonly loggedBy: string | null
  readonly owner: FamilyMember
}

export interface BTCBillPay {
  readonly id: string
  readonly date: string
  readonly merchant: string
  readonly category: string
  readonly amountUsd: Cents
  readonly btcSpentSats: Sats
  readonly btcPrice: Cents
  readonly platform: string | null
  readonly note: string | null
  readonly feeUsd: Cents
  readonly reference: string | null
  readonly owner: FamilyMember
}

export function normalizeBTCSnapshot(raw: Record<string, unknown>, owner: FamilyMember): BTCSnapshot {
  const accountsRaw = asRecord(raw.accounts) ?? {}
  const totals = asRecord(raw.totals) ?? {}
  const metadata = asRecord(raw.metadata)
  return {
    schemaVersion: Number(raw.schemaVersion ?? 0),
    asOf: String(raw.asOf ?? ""),
    accounts: Object.entries(accountsRaw).map(([key, value]) => {
      const entry = asRecord(value) ?? {}
      return {
        key,
        label: String(entry.label ?? key),
        custody: entry.custody === "self_custody" ? "self_custody" : "exchange",
        sats: parseBtcToSats(entry.btc),
        fiat: parseCents(entry.fiat),
        owner,
      }
    }),
    totals: {
      sats: parseBtcToSats(totals.btc),
      fiat: parseCents(totals.fiat),
      exchangeSats: parseBtcToSats(totals.exchange_btc),
      selfCustodySats: parseBtcToSats(totals.self_custody_btc),
    },
    source: metadata ? optionalString(metadata.source) : null,
    basis: metadata ? optionalString(metadata.basis) : null,
    confidence: metadata ? optionalString(metadata.confidence) : null,
  }
}

export function normalizeBTCBuy(raw: Record<string, unknown>, fallbackOwner?: FamilyMember): BTCBuy {
  return {
    id: String(raw.id ?? ""),
    date: String(raw.date ?? ""),
    source: String(raw.source ?? ""),
    // amount_sats is authoritative; amount_btc is a convenience mirror.
    sats: raw.amount_sats !== undefined ? BigInt(String(raw.amount_sats)) : parseBtcToSats(raw.amount_btc),
    priceUsd: parseCents(raw.price_usd),
    usd: parseCents(raw.usd),
    note: optionalString(raw.note),
    status: optionalString(raw.status),
    costBasisStatus: optionalString(raw.cost_basis_status),
    loggedBy: optionalString(raw.logged_by),
    owner: raw.owner === undefined && fallbackOwner ? fallbackOwner : coerceOwner(raw.owner),
  }
}

export function normalizeBTCBillPay(raw: Record<string, unknown>, fallbackOwner?: FamilyMember): BTCBillPay {
  return {
    id: String(raw.id ?? ""),
    date: String(raw.date ?? ""),
    merchant: String(raw.merchant ?? ""),
    category: String(raw.category ?? "Other"),
    amountUsd: parseCents(raw.amount_usd),
    btcSpentSats: parseBtcToSats(raw.btc_spent),
    btcPrice: parseCents(raw.btc_price),
    platform: optionalString(raw.platform),
    note: optionalString(raw.note),
    feeUsd: parseCents(raw.fee_usd),
    reference: optionalString(raw.reference),
    owner: raw.owner === undefined && fallbackOwner ? fallbackOwner : coerceOwner(raw.owner),
  }
}

// ── Todos ───────────────────────────────────────────────────────────────────

export interface TodoItem {
  readonly id: string
  readonly title: string
  readonly done: boolean
  readonly project: string | null
  readonly area: string | null
  readonly due: string | null
  readonly flagged: boolean
  readonly notes: string | null
  readonly owner: FamilyMember
}

export function normalizeTodo(raw: Record<string, unknown>, fallbackOwner?: FamilyMember): TodoItem {
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    done: Boolean(raw.done ?? raw.completed ?? false),
    project: optionalString(raw.project),
    area: optionalString(raw.area),
    due: optionalString(raw.due),
    flagged: Boolean(raw.flagged ?? false),
    notes: optionalString(raw.notes ?? raw.note),
    owner: raw.owner === undefined && fallbackOwner ? fallbackOwner : coerceOwner(raw.owner),
  }
}

// ── Aggregate read model ────────────────────────────────────────────────────

export interface ReadModel {
  readonly activeMember: FamilyMember
  readonly transactions: SliceState<readonly Transaction[]>
  readonly budget: SliceState<Budget | null>
  readonly btcSnapshot: SliceState<BTCSnapshot | null>
  readonly btcBuys: SliceState<readonly BTCBuy[]>
  readonly billPays: SliceState<readonly BTCBillPay[]>
  readonly todos: SliceState<readonly TodoItem[]>
}

// ── helpers ─────────────────────────────────────────────────────────────────

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text === "" ? null : text
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
}
