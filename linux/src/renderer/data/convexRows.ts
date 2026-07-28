import type { FamilyMember } from "@vogel-vault/domain/family"
import type {
  BTCAccount,
  BTCBillPay,
  BTCBuy,
  Budget,
  SliceState,
  TodoItem,
  Transaction,
} from "@vogel-vault/domain/readModel"

import type {
  VogelVaultBtcAccountRow,
  VogelVaultBtcBillPayRow,
  VogelVaultBtcBuyRow,
  VogelVaultBudgetDocument,
  VogelVaultRowErrorCode,
  VogelVaultRowRequest,
  VogelVaultRowResult,
  VogelVaultTodoRow,
  VogelVaultTransactionRow,
} from "../../../shared/ipc.ts"
import type { FixtureEnvelope } from "./fixtures.ts"

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
    budget: errorSlice(null, code),
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
    budget: populatedSlice(null, false, null, `${SOURCE} · budget document`),
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

function priceFromRows(buys: readonly VogelVaultBtcBuyRow[]): bigint {
  const latest = buys.reduce<VogelVaultBtcBuyRow | null>(
    (current, buy) => current === null || buy.date > current.date ? buy : current,
    null,
  )
  return latest !== null && latest.priceUsdCents > 0n ? latest.priceUsdCents : 0n
}

function firstError(results: readonly VogelVaultRowResult[]): VogelVaultRowErrorCode | null {
  for (const result of results) {
    if (result.status === "error") return result.code
  }
  return null
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
    query({ kind: "btcBuys", viewer, scope: "visible" }),
    query({ kind: "btcAccounts", viewer, scope: "visible" }),
    query({ kind: "btcBillPays", viewer, scope: "visible" }),
    query({ kind: "budget", viewer, scope: "netWorth" }),
    query({ kind: "btcSnapshotMeta", viewer, scope: "visible" }),
  ])
  const error = firstError(results)
  if (error !== null) return { status: "loaded", data: errorEnvelope(error, now()) }

  const [transactionsResult, todosResult, buysResult, accountsResult, billPaysResult, budgetResult, metaResult] =
    results
  if (
    transactionsResult.status !== "ok" ||
    transactionsResult.kind !== "transactions" ||
    todosResult.status !== "ok" ||
    todosResult.kind !== "todos" ||
    buysResult.status !== "ok" ||
    buysResult.kind !== "btcBuys" ||
    accountsResult.status !== "ok" ||
    accountsResult.kind !== "btcAccounts" ||
    billPaysResult.status !== "ok" ||
    billPaysResult.kind !== "btcBillPays" ||
    budgetResult.status !== "ok" ||
    budgetResult.kind !== "budget" ||
    metaResult.status !== "ok" ||
    metaResult.kind !== "btcSnapshotMeta"
  ) {
    return { status: "loaded", data: errorEnvelope("invalid-response", now()) }
  }

  const transactionRows = transactionsResult.rows
  const todoRows = todosResult.rows
  const buyRows = buysResult.rows
  const accountRows = accountsResult.rows
  const billPayRows = billPaysResult.rows
  const document = budgetResult.value
  const accountTimestamps = [...accountRows, ...metaResult.rows]
  const timestamps = [
    updatedAt(transactionRows),
    updatedAt(todoRows),
    updatedAt(buyRows),
    updatedAt(accountTimestamps),
    updatedAt(billPayRows),
    document?.updatedAtMs ?? null,
  ].filter((value): value is number => value !== null)

  return {
    status: "loaded",
    data: {
      transactions: populatedSlice(
        transactionRows.map(transaction),
        transactionRows.length > 0,
        updatedAt(transactionRows),
        `${SOURCE} · transactions`,
      ),
      budget: populatedSlice(
        document === null ? null : budget(document),
        document !== null,
        document?.updatedAtMs ?? null,
        `${SOURCE} · budget document`,
      ),
      btcAccounts: populatedSlice(
        accountRows.map(btcAccount),
        accountRows.length > 0,
        updatedAt(accountTimestamps),
        `${SOURCE} · BTC accounts`,
      ),
      btcBuys: populatedSlice(
        buyRows.map(btcBuy),
        buyRows.length > 0,
        updatedAt(buyRows),
        `${SOURCE} · BTC buys`,
      ),
      billPays: populatedSlice(
        billPayRows.map(billPay),
        billPayRows.length > 0,
        updatedAt(billPayRows),
        `${SOURCE} · BTC bill pays`,
      ),
      todos: populatedSlice(
        todoRows.map(todo),
        todoRows.length > 0,
        updatedAt(todoRows),
        `${SOURCE} · todos`,
      ),
      btcPriceUsd: priceFromRows(buyRows),
      generatedAt: timestamps.length > 0 ? Math.max(...timestamps) : now(),
    },
  }
}
