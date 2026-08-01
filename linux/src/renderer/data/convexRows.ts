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
  VogelVaultBtcTransferRow,
  VogelVaultBtcBalanceDocument,
  VogelVaultBudgetDocument,
  VogelVaultIncomeRow,
  VogelVaultRowErrorCode,
  VogelVaultRowRequest,
  VogelVaultRowResult,
  VogelVaultTodoRow,
  VogelVaultTransactionRow,
} from "../../../shared/ipc.ts"
import type { BtcTransferRecord, FixtureEnvelope, IncomeRecord } from "./fixtures.ts"
import {
  type BTCAccountWithFiatValuation,
  type BTCSnapshotWithFiatAvailability,
  type BTCTotalsWithFiatValuation,
  type FiatValuation,
  fiatValuationOf,
} from "./btcFiatValuation.ts"

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
    btcTransfers: errorSlice([], code),
    todos: errorSlice([], code),
    btcPriceUsd: null,
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
    btcTransfers: populatedSlice([], false, null, `${SOURCE} · BTC transfers`),
    todos: populatedSlice([], false, null, `${SOURCE} · todos`),
    btcPriceUsd: null,
    generatedAt: now,
  }
}

function transaction(row: VogelVaultTransactionRow): Transaction {
  return {
    id: row.txId,
    updatedAtMs: row.updatedAtMs,
    date: row.date,
    merchant: row.merchant,
    amount: row.amountCents,
    category: row.category,
    card: row.card ?? null,
    note: row.note ?? null,
    amountSats: row.amountSats,
    bitcoinAccountKey: row.bitcoinAccountKey,
    balancePostingVersion: row.balancePostingVersion,
    owner: row.owner,
  }
}

function todo(row: VogelVaultTodoRow): TodoItem {
  return {
    id: row.todoId,
    updatedAtMs: row.updatedAtMs,
    title: row.title,
    done: row.done,
    project: row.project ?? null,
    area: row.area ?? null,
    due: row.due ?? null,
    flagged: row.flagged,
    lane: row.lane ?? null,
    priority: row.priority ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    completedAt: row.completedAt ?? null,
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
    updatedAtMs: row.updatedAtMs,
    date: row.date,
    source: row.source,
    sats: row.sats,
    priceUsd: row.priceUsdCents,
    usd: row.usdCents,
    note: row.note ?? null,
    status: row.status ?? null,
    costBasisStatus: row.costBasisStatus ?? null,
    loggedBy: row.loggedBy ?? null,
    archimedesRequestId: row.archimedesRequestId ?? null,
    owner: row.owner,
  }
}

function ipcFiatValuation(row: {
  readonly sats: bigint
  readonly fiatCents: bigint
  readonly fiatValuation?: {
    readonly cents: bigint
    readonly priceCents?: bigint
    readonly quotedAt?: string
    readonly source?: string
    readonly confidence?: string
  } | null
}): FiatValuation | null {
  if (!Object.hasOwn(row, "fiatValuation")) {
    if (row.sats > 0n && row.fiatCents === 0n) return null
    return {
      cents: row.fiatCents,
      priceCents: null,
      quotedAt: null,
      source: null,
      confidence: null,
    }
  }
  return row.fiatValuation
    ? {
        cents: row.fiatValuation.cents,
        priceCents: row.fiatValuation.priceCents ?? null,
        quotedAt: row.fiatValuation.quotedAt ?? null,
        source: row.fiatValuation.source ?? null,
        confidence: row.fiatValuation.confidence ?? null,
      }
    : null
}

function btcAccount(row: VogelVaultBtcAccountRow): BTCAccountWithFiatValuation {
  return {
    key: row.key,
    updatedAtMs: row.updatedAtMs,
    asOf: row.asOf,
    label: row.label,
    custody: row.custody,
    sats: row.sats,
    fiat: row.fiatCents,
    fiatValuation: ipcFiatValuation(row),
    owner: row.owner,
  }
}

