// Admin / system page slice.
//
// These pages describe the app's own state — profiles, sync health, export, and
// settings. Row reads and writeback are runtime-gated; the renderer receives
// only closed state/capability results and never a device credential.

import { useMemo, useState } from "react"

import {
  FAMILY_MEMBERS,
  type FamilyMember,
  allowedSwitchTargets,
  canSeeDataOwnedBy,
  displayName,
  isAdult,
  profileDescription,
  sharesNetWorthWith,
  showsFullBudget,
  visibleTo,
} from "@vogel-vault/domain/family"
import { formatMinorUnits, sum } from "@vogel-vault/domain/money"
import {
  budgetTransactionsFor,
  spendAmount,
  transactionsInMonth,
  type Freshness,
  type Transaction,
} from "@vogel-vault/domain/readModel"

import { useAppState } from "../../app/AppState.tsx"
import type { FixtureEnvelope } from "../../data/fixtures.ts"
import { fiatCentsOf } from "../../data/btcFiatValuation.ts"
import { PRICE_UNAVAILABLE } from "../../data/bitcoinDisplay.ts"
import { paymentSourceDisplay } from "../../data/paymentSource.ts"
import {
  Badge,
  type BannerTone,
  Button,
  type Column,
  DataTable,
  DialogFrame,
  Field,
  FreshnessTag,
  HorizonMark,
  IconGlyph,
  type IconName,
  PageGrid,
  PageHeader,
  Panel,
  SUPPRESSED,
  Select,
  StateBlock,
  StatusBanner,
  TextInput,
  Toolbar,
} from "../../components/index.ts"
import type { PageManifest } from "../types.ts"

// ── Family / Profiles ───────────────────────────────────────────────────────

function FamilyProfilesPage() {
  const { activeProfile, switchProfile, switchTargets } = useAppState()

  /*
   * The profile matrix intentionally lists all four family members, including
   * Maddox. The 2026-06-16 correction removed Maddox from the *active profile
   * cycle* on Linux, not from the domain model — so he is shown here as a data
   * owner but is not offered as a switch target unless explicitly enabled.
   */
  const rows = FAMILY_MEMBERS.map((member) => ({
    member,
    canSwitch: switchTargets.includes(member),
  }))

  return (
    <>
      <PageHeader title="Family & Profiles" subtitle="Profiles and what each one sees" />
      <StatusBanner
        tone="info"
        title="Victor and Rachel are one household"
        detail="They see identical finance data. Mason and Maddox are isolated and see only their own records."
      />
      <div className="vv-family-cards">
        {rows.map(({ member, canSwitch }) => {
          const active = member === activeProfile
          const switchLabel = active ? "Active" : canSwitch ? "Switch" : "Locked"
          return (
            <Panel key={member} className={active ? "vv-family-card vv-family-card--active" : "vv-family-card"}>
              <div className="vv-family-card__head">
                <div>
                  <h2>{displayName(member)}</h2>
                  <Badge tone={isAdult(member) ? "accent" : "neutral"}>
                    {isAdult(member) ? "Adult" : "Child"}
                  </Badge>
                </div>
                <Button
                  variant={active ? "primary" : "secondary"}
                  disabled={!canSwitch || active}
                  onClick={() => switchProfile(member)}
                >
                  {switchLabel}
                </Button>
              </div>
              <p className="vv-muted">{profileDescription(member)}</p>
              <dl className="vv-scope-list">
                <RuntimeRow label="Ledger" value={isAdult(member) ? "Shared household" : "Own rows"} />
                <RuntimeRow label="Todos" value="Active profile only" />
                <RuntimeRow label="Sees" value={isAdult(member) ? "Household + children" : "Self only"} />
                <RuntimeRow label="Net worth" value={isAdult(member) ? "Adult household" : "Self only"} />
              </dl>
            </Panel>
          )
        })}
      </div>
      <PageGrid>
        <Panel title="Profiles" flush className="vv-span-2">
          <DataTable
            columns={profileColumns(activeProfile, switchProfile)}
            rows={rows}
            rowKey={(row) => row.member}
          />
        </Panel>
      </PageGrid>
      <Panel title="Visibility matrix" source="Derived from canSeeDataOwnedBy — not a separate rule">
        <VisibilityMatrix />
      </Panel>
      <Panel title="How scoping works" className="vv-scoping-card">
        <p className="vv-muted">
          Victor and Rachel share one financial ledger. Child money stays isolated, child balances
          never enter adult net worth, and todos always belong to the active profile.
        </p>
      </Panel>
    </>
  )
}

function profileColumns(
  activeProfile: FamilyMember,
  switchProfile: (member: FamilyMember) => void,
): ReadonlyArray<Column<{ member: FamilyMember; canSwitch: boolean }>> {
  return [
    {
      key: "name",
      header: "Profile",
      render: (row) => (
        <span className="vv-row">
          <IconGlyph name={isAdult(row.member) ? "users" : "sparkles"} size={14} />
          {displayName(row.member)}
          {row.member === activeProfile ? <Badge tone="accent">Active</Badge> : null}
        </span>
      ),
    },
    { key: "role", header: "Role", render: (row) => (isAdult(row.member) ? "Adult" : "Child") },
    { key: "desc", header: "Sees", render: (row) => profileDescription(row.member), secondary: true },
    {
      key: "budget",
      header: "Full budget",
      render: (row) => (
        <Badge tone={showsFullBudget(row.member) ? "positive" : "neutral"}>
          {showsFullBudget(row.member) ? "Yes" : "No"}
        </Badge>
      ),
      secondary: true,
    },
    {
      key: "switch",
      header: "",
      numeric: true,
      render: (row) =>
        row.member === activeProfile ? null : (
          <Button
            variant="ghost"
            disabled={!row.canSwitch}
            onClick={() => switchProfile(row.member)}
            title={row.canSwitch ? undefined : "This profile cannot switch to that one"}
          >
            Switch
          </Button>
        ),
    },
  ]
}

