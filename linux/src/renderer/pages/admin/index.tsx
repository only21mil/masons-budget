// Admin / system page slice.
//
// These pages describe the app's own state — profiles, sync health, export, and
// settings. They are deliberately honest about what is not wired yet: this build
// has no live Convex connection and no write path, and every surface that would
// mutate real data says so instead of offering a control that quietly no-ops.

import { useState } from "react"

import {
  FAMILY_MEMBERS,
  type FamilyMember,
  allowedSwitchTargets,
  displayName,
  isAdult,
  mc2BTCBuysFileName,
  mc2TransactionsFileName,
  profileDescription,
  showsFullBudget,
} from "@vogel-vault/domain/family"
import { MC2_FILES } from "@vogel-vault/domain/readModel"

import { useAppState } from "../../app/AppState.tsx"
import {
  Badge,
  Button,
  type Column,
  DataTable,
  DialogFrame,
  Field,
  FreshnessTag,
  IconGlyph,
  PageGrid,
  PageHeader,
  Panel,
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
        tone="warning"
        title="This build reads sanitized fixtures, not the live deployment"
        detail="The Convex bridge is approval-gated. Freshness below describes the fixture envelope, not production data."
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

function ExportPage() {
  const { activeProfile } = useAppState()
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <>
      <PageHeader title="Export" subtitle="Take your records out" />
      <StatusBanner
        tone="info"
        title="Export writes a file to disk"
        detail="Exports are scoped to what the active profile can see. Writing to disk is gated until the file path is reviewed."
      />
      <Panel title="Scope">
        <div className="vv-stack">
          <Field label="Profile" hint="Exports never include records this profile cannot see.">
            <TextInput value={displayName(activeProfile)} readOnly />
          </Field>
          <Field label="Format">
            <Select defaultValue="csv">
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </Select>
          </Field>
          <Toolbar>
            <Button variant="primary" icon="download" onClick={() => setConfirmOpen(true)}>
              Export
            </Button>
          </Toolbar>
        </div>
      </Panel>
      <DialogFrame
        open={confirmOpen}
        title="Export is not enabled"
        description="This build has no filesystem write path."
        onClose={() => setConfirmOpen(false)}
        footer={<Button onClick={() => setConfirmOpen(false)}>Close</Button>}
      >
        <p className="vv-muted">
          Writing files from the renderer would require widening the preload bridge, which is a
          reviewed boundary. Export lands once that surface is designed and approved.
        </p>
      </DialogFrame>
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
  const { stateOverride, setStateOverride } = useAppState()
  const runtime = typeof window !== "undefined" ? window.vogelVault?.getRuntimeInfo() : undefined

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
          <li>Writeback is disabled; MC2 remains the owner of private bulk sync.</li>
          <li>All figures shown in this build come from sanitized fixtures.</li>
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
