import { useEffect } from "react"

import { displayName, isAdult } from "@vogel-vault/domain/family"

import { AppStateProvider, useAppState } from "./renderer/app/AppState.tsx"
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
  const { activeProfile, route, navigate, data, locked } = useAppState()

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
        <TopBar
          profileControl={<ProfileControl />}
          syncState={<FreshnessTag status={data.todos.status} updatedAt={data.todos.updatedAt} />}
        />
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

export default function App() {
  return (
    <AppStateProvider>
      <Cockpit />
    </AppStateProvider>
  )
}
