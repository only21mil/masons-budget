// Sanitized fixture envelope.
//
// The client is not wired to the live Convex deployment — that is approval-gated
// (see the repo AGENTS.md and the plan). Everything here is invented sample data
// with the same *shape* MC2 emits, so the pages can be built and reviewed
// without a backend and without any real family financial data on disk.
//
// Two rules for this file:
//   1. No real balances, account numbers, merchants, or identifiers. Ever.
//   2. Records carry canonical owners exactly as MC2 tags them — adults default
//      to "victor" — so the visibility layer is exercised honestly rather than
//      being handed pre-filtered data.

import { type FamilyMember, hasDedicatedMC2ChildFinanceFiles, isAdult } from "@vogel-vault/domain/family"
import { parseBtcToSats, parseCents } from "@vogel-vault/domain/money"
import type {
  BTCAccount,
  BTCBillPay,
  BTCBuy,
  Budget,
  Freshness,
  SliceState,
  TodoItem,
  Transaction,
} from "@vogel-vault/domain/readModel"

const NOW = Date.UTC(2026, 6, 26, 14, 30, 0)
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

function daysAgo(count: number): string {
  return new Date(NOW - count * DAY).toISOString().slice(0, 10)
}

// ── Transactions ────────────────────────────────────────────────────────────

const TRANSACTIONS: readonly Transaction[] = [
  tx("tx-0001", 0, "Neighborhood Market", "-142.18", "Groceries", "victor", "Debit"),
  tx("tx-0002", 0, "Coffee Bar", "-6.75", "Dining", "rachel", "Credit"),
  tx("tx-0003", 1, "Payroll Deposit", "2480.00", "Income", "victor", null),
  tx("tx-0004", 1, "Hardware Store", "-88.40", "Home", "victor", "Debit"),
  tx("tx-0005", 2, "Pharmacy", "-24.10", "Health", "rachel", "Credit"),
  tx("tx-0006", 3, "Electric Utility", "-186.55", "Utilities", "victor", "Debit"),
  tx("tx-0007", 4, "Bookshop", "-31.20", "Shopping", "rachel", "Credit"),
  tx("tx-0008", 5, "Farmers Market", "-52.00", "Groceries", "victor", "Debit"),
  tx("tx-0009", 6, "Internet Provider", "-79.99", "Utilities", "victor", "Debit"),
  tx("tx-0010", 7, "Payroll Deposit", "2480.00", "Income", "victor", null),
  tx("tx-0011", 8, "Auto Fuel", "-46.30", "Transport", "rachel", "Credit"),
  tx("tx-0012", 9, "Streaming Service", "-15.99", "Entertainment", "victor", "Credit"),
  // Child-owned rows. The child files record spend as a positive magnitude.
  tx("tx-1001", 1, "Game Store", "24.00", "Entertainment", "mason", null),
  tx("tx-1002", 4, "School Lunch", "12.50", "Food", "mason", null),
  tx("tx-1003", 6, "Trading Cards", "9.00", "Entertainment", "mason", null),
  tx("tx-2001", 2, "App Store", "4.99", "Entertainment", "maddox", null),
  tx("tx-2002", 5, "Ice Cream", "6.25", "Food", "maddox", null),
]

function tx(
  id: string,
  agoDays: number,
  merchant: string,
  amount: string,
  category: string,
  owner: FamilyMember,
  card: string | null,
): Transaction {
  return {
    id,
    date: daysAgo(agoDays),
    merchant,
    amount: parseCents(amount),
    category,
    card,
    note: null,
    owner,
  }
}

// ── Budget ──────────────────────────────────────────────────────────────────

const ADULT_BUDGET: Budget = {
  month: "2026-07",
  coinbaseOneBalance: parseCents("0"),
  categories: [
    { name: "Groceries", icon: "cart", budget: parseCents("900"), spent: parseCents("614.18") },
    { name: "Utilities", icon: "zap", budget: parseCents("400"), spent: parseCents("266.54") },
    { name: "Dining", icon: "utensils", budget: parseCents("250"), spent: parseCents("188.20") },
    { name: "Transport", icon: "car", budget: parseCents("320"), spent: parseCents("146.30") },
    { name: "Home", icon: "home", budget: parseCents("300"), spent: parseCents("288.40") },
    { name: "Health", icon: "heart", budget: parseCents("200"), spent: parseCents("74.10") },
    { name: "Shopping", icon: "bag", budget: parseCents("180"), spent: parseCents("211.20") },
    { name: "Entertainment", icon: "play", budget: parseCents("120"), spent: parseCents("45.99") },
  ],
  effectiveApr: null,
  strategyNote: "Sample strategy note. Not real guidance.",
  income: {
    weeklyGross: parseCents("1240"),
    weeklyStrike: parseCents("120"),
    weeklyRiver: parseCents("80"),
    payFrequency: "weekly",
    monthlyGross: parseCents("4960"),
    mtdIncome: parseCents("4960"),
    ytdIncome: parseCents("34720"),
    paychecks: [
      { date: daysAgo(1), platform: "Direct", source: "Employer", amount: parseCents("2480"), net: parseCents("2480"), note: null },
      { date: daysAgo(7), platform: "Direct", source: "Employer", amount: parseCents("2480"), net: parseCents("2480"), note: null },
    ],
  },
  mtdIncome: parseCents("4960"),
  ytdIncome: parseCents("34720"),
  monthlyHistory: [
    { month: "2026-03", income: parseCents("9920"), expenses: parseCents("6140"), savingsBps: 3810 },
    { month: "2026-04", income: parseCents("9920"), expenses: parseCents("6720"), savingsBps: 3230 },
    { month: "2026-05", income: parseCents("9920"), expenses: parseCents("5980"), savingsBps: 3970 },
    { month: "2026-06", income: parseCents("9920"), expenses: parseCents("6410"), savingsBps: 3540 },
  ],
  owner: "victor",
}

