import type { FamilyMember } from "@vogel-vault/domain/family"
import type {
  BTCAccount,
  BTCBillPay,
  BTCBuy,
  BTCSnapshot,
  Budget,
  SliceState,
  TodoItem,
  Transaction,
} from "@vogel-vault/domain/readModel"

import type {
  VogelVaultBtcAccountRow,
  VogelVaultBtcBillPayRow,
  VogelVaultBtcBuyRow,
  VogelVaultBtcBalanceDocument,
  VogelVaultBudgetDocument,
  VogelVaultIncomeRow,
  VogelVaultRowErrorCode,
  VogelVaultRowRequest,
  VogelVaultRowResult,
  VogelVaultTodoRow,
  VogelVaultTransactionRow,
} from "../../../shared/ipc.ts"
import type { FixtureEnvelope, IncomeRecord } from "./fixtures.ts"

export type QueryConvexRows = (request: VogelVaultRowRequest) => Promise<VogelVaultRowResult>

export type ConvexEnvelopeLoad =
  | { readonly status: "fallback" }
  | { readonly status: "loaded"; readonly data: FixtureEnvelope }

const SOURCE = "Convex row tables"

function updatedAt(rows: readonly { readonly updatedAtMs: number }[]): number | null {
  let latest: number | null = null
  for (const row of rows) {
    if (latest === null || row.updatedAtMs > latest) latest = row.updatedAtMs
  }
  return latest
}

function populatedSlice<T>(
  value: T,
  populated: boolean,
  timestamp: number | null,
  source: string,
): SliceState<T> {
  return {
    status: populated ? "live" : "empty",
    value,
    updatedAt: populated ? timestamp : null,
    source,
  }
}

function failureMessage(code: VogelVaultRowErrorCode): string {
  switch (code) {
    case "unauthorized":
      return "Convex read authentication failed."
    case "unconfigured":
      return "Convex row reads are not configured."
    case "incomplete-response":
      return "Convex did not return a complete replacement snapshot."
    case "response-too-large":
      return "Convex returned more row data than the client accepts."
    case "disabled":
      return "Convex row reads are disabled."
    case "invalid-request":
    case "invalid-response":
    case "unavailable":
      return "Convex row data is unavailable."
  }
}

function errorSlice<T>(value: T, code: VogelVaultRowErrorCode): SliceState<T> {
  return {
    status: "error",
    value,
    updatedAt: null,
    source: code === "unauthorized" ? `${SOURCE} · authentication required` : SOURCE,
    error: failureMessage(code),
  }
}

function errorEnvelope(code: VogelVaultRowErrorCode, now: number): FixtureEnvelope {
  return {
    transactions: errorSlice([], code),
    income: errorSlice([], code),
    budget: errorSlice(null, code),
    btcBalanceDocument: errorSlice(null, code),
    btcAccounts: errorSlice([], code),
    btcBuys: errorSlice([], code),
    billPays: errorSlice([], code),
    todos: errorSlice([], code),
    btcPriceUsd: 0n,
    generatedAt: now,
  }
}

function emptyEnvelope(now: number): FixtureEnvelope {
  return {
    transactions: populatedSlice([], false, null, `${SOURCE} · transactions`),
    income: populatedSlice([], false, null, `${SOURCE} · income`),
    budget: populatedSlice(null, false, null, `${SOURCE} · budget document`),
    btcBalanceDocument: populatedSlice(null, false, null, `${SOURCE} · BTC balance document`),
    btcAccounts: populatedSlice([], false, null, `${SOURCE} · BTC accounts`),
    btcBuys: populatedSlice([], false, null, `${SOURCE} · BTC buys`),
    billPays: populatedSlice([], false, null, `${SOURCE} · BTC bill pays`),
    todos: populatedSlice([], false, null, `${SOURCE} · todos`),
    btcPriceUsd: 0n,
    generatedAt: now,
  }
}

function transaction(row: VogelVaultTransactionRow): Transaction {
  return {
    id: row.txId,
    date: row.date,
    merchant: row.merchant,
    amount: row.amountCents,
    category: row.category,
    card: row.card ?? null,
    note: row.note ?? null,
    owner: row.owner,
  }
}

function todo(row: VogelVaultTodoRow): TodoItem {
  return {
    id: row.todoId,
    title: row.title,
    done: row.done,
    project: row.project ?? null,
    area: row.area ?? null,
    due: row.due ?? null,
    flagged: row.flagged,
    notes: row.notes ?? null,
    owner: row.owner,
  }
}

function income(row: VogelVaultIncomeRow): IncomeRecord {
  return {
    id: row.incomeId,
    date: row.date,
    month: row.month,
    amount: row.amountCents,
    source: row.source,
    loggedBy: row.loggedBy ?? null,
    note: row.note ?? null,
    owner: row.owner,
  }
}

