// Finance / Bitcoin page slice.
//
// Every page filters through the shared visibility layer rather than trusting
// the envelope. Adults see the household and the kids; kids see only themselves;
// net worth is a narrower scope than visibility, so a child's stack shows on the
// child's profile but never rolls into an adult total.

import {
  canSeeDataOwnedBy,
  displayName,
  isAdult,
  netWorthScopeFor,
  visibleTo,
} from "@vogel-vault/domain/family"
import { basisPoints, formatBtc, formatSats, formatUsd, satsToUsdCents, sum } from "@vogel-vault/domain/money"
import type { BTCAccount, Budget, Transaction } from "@vogel-vault/domain/readModel"

import { useAppState } from "../../app/AppState.tsx"
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
 * `empty` is different: zero really is the answer, so it renders normally.
 */
function figure(status: string, render: () => string): string {
  if (status === "error" || status === "loading") return SUPPRESSED
  return render()
}

function spendOf(transaction: Transaction): bigint {
  if (transaction.category === "Income") return 0n
  return transaction.amount < 0n ? -transaction.amount : transaction.amount
}

function incomeOf(transaction: Transaction): bigint {
  return transaction.category === "Income" && transaction.amount > 0n ? transaction.amount : 0n
}

/**
 * Colour and sign for a transaction row.
 *
 * The raw sign is not enough. Adult MC2 files sign spending negative, but the
 * child files record spending as a POSITIVE magnitude — so keying colour off
 * `amount < 0` painted Mason's spending green, reading as money coming in.
 * Route through the same spend/income helpers the totals use.
 */
function AmountCell({ transaction }: { transaction: Transaction }) {
  const spend = spendOf(transaction)
  if (spend > 0n) {
    return <span className="vv-negative">-{formatUsd(spend)}</span>
  }
  return <span className="vv-positive">{formatUsd(incomeOf(transaction))}</span>
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
  const { activeProfile, data } = useAppState()
  const transactions = visibleTo(activeProfile, data.transactions.value)
  const accounts = netWorthScopeFor(activeProfile, data.btcAccounts.value)
  const todos = visibleTo(activeProfile, data.todos.value).filter((todo) => !todo.done)

  const spend = sum(transactions.map(spendOf))
  const income = sum(transactions.map(incomeOf))
  const stackSats = sum(accounts.map((account) => account.sats))
  const stackValue = satsToUsdCents(stackSats, data.btcPriceUsd)

  const txStatus = data.transactions.status
  const btcStatus = data.btcAccounts.status
  const todoStatus = data.todos.status

  const kpis: KPI[] = [
    { label: "Spend (visible)", value: figure(txStatus, () => formatUsd(spend)), tone: "negative" },
    { label: "Income (visible)", value: figure(txStatus, () => formatUsd(income)), tone: "positive" },
    {
      label: "Stack",
      value: figure(btcStatus, () => formatBtc(stackSats)),
      tone: "accent",
      hint: figure(btcStatus, () => formatUsd(stackValue)),
    },
    { label: "Open tasks", value: figure(todoStatus, () => String(todos.length)) },
  ]

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={isAdult(activeProfile) ? "Household command center" : `${displayName(activeProfile)}'s money`}
        actions={<FreshnessTag status={data.transactions.status} updatedAt={data.transactions.updatedAt} />}
      />
      <StaleNotice status={data.transactions.status} />
      <KPIStrip items={kpis} />
      <PageGrid>
        <Panel title="Recent activity" source={data.transactions.source} flush>
          <DataTable
            columns={recentColumns}
            rows={transactions.slice(0, 8)}
            rowKey={(row) => row.id}
            state={tableState(data.transactions.status)}
          />
        </Panel>
        <Panel title="Bitcoin" source={data.btcAccounts.source} flush>
          <DataTable
            columns={stackColumns}
            rows={accounts}
            rowKey={(row) => row.key}
            state={tableState(data.btcAccounts.status)}
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
  const { data } = useAppState()
  const budget = data.budget.value

  if (!budget) {
    return (
      <>
        <PageHeader title="Budget" />
        <StateBlock state={data.budget.status === "loading" ? "loading" : "empty"} />
      </>
    )
  }

  const planned = sum(budget.categories.map((category) => category.budget))
  const actual = sum(budget.categories.map((category) => category.spent))
  const remaining = planned - actual
  const overCount = budget.categories.filter((category) => category.spent > category.budget).length

  return (
    <>
      <PageHeader
        title="Budget"
        subtitle={budget.month}
        actions={<FreshnessTag status={data.budget.status} updatedAt={data.budget.updatedAt} />}
      />
      <StaleNotice status={data.budget.status} />
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
      <Panel title="Categories" source={data.budget.source} flush>
        <DataTable
          columns={budgetColumns}
          rows={budget.categories}
          rowKey={(row) => row.name}
          state={tableState(data.budget.status)}
        />
      </Panel>
    </>
  )
}

