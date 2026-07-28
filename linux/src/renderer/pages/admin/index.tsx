// Admin / system page slice.
//
// These pages describe the app's own state — profiles, sync health, export, and
// settings. Row reads are runtime-gated and writeback is absent; every surface
// that would mutate real data says so instead of offering a control that no-ops.

import { useMemo, useState } from "react"

import {
  FAMILY_MEMBERS,
  type FamilyMember,
  allowedSwitchTargets,
  displayName,
  isAdult,
  mc2BTCBuysFileName,
  mc2TransactionsFileName,
  profileDescription,
  sharesNetWorthWith,
  showsFullBudget,
  visibleTo,
} from "@vogel-vault/domain/family"
import { formatMinorUnits } from "@vogel-vault/domain/money"
import { type Freshness, MC2_FILES, type Transaction } from "@vogel-vault/domain/readModel"

import { useAppState } from "../../app/AppState.tsx"
import type { FixtureEnvelope } from "../../data/fixtures.ts"
import { spendAmount } from "../../data/transactionAmounts.ts"
import {
  Badge,
  type BannerTone,
  Button,
  type Column,
  DataTable,
  Field,
  FreshnessTag,
  IconGlyph,
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
      <PageHeader title="Family & Profiles" subtitle="Who can see what" />
      <StatusBanner
        tone="info"
        title="Victor and Rachel are one household"
        detail="They see identical finance data. Mason and Maddox are isolated and see only their own records."
      />
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
              // Rendered from the shared contract so this table cannot drift
              // from the behaviour the rest of the app enforces.
              const sees = viewer === owner || isAdult(viewer)
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
  const { data } = useAppState()
  const readsRows = data.transactions.source.startsWith("Convex row tables")

  const slices = [
    { name: "transactions", slice: data.transactions },
    { name: "budget", slice: data.budget },
    { name: "btc-balance-snapshot", slice: data.btcAccounts },
    { name: "bitcoin-buys", slice: data.btcBuys },
    { name: "bitcoin-bill-pays", slice: data.billPays },
    { name: "todos", slice: data.todos },
  ]

  return (
    <>
      <PageHeader title="Sync Health" subtitle="Where every number came from, and when" />
      <StatusBanner
        tone={readsRows ? "info" : "warning"}
        title={readsRows ? "Runtime-gated Convex row reads are active" : "Sanitized fallback data is active"}
        detail={
          readsRows
            ? "Every slice below came through the strict row bridge; credentials remain in the main process."
            : "Enable and fully configure runtime row reads to replace the sanitized fixture envelope."
        }
      />
      <Panel title="Slices" flush>
        <DataTable
          columns={[
            { key: "name", header: "MC2 file", render: (row) => row.name },
            { key: "source", header: "Source", render: (row) => row.slice.source, secondary: true },
            {
              key: "status",
              header: "State",
              render: (row) => <FreshnessTag status={row.slice.status} updatedAt={row.slice.updatedAt} />,
            },
          ]}
          rows={slices}
          rowKey={(row) => row.name}
        />
      </Panel>
      <Panel title="Known MC2 files" source={`${MC2_FILES.length} files in the read model`} flush>
        <DataTable
          columns={[
            { key: "file", header: "File", render: (row: { file: string }) => row.file },
            {
              key: "wired",
              header: "In this build",
              render: (row: { file: string }) => {
                const wired = slices.some((slice) => slice.name === row.file)
                return <Badge tone={wired ? "positive" : "neutral"}>{wired ? "wired" : "pending"}</Badge>
              },
            },
          ]}
          rows={MC2_FILES.map((file) => ({ file }))}
          rowKey={(row) => row.file}
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
 * uses, in the renderer, before anything crosses the bridge — the main process
 * writes bytes and never learns who is logged in. An export that leaked here
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
      // amount_usd is exactly what the source stores. signed_usd uses cash-flow
      // signs (spend negative, income/refunds positive) for spreadsheet sums.
      rows: visibleTo(viewer, data.transactions.value).map((row) => {
        const spend = spendAmount(row)
        return [
          row.id,
          row.date,
          row.merchant,
          row.category,
          row.card ?? "",
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
        usdCell(row.fiat),
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

  // Matches the Settings page: the bridge is absent under plain `vite dev` in a
  // browser and in the headless render tests, and the page has to say so rather
  // than offer a button that throws.
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
      const result = await exporter({
        suggestedFileName: exportFileName(datasetId, activeProfile, data.generatedAt),
        columns: dataset.columns,
        rows: dataset.rows,
      })
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


// ── CSV Import ──────────────────────────────────────────────────────────────

function CSVImportPage() {
  return (
    <>
      <PageHeader title="CSV Import" subtitle="Bring transactions in from a statement" />
      <StatusBanner
        tone="warning"
        title="Import is a write path and is not enabled"
        detail="Imports mutate MC2 data. That path is owned by the approved writeback lane, not the desktop client."
      />
      <Panel title="How import will work">
        <ol className="vv-muted" style={{ margin: 0, paddingLeft: "1.2rem", lineHeight: 1.8 }}>
          <li>Choose a CSV and map its columns to merchant, date, amount, and category.</li>
          <li>Rows are previewed with the owner they would be tagged with.</li>
          <li>Amounts are parsed as decimals, never floats — cents are exact.</li>
          <li>Nothing is written until the mapping is confirmed.</li>
        </ol>
      </Panel>
      <Panel title="Preview" flush>
        <StateBlock
          state="empty"
          title="No file selected"
          detail="File selection needs a reviewed preload surface before it can be enabled."
        />
      </Panel>
    </>
  )
}

// ── Settings / Admin ────────────────────────────────────────────────────────

function SettingsPage() {
  const { data, stateOverride, setStateOverride } = useAppState()
  const runtime = typeof window !== "undefined" ? window.vogelVault?.getRuntimeInfo() : undefined
  const readsRows = data.transactions.source.startsWith("Convex row tables")

  return (
    <>
      <PageHeader title="Settings" subtitle="Runtime and diagnostics" />
      <PageGrid>
        <Panel title="Runtime" source="Read through the preload bridge">
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
              title="Runtime bridge unavailable"
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
      </PageGrid>
      <Panel title="Data boundaries" source="What this client will and will not do">
        <ul className="vv-muted" style={{ margin: 0, paddingLeft: "1.2rem", lineHeight: 1.8 }}>
          <li>The renderer holds no credentials and cannot reach the network directly.</li>
          <li>Writeback is disabled; this client performs read-only Convex queries.</li>
          <li>
            Figures currently come from {readsRows ? "the bounded Convex row API" : "sanitized fallback fixtures"}.
          </li>
        </ul>
      </Panel>
    </>
  )
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
  const { switchProfile, switchTargets } = useAppState()

  return (
    <>
      <PageHeader title="Welcome" subtitle="First run" />
      <Panel title="Pick a profile">
        <p className="vv-muted" style={{ marginTop: 0 }}>
          The Vogel Vault shows different data per profile. Adults share the household ledger;
          children see only their own records.
        </p>
        <Toolbar>
          {switchTargets.map((member) => (
            <Button key={member} variant="secondary" onClick={() => switchProfile(member)}>
              {displayName(member)}
            </Button>
          ))}
        </Toolbar>
      </Panel>
      <Panel title="What syncs" source="Read-only in this build">
        <DataTable
          columns={[
            { key: "member", header: "Profile", render: (row: { member: FamilyMember }) => displayName(row.member) },
            {
              key: "tx",
              header: "Transactions file",
              render: (row: { member: FamilyMember }) => (
                <code className="vv-num">{mc2TransactionsFileName(row.member)}</code>
              ),
            },
            {
              key: "btc",
              header: "Buys file",
              render: (row: { member: FamilyMember }) => (
                <code className="vv-num">{mc2BTCBuysFileName(row.member)}</code>
              ),
              secondary: true,
            },
          ]}
          rows={FAMILY_MEMBERS.map((member) => ({ member }))}
          rowKey={(row) => row.member}
        />
      </Panel>
    </>
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

export const adminPageManifest: PageManifest = {
  id: "admin",
  label: "System",
  pages: [
    { id: "family", label: "Family & Profiles", icon: "users", Component: FamilyProfilesPage },
    { id: "sync-health", label: "Sync Health", icon: "refresh", Component: SyncHealthPage },
    { id: "export", label: "Export", icon: "download", Component: ExportPage, adultOnly: true },
    { id: "csv-import", label: "CSV Import", icon: "receipt", Component: CSVImportPage, adultOnly: true },
    { id: "settings", label: "Settings", icon: "settings", Component: SettingsPage },
    { id: "onboarding", label: "Onboarding", icon: "sparkles", Component: OnboardingPage },
    { id: "lock", label: "Lock Screen", icon: "lock", Component: LockScreenPage },
  ],
}
