// Finance / Bitcoin page slice.
//
// Every page filters through the shared visibility layer rather than trusting
// the envelope. Adults see the household and the kids; kids see only themselves;
// net worth is a narrower scope than visibility, so a child's stack shows on the
// child's profile but never rolls into an adult total.

import {
  type FamilyMember,
  canSeeDataOwnedBy,
  displayName,
  isAdult,
  netWorthScopeFor,
  visibleTo,
} from "@vogel-vault/domain/family"
import { basisPoints, formatUsd, satsToUsdCents, sum } from "@vogel-vault/domain/money"
import {
  type BTCAccount,
  type BTCBillPay,
  type BTCSnapshot,
  type BTCBuy,
  type BudgetCategory,
  type CategorySpend,
  type Freshness,
  type MonthKey,
  type Transaction,
  budgetMonthsFor,
  budgetTransactionsFor,
  monthOf,
  resolveBudgetMonth,
  transactionsInMonth,
} from "@vogel-vault/domain/readModel"
import { useMemo, useState } from "react"

import { useAppState } from "../../app/AppState.tsx"
import {
  type DisplayUnit,
  PRICE_UNAVAILABLE,
  availableBtcQuote,
  formatDisplayAmount,
  formatBitcoin,
} from "../../data/bitcoinDisplay.ts"
import {
  deriveBudgetSpend,
  displaySpendAmount,
  hasOppositeSpendSign,
  spendAmount,
} from "../../data/transactionAmounts.ts"
import {
  fiatCentsOf,
  fiatValuationOf,
} from "../../data/btcFiatValuation.ts"
import {
  Badge,
  BillPayFormDialog,
  BtcAccountFormDialog,
  BtcBuyFormDialog,
  BudgetCategoryFormDialog,
  Button,
  type Column,
  DataTable,
  DeleteConfirmDialog,
  FreshnessTag,
  type KPI,
  KPIStrip,
  PageGrid,
  PageHeader,
  Panel,
  MutationNotice,
  RowActions,
  SUPPRESSED,
  Select,
  StateBlock,
  StatusBanner,
  TransactionFormDialog,
} from "../../components/index.ts"
import { mutationOwner, stableId } from "../../data/mutations.ts"
import type { PageManifest } from "../types.ts"

// ── shared helpers ──────────────────────────────────────────────────────────

function tableState(status: string): "normal" | "empty" | "error" | "stale" | "loading" {
  if (status === "loading" || status === "error" || status === "empty") return status
  return "normal"
}

/**
 * Suppress a figure when the slice it came from did not load.
 *
 * Without this a page renders "Could not load" in its table while the KPI strip
 * above still shows totals computed from whatever was in memory — which is
 * precisely the "something wrong" the error state promises not to display.
 * Some collections can be authoritatively empty (for example todos or bill
 * pays). Required financial snapshots cannot: an empty result means the source
 * is unavailable, not that the household owns zero.
 */
function figure(status: string, render: () => string, emptyIsUnavailable = false): string {
  if (status === "error" || status === "loading" || (emptyIsUnavailable && status === "empty")) {
    return SUPPRESSED
  }
  return render()
}

/** Required financial sources do not turn an empty projection into zero. */
function requiredFigure(status: string, render: () => string): string {
  if (status === "error" || status === "loading" || status === "empty") return SUPPRESSED
  return render()
}

/**
 * Budget actuals are a two-slice projection: targets come from the budget, but
 * spend comes from transactions. The projection is only usable when both reads
 * are usable.
 */
function budgetActualsStatus(budget: Freshness, transactions: Freshness): Freshness {
  for (const unavailable of ["error", "loading", "empty"] as const) {
    if (budget === unavailable || transactions === unavailable) return unavailable
  }
  if (budget === "stale" || transactions === "stale") return "stale"
  if (budget === "demo" || transactions === "demo") return "demo"
  return "live"
}

function BitcoinQuoteNotice({ available }: { available: boolean }) {
  return available ? null : (
    <StatusBanner
      tone="warning"
      title={PRICE_UNAVAILABLE}
      detail="No live or stale canonical BTC quote is available. Native USD and satoshi values remain exact."
    />
  )
}

function BitcoinSnapshotNotice({
  status,
  document,
}: {
  status: Freshness
  document: BTCSnapshot | null
}) {
  const available =
    status !== "error" &&
    status !== "loading" &&
    status !== "empty" &&
    document !== null &&
    fiatValuationOf(document.totals) !== null

  return available ? (
    <StatusBanner
      title="USD snapshot"
      detail={`Uses the canonical BTC balance document from ${document.asOf}. This is not a live price.`}
    />
  ) : (
    <StatusBanner
      tone="warning"
      title={PRICE_UNAVAILABLE}
      detail={
        document
          ? "The BTC balance is known, but no supported USD valuation exists. BTC and SATS remain exact."
          : "No canonical BTC balance document is available. BTC and SATS remain exact."
      }
    />
  )
}

function formatSnapshotBitcoin(
  sats: bigint,
  fiatCents: bigint | null,
  unit: DisplayUnit,
): string {
  return unit === "usd"
    ? fiatCents === null ? PRICE_UNAVAILABLE : formatUsd(fiatCents)
    : formatBitcoin(sats, unit)
}

function incomeOf(transaction: Transaction): bigint {
  return transaction.category === "Income" ? transaction.amount : 0n
}

const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/

interface DashboardIncomeRow {
  readonly date: string
  readonly month: string
  readonly amount: bigint
  readonly owner: FamilyMember
}

