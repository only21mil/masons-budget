// The Vogel Vault — shared financial read model.
//
// Runtime clients read Convex row tables through authenticated HTTP queries.
// Row normalizers preserve the field aliases still present in stored records,
// but no separate upstream or sync service participates in reads.
//
// Conventions carried over from AGENTS.md:
//   - Stored wire fields may be snake_case; this layer exposes camelCase.
//   - Money never touches float — raw values are kept lexically and converted to
//     integer minor units via ./money.
//   - Optional in the DTO means "may be absent in JSON". Default in the
//     normalizer, never in the type.

import {
  type FamilyMember,
  coerceOwner,
  isAdult,
  netWorthScopeFor,
  visibleTo,
} from "./family.ts"
import { type Cents, type Sats, parseBtcToSats, parseCents, parseMinorUnits } from "./money.ts"

/** Freshness of a slice of the read model, surfaced explicitly in the UI. */
export type Freshness = "demo" | "live" | "stale" | "error" | "empty" | "loading"

export interface SliceState<T> {
  readonly status: Freshness
  readonly value: T
  /** Unix ms of the remote write this slice came from; null for demo or never-loaded data. */
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
  /** Exact row revision used for optimistic concurrency. */
  readonly updatedAtMs: number
  readonly date: string
  readonly merchant: string
  /** Signed stored amount. Positive is money out; negative is a credit/refund. */
  readonly amount: Cents
  readonly category: string
  readonly card: string | null
  readonly note: string | null
  readonly owner: FamilyMember
}

/**
 * Signed contribution to budget spend.
 *
 * Adult and child rows both store purchases as positive amounts. Credits and
 * refunds are negative so they reduce actual spend. Income contributes zero.
 */
export function spendAmount(transaction: Transaction): Cents {
  if (transaction.category === "Income") return 0n
  return transaction.amount
}

/** Stable non-negative magnitude for rendering, including wrong-sign rows. */
export function displaySpendAmount(transaction: Transaction): Cents {
  const spend = spendAmount(transaction)
  return spend < 0n ? -spend : spend
}

/**
 * True when a non-Income row is a credit/refund that reduces spend.
 */
export function hasOppositeSpendSign(transaction: Transaction): boolean {
  return spendAmount(transaction) < 0n
}

export function isSpend(transaction: Transaction): boolean {
  return transaction.category !== "Income" && transaction.amount !== 0n
}