const MASON_BUDGET: Budget = {
  month: "2026-07",
  coinbaseOneBalance: parseCents("0"),
  categories: [
    { name: "Entertainment", icon: "play", budget: parseCents("40"), spent: parseCents("33.00") },
    { name: "Food", icon: "utensils", budget: parseCents("30"), spent: parseCents("12.50") },
    { name: "Saving", icon: "piggy", budget: parseCents("30"), spent: parseCents("0") },
  ],
  effectiveApr: null,
  strategyNote: null,
  income: null,
  mtdIncome: parseCents("60"),
  ytdIncome: parseCents("420"),
  monthlyHistory: [],
  owner: "mason",
}

// ── Bitcoin ─────────────────────────────────────────────────────────────────

const BTC_ACCOUNTS: readonly BTCAccount[] = [
  account("coldcard", "Cold Storage", "self_custody", "0.42000000", "39270.00", "victor"),
  account("lightning", "Lightning Wallet", "self_custody", "0.01850000", "1729.75", "victor"),
  account("exchange-dca", "DCA Exchange", "exchange", "0.03400000", "3179.00", "victor"),
  account("mason-stack", "Mason Stack", "exchange", "0.00120000", "112.20", "mason"),
  account("maddox-stack", "Maddox Stack", "exchange", "0.00045000", "42.08", "maddox"),
]

function account(
  key: string,
  label: string,
  custody: "exchange" | "self_custody",
  btc: string,
  fiat: string,
  owner: FamilyMember,
): BTCAccount {
  return { key, label, custody, sats: parseBtcToSats(btc), fiat: parseCents(fiat), owner }
}

const BTC_BUYS: readonly BTCBuy[] = [
  buy("buy-0001", 2, "DCA Exchange", "0.00210000", "93500.00", "196.35", "victor"),
  buy("buy-0002", 9, "DCA Exchange", "0.00205000", "91200.00", "186.96", "victor"),
  buy("buy-0003", 16, "DCA Exchange", "0.00218000", "89400.00", "194.89", "victor"),
  buy("buy-0004", 23, "DCA Exchange", "0.00201000", "94100.00", "189.14", "victor"),
  buy("buy-0005", 12, "Gift", "0.00040000", "91000.00", "36.40", "mason"),
]

function buy(
  id: string,
  agoDays: number,
  source: string,
  btc: string,
  price: string,
  usd: string,
  owner: FamilyMember,
): BTCBuy {
  return {
    id,
    date: daysAgo(agoDays),
    source,
    sats: parseBtcToSats(btc),
    priceUsd: parseCents(price),
    usd: parseCents(usd),
    note: null,
    status: "settled",
    costBasisStatus: "confirmed",
    loggedBy: "mc2",
    owner,
  }
}

const BILL_PAYS: readonly BTCBillPay[] = [
  {
    id: "pay-0001",
    date: daysAgo(6),
    merchant: "Internet Provider",
    category: "Utilities",
    amountUsd: parseCents("79.99"),
    btcSpentSats: parseBtcToSats("0.00085000"),
    btcPrice: parseCents("94100.00"),
    platform: "Sample Platform",
    note: null,
    feeUsd: parseCents("0.40"),
    reference: null,
    owner: "victor",
  },
  {
    id: "pay-0002",
    date: daysAgo(20),
    merchant: "Electric Utility",
    category: "Utilities",
    amountUsd: parseCents("186.55"),
    btcSpentSats: parseBtcToSats("0.00204000"),
    btcPrice: parseCents("91400.00"),
    platform: "Sample Platform",
    note: null,
    feeUsd: parseCents("0.95"),
    reference: null,
    owner: "victor",
  },
]

// ── Todos ───────────────────────────────────────────────────────────────────