function isCanonicalDateInMonth(date: string, month: string): boolean {
  if (!MONTH_KEY.test(month) || !ISO_DATE.test(date) || !date.startsWith(`${month}-`)) return false
  const parsed = new Date(`${date}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date
}

/** Canonical MTD income: dedicated rows, net-worth owner scope, checked int64 sum. */
export function dashboardIncomeMtd(
  viewer: FamilyMember,
  month: string,
  status: Freshness,
  rows: readonly DashboardIncomeRow[],
): bigint | null {
  if (status === "loading" || status === "empty" || status === "error" || !MONTH_KEY.test(month)) {
    return null
  }

  const scoped = netWorthScopeFor(viewer, rows).filter((row) => row.month === month)
  if (scoped.length === 0) return null

  let total = 0n
  for (const row of scoped) {
    if (!isCanonicalDateInMonth(row.date, row.month) ||
        row.amount < INT64_MIN || row.amount > INT64_MAX) return null
    total += row.amount
    if (total < INT64_MIN || total > INT64_MAX) return null
  }
  return total
}

/**
 * Colour and sign for a transaction row.
 *
 * Income is category-based; for non-Income rows, positive is spend and negative
 * is a credit/refund. Route through the same helpers the totals use.
 */
function AmountCell({
  transaction,
  displayUnit,
  btcPriceCents,
}: {
  transaction: Transaction
  displayUnit: DisplayUnit
  btcPriceCents: bigint | null
}) {
  if (transaction.category !== "Income" && transaction.amount !== 0n) {
    const oppositeSign = hasOppositeSpendSign(transaction)
    const amount = formatDisplayAmount(
      { usdCents: displaySpendAmount(transaction) },
      displayUnit,
      btcPriceCents,
    )
    return (
      <span title={oppositeSign ? "Credit/refund, or a stored sign that needs review" : undefined}>
        <span className={oppositeSign ? "vv-positive" : "vv-negative"}>
          {!oppositeSign && amount !== PRICE_UNAVAILABLE ? "-" : ""}{amount}
        </span>
        {oppositeSign ? <> <Badge tone="warning">credit / check sign</Badge></> : null}
      </span>
    )
  }
  return (
    <span className="vv-positive">
      {formatDisplayAmount({ usdCents: incomeOf(transaction) }, displayUnit, btcPriceCents)}
    </span>
  )
}

function TransactionActions({ transaction }: { transaction: Transaction }) {
  const {
    activeProfile,
    data,
    isMutationPending,
    mutationGate,
    submitMutation,
  } = useAppState()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const editGate = mutationGate("transaction.upsert", data.transactions.status, transaction.owner)
  const deleteGate = mutationGate("transaction.delete", data.transactions.status, transaction.owner)
  const pending = isMutationPending(
    "transaction.upsert",
    transaction.owner,
    transaction.id,
  )

  async function remove() {
    setDeleting(true)
    const result = await submitMutation({
      kind: "transaction.delete",
      requestId: stableId("request"),
      actor: activeProfile,
      id: transaction.id,
      owner: mutationOwner("transaction.delete", transaction.owner),
      baseUpdatedAtMs: transaction.updatedAtMs,
    })
    setDeleting(false)
    if (result.status === "ok") setConfirming(false)
  }

  return (
    <>
      <RowActions
        label={transaction.merchant}
        onEdit={() => setEditing(true)}
        onDelete={() => setConfirming(true)}
        editDisabled={!editGate.allowed}
        deleteDisabled={!deleteGate.allowed}
        pending={pending || deleting}
      />
      <TransactionFormDialog
        open={editing}
        transaction={transaction}
        onClose={() => setEditing(false)}
      />
      <DeleteConfirmDialog
        open={confirming}
        label={transaction.merchant}
        busy={deleting}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove()}
      />
    </>
  )
}

function BudgetCategoryActions({
  category,
  month,
  selectedMonth,
  owner,
}: {
  category: BudgetCategory
  month: string
  selectedMonth: string
  owner: FamilyMember
}) {
  const {
    activeProfile,
    data,
    isMutationPending,
    mutationGate,
    submitMutation,
  } = useAppState()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const editGate = mutationGate(
    "budgetCategory.upsert",
    data.budget.status,
    owner,
    selectedMonth,
    month,
  )
  const deleteGate = mutationGate(
    "budgetCategory.delete",
    data.budget.status,
    owner,
    selectedMonth,
    month,
  )
  const pending = isMutationPending(
    "budgetCategory.upsert",
    owner,
    category.name,
    month,
  )

  async function remove() {
    const baseUpdatedAtMs = data.budget.value?.updatedAtMs
    if (baseUpdatedAtMs === undefined) return
    setDeleting(true)
    const result = await submitMutation({
      kind: "budgetCategory.delete",
      requestId: stableId("request"),
      actor: activeProfile,
      owner: mutationOwner("budgetCategory.delete", owner),
      month,
      name: category.name,
      baseUpdatedAtMs,
    })
    setDeleting(false)
    if (result.status === "ok") setConfirming(false)
  }

  return (
    <>
      <RowActions
        label={category.name}
        onEdit={() => setEditing(true)}
        onDelete={() => setConfirming(true)}
        editDisabled={!editGate.allowed}
        deleteDisabled={!deleteGate.allowed}
        pending={pending || deleting}
      />
      <BudgetCategoryFormDialog
        open={editing}
        category={category}
        month={month}
        onClose={() => setEditing(false)}
      />
      <DeleteConfirmDialog
        open={confirming}
        label={category.name}
        busy={deleting}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove()}
      />
    </>
  )
}

function BtcBuyActions({ buy }: { buy: BTCBuy }) {
  const { activeProfile, data, isMutationPending, mutationGate, submitMutation } = useAppState()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const editGate = mutationGate("btcBuy.upsert", data.btcBuys.status, buy.owner)
  const deleteGate = mutationGate("btcBuy.delete", data.btcBuys.status, buy.owner)
  const pending = isMutationPending("btcBuy.upsert", buy.owner, buy.id)

  async function remove() {
    setDeleting(true)
    const result = await submitMutation({
      kind: "btcBuy.delete",
      requestId: stableId("request"),
      actor: activeProfile,
      id: buy.id,
      owner: mutationOwner("btcBuy.delete", buy.owner),
      baseUpdatedAtMs: buy.updatedAtMs,
    })
    setDeleting(false)
    if (result.status === "ok") setConfirming(false)
  }
  return (
    <>
      <RowActions label={`${buy.source} buy`} onEdit={() => setEditing(true)} onDelete={() => setConfirming(true)} editDisabled={!editGate.allowed} deleteDisabled={!deleteGate.allowed} pending={pending || deleting} />
      <BtcBuyFormDialog open={editing} buy={buy} onClose={() => setEditing(false)} />
      <DeleteConfirmDialog open={confirming} label={`${buy.source} buy`} busy={deleting} onCancel={() => setConfirming(false)} onConfirm={() => void remove()} />
    </>
  )
}

function BillPayActions({ payment }: { payment: BTCBillPay }) {
  const { activeProfile, data, isMutationPending, mutationGate, submitMutation } = useAppState()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const editGate = mutationGate("btcBillPay.upsert", data.billPays.status, payment.owner)
  const deleteGate = mutationGate("btcBillPay.delete", data.billPays.status, payment.owner)
  const pending = isMutationPending("btcBillPay.upsert", payment.owner, payment.id)

  async function remove() {
    setDeleting(true)
    const result = await submitMutation({
      kind: "btcBillPay.delete",
      requestId: stableId("request"),
      actor: activeProfile,
      id: payment.id,
      owner: mutationOwner("btcBillPay.delete", payment.owner),
      baseUpdatedAtMs: payment.updatedAtMs,
    })
    setDeleting(false)
    if (result.status === "ok") setConfirming(false)
  }
  return (
    <>
      <RowActions label={payment.merchant} onEdit={() => setEditing(true)} onDelete={() => setConfirming(true)} editDisabled={!editGate.allowed} deleteDisabled={!deleteGate.allowed} pending={pending || deleting} />
      <BillPayFormDialog open={editing} payment={payment} onClose={() => setEditing(false)} />
      <DeleteConfirmDialog open={confirming} label={payment.merchant} busy={deleting} onCancel={() => setConfirming(false)} onConfirm={() => void remove()} />
    </>
  )
}

function BtcAccountActions({ account }: { account: BTCAccount }) {
  const { activeProfile, data, isMutationPending, mutationGate, submitMutation } = useAppState()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const editGate = mutationGate(
    "btcAccount.upsert",
    data.btcBalanceDocument.status,
    mutationOwner("btcAccount.upsert", account.owner),
  )
  const deleteGate = mutationGate(
    "btcAccount.delete",
    data.btcBalanceDocument.status,
    mutationOwner("btcAccount.delete", account.owner),
  )
  const pending = isMutationPending("btcAccount.upsert", account.owner, account.key)

  async function remove() {
    const baseUpdatedAtMs = data.btcBalanceDocument.value?.updatedAtMs
    if (baseUpdatedAtMs === undefined) return
    setDeleting(true)
    const result = await submitMutation({
      kind: "btcAccount.delete",
      requestId: stableId("request"),
      actor: activeProfile,
      key: account.key,
      owner: mutationOwner("btcAccount.delete", account.owner),
      baseUpdatedAtMs,
    })
    setDeleting(false)
    if (result.status === "ok") setConfirming(false)
  }
  return (
    <>
      <RowActions label={account.label} onEdit={() => setEditing(true)} onDelete={() => setConfirming(true)} editDisabled={!editGate.allowed} deleteDisabled={!deleteGate.allowed} pending={pending || deleting} />
      <BtcAccountFormDialog open={editing} account={account} onClose={() => setEditing(false)} />
      <DeleteConfirmDialog open={confirming} label={account.label} busy={deleting} onCancel={() => setConfirming(false)} onConfirm={() => void remove()} />
    </>
  )
}

// ── Month scoping ───────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

/**
 * "2026-06" → "June 2026".
 *
 * Indexed rather than parsed. Handing `yyyy-MM` to Date yields UTC midnight,
 * which renders as the *previous* month for anyone west of Greenwich — the
 * exact class of off-by-one a ledger cannot afford.
 */
function monthLabel(month: MonthKey): string {
  const [year, index] = month.split("-")
  const name = MONTH_NAMES[Number(index) - 1]
  return name && year ? `${name} ${year}` : month
}

interface MonthScope {
  /** The month to report on. */
  readonly month: MonthKey
  /** Months the picker offers, newest first. */
  readonly options: readonly MonthKey[]
}

/**
 * Resolve the month both money screens report on.
 *
 * A selection is honoured only when the budget-scoped transactions contain it.
 * Adults may still see child rows on Activity, but child-only months are not adult
 * budget choices. Anything else falls back to the data's own month: the selection
 * is shared app-wide, so a month that exists only for another profile can be left
 * behind by a switch, and silently reporting an empty month reads as a broken
 * screen rather than as a filter.
 *
 * The fallback is always offered even when it holds no transactions — a budget
 * with nothing spent against it yet is a real month, and dropping it from the
 * list would leave the picker showing no selection at all.
 */
function resolveMonthScope(
  viewer: FamilyMember,
  selected: MonthKey | null,
  transactions: readonly Transaction[],
  fallback: MonthKey,
): MonthScope {
  const options = budgetMonthsFor(viewer, transactions, fallback)
  return {
    month: resolveBudgetMonth(selected, options, fallback) ?? fallback,
    options,
  }
}

function MonthPicker({ scope, label }: { scope: MonthScope; label: string }) {
  const { selectMonth } = useAppState()
  return (
    <Select
      aria-label={label}
      value={scope.month}
      onChange={(event) => selectMonth(event.target.value)}
      // .vv-input is width:100%, sized for a form column. In the page header it
      // is one control in a flex row, so let it take its own intrinsic width.
      style={{ width: "auto" }}
    >
      {scope.options.map((option) => (
        <option key={option} value={option}>
          {monthLabel(option)}
        </option>
      ))}
    </Select>
  )
}

function StaleNotice({ status }: { status: string }) {
  if (status !== "stale") return null
  return (
    <StatusBanner
      tone="warning"
      title="These figures are stale"
      detail="The Convex row-table read has not refreshed recently. Do not act on these numbers until sync is healthy."
    />
  )
}

// ── Dashboard ───────────────────────────────────────────────────────────────

function DashboardPage() {
  const { activeProfile, data, displayUnit, selectedMonth } = useAppState()
  const visibleTransactions = visibleTo(activeProfile, data.transactions.value)
  const budgetTransactions = budgetTransactionsFor(activeProfile, data.transactions.value)
  const accounts = data.btcBalanceDocument.value?.accounts ?? []
  const todos = visibleTo(activeProfile, data.todos.value).filter((todo) => !todo.done)
  const btcPriceCents = availableBtcQuote(data.btcBalanceDocument.status, data.btcPriceUsd)

  // The headline follows budget scope: adults share only adult-owned rows while
  // retaining child rows in Recent activity for oversight. Children remain
  // self-only. Both lists use the same selected month.
  const defaultMonth = data.budget.value?.month ?? monthOf(new Date(data.generatedAt).toISOString().slice(0, 10))
  const { month } = resolveMonthScope(activeProfile, selectedMonth, data.transactions.value, defaultMonth)
  const budgetMonthTransactions = transactionsInMonth(budgetTransactions, month)
  const activityMonthTransactions = transactionsInMonth(visibleTransactions, month)
  const spend = sum(budgetMonthTransactions.map(spendAmount))
  const income = dashboardIncomeMtd(activeProfile, month, data.income.status, data.income.value)
  const stackSats = data.btcBalanceDocument.value?.totals.sats ?? 0n
  const stackValue = data.btcBalanceDocument.value
    ? fiatCentsOf(data.btcBalanceDocument.value.totals)
    : null

  const txStatus = data.transactions.status
  const btcStatus = data.btcBalanceDocument.status
  const todoStatus = data.todos.status

  const kpis: KPI[] = [
    {
      label: "Spend (visible)",
      value: figure(
        txStatus,
        () => formatDisplayAmount({ usdCents: spend }, displayUnit, btcPriceCents),
        true,
      ),
      tone: "negative",
    },
    {
      label: "Income MTD",
      value: income === null
        ? SUPPRESSED
        : formatDisplayAmount({ usdCents: income }, displayUnit, btcPriceCents),
      tone: "positive",
    },
    {
      label: "Stack",
      value: requiredFigure(
        btcStatus,
        () => formatSnapshotBitcoin(stackSats, stackValue, displayUnit),
      ),
      tone: "accent",
      hint: requiredFigure(
        btcStatus,
        () => `Canonical snapshot · ${data.btcBalanceDocument.value?.asOf ?? "date unavailable"}`,
      ),
    },
    { label: "Open tasks", value: figure(todoStatus, () => String(todos.length)) },
  ]

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${isAdult(activeProfile) ? "Household command center" : `${displayName(activeProfile)}'s money`} · ${monthLabel(month)}`}
        actions={<FreshnessTag status={data.transactions.status} updatedAt={data.transactions.updatedAt} />}
      />
      <StaleNotice status={data.transactions.status} />
      {displayUnit === "usd" ? (
        <BitcoinSnapshotNotice
          status={data.btcBalanceDocument.status}
          document={data.btcBalanceDocument.value}
        />
      ) : null}
      <KPIStrip items={kpis} />
      <PageGrid>
        <Panel title="Recent activity" source={data.transactions.source} flush>
          <DataTable
            columns={transactionColumns(displayUnit, btcPriceCents, false)}
            rows={activityMonthTransactions.slice(0, 8)}
            rowKey={(row) => row.id}
            state={tableState(data.transactions.status)}
          />
        </Panel>
        <Panel title="Bitcoin" source={data.btcBalanceDocument.source} flush>
          <DataTable
            columns={stackColumns(displayUnit)}
            rows={accounts}
            rowKey={(row) => row.key}
            state={tableState(data.btcBalanceDocument.status)}
            emptyTitle="No accounts in scope"
            emptyDetail="This profile has no Bitcoin accounts that count toward its net worth."
          />
        </Panel>
      </PageGrid>
    </>
  )
}