function billPay(row: VogelVaultBtcBillPayRow): BTCBillPay {
  return {
    id: row.billPayId,
    updatedAtMs: row.updatedAtMs,
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

function btcTransfer(row: VogelVaultBtcTransferRow): BtcTransferRecord {
  return {
    id: row.transferId,
    updatedAtMs: row.updatedAtMs,
    date: row.date,
    month: row.month,
    fromAccountKey: row.fromAccountKey,
    toAccountKey: row.toAccountKey,
    sats: row.sats,
    feeSats: row.feeSats,
    note: row.note ?? null,
    owner: row.owner,
  }
}

function btcBalanceDocument(
  document: VogelVaultBtcBalanceDocument,
): BTCSnapshotWithFiatAvailability {
  const totals: BTCTotalsWithFiatValuation = {
    sats: document.totals.sats,
    fiat: document.totals.fiatCents,
    fiatValuation: ipcFiatValuation(document.totals),
    exchangeSats: document.totals.exchangeSats,
    selfCustodySats: document.totals.selfCustodySats,
  }
  return {
    updatedAtMs: document.updatedAtMs,
    schemaVersion: Number(document.schemaVersion),
    asOf: document.asOf,
    accounts: document.accounts.map((account): BTCAccountWithFiatValuation => ({
      key: account.key,
      updatedAtMs: document.updatedAtMs,
      asOf: document.asOf,
      label: account.label,
      custody: account.custody,
      sats: account.sats,
      fiat: account.fiatCents,
      fiatValuation: ipcFiatValuation(account),
      owner: document.owner,
    })),
    totals,
    source: document.source ?? null,
    basis: document.basis ?? null,
    balanceConfidence: document.balanceConfidence ?? document.confidence ?? null,
    confidence: document.confidence ?? null,
  }
}

const ENGLISH_BUDGET_MONTHS: Readonly<Record<string, string>> = {
  January: "01",
  February: "02",
  March: "03",
  April: "04",
  May: "05",
  June: "06",
  July: "07",
  August: "08",
  September: "09",
  October: "10",
  November: "11",
  December: "12",
}

/**
 * Convert the two supported budget wire labels to the transaction month key.
 *
 * The legacy label is English by contract. An explicit table avoids both the
 * host locale and Date/timezone semantics at this financial adapter boundary.
 */
function canonicalBudgetMonth(raw: string): string | null {
  const canonical = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(raw)
  if (canonical) return canonical[1] === "0000" ? null : raw

  const legacy = /^([A-Za-z]+) (\d{4})$/.exec(raw)
  if (!legacy || legacy[2] === "0000") return null
  const month = ENGLISH_BUDGET_MONTHS[legacy[1] ?? ""]
  return month ? `${legacy[2]}-${month}` : null
}

function budget(document: VogelVaultBudgetDocument): Budget | null {
  const month = canonicalBudgetMonth(document.month)
  if (month === null) return null

  const monthlyHistory: Array<Budget["monthlyHistory"][number]> = []
  for (const entry of document.monthlyHistory) {
    const historyMonth = canonicalBudgetMonth(entry.month)
    if (historyMonth === null) return null
    monthlyHistory.push({
      month: historyMonth,
      income: entry.incomeCents,
      expenses: entry.expensesCents,
      savingsBps: entry.savingsBps,
    })
  }

  return {
    updatedAtMs: document.updatedAtMs,
    month,
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
    monthlyHistory,
    owner: document.owner,
  }
}

function priceFromBalanceDocument(document: BTCSnapshot | null): bigint | null {
  if (!document || document.totals.sats <= 0n) return null
  const valuation = fiatValuationOf(document.totals)
  if (!valuation) return null
  return valuation.priceCents ??
    (valuation.cents * 100_000_000n) / document.totals.sats
}

export async function loadConvexRowEnvelope(
  query: QueryConvexRows,
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
    query({ kind: "transactions" }),
    query({ kind: "todos" }),
    query({ kind: "income" }),
    query({ kind: "btcBuys", scope: "visible" }),
    query({ kind: "btcAccounts", scope: "visible" }),
    query({ kind: "btcBillPays", scope: "visible" }),
    query({ kind: "btcTransfers", scope: "netWorth" }),
    query({ kind: "budget", scope: "netWorth" }),
    query({ kind: "btcSnapshotMeta", scope: "visible" }),
    query({ kind: "btcBalanceDocuments", scope: "netWorth" }),
  ])
  const [
    transactionsResult,
    todosResult,
    incomeResult,
    buysResult,
    accountsResult,
    billPaysResult,
    transfersResult,
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
            // A complete successful transaction query is usable even when it
            // contains no rows: that is an authoritative zero, not missing data.
            true,
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
  const btcTransfers =
    transfersResult.status === "error"
      ? errorSlice<readonly BtcTransferRecord[]>([], transfersResult.code)
      : transfersResult.kind !== "btcTransfers"
        ? errorSlice<readonly BtcTransferRecord[]>([], "invalid-response")
        : populatedSlice(
            transfersResult.rows.map(btcTransfer),
            true,
            updatedAt(transfersResult.rows),
            `${SOURCE} · BTC transfers`,
          )
  let budgetSlice: SliceState<Budget | null>
  if (budgetResult.status === "error") {
    budgetSlice = errorSlice<Budget | null>(null, budgetResult.code)
  } else if (budgetResult.kind !== "budget") {
    budgetSlice = errorSlice<Budget | null>(null, "invalid-response")
  } else if (budgetResult.value === null) {
    budgetSlice = populatedSlice(null, false, null, `${SOURCE} · budget document`)
  } else {
    const adaptedBudget = budget(budgetResult.value)
    budgetSlice = adaptedBudget === null
      ? errorSlice<Budget | null>(null, "invalid-response")
      : populatedSlice(
          adaptedBudget,
          true,
          budgetResult.value.updatedAtMs,
          `${SOURCE} · budget document`,
        )
  }
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
    btcTransfers.updatedAt,
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
      btcTransfers,
      todos,
      btcPriceUsd: priceFromBalanceDocument(btcBalance.value),
      generatedAt: timestamps.length > 0 ? Math.max(...timestamps) : now(),
    },
  }
}