const budgetColumns: ReadonlyArray<Column<Budget["categories"][number]>> = [
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
      <span className={row.budget - row.spent < 0n ? "vv-negative" : "vv-muted"}>
        {formatUsd(row.budget - row.spent)}
      </span>
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
  const inScope = netWorthScopeFor(activeProfile, data.btcAccounts.value)

  const totalSats = sum(inScope.map((account) => account.sats))
  const selfCustody = sum(
    inScope.filter((a) => a.custody === "self_custody").map((account) => account.sats),
  )
  const exchange = totalSats - selfCustody

  const status = data.btcAccounts.status

  // Adults can see a child's stack but it is not part of their net worth. Say so
  // rather than letting the difference look like a bug.
  const outOfScope = visible.filter((account) => !inScope.includes(account))

  return (
    <>
      <PageHeader
        title="Bitcoin Overview"
        actions={<FreshnessTag status={data.btcAccounts.status} updatedAt={data.btcAccounts.updatedAt} />}
      />
      <StaleNotice status={data.btcAccounts.status} />
      <KPIStrip
        items={[
          { label: "Total stack", value: figure(status, () => formatBtc(totalSats)), tone: "accent" },
          {
            label: "Value",
            value: figure(status, () => formatUsd(satsToUsdCents(totalSats, data.btcPriceUsd))),
            provenance: "estimated",
          },
          {
            label: "Self custody",
            value: figure(status, () => `${(basisPoints(selfCustody, totalSats) / 100).toFixed(1)}%`),
            hint: figure(status, () => formatSats(selfCustody)),
          },
          { label: "On exchange", value: figure(status, () => formatSats(exchange)) },
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
        <Panel title="Accounts in net worth" source={data.btcAccounts.source} flush className="vv-span-2">
          <DataTable
            columns={stackColumns}
            rows={inScope}
            rowKey={(row) => row.key}
            state={tableState(data.btcAccounts.status)}
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
  const { data } = useAppState()
  const budget = data.budget.value
  // Bound once: figure() defers evaluation, which loses inline narrowing.
  const income = budget?.income ?? null

  return (
    <>
      <PageHeader
        title="Retirement"
        subtitle="Long-horizon accounts"
        actions={<FreshnessTag status={data.budget.status} updatedAt={data.budget.updatedAt} />}
      />
      <StaleNotice status={data.budget.status} />
      {income ? (
        <KPIStrip
          items={[
            {
              label: "YTD income",
              value: figure(data.budget.status, () => formatUsd(income.ytdIncome)),
              provenance: "actual",
            },
            {
              label: "MTD income",
              value: figure(data.budget.status, () => formatUsd(income.mtdIncome)),
              provenance: "actual",
            },
            {
              label: "Weekly gross",
              value: figure(data.budget.status, () => formatUsd(income.weeklyGross)),
              provenance: "planned",
            },
          ]}
        />
      ) : null}
      <Panel
        title="Retirement accounts"
        source="MC2 · finances"
        flush
      >
        {/*
          The retirement slice of finances.json is not part of the fixture
          envelope yet — it lands with the live Convex read. Showing an explicit
          empty state is correct here; inventing numbers would be worse.
        */}
        <StateBlock
          state="empty"
          title="Not wired to the live read yet"
          detail="Retirement accounts come from the finances.json slice, which arrives with the Convex bridge. No placeholder figures are shown on purpose."
        />
      </Panel>
    </>
  )
}

// ── Net Worth ───────────────────────────────────────────────────────────────

function NetWorthPage() {
  const { activeProfile, data } = useAppState()
  const inScope = netWorthScopeFor(activeProfile, data.btcAccounts.value)
  const stackSats = sum(inScope.map((account) => account.sats))
  const stackValue = satsToUsdCents(stackSats, data.btcPriceUsd)

  const excluded = data.btcAccounts.value.filter(
    (account) => canSeeDataOwnedBy(activeProfile, account.owner) && !inScope.includes(account),
  )

  return (
    <>
      <PageHeader
        title="Net Worth"
        subtitle="Household scope for adults; self only for children"
        actions={<FreshnessTag status={data.btcAccounts.status} updatedAt={data.btcAccounts.updatedAt} />}
      />
      <StaleNotice status={data.btcAccounts.status} />
      <KPIStrip
        items={[
          {
            label: "Bitcoin",
            value: figure(data.btcAccounts.status, () => formatUsd(stackValue)),
            tone: "accent",
            provenance: "estimated",
          },
          { label: "Stack", value: figure(data.btcAccounts.status, () => formatBtc(stackSats)) },
          { label: "Accounts", value: figure(data.btcAccounts.status, () => String(inScope.length)) },
        ]}
      />
      <PageGrid>
        <Panel title="In scope" source={data.btcAccounts.source} flush>
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
                  <span className="vv-estimated">{formatUsd(satsToUsdCents(row.sats, data.btcPriceUsd))}</span>
                ),
              },
            ]}
            rows={inScope}
            rowKey={(row) => row.key}
            state={tableState(data.btcAccounts.status)}
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