function transactionColumns(
  displayUnit: DisplayUnit,
  btcPriceCents: bigint | null,
  detailed: boolean,
): ReadonlyArray<Column<Transaction>> {
  return [
    { key: "date", header: "Date", render: (row) => row.date, width: "104px" },
    { key: "merchant", header: "Merchant", render: (row) => row.merchant },
    { key: "category", header: "Category", render: (row) => <Badge>{row.category}</Badge>, secondary: !detailed },
    ...(detailed ? [
      { key: "card", header: "Card", render: (row: Transaction) => row.card ?? "—", secondary: true },
      { key: "owner", header: "Owner", render: (row: Transaction) => <Badge tone="neutral">{row.owner}</Badge>, secondary: true },
    ] : []),
    {
      key: "amount",
      header: displayUnit === "sats" ? "Sats" : displayUnit.toUpperCase(),
      numeric: true,
      render: (row) => (
        <AmountCell
          transaction={row}
          displayUnit={displayUnit}
          btcPriceCents={btcPriceCents}
        />
      ),
    },
  ]
}

function stackColumns(
  displayUnit: DisplayUnit,
): ReadonlyArray<Column<BTCAccount>> {
  return [
    { key: "label", header: "Account", render: (row) => row.label },
    {
      key: "custody",
      header: "Custody",
      render: (row) => (
        <Badge tone={row.custody === "self_custody" ? "accent" : "neutral"}>
          {row.custody === "self_custody" ? "Self custody" : "Exchange"}
        </Badge>
      ),
      secondary: true,
    },
    {
      key: "amount",
      header: displayUnit === "sats" ? "Sats" : displayUnit.toUpperCase(),
      numeric: true,
      render: (row) => formatSnapshotBitcoin(row.sats, fiatCentsOf(row), displayUnit),
    },
  ]
}