function btcBuy(row: VogelVaultBtcBuyRow): BTCBuy {
  return {
    id: row.buyId,
    date: row.date,
    source: row.source,
    sats: row.sats,
    priceUsd: row.priceUsdCents,
    usd: row.usdCents,
    note: row.note ?? null,
    status: row.status ?? null,
    costBasisStatus: row.costBasisStatus ?? null,
    loggedBy: row.loggedBy ?? null,
    owner: row.owner,
  }
}

function btcAccount(row: VogelVaultBtcAccountRow): BTCAccount {
  return {
    key: row.key,
    label: row.label,
    custody: row.custody,
    sats: row.sats,
    fiat: row.fiatCents,
    owner: row.owner,
  }
}

function billPay(row: VogelVaultBtcBillPayRow): BTCBillPay {
  return {
    id: row.billPayId,
    date: row.date,
    merchant: row.merchant,
    category: row.category,
    amountUsd: row.amountUsdCents,
    btcSpentSats: row.btcSpentSats,
    btcPrice: row.btcPriceCents,
    platform: row.platform ?? null,
    note: row.note ?? null,
    feeUsd: row.feeUsdCents,
    reference: row.reference ?? null,
    owner: row.owner,
  }
}

function btcBalanceDocument(document: VogelVaultBtcBalanceDocument): BTCSnapshot {
  return {
    schemaVersion: Number(document.schemaVersion),
    asOf: document.asOf,
    accounts: document.accounts.map((account) => ({
      key: account.key,
      label: account.label,
      custody: account.custody,
      sats: account.sats,
      fiat: account.fiatCents,
      owner: document.owner,
    })),
    totals: {
      sats: document.totals.sats,
      fiat: document.totals.fiatCents,
      exchangeSats: document.totals.exchangeSats,
      selfCustodySats: document.totals.selfCustodySats,
    },
    source: document.source ?? null,
    basis: document.basis ?? null,
    confidence: document.confidence ?? null,
  }
}

function budget(document: VogelVaultBudgetDocument): Budget {
  return {
    month: document.month,
    coinbaseOneBalance: document.coinbaseOneBalanceCents,
    categories: document.categories.map((category) => ({
      name: category.name,
      icon: category.icon ?? null,
      budget: category.budgetCents,
      // Budget actuals are always derived from the selected month's transactions.
      spent: 0n,
    })),
    effectiveApr: document.effectiveApr ?? null,
    strategyNote: document.strategyNote ?? null,
    income: document.income
      ? {
          weeklyGross: document.income.weeklyGrossCents,
          weeklyStrike: document.income.weeklyStrikeCents,
          weeklyRiver: document.income.weeklyRiverCents,
          payFrequency: document.income.payFrequency ?? null,
          monthlyGross: document.income.monthlyGrossCents,
          mtdIncome: document.income.mtdIncomeCents,
          ytdIncome: document.income.ytdIncomeCents,
          paychecks: document.income.paychecks.map((paycheck) => ({
            date: paycheck.date,
            platform: paycheck.platform ?? null,
            source: paycheck.source ?? null,
            amount: paycheck.amountCents,
            net: paycheck.netCents,
            note: paycheck.note ?? null,
          })),
        }
      : null,
    mtdIncome: document.mtdIncomeCents,
    ytdIncome: document.ytdIncomeCents,
    monthlyHistory: document.monthlyHistory.map((entry) => ({
      month: entry.month,
      income: entry.incomeCents,
      expenses: entry.expensesCents,
      savingsBps: entry.savingsBps,
    })),
    owner: document.owner,
  }
}

function priceFromBalanceDocument(document: BTCSnapshot | null): bigint {
  if (!document || document.totals.sats <= 0n) return 0n
  return (document.totals.fiat * 100_000_000n) / document.totals.sats
}

