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
import { basisPoints, formatBtc, formatSats, formatUsd, satsToUsdCents, sum } from "@vogel-vault/domain/money"
import {
  type BTCAccount,
  type CategorySpend,
  type MonthKey,
  type Transaction,
  budgetMonthsFor,
  budgetTransactionsFor,
  monthOf,
  resolveBudgetMonth,
  transactionsInMonth,
} from "@vogel-vault/domain/readModel"

import { useAppState } from "../../app/AppState.tsx"
import {
  deriveBudgetSpend,
  displaySpendAmount,
  hasOppositeSpendSign,
  spendAmount,
} from "../../data/transactionAmounts.ts"
import {
  Badge,
  type Column,
  DataTable,
  FreshnessTag,
  type KPI,
  KPIStrip,
  PageGrid,
  PageHeader,
  Panel,
  SUPPRESSED,
  Select,
  StateBlock,
  StatusBanner,
} from "../../components/index.ts"
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

function incomeOf(transaction: Transaction): bigint {
  return transaction.category === "Income" && transaction.amount > 0n ? transaction.amount : 0n
}

/**
 * Colour and sign for a transaction row.
 *
 * Income is category-based; for non-Income rows, positive is spend and negative
 * is a credit/refund. Route through the same helpers the totals use.
 */
function AmountCell({ transaction }: { transaction: Transaction }) {
  if (transaction.category !== "Income" && transaction.amount !== 0n) {
    const oppositeSign = hasOppositeSpendSign(transaction)
    return (
      <span title={oppositeSign ? "Credit/refund, or a stored sign that needs review" : undefined}>
        <span className={oppositeSign ? "vv-positive" : "vv-negative"}>
          {oppositeSign ? "" : "-"}{formatUsd(displaySpendAmount(transaction))}
        </span>
        {oppositeSign ? <> <Badge tone="warning">credit / check sign</Badge></> : null}
      </span>
    )
  }
  return <span className="vv-positive">{formatUsd(incomeOf(transaction))}</span>
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
      detail="The bridge has not refreshed recently. Do not act on these numbers until sync is healthy."
    />
  )
}

// ── Dashboard ───────────────────────────────────────────────────────────────