// ── Budget ──────────────────────────────────────────────────────────────────

function BudgetPage() {
  const {
    activeProfile,
    data,
    mutationGate,
    mutationNotice,
    refresh,
    selectedMonth,
  } = useAppState()
  const [adding, setAdding] = useState(false)
  const budget = data.budget.value

  if (!budget) {
    return (
      <>
        <PageHeader title="Budget" />
        <StateBlock state={data.budget.status === "loading" ? "loading" : "empty"} />
      </>
    )
  }

  const transactions = budgetTransactionsFor(activeProfile, data.transactions.value)
  const scope = resolveMonthScope(activeProfile, selectedMonth, data.transactions.value, budget.month)

  // Spend is DERIVED from the reported month's transactions, never read from
  // the reported category total: a July budget must count only July
  // transactions. This is what the iOS client has always done
  // (BudgetView.monthTransactions).
  //
  // The month is overridden on the budget rather than passed alongside it
  // because deriveBudgetSpend reads its month from the budget — one source of
  // truth for the filter, so the categories, the totals and the panel caption
  // cannot drift apart.
  const spend = deriveBudgetSpend({ ...budget, month: scope.month }, transactions)
  const { planned, actual, remaining, overBudgetCount: overCount } = spend
  const actualsStatus = budgetActualsStatus(data.budget.status, data.transactions.status)
  const actualsUnavailable =
    actualsStatus === "error" || actualsStatus === "loading" || actualsStatus === "empty"
  const addGate = mutationGate(
    "budgetCategory.upsert",
    data.budget.status,
    budget.owner,
    scope.month,
    budget.month,
  )
  const interactiveBudgetColumns: ReadonlyArray<Column<CategorySpend>> = [
    ...budgetColumns,
    {
      key: "actions",
      header: "Actions",
      render: (row) => {
        const sourceCategory = budget.categories.find((item) => item.name === row.name)
        return sourceCategory ? (
          <BudgetCategoryActions
            category={sourceCategory}
            month={budget.month}
            selectedMonth={scope.month}
            owner={budget.owner}
          />
        ) : null
      },
      width: "150px",
    },
  ]

  return (
    <>
      <PageHeader
        title="Budget"
        subtitle={monthLabel(scope.month)}
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => setAdding(true)}
              disabled={!addGate.allowed}
              title={addGate.reason ?? undefined}
            >
              Add category
            </Button>
            {actualsUnavailable ? null : <MonthPicker scope={scope} label="Budget month" />}
            <FreshnessTag status={data.budget.status} updatedAt={data.budget.updatedAt} />
          </>
        }
      />
      <MutationNotice notice={mutationNotice} onRetry={() => void refresh()} />
      <StaleNotice status={data.budget.status} />
      {scope.month === budget.month ? null : (
        <StatusBanner
          tone="info"
          title={`Planned amounts are from the ${monthLabel(budget.month)} budget`}
          detail="The current budget projection carries one planned month at a time, so the actuals below are this month's while the planned column is not. Compare with that in mind."
        />
      )}
      {/* The budget operations strip: planned / actual / remaining / over-budget. */}
      <KPIStrip
        items={[
          { label: "Planned", value: figure(data.budget.status, () => formatUsd(planned)), provenance: "planned" },
          { label: "Actual", value: requiredFigure(actualsStatus, () => formatUsd(actual)), provenance: "actual" },
          {
            label: "Remaining",
            value: requiredFigure(actualsStatus, () => formatUsd(remaining)),
            tone: remaining < 0n ? "negative" : "positive",
          },
          {
            label: "Over budget",
            value: requiredFigure(actualsStatus, () => String(overCount)),
            tone: overCount > 0 ? "negative" : "neutral",
            hint: overCount === 1 ? "1 category" : `${overCount} categories`,
          },
        ]}
      />
      {spend.uncategorised > 0n && !actualsUnavailable ? (
        <StatusBanner
          tone="info"
          title={`${formatUsd(spend.uncategorised)} spent outside any budget category`}
          detail="Counted on Activity but not against a category here. Add a category through an approved write path to track it."
        />
      ) : null}
      <Panel
        title="Categories"
        source={`${data.budget.source} · spend derived from ${scope.month} transactions`}
        flush
      >
        <DataTable
          columns={interactiveBudgetColumns}
          rows={spend.categories}
          rowKey={(row) => row.name}
          state={
            actualsStatus === "loading"
              ? "loading"
              : actualsUnavailable
                ? "error"
                : tableState(actualsStatus)
          }
        />
      </Panel>
      <BudgetCategoryFormDialog
        open={adding}
        category={null}
        month={budget.month}
        onClose={() => setAdding(false)}
      />
    </>
  )
}