export function normalizeTransaction(raw: Record<string, unknown>, fallbackOwner?: FamilyMember): Transaction {
  return {
    id: String(raw.id ?? ""),
    updatedAtMs: timestampMillis(raw.updatedAtMs ?? raw.updated_at_ms),
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
  /** Savings rate in basis points; the retained blob projection reports a percentage. */
  readonly savingsBps: number
}

export interface Budget {
  /** Exact enclosing document revision used for category writes. */
  readonly updatedAtMs: number
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
    updatedAtMs: timestampMillis(raw.updatedAtMs ?? raw.updated_at_ms),
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

/**
 * An optional USD valuation with evidence independent from the BTC balance.
 *
 * `cents` may legitimately be zero. A missing object means no supported USD
 * value exists; callers must not infer availability from balance confidence.
 */
export interface FiatValuation {
  readonly cents: Cents
  readonly priceCents: Cents | null
  readonly quotedAt: string | null
  readonly source: string | null
  readonly confidence: string | null
}

export interface BTCAccount {
  readonly key: string
  /** Exact row-mirror revision; account writes use the enclosing snapshot revision. */
  readonly updatedAtMs: number
  readonly asOf: string
  readonly label: string
  readonly custody: BTCCustody
  readonly sats: Sats
  /** @deprecated Transition-only mirror. Render `fiatValuation`, never this field. */
  readonly fiat: Cents
  readonly fiatValuation?: FiatValuation | null
  readonly owner: FamilyMember
}

export interface BTCTotals {
  readonly sats: Sats
  /** @deprecated Transition-only mirror. Render `fiatValuation`, never this field. */
  readonly fiat: Cents
  readonly fiatValuation?: FiatValuation | null
  readonly exchangeSats: Sats
  readonly selfCustodySats: Sats
}

export interface BTCSnapshot {
  /** Exact enclosing balance-document revision used for account writes. */
  readonly updatedAtMs: number
  readonly schemaVersion: number
  readonly asOf: string
  readonly accounts: readonly BTCAccount[]
  readonly totals: BTCTotals
  readonly source: string | null
  readonly basis: string | null
  /** Confidence in the sats balance only. */
  readonly balanceConfidence?: string | null
  /** @deprecated Transition-only alias for balanceConfidence. */
  readonly confidence: string | null
}

export interface BTCBuy {
  readonly id: string
  /** Exact row revision used for optimistic concurrency. */
  readonly updatedAtMs: number
  readonly date: string
  readonly source: string
  readonly sats: Sats
  readonly priceUsd: Cents
  readonly usd: Cents
  readonly note: string | null
  readonly status: string | null
  readonly costBasisStatus: string | null
  readonly loggedBy: string | null
  readonly archimedesRequestId: string | null
  readonly owner: FamilyMember
}

export interface BTCBillPay {
  readonly id: string
  /** Exact row revision used for optimistic concurrency. */
  readonly updatedAtMs: number
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
  const balanceConfidence = metadata ? optionalString(metadata.confidence) : null
  return {
    updatedAtMs: timestampMillis(raw.updatedAtMs ?? raw.updated_at_ms),
    schemaVersion: Number(raw.schemaVersion ?? 0),
    asOf: String(raw.asOf ?? ""),
    accounts: Object.entries(accountsRaw).map(([key, value]) => {
      const entry = asRecord(value) ?? {}
      const sats = parseBtcToSats(entry.btc)
      const legacyFiat = parseCents(entry.fiat)
      return {
        key,
        updatedAtMs: timestampMillis(entry.updatedAtMs ?? entry.updated_at_ms),
        asOf: String(entry.asOf ?? raw.asOf ?? ""),
        label: String(entry.label ?? key),
        custody: entry.custody === "self_custody" ? "self_custody" : "exchange",
        sats,
        fiat: legacyFiat,
        fiatValuation: normalizeFiatValuation(entry, sats, legacyFiat),
        owner,
      }
    }),
    totals: {
      sats: parseBtcToSats(totals.btc),
      fiat: parseCents(totals.fiat),
      fiatValuation: normalizeFiatValuation(
        totals,
        parseBtcToSats(totals.btc),
        parseCents(totals.fiat),
      ),
      exchangeSats: parseBtcToSats(totals.exchange_btc),
      selfCustodySats: parseBtcToSats(totals.self_custody_btc),
    },
    source: metadata ? optionalString(metadata.source) : null,
    basis: metadata ? optionalString(metadata.basis) : null,
    balanceConfidence,
    confidence: balanceConfidence,
  }
}

export function normalizeBTCBuy(raw: Record<string, unknown>, fallbackOwner?: FamilyMember): BTCBuy {
  return {
    id: String(raw.id ?? ""),
    updatedAtMs: timestampMillis(raw.updatedAtMs ?? raw.updated_at_ms),
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
    archimedesRequestId: optionalString(
      raw.archimedesRequestId ?? raw.archimedes_request_id,
    ),
    owner: raw.owner === undefined && fallbackOwner ? fallbackOwner : coerceOwner(raw.owner),
  }
}

export function normalizeBTCBillPay(raw: Record<string, unknown>, fallbackOwner?: FamilyMember): BTCBillPay {
  return {
    id: String(raw.id ?? ""),
    updatedAtMs: timestampMillis(raw.updatedAtMs ?? raw.updated_at_ms),
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
  /** Exact row revision used for optimistic concurrency. */
  readonly updatedAtMs: number
  readonly title: string
  readonly done: boolean
  readonly project: string | null
  readonly area: string | null
  readonly due: string | null
  readonly flagged: boolean
  readonly lane: string | null
  readonly priority: bigint | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
  readonly completedAt: string | null
  readonly notes: string | null
  readonly owner: FamilyMember
}

export function normalizeTodo(raw: Record<string, unknown>, fallbackOwner?: FamilyMember): TodoItem {
  return {
    id: String(raw.id ?? ""),
    updatedAtMs: timestampMillis(raw.updatedAtMs ?? raw.updated_at_ms),
    title: String(raw.title ?? ""),
    done: Boolean(raw.done ?? raw.completed ?? false),
    project: optionalString(raw.project),
    area: optionalString(raw.area),
    due: optionalString(raw.due),
    flagged: Boolean(raw.flagged ?? false),
    lane: optionalString(raw.lane),
    priority: optionalBigInt(raw.priority),
    createdAt: optionalString(raw.createdAt ?? raw.created_at),
    updatedAt: optionalString(raw.updatedAt ?? raw.updated_at),
    completedAt: optionalString(raw.completedAt ?? raw.completed_at),
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

function normalizeFiatValuation(
  container: Record<string, unknown>,
  sats: Sats,
  legacyFiat: Cents,
): FiatValuation | null {
  if (Object.prototype.hasOwnProperty.call(container, "fiatValuation")) {
    const valuation = asRecord(container.fiatValuation)
    if (!valuation || valuation.cents === undefined || valuation.cents === null) return null
    return {
      cents: parseMinorUnits(valuation.cents, 0),
      priceCents: optionalIntegerMinorUnits(valuation.priceCents),
      quotedAt: optionalString(valuation.quotedAt),
      source: optionalString(valuation.source),
      confidence: optionalString(valuation.confidence),
    }
  }

  // Conservative compatibility for legacy blobs with no discriminator:
  // positive sats plus stored zero has no valuation evidence. Zero sats is a
  // legitimate zero, and positive legacy fiat remains available with unknown
  // provenance.
  if (sats > 0n && legacyFiat === 0n) return null
  return {
    cents: legacyFiat,
    priceCents: null,
    quotedAt: null,
    source: null,
    confidence: null,
  }
}

function optionalIntegerMinorUnits(value: unknown): Cents | null {
  if (value === null || value === undefined || value === "") return null
  return parseMinorUnits(value, 0)
}

function optionalBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined || value === "") return null
  try {
    return BigInt(String(value))
  } catch {
    return null
  }
}

function timestampMillis(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

// ── Month scoping ───────────────────────────────────────────────────────────
//
// A budget is for one month, so its spend must come from that month's
// transactions and no others. The iOS client has always derived it this way
// (BudgetView.monthTransactions); these helpers give the other clients the same
// rule instead of trusting a precomputed total.

/** `yyyy-MM`, e.g. "2026-07". Retained budget records key on this. */
export type MonthKey = string

/**
 * Transactions that contribute to a profile's budget.
 *
 * Adults retain wide visibility for oversight, but their household budget follows
 * the narrower net-worth-sharing rule: Victor and Rachel share one budget while
 * child spending stays out of their totals. A child budget remains self-only.
 */
export function budgetTransactionsFor(
  viewer: FamilyMember,
  transactions: readonly Transaction[],
): Transaction[] {
  return isAdult(viewer)
    ? netWorthScopeFor(viewer, transactions)
    : visibleTo(viewer, transactions)
}

/** Months that can contribute to a profile's budget, newest first. */
export function budgetMonthsFor(
  viewer: FamilyMember,
  transactions: readonly Transaction[],
  budgetMonth: MonthKey | null,
): MonthKey[] {
  const present = monthsPresent(budgetTransactionsFor(viewer, transactions))
  return [...new Set(budgetMonth ? [budgetMonth, ...present] : present)].sort().reverse()
}

/** Resolve a persisted selection against the months still valid for this budget. */
export function resolveBudgetMonth(
  selected: MonthKey | null,
  months: readonly MonthKey[],
  budgetMonth: MonthKey | null,
): MonthKey | null {
  if (selected && months.includes(selected)) return selected
  if (budgetMonth && months.includes(budgetMonth)) return budgetMonth
  return months[0] ?? null
}

/**
 * Month a transaction belongs to.
 *
 * Stored transaction dates are ISO `yyyy-MM-dd`, so the month is a prefix — no
 * Date parsing, no timezone to get wrong. A transaction dated 2026-07-01 belongs
 * to July whatever timezone the reader is in, which is the behaviour a ledger
 * needs.
 */
export function monthOf(date: string): MonthKey {
  return date.slice(0, 7)
}

export function isInMonth(transaction: Transaction, month: MonthKey): boolean {
  return monthOf(transaction.date) === month
}

export function transactionsInMonth(
  transactions: readonly Transaction[],
  month: MonthKey,
): Transaction[] {
  return transactions.filter((transaction) => isInMonth(transaction, month))
}

/** Months present in a set of transactions, newest first. */
export function monthsPresent(transactions: readonly Transaction[]): MonthKey[] {
  return [...new Set(transactions.map((transaction) => monthOf(transaction.date)))].sort().reverse()
}

/** A budget category with spend derived from transactions rather than reported. */
export interface CategorySpend {
  readonly name: string
  readonly icon: string | null
  readonly budget: Cents
  /** Derived from this month's transactions in this category. */
  readonly spent: Cents
  readonly remaining: Cents
  readonly isOverBudget: boolean
}

export interface BudgetSpend {
  readonly month: MonthKey
  readonly categories: readonly CategorySpend[]
  readonly planned: Cents
  readonly actual: Cents
  readonly remaining: Cents
  readonly overBudgetCount: number
  /**
   * Spend in this month that matched no budget category.
   *
   * Surfaced rather than dropped: silently discarding it would make the totals
   * disagree with the Activity screen for no visible reason.
   */
  readonly uncategorised: Cents
}

/**
 * Derive a month's spend for a budget.
 *
 * `transactions` should already be filtered to what the viewer may see — this
 * function does not apply visibility, deliberately, so the two rules stay
 * separate and testable.
 */
export function deriveBudgetSpend(
  budget: Budget,
  transactions: readonly Transaction[],
): BudgetSpend {
  const inMonth = transactionsInMonth(transactions, budget.month)

  const spentByCategory = new Map<string, Cents>()
  for (const transaction of inMonth) {
    const spend = spendAmount(transaction)
    if (spend === 0n) continue
    spentByCategory.set(transaction.category, (spentByCategory.get(transaction.category) ?? 0n) + spend)
  }

  const categories: CategorySpend[] = budget.categories.map((category) => {
    const spent = spentByCategory.get(category.name) ?? 0n
    spentByCategory.delete(category.name)
    return {
      name: category.name,
      icon: category.icon,
      budget: category.budget,
      spent,
      remaining: category.budget - spent,
      isOverBudget: spent > category.budget,
    }
  })

  // Whatever is left in the map had no matching budget category.
  let uncategorised = 0n
  for (const remainder of spentByCategory.values()) uncategorised += remainder

  const planned = categories.reduce((total, category) => total + category.budget, 0n)
  const actual = categories.reduce((total, category) => total + category.spent, 0n)

  return {
    month: budget.month,
    categories,
    planned,
    actual,
    remaining: planned - actual,
    overBudgetCount: categories.filter((category) => category.isOverBudget).length,
    uncategorised,
  }
}