function DashboardPage() {
  const { activeProfile, data, selectedMonth } = useAppState()
  const visibleTransactions = visibleTo(activeProfile, data.transactions.value)
  const budgetTransactions = budgetTransactionsFor(activeProfile, data.transactions.value)
  const accounts = data.btcBalanceDocument.value?.accounts ?? []
  const incomeRows = visibleTo(activeProfile, data.income.value)
  const todos = visibleTo(activeProfile, data.todos.value).filter((todo) => !todo.done)

  // The headline follows budget scope: adults share only adult-owned rows while
  // retaining child rows in Recent activity for oversight. Children remain
  // self-only. Both lists use the same selected month.
  const defaultMonth = data.budget.value?.month ?? monthOf(new Date(data.generatedAt).toISOString().slice(0, 10))
  const { month } = resolveMonthScope(activeProfile, selectedMonth, data.transactions.value, defaultMonth)
  const budgetMonthTransactions = transactionsInMonth(budgetTransactions, month)
  const activityMonthTransactions = transactionsInMonth(visibleTransactions, month)
  const spend = sum(budgetMonthTransactions.map(spendAmount))
  const income = sum(incomeRows.filter((row) => row.month === month).map((row) => row.amount))
  const stackSats = data.btcBalanceDocument.value?.totals.sats ?? 0n
  const stackValue = data.btcBalanceDocument.value?.totals.fiat ?? 0n

  const txStatus = data.transactions.status
  const incomeStatus = data.income.status
  const btcStatus = data.btcBalanceDocument.status
  const todoStatus = data.todos.status

  const kpis: KPI[] = [
    {
      label: "Spend (visible)",
      value: figure(txStatus, () => formatUsd(spend), true),
      tone: "negative",
    },
    {
      label: "Income (visible)",
      value: figure(incomeStatus, () => formatUsd(income), true),
      tone: "positive",
    },
    {
      label: "Stack",
      value: figure(btcStatus, () => formatBtc(stackSats), true),
      tone: "accent",
      hint: figure(btcStatus, () => formatUsd(stackValue), true),
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
      <KPIStrip items={kpis} />
      <PageGrid>
        <Panel title="Recent activity" source={data.transactions.source} flush>
          <DataTable
            columns={recentColumns}
            rows={activityMonthTransactions.slice(0, 8)}
            rowKey={(row) => row.id}
            state={tableState(data.transactions.status)}
          />
        </Panel>
        <Panel title="Bitcoin" source={data.btcBalanceDocument.source} flush>
          <DataTable
            columns={stackColumns}
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

const recentColumns: ReadonlyArray<Column<Transaction>> = [
  { key: "date", header: "Date", render: (row) => row.date, width: "104px" },
  { key: "merchant", header: "Merchant", render: (row) => row.merchant },
  { key: "category", header: "Category", render: (row) => <Badge>{row.category}</Badge>, secondary: true },
  {
    key: "amount",
    header: "Amount",
    numeric: true,
    render: (row) => <AmountCell transaction={row} />,
  },
]

const stackColumns: ReadonlyArray<Column<BTCAccount>> = [
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
  { key: "sats", header: "Sats", numeric: true, render: (row) => formatSats(row.sats) },
]

// ── Budget ──────────────────────────────────────────────────────────────────

function BudgetPage() {
  const { activeProfile, data, selectedMonth } = useAppState()
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

  return (
    <>
      <PageHeader
        title="Budget"
        subtitle={monthLabel(scope.month)}
        actions={
          <>
            <MonthPicker scope={scope} label="Budget month" />
            <FreshnessTag status={data.budget.status} updatedAt={data.budget.updatedAt} />
          </>
        }
      />
      <StaleNotice status={data.budget.status} />
      {scope.month === budget.month ? null : (
        <StatusBanner
          tone="info"
          title={`Planned amounts are from the ${monthLabel(budget.month)} budget`}
          detail="MC2 publishes one budget file at a time, so the actuals below are this month's while the planned column is not. Compare with that in mind."
        />
      )}
      {/* The budget operations strip: planned / actual / remaining / over-budget. */}
      <KPIStrip
        items={[
          { label: "Planned", value: figure(data.budget.status, () => formatUsd(planned)), provenance: "planned" },
          { label: "Actual", value: figure(data.budget.status, () => formatUsd(actual)), provenance: "actual" },
          {
            label: "Remaining",
            value: figure(data.budget.status, () => formatUsd(remaining)),
            tone: remaining < 0n ? "negative" : "positive",
          },
          {
            label: "Over budget",
            value: figure(data.budget.status, () => String(overCount)),
            tone: overCount > 0 ? "negative" : "neutral",
            hint: overCount === 1 ? "1 category" : `${overCount} categories`,
          },
        ]}
      />
      {spend.uncategorised > 0n ? (
        <StatusBanner
          tone="info"
          title={`${formatUsd(spend.uncategorised)} spent outside any budget category`}
          detail="Counted on Activity but not against a category here. Add a category in MC2 to track it."
        />
      ) : null}
      <Panel
        title="Categories"
        source={`${data.budget.source} · spend derived from ${scope.month} transactions`}
        flush
      >
        <DataTable
          columns={budgetColumns}
          rows={spend.categories}
          rowKey={(row) => row.name}
          state={tableState(data.budget.status)}
        />
      </Panel>
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
  const { activeProfile, data } = useAppState()
  const transactions = visibleTo(activeProfile, data.transactions.value)

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="All transactions visible to this profile"
        actions={<FreshnessTag status={data.transactions.status} updatedAt={data.transactions.updatedAt} />}
      />
      <StaleNotice status={data.transactions.status} />
      <Panel source={data.transactions.source} flush>
        <DataTable
          columns={activityColumns}
          rows={transactions}
          rowKey={(row) => row.id}
          state={tableState(data.transactions.status)}
          footer={`${transactions.length} of ${data.transactions.value.length} records visible to ${activeProfile}`}
        />
      </Panel>
    </>
  )
}

const activityColumns: ReadonlyArray<Column<Transaction>> = [
  { key: "date", header: "Date", render: (row) => row.date, width: "104px" },
  { key: "merchant", header: "Merchant", render: (row) => row.merchant },
  { key: "category", header: "Category", render: (row) => <Badge>{row.category}</Badge> },
  { key: "card", header: "Card", render: (row) => row.card ?? "—", secondary: true },
  { key: "owner", header: "Owner", render: (row) => <Badge tone="neutral">{row.owner}</Badge>, secondary: true },
  {
    key: "amount",
    header: "Amount",
    numeric: true,
    render: (row) => <AmountCell transaction={row} />,
  },
]

// ── Bitcoin Overview ────────────────────────────────────────────────────────

function BitcoinOverviewPage() {
  const { activeProfile, data } = useAppState()
  const visible = visibleTo(activeProfile, data.btcAccounts.value)
  const projectionInScope = netWorthScopeFor(activeProfile, visible)
  const document = data.btcBalanceDocument.value
  const inScope = document?.accounts ?? []
  const totalSats = document?.totals.sats ?? 0n
  const totalFiat = document?.totals.fiat ?? 0n
  const selfCustody = document?.totals.selfCustodySats ?? 0n
  const exchange = document?.totals.exchangeSats ?? 0n
  const status = data.btcBalanceDocument.status

  // Adults can see a child's stack but it is not part of their net worth. Say so
  // rather than letting the difference look like a bug.
  const outOfScope = visible.filter((account) => !projectionInScope.includes(account))

  return (
    <>
      <PageHeader
        title="Bitcoin Overview"
        actions={
          <FreshnessTag
            status={data.btcBalanceDocument.status}
            updatedAt={data.btcBalanceDocument.updatedAt}
          />
        }
      />
      <StaleNotice status={data.btcBalanceDocument.status} />
      <KPIStrip
        items={[
          {
            label: "Total stack",
            value: figure(status, () => formatBtc(totalSats), true),
            tone: "accent",
          },
          {
            label: "Value",
            value: figure(status, () => formatUsd(totalFiat), true),
            provenance: "estimated",
          },
          {
            label: "Self custody",
            value: figure(
              status,
              () => `${(basisPoints(selfCustody, totalSats) / 100).toFixed(1)}%`,
              true,
            ),
            hint: figure(status, () => formatSats(selfCustody), true),
          },
          { label: "On exchange", value: figure(status, () => formatSats(exchange), true) },
        ]}
      />
      {outOfScope.length > 0 ? (
        <StatusBanner
          tone="info"
          title={`${outOfScope.length} account(s) visible but outside this profile's net worth`}
          detail="Children's stacks are shown for oversight but never roll into adult totals."
        />
      ) : null}
      <PageGrid>
        <Panel
          title="Accounts in net worth"
          source={data.btcBalanceDocument.source}
          flush
          className="vv-span-2"
        >
          <DataTable
            columns={stackColumns}
            rows={inScope}
            rowKey={(row) => row.key}
            state={tableState(data.btcBalanceDocument.status)}
          />
        </Panel>
      </PageGrid>
    </>
  )
}

// ── Bitcoin Buys ────────────────────────────────────────────────────────────

function BitcoinBuysPage() {
  const { activeProfile, data } = useAppState()
  const buys = visibleTo(activeProfile, data.btcBuys.value)
  const totalSats = sum(buys.map((buy) => buy.sats))
  const totalUsd = sum(buys.map((buy) => buy.usd))

  return (
    <>
      <PageHeader
        title="Bitcoin Buys"
        actions={<FreshnessTag status={data.btcBuys.status} updatedAt={data.btcBuys.updatedAt} />}
      />
      <StaleNotice status={data.btcBuys.status} />
      <KPIStrip
        items={[
          { label: "Accumulated", value: figure(data.btcBuys.status, () => formatBtc(totalSats)), tone: "accent" },
          { label: "Invested", value: figure(data.btcBuys.status, () => formatUsd(totalUsd)) },
          {
            label: "Average cost",
            value: figure(data.btcBuys.status, () =>
              totalSats > 0n
                ? formatUsd(satsToUsdCents(100_000_000n, (totalUsd * 100_000_000n) / totalSats))
                : "—",
            ),
            provenance: "estimated",
            hint: "per BTC",
          },
        ]}
      />
      <Panel source={data.btcBuys.source} flush>
        <DataTable
          columns={[
            { key: "date", header: "Date", render: (row) => row.date, width: "104px" },
            { key: "source", header: "Source", render: (row) => row.source },
            { key: "sats", header: "Sats", numeric: true, render: (row) => formatSats(row.sats) },
            { key: "price", header: "Price", numeric: true, render: (row) => formatUsd(row.priceUsd), secondary: true },
            { key: "usd", header: "Cost", numeric: true, render: (row) => formatUsd(row.usd) },
            {
              key: "status",
              header: "Basis",
              render: (row) => <Badge tone={row.costBasisStatus === "confirmed" ? "positive" : "warning"}>{row.costBasisStatus ?? "unknown"}</Badge>,
              secondary: true,
            },
          ]}
          rows={buys}
          rowKey={(row) => row.id}
          state={tableState(data.btcBuys.status)}
        />
      </Panel>
    </>
  )
}

// ── Bills ───────────────────────────────────────────────────────────────────

function BillsPage() {
  const { activeProfile, data } = useAppState()
  const pays = visibleTo(activeProfile, data.billPays.value)

  return (
    <>
      <PageHeader
        title="Bills"
        subtitle="Bills settled in Bitcoin"
        actions={<FreshnessTag status={data.billPays.status} updatedAt={data.billPays.updatedAt} />}
      />
      <StaleNotice status={data.billPays.status} />
      <KPIStrip
        items={[
          { label: "Paid", value: figure(data.billPays.status, () => formatUsd(sum(pays.map((pay) => pay.amountUsd)))) },
          {
            label: "Sats spent",
            value: figure(data.billPays.status, () => formatSats(sum(pays.map((pay) => pay.btcSpentSats)))),
            tone: "accent",
          },
          { label: "Fees", value: figure(data.billPays.status, () => formatUsd(sum(pays.map((pay) => pay.feeUsd)))) },
        ]}
      />
      <Panel source={data.billPays.source} flush>
        <DataTable
          columns={[
            { key: "date", header: "Date", render: (row) => row.date, width: "104px" },
            { key: "merchant", header: "Payee", render: (row) => row.merchant },
            { key: "category", header: "Category", render: (row) => <Badge>{row.category}</Badge>, secondary: true },
            { key: "usd", header: "Amount", numeric: true, render: (row) => formatUsd(row.amountUsd) },
            { key: "sats", header: "Sats", numeric: true, render: (row) => formatSats(row.btcSpentSats) },
            { key: "fee", header: "Fee", numeric: true, render: (row) => formatUsd(row.feeUsd), secondary: true },
          ]}
          rows={pays}
          rowKey={(row) => row.id}
          state={tableState(data.billPays.status)}
          emptyTitle="No Bitcoin bill payments"
          emptyDetail="Nothing has been settled in Bitcoin for this profile."
        />
      </Panel>
    </>
  )
}

// ── Retirement ──────────────────────────────────────────────────────────────

function RetirementPage() {
  const { activeProfile, data } = useAppState()
  const incomeRows = visibleTo(activeProfile, data.income.value)
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
            value: figure(data.income.status, () => formatUsd(ytdIncome), true),
            provenance: "actual",
          },
          {
            label: "MTD income",
            value: figure(data.income.status, () => formatUsd(mtdIncome), true),
            provenance: "actual",
          },
        ]}
      />
      <Panel
        title="Retirement accounts"
        source="Convex rows · finances not wired"
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
          detail="Retirement accounts require the Convex finances row source. No placeholder figures are shown on purpose."
        />
      </Panel>
    </>
  )
}