const budgetColumns: ReadonlyArray<Column<CategorySpend>> = [
  { key: "name", header: "Category", render: (row) => row.name },
  {
    key: "budget",
    header: "Planned",
    numeric: true,
    render: (row) => <span className="vv-planned">{formatUsd(row.budget)}</span>,
  },
  {
    key: "spent",
    header: "Actual",
    numeric: true,
    render: (row) => <span className="vv-actual">{formatUsd(row.spent)}</span>,
  },
  {
    key: "remaining",
    header: "Remaining",
    numeric: true,
    render: (row) => (
      <span className={row.isOverBudget ? "vv-negative" : "vv-muted"}>{formatUsd(row.remaining)}</span>
    ),
  },
  {
    key: "use",
    header: "Used",
    numeric: true,
    secondary: true,
    render: (row) => `${(basisPoints(row.spent, row.budget) / 100).toFixed(0)}%`,
  },
]

// ── Activity ────────────────────────────────────────────────────────────────

function ActivityPage() {
  const {
    activeProfile,
    data,
    displayUnit,
    mutationGate,
    mutationNotice,
    refresh,
  } = useAppState()
  const [adding, setAdding] = useState(false)
  const transactions = visibleTo(activeProfile, data.transactions.value)
  const btcPriceCents = availableBtcQuote(data.btcBalanceDocument.status, data.btcPriceUsd)
  const addGate = mutationGate(
    "transaction.upsert",
    data.transactions.status,
    mutationOwner("transaction.upsert", activeProfile),
  )
  const columns = useMemo<ReadonlyArray<Column<Transaction>>>(
    () => [
      ...transactionColumns(displayUnit, btcPriceCents, true),
      {
        key: "actions",
        header: "Actions",
        render: (row) => <TransactionActions transaction={row} />,
        width: "150px",
      },
    ],
    [btcPriceCents, displayUnit],
  )

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="All transactions visible to this profile"
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => setAdding(true)}
              disabled={!addGate.allowed}
              title={addGate.reason ?? undefined}
            >
              Add transaction
            </Button>
            <FreshnessTag status={data.transactions.status} updatedAt={data.transactions.updatedAt} />
          </>
        }
      />
      <MutationNotice notice={mutationNotice} onRetry={() => void refresh()} />
      <StaleNotice status={data.transactions.status} />
      <Panel source={data.transactions.source} flush>
        <DataTable
          columns={columns}
          rows={transactions}
          rowKey={(row) => row.id}
          state={tableState(data.transactions.status)}
          footer={`${transactions.length} of ${data.transactions.value.length} records visible to ${activeProfile}`}
        />
      </Panel>
      <TransactionFormDialog open={adding} transaction={null} onClose={() => setAdding(false)} />
    </>
  )
}

