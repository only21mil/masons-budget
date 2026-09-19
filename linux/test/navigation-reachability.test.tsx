// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test } from "vitest"

import { FAMILY_MEMBERS, isAdult, type FamilyMember } from "@vogel-vault/domain/family"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import { Cockpit } from "../src/App.tsx"
import { ROUTABLE_PAGES, navSectionsFor, resolvePage } from "../src/renderer/pages/index.ts"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

// Click paths from Home, not direct route mounts. Every step must be rendered
// and enabled, and the resulting route must match the registry.
const SECONDARY_ENTRY_POINTS: Readonly<Record<string, readonly string[]>> = {
  family: ["App menu", "Family"],
  settings: ["App menu", "Settings"],
  export: ["App menu", "Export"],
  lock: ["App menu", "Lock now"],
  awards: ["App menu", "Settings", "Awards"],
  "sync-health": ["App menu", "Settings", "Sync Health"],
  onboarding: ["App menu", "Settings", "Replay onboarding"],
  "bitcoin-buys": ["Bitcoin", "Bitcoin Buys"],
  bills: ["Bitcoin", "Bill Pays"],
  price: ["Bitcoin", "Price"],
}

function StateProbe() {
  const { route, locked } = useAppState()
  return (
    <>
      <output data-testid="route">{route}</output>
      <output data-testid="locked">{String(locked)}</output>
    </>
  )
}

let dispose: (() => Promise<void>) | undefined

afterEach(async () => {
  await dispose?.()
  dispose = undefined
  localStorage.clear()
})

async function mount(profile: FamilyMember) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  dispose = async () => {
    await act(async () => root.unmount())
    container.remove()
  }
  await act(async () => root.render(
    <AppStateProvider initialProfile={profile} initialRoute="home" initialCurrentMonth="2026-07">
      <Cockpit />
      <StateProbe />
    </AppStateProvider>,
  ))
  return container
}

async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === label)
  expect(button, `missing button: ${label}`).toBeDefined()
  expect(button!.disabled, `disabled button: ${label}`).toBe(false)
  await act(async () => button!.click())
}

for (const profile of FAMILY_MEMBERS) {
  const primary = navSectionsFor(profile).flatMap((section) => section.items)
  for (const { id } of ROUTABLE_PAGES) {
    if (!resolvePage(id, profile)) continue
    test(`${profile} reaches ${id} through rendered navigation`, async () => {
      const container = await mount(profile)
      const sidebarItem = primary.find((item) => item.id === id)
      const path = sidebarItem ? [sidebarItem.label] : SECONDARY_ENTRY_POINTS[id]
      expect(path, `no entry point declared for ${id}`).toBeDefined()
      for (const label of path!) await click(container, label)
      if (id === "lock") {
        expect(container.querySelector('[data-testid="locked"]')?.textContent).toBe("true")
        expect(container.querySelector('[role="dialog"][aria-label="Locked"]')).not.toBeNull()
        expect(container.querySelector('[data-testid="route"]')?.textContent).toBe("home")
        await click(container, "Unlock")
        expect(container.querySelector('[data-testid="locked"]')?.textContent).toBe("false")
        expect(container.querySelector('[data-testid="route"]')?.textContent).toBe("home")
      } else {
        expect(container.querySelector('[data-testid="route"]')?.textContent).toBe(id)
      }
    })
  }

  test(`${profile} gear menu filters Export and closes after navigation`, async () => {
    const container = await mount(profile)
    expect(container.querySelector('[role="menu"]')).toBeNull()
    await click(container, "App menu")
    const labels = [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(labels).toContain("Lock now")
    expect(labels.includes("Export")).toBe(isAdult(profile))
    await click(container, "Settings")
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(container.querySelector('[data-testid="route"]')?.textContent).toBe("settings")
  })
}

test("gear menu toggles closed and dismisses on Escape or outside pointerdown", async () => {
  const container = await mount("victor")
  const expanded = () => container.querySelector('[aria-label="App menu"]')?.getAttribute("aria-expanded")
  expect(expanded()).toBe("false")
  await click(container, "App menu")
  expect(expanded()).toBe("true")
  await act(async () => container.querySelector('[role="menu"]')!
    .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
  expect(expanded()).toBe("true")
  await click(container, "App menu")
  expect(expanded()).toBe("false")
  await click(container, "App menu")
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })))
  expect(expanded()).toBe("false")
  expect(container.querySelector('[role="menu"]')).toBeNull()
  await click(container, "App menu")
  await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
  expect(expanded()).toBe("false")
  expect(container.querySelector('[role="menu"]')).toBeNull()
})