// ── Net Worth ───────────────────────────────────────────────────────────────

function NetWorthPage() {
  const { activeProfile, data } = useAppState()
  const document = data.btcBalanceDocument.value
  const inScope = document?.accounts ?? []
  const stackSats = document?.totals.sats ?? 0n
  const stackValue = document?.totals.fiat ?? 0n

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
      <KPIStrip
        items={[
          {
            label: "Bitcoin",
            value: figure(data.btcBalanceDocument.status, () => formatUsd(stackValue), true),
            tone: "accent",
            provenance: "estimated",
          },
          {
            label: "Stack",
            value: figure(data.btcBalanceDocument.status, () => formatBtc(stackSats), true),
          },
          {
            label: "Accounts",
            value: figure(data.btcBalanceDocument.status, () => String(inScope.length), true),
          },
        ]}
      />
      <PageGrid>
        <Panel title="In scope" source={data.btcBalanceDocument.source} flush>
          <DataTable
            columns={[
              { key: "label", header: "Account", render: (row) => row.label },
              { key: "owner", header: "Owner", render: (row) => <Badge>{row.owner}</Badge>, secondary: true },
              { key: "sats", header: "Sats", numeric: true, render: (row) => formatSats(row.sats) },
              {
                key: "value",
                header: "Value",
                numeric: true,
                render: (row) => (
                  <span className="vv-estimated">{formatUsd(row.fiat)}</span>
                ),
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
              { key: "sats", header: "Sats", numeric: true, render: (row) => formatSats(row.sats) },
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