// ── Bitcoin Overview ────────────────────────────────────────────────────────

function BitcoinOverviewPage() {
  const {
    activeProfile,
    data,
    displayUnit,
    mutationGate,
    mutationNotice,
    refresh,
  } = useAppState()
  const [adding, setAdding] = useState(false)
  const visible = visibleTo(activeProfile, data.btcAccounts.value)
  const projectionInScope = netWorthScopeFor(activeProfile, visible)
  const document = data.btcBalanceDocument.value
  const inScope = document?.accounts ?? []
  const totalSats = document?.totals.sats ?? 0n
  const totalValuation = document ? fiatValuationOf(document.totals) : null
  const totalFiat = totalValuation?.cents ?? null
  const valuationPrice = totalValuation?.priceCents ?? null
  const selfCustody = document?.totals.selfCustodySats ?? 0n
  const exchange = document?.totals.exchangeSats ?? 0n
  const status = data.btcBalanceDocument.status
  const btcPriceCents = availableBtcQuote(status, data.btcPriceUsd)
  const addGate = mutationGate(
    "btcAccount.upsert",
    data.btcBalanceDocument.status,
    mutationOwner("btcAccount.upsert", activeProfile),
  )
  const syncedColumns: ReadonlyArray<Column<BTCAccount>> = [
    ...stackColumns(displayUnit),
    { key: "owner", header: "Owner", render: (row) => <Badge>{row.owner}</Badge>, secondary: true },
    {
      key: "actions",
      header: "Actions",
      render: (row) => <BtcAccountActions account={row} />,
      width: "150px",
    },
  ]

  // Adults can see a child's stack but it is not part of their net worth. Say so
  // rather than letting the difference look like a bug.
  const outOfScope = visible.filter((account) => !projectionInScope.includes(account))

  return (
    <>
      <PageHeader
        title="Bitcoin Overview"
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => setAdding(true)}
              disabled={!addGate.allowed}
              title={addGate.reason ?? undefined}
            >
              Add BTC account
            </Button>
            <FreshnessTag
              status={data.btcBalanceDocument.status}
              updatedAt={data.btcBalanceDocument.updatedAt}
            />
          </>
        }
      />
      <MutationNotice notice={mutationNotice} onRetry={() => void refresh()} />
      <StaleNotice status={data.btcBalanceDocument.status} />
      {displayUnit === "usd" ? (
        <BitcoinSnapshotNotice status={status} document={document} />
      ) : null}
      <KPIStrip
        items={[
          {
            label: "Total stack",
            value: requiredFigure(
              status,
              () => formatSnapshotBitcoin(totalSats, totalFiat, displayUnit),
            ),
            tone: "accent",
          },
          {
            label: "Value",
            value: requiredFigure(
              status,
              () => formatDisplayAmount(
                { sats: totalSats, usdCents: totalFiat },
                displayUnit,
                btcPriceCents,
              ),
            ),
            provenance: "estimated",
          },
          {
            label: "Self custody",
            value: requiredFigure(
              status,
              () => `${(basisPoints(selfCustody, totalSats) / 100).toFixed(1)}%`,
            ),
            hint: requiredFigure(
              status,
              () => formatSnapshotBitcoin(
                selfCustody,
                valuationPrice && valuationPrice > 0n
                  ? satsToUsdCents(selfCustody, valuationPrice)
                  : null,
                displayUnit,
              ),
            ),
          },
          {
            label: "On exchange",
            value: requiredFigure(
              status,
              () => formatSnapshotBitcoin(
                exchange,
                valuationPrice && valuationPrice > 0n
                  ? satsToUsdCents(exchange, valuationPrice)
                  : null,
                displayUnit,
              ),
            ),
          },
        ]}
      />
      {outOfScope.length > 0 ? (
        <StatusBanner
          tone="info"
          title={`${outOfScope.length} account(s) visible but outside this profile's net worth`}
          detail="Children's stacks are shown for oversight but never roll into adult totals."
        />
      ) : null}
      <Panel
        title="Canonical accounts"
        source={`${data.btcBalanceDocument.source} · writes update this document atomically`}
        flush
      >
        <StatusBanner
          tone="info"
          title="Account edits do not fabricate a USD value"
          detail="Quantity edits preserve an existing supported valuation; new unvalued accounts remain unvalued."
        />
        <DataTable
          columns={syncedColumns}
          rows={inScope}
          rowKey={(row) => row.key}
          state={tableState(data.btcBalanceDocument.status)}
          emptyTitle="No canonical accounts"
          emptyDetail="No editable account document is available for this profile."
        />
      </Panel>
      <BtcAccountFormDialog open={adding} account={null} onClose={() => setAdding(false)} />
    </>
  )
}

// ── Bitcoin Buys ────────────────────────────────────────────────────────────

