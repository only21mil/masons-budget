// @vitest-environment happy-dom

import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import type { FamilyMember } from "@vogel-vault/domain/family"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import { ALL_PAGES } from "../src/renderer/pages/index.ts"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const LEGACY_BIOMETRIC_STORAGE_KEY = "vogel-vault.biometric-unlock"
const settingsPage = ALL_PAGES.find((page) => page.id === "settings")!

function ProfileSwitchProbe() {
  const { activeProfile, switchProfile, switchTargets } = useAppState()
  const target = (member: FamilyMember) => () => switchProfile(member)

  return createElement(
    "section",
    null,
    createElement("output", { "aria-label": "Current profile" }, activeProfile),
    createElement("output", { "aria-label": "Switch targets" }, switchTargets.join(",")),
    createElement("button", { type: "button", onClick: target("mason") }, "Switch to Mason"),
    createElement("button", { type: "button", onClick: target("victor") }, "Switch to Victor"),
  )
}

afterEach(() => {
  window.localStorage.clear()
  document.body.replaceChildren()
})

describe("truthful Linux profile-switch security", () => {
  it("keeps biometric unlock disabled and clears a persisted renderer grant on every mount", async () => {
    for (let mount = 0; mount < 2; mount += 1) {
      window.localStorage.setItem(LEGACY_BIOMETRIC_STORAGE_KEY, "true")
      const container = document.createElement("div")
      document.body.append(container)
      const root = createRoot(container)

      await act(async () => {
        root.render(createElement(AppStateProvider, {
          mutationAdapter: null,
          children: createElement(settingsPage.Component),
        }))
      })

      const biometric = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Biometric unlock"]',
      )
      expect(biometric).not.toBeNull()
      expect(biometric!.disabled).toBe(true)
      expect(biometric!.getAttribute("aria-checked")).toBe("false")
      expect(container.textContent).toContain(
        "Unavailable on Linux. Profile switching does not perform an operating-system authentication check.",
      )
      expect(window.localStorage.getItem(LEGACY_BIOMETRIC_STORAGE_KEY)).toBeNull()

      await act(async () => root.unmount())
      container.remove()
    }
  })

  it("switches without claiming OS authentication and preserves child containment", async () => {
    window.localStorage.setItem(LEGACY_BIOMETRIC_STORAGE_KEY, "true")
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(createElement(AppStateProvider, {
          initialProfile: "victor",
          mutationAdapter: null,
          children: createElement(ProfileSwitchProbe),
        }))
      })

      const current = () => container.querySelector('output[aria-label="Current profile"]')!.textContent
      const targets = () => container.querySelector('output[aria-label="Switch targets"]')!.textContent
      const button = (label: string) =>
        [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!

      expect(current()).toBe("victor")
      expect(targets()).toBe("victor,rachel,mason,maddox")
      expect(window.localStorage.getItem(LEGACY_BIOMETRIC_STORAGE_KEY)).toBeNull()

      await act(async () => button("Switch to Mason").click())
      expect(current()).toBe("mason")
      expect(targets()).toBe("mason")

      await act(async () => button("Switch to Victor").click())
      expect(current()).toBe("mason")
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