const TODOS: readonly TodoItem[] = [
  todo("todo-0001", "Reconcile July statements", "victor", { area: "Finance", due: daysAgo(-1), flagged: true }),
  todo("todo-0002", "Review insurance renewal", "victor", { area: "Home", due: daysAgo(-4) }),
  todo("todo-0003", "Schedule annual checkup", "rachel", { area: "Health", due: daysAgo(-2) }),
  todo("todo-0004", "Plan birthday weekend", "rachel", { project: "Family Calendar" }),
  todo("todo-0005", "Export Q2 records", "victor", { project: "Tax Prep", flagged: true }),
  todo("todo-0006", "File receipts", "victor", { project: "Tax Prep", done: true }),
  todo("todo-0007", "Finish reading assignment", "mason", { area: "School", due: daysAgo(-1) }),
  todo("todo-0008", "Tidy room", "mason", { area: "Home", done: true }),
  todo("todo-0009", "Practice piano", "maddox", { area: "Music", due: daysAgo(0) }),
]

function todo(
  id: string,
  title: string,
  owner: FamilyMember,
  extra: { project?: string; area?: string; due?: string; flagged?: boolean; done?: boolean } = {},
): TodoItem {
  return {
    id,
    title,
    done: extra.done ?? false,
    project: extra.project ?? null,
    area: extra.area ?? null,
    due: extra.due ?? null,
    flagged: extra.flagged ?? false,
    notes: null,
    owner,
  }
}

// ── Envelope ────────────────────────────────────────────────────────────────

export interface FixtureEnvelope {
  readonly transactions: SliceState<readonly Transaction[]>
  readonly budget: SliceState<Budget | null>
  readonly btcAccounts: SliceState<readonly BTCAccount[]>
  readonly btcBuys: SliceState<readonly BTCBuy[]>
  readonly billPays: SliceState<readonly BTCBillPay[]>
  readonly todos: SliceState<readonly TodoItem[]>
  readonly btcPriceUsd: bigint
  readonly generatedAt: number
}

function slice<T>(value: T, status: Freshness, ageMinutes: number, source: string): SliceState<T> {
  return {
    status,
    value,
    updatedAt: status === "empty" ? null : NOW - ageMinutes * MINUTE,
    source,
  }
}

/**
 * Build the fixture envelope for a profile.
 *
 * Data is returned UNFILTERED, tagged with canonical owners. Pages apply
 * `visibleTo` / `netWorthScopeFor` themselves, which is what keeps the
 * visibility contract honest — a page that forgets to filter shows too much in
 * review rather than silently receiving a pre-filtered set.
 */
export function buildSanitizedFixtureEnvelope(
  activeProfile: FamilyMember,
  overrides: Partial<Record<keyof FixtureEnvelope, Freshness>> = {},
): FixtureEnvelope {
  // Budget is per-owner, and there is no "default to the adult budget" case:
  // adults share the household budget, Mason has dedicated MC2 child finance
  // files, and Maddox has none — so his budget slice is genuinely empty. Falling
  // back to the adult budget here leaked household categories to Maddox.
  const budgetForProfile = isAdult(activeProfile)
    ? ADULT_BUDGET
    : hasDedicatedMC2ChildFinanceFiles(activeProfile)
      ? MASON_BUDGET
      : null

  return {
    transactions: slice(TRANSACTIONS, overrides.transactions ?? "live", 4, "MC2 · transactions"),
    budget: slice(budgetForProfile, overrides.budget ?? "live", 4, "MC2 · budget"),
    btcAccounts: slice(BTC_ACCOUNTS, overrides.btcAccounts ?? "live", 11, "MC2 · btc-balance-snapshot"),
    btcBuys: slice(BTC_BUYS, overrides.btcBuys ?? "live", 11, "MC2 · bitcoin-buys"),
    billPays: slice(BILL_PAYS, overrides.billPays ?? "live", 11, "MC2 · bitcoin-bill-pays"),
    todos: slice(TODOS, overrides.todos ?? "live", 2, "MC2 · todos"),
    btcPriceUsd: parseCents("93500.00"),
    generatedAt: NOW,
  }
}

/** Envelope with every slice forced to one state — drives the QA state matrix. */
export function fixtureEnvelopeInState(
  activeProfile: FamilyMember,
  status: Freshness,
): FixtureEnvelope {
  const empty = status === "empty"
  const base = buildSanitizedFixtureEnvelope(activeProfile, {
    transactions: status,
    budget: status,
    btcAccounts: status,
    btcBuys: status,
    billPays: status,
    todos: status,
  })
  if (!empty) return base
  return {
    ...base,
    transactions: { ...base.transactions, value: [] },
    budget: { ...base.budget, value: null },
    btcAccounts: { ...base.btcAccounts, value: [] },
    btcBuys: { ...base.btcBuys, value: [] },
    billPays: { ...base.billPays, value: [] },
    todos: { ...base.todos, value: [] },
  }
}