function BitcoinBuysPage() {
  const {
    activeProfile,
    data,
    displayUnit,
    mutationGate,
    mutationNotice,
    refresh,
  } = useAppState()
  const [adding, setAdding] = useState(false)
  const buys = visibleTo(activeProfile, data.btcBuys.value)
  const totalSats = sum(buys.map((buy) => buy.sats))
  const totalUsd = sum(buys.map((buy) => buy.usd))
  const quote = availableBtcQuote(data.btcBalanceDocument.status, data.btcPriceUsd)
  const addGate = mutationGate(
    "btcBuy.upsert",
    data.btcBuys.status,
    mutationOwner("btcBuy.upsert", activeProfile),
  )

  return (
    <>
      <PageHeader
        title="Bitcoin Buys"
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => setAdding(true)}
              disabled={!addGate.allowed}
              title={addGate.reason ?? undefined}
            >
              Add buy
            </Button>
            <FreshnessTag status={data.btcBuys.status} updatedAt={data.btcBuys.updatedAt} />
          </>
        }
      />
      <MutationNotice notice={mutationNotice} onRetry={() => void refresh()} />
      <StaleNotice status={data.btcBuys.status} />
      <BitcoinQuoteNotice available={quote !== null} />
      <KPIStrip
        items={[
          {
            label: "Accumulated",
            value: requiredFigure(
              data.btcBuys.status,
              () => formatDisplayAmount(
                { sats: totalSats, usdCents: totalUsd },
                displayUnit,
                quote,
              ),
            ),
            tone: "accent",
          },
          {
            label: "Invested",
            value: requiredFigure(
              data.btcBuys.status,
              () => formatDisplayAmount({ usdCents: totalUsd }, displayUnit, quote),
            ),
          },
          {
            label: "Average cost",
            value: figure(data.btcBuys.status, () =>
              totalSats > 0n
                ? `${formatDisplayAmount(
                    { usdCents: (totalUsd * 100_000_000n) / totalSats },
                    displayUnit,
                    quote,
                  )}/BTC`
                : "—",
            ),
            provenance: "estimated",
          },
        ]}
      />
      <Panel source={data.btcBuys.source} flush>
        <DataTable
          columns={[
            { key: "date", header: "Date", render: (row) => row.date, width: "104px" },
            { key: "source", header: "Source", render: (row) => row.source },
            {
              key: "amount",
              header: displayUnit === "sats" ? "Sats" : displayUnit.toUpperCase(),
              numeric: true,
              render: (row) => formatDisplayAmount(
                { sats: row.sats, usdCents: row.usd },
                displayUnit,
                quote,
              ),
            },
            {
              key: "price",
              header: `Price (${displayUnit === "sats" ? "SATS" : displayUnit.toUpperCase()}/BTC)`,
              numeric: true,
              render: (row) => formatDisplayAmount({ usdCents: row.priceUsd }, displayUnit, quote),
              secondary: true,
            },
            {
              key: "cost",
              header: `Cost (${displayUnit === "sats" ? "SATS" : displayUnit.toUpperCase()})`,
              numeric: true,
              render: (row) => formatDisplayAmount({ usdCents: row.usd }, displayUnit, quote),
            },
            {
              key: "status",
              header: "Basis",
              render: (row) => <Badge tone={row.costBasisStatus === "confirmed" ? "positive" : "warning"}>{row.costBasisStatus ?? "unknown"}</Badge>,
              secondary: true,
            },
            {
              key: "actions",
              header: "Actions",
              render: (row) => <BtcBuyActions buy={row} />,
              width: "150px",
            },
          ]}
          rows={buys}
          rowKey={(row) => row.id}
          state={tableState(data.btcBuys.status)}
        />
      </Panel>
      <BtcBuyFormDialog open={adding} buy={null} onClose={() => setAdding(false)} />
    </>
  )
}

// ── Bills ───────────────────────────────────────────────────────────────────

function BillsPage() {
  const {
    activeProfile,
    data,
    displayUnit,
    mutationGate,
    mutationNotice,
    refresh,
  } = useAppState()
  const [adding, setAdding] = useState(false)
  const pays = visibleTo(activeProfile, data.billPays.value)
  const quote = availableBtcQuote(data.btcBalanceDocument.status, data.btcPriceUsd)
  const totalUsd = sum(pays.map((pay) => pay.amountUsd))
  const totalSats = sum(pays.map((pay) => pay.btcSpentSats))
  const addGate = mutationGate(
    "btcBillPay.upsert",
    data.billPays.status,
    mutationOwner("btcBillPay.upsert", activeProfile),
  )

  return (
    <>
      <PageHeader
        title="Bills"
        subtitle="Bills settled in Bitcoin"
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => setAdding(true)}
              disabled={!addGate.allowed}
              title={addGate.reason ?? undefined}
            >
              Add bill payment
            </Button>
            <FreshnessTag status={data.billPays.status} updatedAt={data.billPays.updatedAt} />
          </>
        }
      />
      <MutationNotice notice={mutationNotice} onRetry={() => void refresh()} />
      <StaleNotice status={data.billPays.status} />
      <KPIStrip
        items={[
          {
            label: "Paid",
            value: figure(
              data.billPays.status,
              () => formatDisplayAmount(
                { sats: totalSats, usdCents: totalUsd },
                displayUnit,
                quote,
              ),
            ),
          },
          {
            label: "Bitcoin spent",
            value: figure(
              data.billPays.status,
              () => formatDisplayAmount({ sats: totalSats }, displayUnit, quote),
            ),
            tone: "accent",
          },
          {
            label: "Fees",
            value: figure(
              data.billPays.status,
              () => formatDisplayAmount(
                { usdCents: sum(pays.map((pay) => pay.feeUsd)) },
                displayUnit,
                quote,
              ),
            ),
          },
        ]}
      />
      <Panel source={data.billPays.source} flush>
        <DataTable
          columns={[
            { key: "date", header: "Date", render: (row) => row.date, width: "104px" },
            { key: "merchant", header: "Payee", render: (row) => row.merchant },
            { key: "category", header: "Category", render: (row) => <Badge>{row.category}</Badge>, secondary: true },
            {
              key: "amount",
              header: displayUnit === "sats" ? "Sats" : displayUnit.toUpperCase(),
              numeric: true,
              render: (row) => formatDisplayAmount(
                { sats: row.btcSpentSats, usdCents: row.amountUsd },
                displayUnit,
                quote,
              ),
            },
            {
              key: "fee",
              header: `Fee (${displayUnit === "sats" ? "SATS" : displayUnit.toUpperCase()})`,
              numeric: true,
              render: (row) => formatDisplayAmount({ usdCents: row.feeUsd }, displayUnit, quote),
              secondary: true,
            },
            {
              key: "actions",
              header: "Actions",
              render: (row) => <BillPayActions payment={row} />,
              width: "150px",
            },
          ]}
          rows={pays}
          rowKey={(row) => row.id}
          state={tableState(data.billPays.status)}
          emptyTitle="No Bitcoin bill payments"
          emptyDetail="Nothing has been settled in Bitcoin for this profile."
        />
      </Panel>
      <BillPayFormDialog open={adding} payment={null} onClose={() => setAdding(false)} />
    </>
  )
}

// ── Retirement ──────────────────────────────────────────────────────────────

