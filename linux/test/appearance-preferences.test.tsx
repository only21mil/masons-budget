// @vitest-environment happy-dom

import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const STORAGE_KEYS = {
  theme: "vogel-vault.ledger-theme",
  scanlines: "vogel-vault.scanlines",
  phosphor: "vogel-vault.phosphor",
} as const

const mountedRoots = new Set<Root>()

function AppearanceProbe() {
  const {
    ledgerTheme,
    phosphorEnabled,
    scanlinesEnabled,
    setLedgerTheme,
    setPhosphorEnabled,
    setScanlinesEnabled,
  } = useAppState()

  return createElement(
    "section",
    null,
    createElement("output", { "aria-label": "Ledger theme" }, ledgerTheme),
    createElement("output", { "aria-label": "Scanlines enabled" }, String(scanlinesEnabled)),
    createElement("output", { "aria-label": "Phosphor enabled" }, String(phosphorEnabled)),
    createElement("button", { type: "button", onClick: () => setLedgerTheme("dark") }, "Use dark"),
    createElement("button", { type: "button", onClick: () => setScanlinesEnabled(true) }, "Enable scanlines"),
    createElement("button", { type: "button", onClick: () => setPhosphorEnabled(true) }, "Enable phosphor"),
  )
}

async function mountAppearanceProbe() {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mountedRoots.add(root)

  await act(async () => {
    root.render(createElement(AppStateProvider, {
      mutationAdapter: null,
      children: createElement(AppearanceProbe),
    }))
  })

  return { container, root }
}

async function unmountAppearanceProbe(root: Root, container: HTMLDivElement) {
  await act(async () => root.unmount())
  mountedRoots.delete(root)
  container.remove()
}

function readAppearance(container: HTMLDivElement) {
  const value = (label: string) =>
    container.querySelector<HTMLOutputElement>(`output[aria-label="${label}"]`)!.value

  return {
    theme: value("Ledger theme"),
    scanlines: value("Scanlines enabled"),
    phosphor: value("Phosphor enabled"),
  }
}

function click(container: HTMLDivElement, label: string) {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent === label)
  expect(button).toBeDefined()
  button!.click()
}

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => root.unmount())
  }
  mountedRoots.clear()
  window.localStorage.clear()
  document.body.replaceChildren()
})

describe("Linux appearance preference persistence", () => {
  it("restores valid preferences, persists changes, and restores them after remount", async () => {
    window.localStorage.setItem(STORAGE_KEYS.theme, "light")
    window.localStorage.setItem(STORAGE_KEYS.scanlines, "false")
    window.localStorage.setItem(STORAGE_KEYS.phosphor, "false")

    const firstMount = await mountAppearanceProbe()
    expect(readAppearance(firstMount.container)).toEqual({
      theme: "light",
      scanlines: "false",
      phosphor: "false",
    })

    await act(async () => {
      click(firstMount.container, "Use dark")
      click(firstMount.container, "Enable scanlines")
      click(firstMount.container, "Enable phosphor")
    })

    expect(readAppearance(firstMount.container)).toEqual({
      theme: "dark",
      scanlines: "true",
      phosphor: "true",
    })
    expect(window.localStorage.getItem(STORAGE_KEYS.theme)).toBe("dark")
    expect(window.localStorage.getItem(STORAGE_KEYS.scanlines)).toBe("true")
    expect(window.localStorage.getItem(STORAGE_KEYS.phosphor)).toBe("true")

    await unmountAppearanceProbe(firstMount.root, firstMount.container)
    const secondMount = await mountAppearanceProbe()

    expect(readAppearance(secondMount.container)).toEqual({
      theme: "dark",
      scanlines: "true",
      phosphor: "true",
    })
  })

  it("defaults scanlines off for a new profile without overriding a saved choice", async () => {
    const fresh = await mountAppearanceProbe()
    expect(readAppearance(fresh.container).scanlines).toBe("false")
    expect(window.localStorage.getItem(STORAGE_KEYS.scanlines)).toBeNull()
    await unmountAppearanceProbe(fresh.root, fresh.container)

    window.localStorage.setItem(STORAGE_KEYS.scanlines, "true")
    const saved = await mountAppearanceProbe()
    expect(readAppearance(saved.container).scanlines).toBe("true")
  })

  it.each([
    ["missing", null],
    ["invalid", "sepia"],
  ] as const)("falls back to dark when the stored theme is %s", async (_case, storedTheme) => {
    if (storedTheme === null) {
      window.localStorage.removeItem(STORAGE_KEYS.theme)
    } else {
      window.localStorage.setItem(STORAGE_KEYS.theme, storedTheme)
    }

    const mounted = await mountAppearanceProbe()

    expect(readAppearance(mounted.container).theme).toBe("dark")
  })
})
