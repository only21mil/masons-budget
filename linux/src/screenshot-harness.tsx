// Screenshot harness entry point.
//
// A second Vite entry used only to build the design packet. It renders the real
// app shell — sidebar, top bar, the actual page — seeded to one
// profile/route/state combination from the query string, so the capture script
// can target a combination directly instead of clicking through the UI.
//
// This is NOT part of the shipped app. electron/main.ts only ever loads
// index.html, and the harness carries no data of its own: it renders the same
// sanitized fixtures the app does.
//
//   screenshots.html?page=dashboard&profile=victor&state=normal

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { FAMILY_MEMBERS, type FamilyMember } from "@vogel-vault/domain/family"

import App from "./App.tsx"
import type { StateOverride } from "./renderer/app/AppState.tsx"
import { TaskClockProvider } from "./renderer/pages/tasks/taskClock.tsx"

const VALID_STATES: StateOverride[] = ["normal", "stale", "error", "empty", "loading"]

function readParams(): { page: string; profile: FamilyMember; state: StateOverride } {
  const params = new URLSearchParams(window.location.search)

  const page = params.get("page") ?? "dashboard"

  const rawProfile = params.get("profile")
  const profile = (FAMILY_MEMBERS as readonly string[]).includes(rawProfile ?? "")
    ? (rawProfile as FamilyMember)
    : "victor"

  const rawState = params.get("state")
  const state = (VALID_STATES as string[]).includes(rawState ?? "")
    ? (rawState as StateOverride)
    : "normal"

  return { page, profile, state }
}

const container = document.getElementById("root")
if (!container) throw new Error("Root container missing from screenshots.html")

const { page, profile, state } = readParams()
const fixtureNow = () => new Date(2026, 6, 26, 12, 0, 0)

createRoot(container).render(
  <StrictMode>
    <TaskClockProvider now={fixtureNow}>
      <App initialProfile={profile} initialRoute={page} initialStateOverride={state} />
    </TaskClockProvider>
  </StrictMode>,
)

// The capture script waits on this flag rather than a fixed timeout, so a slow
// runner cannot produce a half-painted screenshot.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    document.documentElement.dataset.vvReady = "true"
  })
})