function RetirementPage() {
  const { activeProfile, data, displayUnit } = useAppState()
  const incomeRows = visibleTo(activeProfile, data.income.value)
  const quote = availableBtcQuote(data.btcBalanceDocument.status, data.btcPriceUsd)
  const currentMonth =
    data.budget.value?.month ?? monthOf(new Date(data.generatedAt).toISOString().slice(0, 10))
  const currentYear = currentMonth.slice(0, 4)
  const ytdIncome = sum(
    incomeRows.filter((row) => row.month.startsWith(currentYear)).map((row) => row.amount),
  )
  const mtdIncome = sum(
    incomeRows.filter((row) => row.month === currentMonth).map((row) => row.amount),
  )

  return (
    <>
      <PageHeader
        title="Retirement"
        subtitle="Long-horizon accounts"
        actions={<FreshnessTag status={data.income.status} updatedAt={data.income.updatedAt} />}
      />
      <StaleNotice status={data.income.status} />
      <KPIStrip
        items={[
          {
            label: "YTD income",
            value: figure(
              data.income.status,
              () => formatDisplayAmount({ usdCents: ytdIncome }, displayUnit, quote),
              true,
            ),
            provenance: "actual",
          },
          {
            label: "MTD income",
            value: figure(
              data.income.status,
              () => formatDisplayAmount({ usdCents: mtdIncome }, displayUnit, quote),
              true,
            ),
            provenance: "actual",
          },
        ]}
      />
      <Panel
        title="Retirement accounts"
        source="Unavailable in this client"
        flush
      >
        {/*
          The retirement account slice is not part of the renderer envelope yet.
          Showing an explicit unavailable state is correct here; inventing
          numbers would be worse.
        */}
        <StateBlock
          state="empty"
          title="Not wired to the live read yet"
          detail="Retirement rows are not wired into this client yet. No placeholder figures are shown on purpose."
        />
      </Panel>
    </>
  )
}

// ── Net Worth ───────────────────────────────────────────────────────────────

function NetWorthPage() {
  const { activeProfile, data, displayUnit } = useAppState()
  const document = data.btcBalanceDocument.value
  const inScope = document?.accounts ?? []
  const stackSats = document?.totals.sats ?? 0n
  const stackValue = document ? fiatCentsOf(document.totals) : null
  const quote = availableBtcQuote(data.btcBalanceDocument.status, data.btcPriceUsd)

  const projectedInScope = netWorthScopeFor(activeProfile, data.btcAccounts.value)
  const excluded = data.btcAccounts.value.filter(
    (account) =>
      canSeeDataOwnedBy(activeProfile, account.owner) && !projectedInScope.includes(account),
  )

  return (
    <>
      <PageHeader
        title="Net Worth"
        subtitle="Household scope for adults; self only for children"
        actions={
          <FreshnessTag
            status={data.btcBalanceDocument.status}
            updatedAt={data.btcBalanceDocument.updatedAt}
          />
        }
      />
      <StaleNotice status={data.btcBalanceDocument.status} />
      {displayUnit === "usd" ? (
        <BitcoinSnapshotNotice
          status={data.btcBalanceDocument.status}
          document={document}
        />
      ) : null}
      <KPIStrip
        items={[
          {
            label: "Bitcoin",
            value: requiredFigure(
              data.btcBalanceDocument.status,
              () => formatSnapshotBitcoin(stackSats, stackValue, displayUnit),
            ),
            tone: "accent",
          },
          {
            label: "Value",
            value: requiredFigure(
              data.btcBalanceDocument.status,
              () => formatDisplayAmount(
                { sats: stackSats, usdCents: stackValue },
                displayUnit,
                quote,
              ),
            ),
            hint: requiredFigure(
              data.btcBalanceDocument.status,
              () => `Canonical snapshot · ${document?.asOf ?? "date unavailable"}`,
            ),
            provenance: "estimated",
          },
          {
            label: "Accounts",
            value: requiredFigure(data.btcBalanceDocument.status, () => String(inScope.length)),
          },
        ]}
      />
      <PageGrid>
        <Panel title="In scope" source={data.btcBalanceDocument.source} flush>
          <DataTable
            columns={[
              { key: "label", header: "Account", render: (row) => row.label },
              { key: "owner", header: "Owner", render: (row) => <Badge>{row.owner}</Badge>, secondary: true },
              {
                key: "amount",
                header: displayUnit === "sats" ? "Sats" : displayUnit.toUpperCase(),
                numeric: true,
                render: (row) => formatSnapshotBitcoin(row.sats, fiatCentsOf(row), displayUnit),
              },
            ]}
            rows={inScope}
            rowKey={(row) => row.key}
            state={tableState(data.btcBalanceDocument.status)}
          />
        </Panel>
        <Panel
          title="Visible but excluded"
          source="Children's stacks never roll into adult totals"
          flush
        >
          <DataTable
            columns={[
              { key: "label", header: "Account", render: (row) => row.label },
              { key: "owner", header: "Owner", render: (row) => <Badge>{row.owner}</Badge> },
              {
                key: "amount",
                header: displayUnit === "sats" ? "Sats" : displayUnit.toUpperCase(),
                numeric: true,
                render: (row) => formatSnapshotBitcoin(row.sats, fiatCentsOf(row), displayUnit),
              },
            ]}
            rows={excluded}
            rowKey={(row) => row.key}
            state={tableState(data.btcAccounts.status)}
            emptyTitle="Nothing excluded"
            emptyDetail="Every account this profile can see also counts toward its net worth."
          />
        </Panel>
      </PageGrid>
    </>
  )
}

// ── Manifest ────────────────────────────────────────────────────────────────

export const financePageManifest: PageManifest = {
  id: "finance",
  label: "Finance",
  pages: [
    { id: "dashboard", label: "Dashboard", icon: "dashboard", Component: DashboardPage },
    { id: "budget", label: "Budget", icon: "banknote", Component: BudgetPage },
    { id: "activity", label: "Activity", icon: "activity", Component: ActivityPage },
    { id: "bitcoin", label: "Bitcoin Overview", icon: "bitcoin", Component: BitcoinOverviewPage },
    { id: "bitcoin-buys", label: "Bitcoin Buys", icon: "wallet", Component: BitcoinBuysPage },
    { id: "bills", label: "Bills", icon: "receipt", Component: BillsPage },
    { id: "retirement", label: "Retirement", icon: "retirement", Component: RetirementPage, adultOnly: true },
    { id: "net-worth", label: "Net Worth", icon: "bank", Component: NetWorthPage },
  ],
}