function VisibilityMatrix() {
  return (
    <table className="vv-table">
      <thead>
        <tr>
          <th scope="col">Viewer</th>
          {FAMILY_MEMBERS.map((owner) => (
            <th key={owner} scope="col" className="vv-table__cell--num">
              {displayName(owner)}
            </th>
          ))}
          <th scope="col" className="vv-table__cell--num">
            Can switch to
          </th>
        </tr>
      </thead>
      <tbody>
        {FAMILY_MEMBERS.map((viewer) => (
          <tr key={viewer}>
            <th scope="row" style={{ textAlign: "left", fontWeight: 500 }}>
              {displayName(viewer)}
            </th>
            {FAMILY_MEMBERS.map((owner) => {
              // The shared contract itself, not a copy of it: this table is
              // the display surface for the visibility rule the rest of the
              // app enforces, so it calls the same function.
              const sees = canSeeDataOwnedBy(viewer, owner)
              return (
                <td key={owner} className="vv-table__cell--num">
                  <span className={sees ? "vv-positive" : "vv-dim"}>{sees ? "yes" : "no"}</span>
                </td>
              )
            })}
            <td className="vv-table__cell--num vv-muted">
              {allowedSwitchTargets(viewer).length === FAMILY_MEMBERS.length
                ? "all"
                : "self only"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Sync Health ─────────────────────────────────────────────────────────────

function SyncHealthPage() {
  const { data, financeModel, stateOverride } = useAppState()
  const readsRows = data.transactions.source.startsWith("Convex row tables")
  const forcedState = stateOverride === "normal" || stateOverride === "demo"
    ? null
    : stateOverride
  const financeStatus: Freshness = forcedState ?? financeModel.finance.status
  const quoteStatus: Freshness = forcedState ?? (
    financeModel.marketQuotes.status === "live"
      ? financeModel.marketQuotes.value.quotes.some((quote) => quote.status !== "live")
        ? "stale"
        : "live"
      : financeModel.marketQuotes.status
  )
  const financeUpdatedAt = financeModel.finance.status === "live"
    ? financeModel.finance.value.updatedAtMs
    : null
  const quoteUpdatedAt = financeModel.marketQuotes.status === "live"
    ? financeModel.marketQuotes.value.quotes.some((quote) => quote.fetchedAt === null)
      ? null
      : Math.min(
          ...financeModel.marketQuotes.value.quotes
            .map((quote) => Date.parse(quote.fetchedAt ?? "")),
        )
    : null
  const financeReadsFailed = financeStatus === "error" || quoteStatus === "error"

  const slices = [
    { name: "transactions", slice: data.transactions },
    { name: "income", slice: data.income },
    { name: "budget", slice: data.budget },
    { name: "btc-balance-document", slice: data.btcBalanceDocument },
    { name: "btc-accounts", slice: data.btcAccounts },
    { name: "bitcoin-buys", slice: data.btcBuys },
    { name: "bitcoin-bill-pays", slice: data.billPays },
    { name: "btc-transfers", slice: data.btcTransfers },
    { name: "todos", slice: data.todos },
    {
      name: "finance-document",
      slice: {
        status: financeStatus,
        updatedAt: forcedState ? null : financeUpdatedAt,
        source: financeModel.finance.status === "live"
          ? "Convex tables:getFinanceDocument"
          : "Authenticated finance document unavailable",
      },
    },
    {
      name: "market-quotes",
      slice: {
        status: quoteStatus,
        updatedAt: forcedState ? null : quoteUpdatedAt,
        source: financeModel.marketQuotes.status === "live"
          ? "Convex marketQuotes:getSnapshot"
          : "Authenticated market quote snapshot unavailable",
      },
    },
  ]

  return (
    <>
      <PageHeader title="Sync Health" subtitle="Where every number came from, and when" />
      <StatusBanner
        tone={readsRows && !financeReadsFailed ? "info" : "warning"}
        title={readsRows
          ? financeReadsFailed
            ? "Some authenticated Convex reads failed"
            : "Runtime-gated Convex row reads are active"
          : "Sanitized fallback data is active"}
        detail={
          readsRows
            ? financeReadsFailed
              ? "Ledger rows loaded, but the finance document or market quote snapshot failed. Global refresh remains incomplete."
              : "Every slice below came from Convex row tables over authenticated HTTP; the read token remains in the main process."
            : "Configure authenticated reads from Convex row tables to replace the sanitized fixture envelope."
        }
      />
      <Panel title="Slices" flush>
        <DataTable
          columns={[
            { key: "name", header: "Row projection", render: (row) => row.name },
            { key: "source", header: "Source", render: (row) => row.slice.source, secondary: true },
            {
              key: "status",
              header: "State",
              render: (row) => (
                <FreshnessTag
                  status={row.slice.status}
                  updatedAt={row.slice.updatedAt}
                  checkedAt={data.checkedAt}
                />
              ),
            },
          ]}
          rows={slices}
          rowKey={(row) => row.name}
        />
      </Panel>
    </>
  )
}

// ── Export ──────────────────────────────────────────────────────────────────

export const EXPORT_DATASET_IDS = [
  "transactions",
  "bitcoin-buys",
  "bitcoin-accounts",
  "bill-pays",
  "todos",
] as const

type ExportDatasetId = (typeof EXPORT_DATASET_IDS)[number]

const EXPORT_PREVIEW_ROWS = 6

interface ExportDataset {
  readonly label: string
  readonly source: string
  readonly status: Freshness
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

/** Exact decimal text for integer minor units. Never Number, never toFixed. */
function usdCell(cents: bigint): string {
  return formatMinorUnits(cents, 2)
}

function btcCell(sats: bigint): string {
  return formatMinorUnits(sats, 8)
}

function boolCell(value: boolean): string {
  return value ? "yes" : "no"
}

function incomeOf(transaction: Transaction): bigint {
  return transaction.category === "Income" && transaction.amount > 0n ? transaction.amount : 0n
}

/**
 * Build every exportable data set for the active profile.
 *
 * Rows are filtered through the same visibility helpers the rest of the app
 * uses, in the renderer, before anything reaches the preload API — the main
 * process writes bytes and never learns who is logged in. An export that leaked here
 * would leak in the file, where nobody would ever notice it again.
 */
export function buildExportDatasets(
  viewer: FamilyMember,
  data: FixtureEnvelope,
): Record<ExportDatasetId, ExportDataset> {
  return {
    transactions: {
      label: "Transactions",
      source: data.transactions.source,
      status: data.transactions.status,
      columns: ["id", "date", "merchant", "category", "card", "owner", "amount_usd", "direction", "signed_usd"],
      // amount_usd preserves production storage: purchases positive, refunds
      // negative. signed_usd deliberately inverts non-Income cash flow so
      // spreadsheet totals treat spend as outflow and refunds as inflow.
      rows: visibleTo(viewer, data.transactions.value).map((row) => {
        const spend = spendAmount(row)
        return [
          row.id,
          row.date,
          row.merchant,
          row.category,
          paymentSourceDisplay(row) ?? "On-chain",
          row.owner,
          usdCell(row.amount),
          spend > 0n ? "spend" : spend < 0n ? "credit" : "income",
          usdCell(spend !== 0n ? -spend : incomeOf(row)),
        ]
      }),
    },
    "bitcoin-buys": {
      label: "Bitcoin buys",
      source: data.btcBuys.source,
      status: data.btcBuys.status,
      columns: ["id", "date", "source", "owner", "sats", "btc", "price_usd", "cost_usd", "status"],
      rows: visibleTo(viewer, data.btcBuys.value).map((row) => [
        row.id,
        row.date,
        row.source,
        row.owner,
        String(row.sats),
        btcCell(row.sats),
        usdCell(row.priceUsd),
        usdCell(row.usd),
        row.status ?? "",
      ]),
    },
    "bitcoin-accounts": {
      label: "Bitcoin accounts",
      source: data.btcAccounts.source,
      status: data.btcAccounts.status,
      columns: ["key", "label", "custody", "owner", "sats", "btc", "fiat_usd", "in_net_worth"],
      // Visibility is wider than the net-worth scope, so an adult's export does
      // contain a child's stack. The in_net_worth column says which rows belong
      // in a total, rather than leaving a reader to assume they all do.
      rows: visibleTo(viewer, data.btcAccounts.value).map((row) => [
        row.key,
        row.label,
        row.custody,
        row.owner,
        String(row.sats),
        btcCell(row.sats),
        fiatCentsOf(row) === null ? PRICE_UNAVAILABLE : usdCell(fiatCentsOf(row) ?? 0n),
        boolCell(sharesNetWorthWith(viewer, row.owner)),
      ]),
    },
    "bill-pays": {
      label: "Bitcoin bill pays",
      source: data.billPays.source,
      status: data.billPays.status,
      columns: ["id", "date", "merchant", "category", "owner", "amount_usd", "fee_usd", "btc_spent_sats", "btc_price_usd", "platform"],
      rows: visibleTo(viewer, data.billPays.value).map((row) => [
        row.id,
        row.date,
        row.merchant,
        row.category,
        row.owner,
        usdCell(row.amountUsd),
        usdCell(row.feeUsd),
        String(row.btcSpentSats),
        usdCell(row.btcPrice),
        row.platform ?? "",
      ]),
    },
    todos: {
      label: "Tasks",
      source: data.todos.source,
      status: data.todos.status,
      columns: ["id", "title", "owner", "project", "area", "due", "flagged", "done"],
      rows: visibleTo(viewer, data.todos.value).map((row) => [
        row.id,
        row.title,
        row.owner,
        row.project ?? "",
        row.area ?? "",
        row.due ?? "",
        boolCell(row.flagged),
        boolCell(row.done),
      ]),
    },
  }
}

/** Dated from the envelope, not the clock, so the same data exports the same name. */
function exportFileName(dataset: ExportDatasetId, viewer: FamilyMember, generatedAt: number): string {
  return `vogel-vault-${dataset}-${viewer}-${new Date(generatedAt).toISOString().slice(0, 10)}.csv`
}

/**
 * The exact request the Export page hands to the preload bridge. Exported so
 * the row-builder tests validate the same object the page sends, not a
 * re-derivation of it.
 */
export function buildCsvExportRequest(
  datasetId: ExportDatasetId,
  viewer: FamilyMember,
  envelope: FixtureEnvelope,
): {
  readonly suggestedFileName: string
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
} {
  const dataset = buildExportDatasets(viewer, envelope)[datasetId]
  return {
    suggestedFileName: exportFileName(datasetId, viewer, envelope.generatedAt),
    columns: dataset.columns,
    rows: dataset.rows,
  }
}

interface ExportOutcome {
  readonly tone: BannerTone
  readonly title: string
  readonly detail: string
}

function ExportPage() {
  const { activeProfile, data } = useAppState()
  const [datasetId, setDatasetId] = useState<ExportDatasetId>("transactions")
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null)

  const datasets = useMemo(() => buildExportDatasets(activeProfile, data), [activeProfile, data])
  const dataset = datasets[datasetId]

  // Matches the Settings page: the preload API is absent under plain `vite dev`
  // in a browser and in the headless render tests, and the page has to say so
  // rather than offer a button that throws.
  const bridge = typeof window !== "undefined" ? window.vogelVault : undefined

  // Suppression rule, applied to a file instead of a figure: a slice that
  // errored or is still loading must not be written, because the rows in memory
  // are not an answer. `empty` is different — zero rows is a real answer, and a
  // header-only CSV is the honest export of it.
  const unreadable = dataset.status === "error" || dataset.status === "loading"
  const rowCount = unreadable ? SUPPRESSED : String(dataset.rows.length)

  async function runExport() {
    const exporter = window.vogelVault?.exportCsv
    if (!exporter) return
    setBusy(true)
    setOutcome(null)
    try {
      const result = await exporter(buildCsvExportRequest(datasetId, activeProfile, data))
      if (result.status === "written") {
        setOutcome({
          tone: "positive",
          title: `Wrote ${result.fileName}`,
          detail: `${result.rowCount} ${result.rowCount === 1 ? "row" : "rows"}, scoped to what ${displayName(activeProfile)} can see.`,
        })
      } else if (result.status === "cancelled") {
        setOutcome({ tone: "info", title: "Export cancelled", detail: "Nothing was written." })
      } else {
        setOutcome({ tone: "negative", title: "Export refused", detail: result.reason })
      }
    } catch {
      setOutcome({
        tone: "negative",
        title: "Export failed",
        detail: "The main process did not complete the write. Nothing was saved.",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="Export" subtitle="Take your records out" />
      {bridge ? (
        <StatusBanner
          tone="info"
          title="Export writes a CSV you pick a location for"
          detail="Rows are scoped to what the active profile can see. The app suggests a file name; the folder is yours to choose in the system dialog."
        />
      ) : (
        <StatusBanner
          tone="warning"
          title="Export needs the desktop app"
          detail="window.vogelVault is absent, so there is no write path. This is expected outside Electron."
        />
      )}
      {outcome ? (
        <StatusBanner tone={outcome.tone} title={outcome.title} detail={outcome.detail} />
      ) : null}
      <Panel title="Scope" source={`${rowCount} rows in scope`}>
        <div className="vv-stack">
          <Field label="Profile" hint="Exports never include records this profile cannot see.">
            <TextInput value={displayName(activeProfile)} readOnly />
          </Field>
          <Field label="Data set" hint={dataset.source}>
            <Select
              value={datasetId}
              onChange={(event) => {
                setDatasetId(event.target.value as ExportDatasetId)
                setOutcome(null)
              }}
            >
              {EXPORT_DATASET_IDS.map((id) => (
                <option key={id} value={id}>
                  {datasets[id].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Format"
            hint="RFC 4180, UTF-8, one record per line. Amounts are exact decimal text, never rounded."
          >
            <Select defaultValue="csv">
              <option value="csv">CSV</option>
              {/* Honest about the surface: the reviewed channel writes CSV only. */}
              <option value="json" disabled>
                JSON (not wired)
              </option>
            </Select>
          </Field>
          <Toolbar>
            <Button
              variant="primary"
              icon="download"
              disabled={!bridge || unreadable || busy}
              onClick={() => void runExport()}
              title={unreadable ? "This data set did not load; there is nothing safe to write." : undefined}
            >
              {busy ? "Exporting…" : "Export CSV"}
            </Button>
          </Toolbar>
        </div>
      </Panel>
      <Panel
        title="Preview"
        source={
          unreadable
            ? "Suppressed until this data set loads"
            : `${Math.min(EXPORT_PREVIEW_ROWS, dataset.rows.length)} of ${dataset.rows.length} rows · ${dataset.columns.length} columns`
        }
        flush
      >
        <DataTable
          columns={dataset.columns.map((name, index) => ({
            key: name,
            header: name,
            render: (row: readonly string[]) => row[index] ?? "",
          }))}
          rows={dataset.rows.slice(0, EXPORT_PREVIEW_ROWS)}
          rowKey={(_row, index) => String(index)}
          state={dataset.status === "error" || dataset.status === "loading" ? dataset.status : "normal"}
          emptyTitle="Nothing to export"
          emptyDetail="This profile has no rows in this data set. Exporting writes the header row only."
        />
      </Panel>
    </>
  )
}


// ── Settings / Admin ────────────────────────────────────────────────────────

function SettingsPage() {
  const {
    budgetAlertsEnabled,
    data,
    displayUnit,
    ledgerTheme,
    navigate,
    phosphorEnabled,
    reduceMotionEnabled,
    scanlinesEnabled,
    setBudgetAlertsEnabled,
    setDisplayUnit,
    setLedgerTheme,
    setPhosphorEnabled,
    setReduceMotionEnabled,
    setScanlinesEnabled,
    stateOverride,
    setStateOverride,
  } = useAppState()
  const runtime = typeof window !== "undefined" ? window.vogelVault?.getRuntimeInfo() : undefined
  const readsRows = data.transactions.source.startsWith("Convex row tables")
  const terminalEffectsAvailable = ledgerTheme === "dark"
  const terminalEffectHint = "Dark theme only — Daylight is ink on paper."

  return (
    <>
      <PageHeader title="Settings" subtitle="Runtime and boundaries" />
      <Panel className="vv-settings-brand">
        <HorizonMark size={40} title="Sovereign Budget App" />
        <div className="vv-wordmark">
          <strong>SOVEREIGN</strong>
          <span>BUDGET APP</span>
        </div>
      </Panel>
      <StatusBanner
        tone={readsRows ? "positive" : "info"}
        title={readsRows ? "Row reads enabled" : "Sanitized review data"}
        detail="Every remote query is authenticated. Writes use the protected device sync credential."
      />
      <PageGrid>
        <Panel title="Appearance" source="Terminal Ledger and Daylight Ledger">
          <div className="vv-setting-group">
            <span className="vv-setting-group__label">Theme</span>
            <Toolbar>
              {(["dark", "light"] as const).map((theme) => (
                <Button
                  key={theme}
                  variant={ledgerTheme === theme ? "primary" : "secondary"}
                  aria-pressed={ledgerTheme === theme}
                  onClick={() => setLedgerTheme(theme)}
                >
                  {theme}
                </Button>
              ))}
            </Toolbar>
          </div>
          <div className="vv-setting-group">
            <span className="vv-setting-group__label">Default unit</span>
            <Toolbar>
              {(["btc", "sats", "usd"] as const).map((unit) => (
                <Button
                  key={unit}
                  variant={displayUnit === unit ? "primary" : "secondary"}
                  aria-pressed={displayUnit === unit}
                  onClick={() => setDisplayUnit(unit)}
                >
                  {unit}
                </Button>
              ))}
            </Toolbar>
          </div>
        </Panel>
        <Panel title="Behaviour" source="Local display preferences">
          <div className="vv-settings-toggles">
            <SettingsToggle
              label="Budget alerts"
              hint="Ping at 85% and again when a category tips over."
              enabled={budgetAlertsEnabled}
              onChange={setBudgetAlertsEnabled}
            />
            <SettingsToggle
              label="Phosphor glow"
              hint={terminalEffectsAvailable ? "Apply bloom to the Bitcoin price hero." : terminalEffectHint}
              enabled={terminalEffectsAvailable && phosphorEnabled}
              disabled={!terminalEffectsAvailable}
              onChange={setPhosphorEnabled}
            />
            <SettingsToggle
              label="Scanlines"
              hint={terminalEffectsAvailable ? "Overlay a non-interactive three-pixel ledger texture." : terminalEffectHint}
              enabled={terminalEffectsAvailable && scanlinesEnabled}
              disabled={!terminalEffectsAvailable}
              onChange={setScanlinesEnabled}
            />
            <SettingsToggle
              label="Reduce motion"
              hint="Land figures, fills, and row reveals instantly. The system reduce-motion preference is honoured either way."
              enabled={reduceMotionEnabled}
              onChange={setReduceMotionEnabled}
            />
            <SettingsToggle
              label="Biometric unlock"
              hint="Unavailable on Linux. Profile switching does not perform an operating-system authentication check."
              enabled={false}
              disabled
              onChange={() => {}}
            />
          </div>
        </Panel>
      </PageGrid>
      <PageGrid>
        <Panel title="Runtime" source="Desktop main process">
          {runtime ? (
            <dl className="vv-stack" style={{ margin: 0 }}>
              <RuntimeRow label="App" value={`${runtime.appName} ${runtime.appVersion}`} />
              <RuntimeRow label="Platform" value={runtime.platform} />
              <RuntimeRow label="Electron" value={runtime.electronVersion} />
              <RuntimeRow label="Chrome" value={runtime.chromeVersion} />
              <RuntimeRow label="Node" value={runtime.nodeVersionMajor} />
              <RuntimeRow label="Mode" value={runtime.isDev ? "development" : "packaged"} />
            </dl>
          ) : (
            <StateBlock
              state="empty"
              title="Desktop runtime unavailable"
              detail="window.vogelVault is absent. This is expected outside Electron."
            />
          )}
        </Panel>
        <Panel
          title="QA state matrix"
          source="Force every page into one state for review"
        >
          <Field label="Simulated slice state">
            <Select
              value={stateOverride}
              onChange={(event) => setStateOverride(event.target.value as typeof stateOverride)}
            >
              <option value="normal">Normal</option>
              <option value="stale">Stale</option>
              <option value="error">Error</option>
              <option value="empty">Empty</option>
              <option value="loading">Loading</option>
            </Select>
          </Field>
        </Panel>
        <PairingPanel />
      </PageGrid>
      <Panel title="Data boundaries" source="What this client will and will not do">
        <ul className="vv-muted" style={{ margin: 0, paddingLeft: "1.2rem", lineHeight: 1.8 }}>
          <li>The renderer holds no durable device credential and cannot reach the network directly.</li>
          <li>Writeback is available only for paired devices and explicitly supported row operations.</li>
          <li>
            Figures currently come from {readsRows ? "the bounded Convex row API" : "sanitized fallback fixtures"}.
          </li>
        </ul>
      </Panel>
      <Button variant="secondary" onClick={() => navigate("onboarding")}>
        Replay onboarding
      </Button>
    </>
  )
}

function SettingsToggle({
  disabled = false,
  enabled,
  hint,
  label,
  onChange,
}: {
  readonly disabled?: boolean
  readonly enabled: boolean
  readonly hint: string
  readonly label: string
  readonly onChange: (enabled: boolean) => void
}) {
  return (
    <div className="vv-setting-toggle">
      <div>
        <strong>{label}</strong>
        <span>{hint}</span>
      </div>
      <button
        type="button"
        className="vv-toggle"
        role="switch"
        aria-checked={enabled}
        aria-disabled={disabled}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!enabled)}
      >
        <span />
      </button>
    </div>
  )
}

function PairingPanel() {
  const {
    pairDevice,
    pairingStatus,
    unpairDevice,
  } = useAppState()
  const [pairingInput, setPairingInput] = useState("")
  const [deviceName, setDeviceName] = useState("Vogel Vault Linux")
  const [busy, setBusy] = useState(false)
  const [confirmingUnpair, setConfirmingUnpair] = useState(false)
  const [message, setMessage] = useState<{
    tone: BannerTone
    title: string
    detail?: string
  } | null>(null)

  async function pair() {
    const input = pairingInput.trim()
    const name = deviceName.trim()
    if (!input || input.length > 2_048 || !name || name.length > 80) {
      setMessage({
        tone: "negative",
        title: "Pairing details are invalid",
        detail: "Paste or scan a pairing value and use a device name of 80 characters or fewer.",
      })
      return
    }
    setBusy(true)
    const result = await pairDevice({ pairingInput: input, deviceName: name })
    setBusy(false)
    if (result.status === "paired") {
      setPairingInput("")
      setMessage({ tone: "positive", title: "Device paired" })
      return
    }
    setMessage({
      tone: "negative",
      title: result.status === "disabled" ? "Pairing is unavailable" : pairingFailureMessage(result.code),
      detail: "No durable device credential or backend response details were exposed to this screen.",
    })
  }

  async function unpair() {
    setBusy(true)
    const result = await unpairDevice()
    setBusy(false)
    if (result.status === "ok" || result.status === "unpaired") {
      setConfirmingUnpair(false)
      setMessage({ tone: "positive", title: "Device unpaired" })
      return
    }
    if (result.status === "cancelled") {
      setConfirmingUnpair(false)
      setMessage({
        tone: "info",
        title: "Unpair cancelled",
        detail: "The device remains paired and local write state was not changed.",
      })
      return
    }
    setMessage({
      tone: "negative",
      title: "Could not unpair this device",
      detail: "The remote revocation did not complete, so local pairing state was retained. Try again.",
    })
  }

  return (
    <Panel title="Paired-device write access" source="Protected by the desktop main process">
      <div className="vv-stack">
        {message ? (
          <StatusBanner tone={message.tone} title={message.title} detail={message.detail} />
        ) : null}
        {pairingStatus.status === "loading" ? <StateBlock state="loading" /> : null}
        {pairingStatus.status === "unavailable" ? (
          <StateBlock
            state="empty"
            title="Pairing status unavailable"
            detail="The secure pairing bridge is not available in this runtime."
          />
        ) : null}
        {pairingStatus.status === "paired" ? (
          <>
            <StatusBanner
              tone={pairingStatus.writesEnabled ? "positive" : "warning"}
              title={pairingStatus.writesEnabled ? "Paired" : "Paired · writes disabled"}
              detail={
                pairingStatus.writesEnabled
                  ? `Paired ${new Date(pairingStatus.pairedAt).toLocaleString()}.`
                  : "The credential remains available to unpair, but this runtime is not accepting writes."
              }
            />
            <div aria-label="Enabled write capabilities">
              {pairingStatus.capabilities.length === 0
                ? <span className="vv-muted">No write capabilities granted.</span>
                : pairingStatus.capabilities.map((capability) => (
                    <Badge key={capability} tone="info">{capability}</Badge>
                  ))}
            </div>
            <Button variant="danger" onClick={() => setConfirmingUnpair(true)} disabled={busy}>
              Unpair device
            </Button>
          </>
        ) : null}
        {pairingStatus.status === "unpaired" ? (
          <>
            {!pairingStatus.writesEnabled ? (
              <StatusBanner
                tone="warning"
                title="Paired-device writes are disabled"
                detail="Pairing is unavailable until the desktop runtime enables its local write switch."
              />
            ) : null}
            <form onSubmit={(event) => {
              event.preventDefault()
              void pair()
            }} className="vv-form-grid">
              <Field
                label="One-time pairing code"
                hint="Copy only the pairingCode secret from the protected pairing file."
              >
                <TextInput
                  data-autofocus
                  type="password"
                  value={pairingInput}
                  onChange={(event) => setPairingInput(event.target.value)}
                  maxLength={2_048}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field
                label="Device name"
                hint="Sent during claim and stored by the server as this device's display label."
              >
                <TextInput
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                  maxLength={80}
                />
              </Field>
              <div className="vv-form-grid__wide">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    busy ||
                    !pairingStatus.writesEnabled ||
                    !pairingInput.trim() ||
                    !deviceName.trim()
                  }
                  title={
                    pairingStatus.writesEnabled
                      ? undefined
                      : "Paired-device writes are disabled in this runtime."
                  }
                >
                  {busy ? "Pairing…" : "Pair device"}
                </Button>
              </div>
            </form>
          </>
        ) : null}
      </div>
      <DialogFrame
        open={confirmingUnpair}
        title="Unpair this device?"
        description="Remote revocation must succeed before protected local pairing state is cleared."
        onClose={() => setConfirmingUnpair(false)}
        busy={busy}
        footer={
          <>
            <Button onClick={() => setConfirmingUnpair(false)} disabled={busy}>Cancel</Button>
            <Button variant="danger" onClick={() => void unpair()} disabled={busy} data-autofocus>
              {busy ? "Unpairing…" : "Unpair device"}
            </Button>
          </>
        }
      >
        <p>Ledger edits will be disabled immediately after a successful unpair.</p>
      </DialogFrame>
    </Panel>
  )
}

function pairingFailureMessage(
  code:
    | "invalid-input"
    | "expired"
    | "already-claimed"
    | "cancelled"
    | "server-rejected"
    | "unavailable"
    | "invalid-response"
    | "credential-storage",
): string {
  switch (code) {
    case "invalid-input":
      return "The pairing input is invalid"
    case "expired":
      return "The pairing input has expired"
    case "already-claimed":
      return "The pairing input was already used"
    case "cancelled":
      return "Pairing was cancelled"
    case "credential-storage":
      return "Protected credential storage is unavailable"
    case "server-rejected":
    case "unavailable":
    case "invalid-response":
      return "The device could not be paired"
  }
}

function RuntimeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="vv-row">
      <dt className="vv-dim" style={{ minWidth: "88px" }}>
        {label}
      </dt>
      <dd className="vv-num" style={{ margin: 0 }}>
        {value}
      </dd>
    </div>
  )
}

// ── Onboarding ──────────────────────────────────────────────────────────────

function OnboardingPage() {
  const { activeProfile, data, navigate } = useAppState()
  const [step, setStep] = useState(0)
  const document = data.btcBalanceDocument.value
  const accounts = document?.accounts ?? []
  const selfCustody = document?.totals.selfCustodySats ?? 0n
  const total = document?.totals.sats ?? 0n
  const custodyPercent = total > 0n ? Number((selfCustody * 10_000n) / total) / 100 : 0
  const openTasks = data.todos.value.filter(
    (todo) => todo.owner === activeProfile && !todo.done,
  ).length
  const budget = data.budget.value
  const monthRows = budget
    ? transactionsInMonth(budgetTransactionsFor(activeProfile, data.transactions.value), budget.month)
    : []
  const remaining = budget
    ? sum(budget.categories.map((category) => category.budget)) - sum(monthRows.map(spendAmount))
    : null
  const steps = [
    {
      title: "Everything in BTC, sats, or dollars",
      body: "One unit control reconverts balances, budgets, bill pays, and every ledger figure.",
      label: "Reference price",
      value: data.btcPriceUsd === null ? "QUOTE UNAVAILABLE" : `$${formatMinorUnits(data.btcPriceUsd, 2)} / BTC`,
    },
    {
      title: "Track your BTC and net worth",
      body: "Balances are read-only snapshots. Writes require the protected sync credential on this device.",
      label: "Row access · custody",
      value: document ? `${custodyPercent.toFixed(1)}% self custody · ${accounts.length} accounts` : "NO BALANCE SOURCE",
    },
    {
      title: "Money and tasks, one ledger",
      body: "A bill pay and a todo share one timeline without sharing their security boundary.",
      label: "This month",
      value: `${remaining === null ? "—" : `$${formatMinorUnits(remaining, 2)} left`} · ${openTasks} tasks open`,
    },
  ] as const
  const current = steps[step]!

  return (
    <section className="vv-onboarding" aria-label="Sovereign Budget App onboarding">
      <span className="vv-sr-only">Row access uses authenticated Convex row tables.</span>
      <div className="vv-onboarding__brand">
        <HorizonMark size={48} title="Sovereign Budget App" />
        <div className="vv-wordmark"><strong>SOVEREIGN</strong><span>BUDGET APP</span></div>
      </div>
      <div className="vv-onboarding__content">
        <span className="vv-onboarding__step">STEP {String(step + 1).padStart(2, "0")} / 03</span>
        <h1>{current.title}<span className="vv-onboarding__cursor" aria-hidden="true">_</span></h1>
        <p>{current.body}</p>
        <Panel className="vv-onboarding__card">
          <span>{current.label}</span>
          <strong className="vv-num">{current.value}</strong>
        </Panel>
      </div>
      <footer className="vv-onboarding__footer">
        <div className="vv-onboarding__progress" aria-label={`Step ${step + 1} of 3`}>
          {steps.map((item, index) => (
            <span key={item.title} className={index <= step ? "is-complete" : undefined} />
          ))}
        </div>
        <Button
          variant="primary"
          onClick={() => step === steps.length - 1 ? navigate("home") : setStep(step + 1)}
        >
          {step === steps.length - 1 ? "Open ledger" : "Continue"}
        </Button>
        <Button variant="ghost" onClick={() => navigate("home")}>Skip</Button>
      </footer>
    </section>
  )
}

// ── Lock Screen ─────────────────────────────────────────────────────────────

function LockScreenPage() {
  const { setLocked } = useAppState()

  return (
    <>
      <PageHeader title="Lock" subtitle="Hide the ledger without quitting" />
      <Panel title="Lock this window">
        <p className="vv-muted" style={{ marginTop: 0 }}>
          Locking blanks the ledger immediately. Unlocking re-shows it — this build has no
          credential check, so it is a screen cover, not a security control. Treat it as such.
        </p>
        <Toolbar>
          <Button variant="primary" icon="lock" onClick={() => setLocked(true)}>
            Lock now
          </Button>
        </Toolbar>
      </Panel>
    </>
  )
}

// ── Awards / More ───────────────────────────────────────────────────────────

type LedgerPageState = "empty" | "error" | "loading" | "stale"

function combinedLedgerState(statuses: readonly Freshness[]): LedgerPageState | null {
  if (statuses.includes("error")) return "error"
  if (statuses.includes("loading")) return "loading"
  if (statuses.includes("stale")) return "stale"
  if (statuses.every((status) => status === "empty")) return "empty"
  return null
}

export interface LedgerAward {
  readonly title: string
  readonly detail: string
  readonly earned: boolean
}

export function ledgerAwards(
  transactionCount: number,
  bitcoinBuyCount: number,
  completedTaskCount: number,
): readonly LedgerAward[] {
  return [
    {
      title: "First entry",
      detail: "Record one ledger transaction",
      earned: transactionCount > 0,
    },
    {
      title: "Stacking",
      detail: "Log a Bitcoin buy",
      earned: bitcoinBuyCount > 0,
    },
    {
      title: "Clear the board",
      detail: "Complete a task",
      earned: completedTaskCount > 0,
    },
    {
      title: "Ten clean closes",
      detail: "Complete ten tasks",
      earned: completedTaskCount >= 10,
    },
  ]
}

export function moreCountLabel(count: number): string {
  if (count <= 0) return ""
  return count > 999 ? "999+" : String(count)
}

function readableCount(status: Freshness, count: number): string {
  if (status === "error" || status === "loading" || status === "stale") return SUPPRESSED
  return moreCountLabel(count)
}

function countValueLabel(status: Freshness, count: number, label: string): string {
  if (status === "error" || status === "loading" || status === "stale") {
    return `${label} unavailable`
  }
  return `${count} ${label}`
}

function AwardsPage() {
  const { activeProfile, data } = useAppState()
  const tasks = data.todos.value.filter((todo) => todo.owner === activeProfile)
  const transactions = visibleTo(activeProfile, data.transactions.value)
  const buys = visibleTo(activeProfile, data.btcBuys.value)
  const status = combinedLedgerState([
    data.transactions.status,
    data.btcBuys.status,
    data.todos.status,
  ])

  if (status) {
    return (
      <>
        <PageHeader title="Awards" subtitle="Ledger progress" />
        <StateBlock
          state={status}
          detail="Awards wait for the scoped transaction, Bitcoin buy, and task ledgers."
        />
      </>
    )
  }

  const awards = ledgerAwards(
    transactions.length,
    buys.length,
    tasks.filter((todo) => todo.done).length,
  )
  const earned = awards.filter((award) => award.earned).length

  return (
    <>
      <PageHeader
        title="Awards"
        subtitle="Ledger progress"
        actions={<Badge tone="accent">{earned}/{awards.length} earned</Badge>}
      />
      <Panel flush>
        <div className="vv-awards-list">
          {awards.map((award) => (
            <div key={award.title} className="vv-award-row">
              <span className={award.earned ? "vv-award-row__icon vv-award-row__icon--earned" : "vv-award-row__icon"}>
                <IconGlyph name="sparkles" size={18} />
              </span>
              <span>
                <strong>{award.title}</strong>
                <small>{award.detail}</small>
              </span>
              <Badge tone={award.earned ? "positive" : "neutral"}>
                {award.earned ? "Earned" : "Locked"}
              </Badge>
            </div>
          ))}
        </div>
      </Panel>
      <StatusBanner
        tone="info"
        title="No inferred badges"
        detail="Every award comes from a recorded ledger row. Missing data never unlocks one."
      />
    </>
  )
}

function MorePage() {
  const { activeProfile, data, navigate } = useAppState()
  const transactionCount = visibleTo(activeProfile, data.transactions.value).length
  const buyCount = visibleTo(activeProfile, data.btcBuys.value).length
  const billPayCount = visibleTo(activeProfile, data.billPays.value).length
  const completedTasks = data.todos.value
    .filter((todo) => todo.owner === activeProfile && todo.done).length
  const awardCount = ledgerAwards(transactionCount, buyCount, completedTasks)
    .filter((award) => award.earned).length
  const awardStatus = combinedLedgerState([
    data.transactions.status,
    data.btcBuys.status,
    data.todos.status,
  ]) ?? "live"
  const state = combinedLedgerState([
    data.transactions.status,
    data.btcBuys.status,
    data.billPays.status,
    data.btcBalanceDocument.status,
    data.todos.status,
  ])
  const rows: ReadonlyArray<{
    readonly icon: IconName
    readonly label: string
    readonly route: string
    readonly value: string
    readonly valueLabel?: string
  }> = [
    {
      icon: "wallet",
      label: "BTC Buys",
      route: "bitcoin-buys",
      value: readableCount(data.btcBuys.status, buyCount),
      valueLabel: countValueLabel(data.btcBuys.status, buyCount, "Bitcoin buys"),
    },
    {
      icon: "receipt",
      label: "BTC Bill Pays",
      route: "bills",
      value: readableCount(data.billPays.status, billPayCount),
      valueLabel: countValueLabel(data.billPays.status, billPayCount, "Bitcoin bill pays"),
    },
    {
      icon: "sparkles",
      label: "Awards",
      route: "awards",
      value: readableCount(awardStatus, awardCount),
      valueLabel: countValueLabel(awardStatus, awardCount, "earned awards"),
    },
  ]

  return (
    <>
      <PageHeader title="More" subtitle="Everything else in the household" />
      {state ? (
        <StateBlock
          state={state}
          detail="Navigation remains available. A dash replaces each count that cannot be read safely."
        />
      ) : null}
      <div className="vv-more-list">
        {rows.map((row) => (
          <button key={`${row.label}-${row.route}`} type="button" onClick={() => navigate(row.route)}>
            <IconGlyph name={row.icon} size={18} />
            <span>{row.label}</span>
            <strong className="vv-num" aria-label={row.valueLabel}>{row.value}</strong>
            <IconGlyph name="chevron-right" size={14} />
          </button>
        ))}
      </div>
    </>
  )
}

export const adminPageManifest: PageManifest = {
  id: "admin",
  label: "System",
  pages: [
    { id: "family", label: "Family & Profiles", icon: "users", Component: FamilyProfilesPage },
    { id: "sync-health", label: "Sync Health", icon: "refresh", Component: SyncHealthPage },
    { id: "export", label: "Export", icon: "download", Component: ExportPage, adultOnly: true },
    { id: "settings", label: "Settings", icon: "settings", Component: SettingsPage },
    { id: "awards", label: "Awards", icon: "sparkles", Component: AwardsPage },
    { id: "more", label: "More", icon: "chevron-right", Component: MorePage },
    { id: "onboarding", label: "Onboarding", icon: "sparkles", Component: OnboardingPage },
    { id: "lock", label: "Lock Screen", icon: "lock", Component: LockScreenPage },
  ],
}
