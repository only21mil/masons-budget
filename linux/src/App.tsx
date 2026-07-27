import { useEffect } from "react"

import { type FamilyMember, displayName, isAdult } from "@vogel-vault/domain/family"
import type { Freshness } from "@vogel-vault/domain/readModel"

import { AppStateProvider, type StateOverride, useAppState } from "./renderer/app/AppState.tsx"
import {
  AppShell,
  Badge,
  Button,
  FreshnessTag,
  IconGlyph,
  Select,
  StateBlock,
  TopBar,
} from "./renderer/components/index.ts"
import { DEFAULT_ROUTE, navSectionsFor, resolvePage } from "./renderer/pages/index.ts"

import "./renderer/styles/global.css"
import "./renderer/styles/components.css"

function ProfileControl() {
  const { activeProfile, switchProfile, switchTargets } = useAppState()

  // A child profile has exactly one switch target — itself. Render a static
  // label rather than a disabled picker that implies a door they cannot open.
  if (switchTargets.length <= 1) {
    return (
      <span className="vv-row">
        <IconGlyph name="sparkles" size={15} />
        <strong>{displayName(activeProfile)}</strong>
        <Badge tone="neutral">Child profile</Badge>
      </span>
    )
  }

  return (
    <span className="vv-row">
      <IconGlyph name={isAdult(activeProfile) ? "users" : "sparkles"} size={15} />
      <Select
        aria-label="Active profile"
        value={activeProfile}
        onChange={(event) => switchProfile(event.target.value as typeof activeProfile)}
        style={{ width: "auto" }}
      >
        {switchTargets.map((member) => (
          <option key={member} value={member}>
            {displayName(member)}
          </option>
        ))}
      </Select>
    </span>
  )
}

/**
 * Global sync indicator.
 *
 * Reports the WORST state across every slice, not one arbitrary slice — a single
 * failed read matters even when the rest are fine. Labelled "Sync" so it reads
 * as the app-wide indicator rather than duplicating the per-slice badge that
 * each page header already shows.
 */
function GlobalSyncState() {
  const { data } = useAppState()

  const slices = [data.transactions, data.budget, data.btcAccounts, data.btcBuys, data.billPays, data.todos]
  const rank: Record<Freshness, number> = {
    error: 0,
    loading: 1,
    stale: 2,
    demo: 3,
    empty: 4,
    live: 5,
  }
  const worst = slices.reduce((acc, slice) => (rank[slice.status] < rank[acc.status] ? slice : acc), slices[0]!)

  return (
    <span className="vv-row">
      <span className="vv-dim" style={{ fontSize: "var(--vv-text-2xs)", letterSpacing: "0.06em" }}>
        SYNC
      </span>
      <FreshnessTag status={worst.status} updatedAt={worst.updatedAt} />
    </span>
  )
}

function LockOverlay() {
  const { setLocked } = useAppState()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLocked(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [setLocked])

  return (
    <div className="vv-lock" role="dialog" aria-modal="true" aria-label="Locked">
      <IconGlyph name="lock" size={28} />
      <p className="vv-lock__title">The Vogel Vault is locked</p>
      <p className="vv-lock__detail">
        A screen cover, not a security control — this build has no credential check.
      </p>
      <Button variant="primary" onClick={() => setLocked(false)}>
        Unlock
      </Button>
    </div>
  )
}

function Cockpit() {
  const { activeProfile, route, navigate, locked } = useAppState()

  const sections = navSectionsFor(activeProfile)
  const page = resolvePage(route, activeProfile)

  // A profile switch can strand the user on a page they may no longer see.
  useEffect(() => {
    if (!resolvePage(route, activeProfile)) navigate(DEFAULT_ROUTE)
  }, [route, activeProfile, navigate])

  if (locked) return <LockOverlay />

  return (
    <AppShell
      sections={sections}
      activeId={route}
      onNavigate={navigate}
      topBar={
        <TopBar profileControl={<ProfileControl />} syncState={<GlobalSyncState />} />
      }
    >
      {page ? (
        <page.Component />
      ) : (
        <StateBlock
          state="empty"
          title="Page unavailable"
          detail="This profile cannot open that page."
        />
      )}
    </AppShell>
  )
}

/**
 * Optional seeds. The app itself never passes these — they exist so the
 * screenshot harness can render a specific profile/route/state combination
 * without clicking through the UI. Same mechanism the render-matrix tests use.
 */
export interface AppProps {
  initialProfile?: FamilyMember
  initialRoute?: string
  initialStateOverride?: StateOverride
}

export default function App({ initialProfile, initialRoute, initialStateOverride }: AppProps = {}) {
  return (
    <AppStateProvider
      initialProfile={initialProfile}
      initialRoute={initialRoute}
      initialStateOverride={initialStateOverride}
    >
      <Cockpit />
    </AppStateProvider>
  )
}