export async function loadConvexRowEnvelope(
  query: QueryConvexRows,
  viewer: FamilyMember,
  now: () => number = Date.now,
): Promise<ConvexEnvelopeLoad> {
  const counts = await query({ kind: "rowCounts" })
  if (counts.status === "error") {
    if (counts.code === "disabled") return { status: "fallback" }
    return { status: "loaded", data: errorEnvelope(counts.code, now()) }
  }
  if (counts.kind !== "rowCounts") {
    return { status: "loaded", data: errorEnvelope("invalid-response", now()) }
  }

  const anyRows = Object.values(counts.value).some((count) => count > 0)
  if (!anyRows) return { status: "loaded", data: emptyEnvelope(now()) }

  const results = await Promise.all([
    query({ kind: "transactions", viewer }),
    query({ kind: "todos", viewer }),
    query({ kind: "income", viewer }),
    query({ kind: "btcBuys", viewer, scope: "visible" }),
    query({ kind: "btcAccounts", viewer, scope: "visible" }),
    query({ kind: "btcBillPays", viewer, scope: "visible" }),
    query({ kind: "budget", viewer, scope: "netWorth" }),
    query({ kind: "btcSnapshotMeta", viewer, scope: "visible" }),
    query({ kind: "btcBalanceDocuments", viewer, scope: "netWorth" }),
  ])
  const [
    transactionsResult,
    todosResult,
    incomeResult,
    buysResult,
    accountsResult,
    billPaysResult,
    budgetResult,
    metaResult,
    btcBalanceResult,
  ] = results

  const transactions =
    transactionsResult.status === "error"
      ? errorSlice<readonly Transaction[]>([], transactionsResult.code)
      : transactionsResult.kind !== "transactions"
        ? errorSlice<readonly Transaction[]>([], "invalid-response")
        : populatedSlice(
            transactionsResult.rows.map(transaction),
            transactionsResult.rows.length > 0,
            updatedAt(transactionsResult.rows),
            `${SOURCE} · transactions`,
          )
  const todos =
    todosResult.status === "error"
      ? errorSlice<readonly TodoItem[]>([], todosResult.code)
      : todosResult.kind !== "todos"
        ? errorSlice<readonly TodoItem[]>([], "invalid-response")
        : populatedSlice(
            todosResult.rows.map(todo),
            todosResult.rows.length > 0,
            updatedAt(todosResult.rows),
            `${SOURCE} · todos`,
          )
  const incomeRows =
    incomeResult.status === "error"
      ? errorSlice<readonly IncomeRecord[]>([], incomeResult.code)
      : incomeResult.kind !== "income"
        ? errorSlice<readonly IncomeRecord[]>([], "invalid-response")
        : populatedSlice(
            incomeResult.rows.map(income),
            incomeResult.rows.length > 0,
            updatedAt(incomeResult.rows),
            `${SOURCE} · income`,
          )
  const btcBuys =
    buysResult.status === "error"
      ? errorSlice<readonly BTCBuy[]>([], buysResult.code)
      : buysResult.kind !== "btcBuys"
        ? errorSlice<readonly BTCBuy[]>([], "invalid-response")
        : populatedSlice(
            buysResult.rows.map(btcBuy),
            buysResult.rows.length > 0,
            updatedAt(buysResult.rows),
            `${SOURCE} · BTC buys`,
          )
  const accountTimestamp =
    accountsResult.status === "ok" && accountsResult.kind === "btcAccounts"
      ? updatedAt([
          ...accountsResult.rows,
          ...(metaResult.status === "ok" && metaResult.kind === "btcSnapshotMeta"
            ? metaResult.rows
            : []),
        ])
      : null
  const btcAccounts =
    accountsResult.status === "error"
      ? errorSlice<readonly BTCAccount[]>([], accountsResult.code)
      : accountsResult.kind !== "btcAccounts"
        ? errorSlice<readonly BTCAccount[]>([], "invalid-response")
        : populatedSlice(
            accountsResult.rows.map(btcAccount),
            accountsResult.rows.length > 0,
            accountTimestamp,
            `${SOURCE} · BTC accounts`,
          )
  const billPays =
    billPaysResult.status === "error"
      ? errorSlice<readonly BTCBillPay[]>([], billPaysResult.code)
      : billPaysResult.kind !== "btcBillPays"
        ? errorSlice<readonly BTCBillPay[]>([], "invalid-response")
        : populatedSlice(
            billPaysResult.rows.map(billPay),
            billPaysResult.rows.length > 0,
            updatedAt(billPaysResult.rows),
            `${SOURCE} · BTC bill pays`,
          )
  const budgetSlice =
    budgetResult.status === "error"
      ? errorSlice<Budget | null>(null, budgetResult.code)
      : budgetResult.kind !== "budget"
        ? errorSlice<Budget | null>(null, "invalid-response")
        : populatedSlice(
            budgetResult.value === null ? null : budget(budgetResult.value),
            budgetResult.value !== null,
            budgetResult.value?.updatedAtMs ?? null,
            `${SOURCE} · budget document`,
          )
  const btcBalance =
    btcBalanceResult.status === "error"
      ? errorSlice<BTCSnapshot | null>(null, btcBalanceResult.code)
      : btcBalanceResult.kind !== "btcBalanceDocuments" || btcBalanceResult.rows.length > 1
        ? errorSlice<BTCSnapshot | null>(null, "invalid-response")
        : populatedSlice(
            btcBalanceResult.rows[0] ? btcBalanceDocument(btcBalanceResult.rows[0]) : null,
            btcBalanceResult.rows.length === 1,
            updatedAt(btcBalanceResult.rows),
            `${SOURCE} · canonical BTC balance document`,
          )

  const timestamps = [
    transactions.updatedAt,
    todos.updatedAt,
    incomeRows.updatedAt,
    btcBuys.updatedAt,
    btcAccounts.updatedAt,
    billPays.updatedAt,
    budgetSlice.updatedAt,
    btcBalance.updatedAt,
  ].filter((value): value is number => value !== null)

  return {
    status: "loaded",
    data: {
      transactions,
      income: incomeRows,
      budget: budgetSlice,
      btcBalanceDocument: btcBalance,
      btcAccounts,
      btcBuys,
      billPays,
      todos,
      btcPriceUsd: priceFromBalanceDocument(btcBalance.value),
      generatedAt: timestamps.length > 0 ? Math.max(...timestamps) : now(),
    },
  }
}
