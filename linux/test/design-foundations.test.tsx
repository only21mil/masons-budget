// @vitest-environment happy-dom

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"

import { AppStateProvider } from "../src/renderer/app/AppState.tsx"
import {
  CarGlyph,
  HorizonMark,
  LedgerScanlines,
  LedgerSemanticValue,
  PawGlyph,
} from "../src/renderer/components/LedgerFoundations.tsx"
import { AppShell } from "../src/renderer/components/AppShell.tsx"
import { LEDGER_WINDOW_BACKGROUND } from "../shared/ledgerWindow.ts"
import { renderRoute } from "./support/renderRoute.ts"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const here = dirname(fileURLToPath(import.meta.url))
const renderer = join(here, "..", "src", "renderer")
const foundations = readFileSync(join(renderer, "styles", "ledger-foundations.css"), "utf8")
const globalStyles = readFileSync(join(renderer, "styles", "global.css"), "utf8")
const componentStyles = readFileSync(join(renderer, "styles", "components.css"), "utf8")
const priceStyles = readFileSync(join(renderer, "pages", "finance", "price", "price.css"), "utf8")
const foundationComponents = readFileSync(
  join(renderer, "components", "LedgerFoundations.tsx"),
  "utf8",
)
const fontPath = join(
  renderer,
  "assets",
  "fonts",
  "source-code-pro",
  "SourceCodePro[wght].ttf",
)

describe("ledger design foundations", () => {
  afterEach(() => window.localStorage.clear())

  it("adopts the ledger scope at the application shell", () => {
    const shell = renderToStaticMarkup(
      <AppShell sections={[]} activeId="home" onNavigate={() => {}} topBar={null}>
        Ledger content
      </AppShell>,
    )

    expect(shell).toContain('class="vv-shell vv-ledger-root"')
    expect(globalStyles).toContain("--vv-bg: var(--vv-ledger-bg)")
    expect(globalStyles).toContain("--vv-font-ui: var(--vv-ledger-font)")
  })

  it("keeps the exact Terminal and Daylight semantic tokens", () => {
    for (const token of [
      "--vv-ledger-bg: #0a0d0c",
      "--vv-ledger-panel: #0c100e",
      "--vv-ledger-panel-raised: #111614",
      "--vv-ledger-bitcoin: #f7931a",
      "--vv-ledger-gain: oklch(0.74 0.155 158)",
      "--vv-ledger-loss: oklch(0.7 0.155 28)",
      "--vv-ledger-rule-style: solid",
      "--vv-ledger-screen-gutter: 20px",
      "--vv-ledger-row-padding-block: 12px",
      "--vv-ledger-screen-title-size: 26px",
      "--vv-ledger-row-text-size: 12.5px",
      "--vv-ledger-meta-text-size: 11px",
      "--vv-ledger-bg: #f4f3ee",
      "--vv-ledger-panel: #edebe4",
      "--vv-ledger-panel-raised: #ffffff",
      "--vv-ledger-bitcoin: #9e5104",
      "--vv-ledger-gain: oklch(0.52 0.13 158)",
      "--vv-ledger-loss: oklch(0.52 0.15 28)",
      "--vv-ledger-rule-style: dashed",
      "--vv-ledger-screen-gutter: 22px",
      "--vv-ledger-row-padding-block: 15px",
      "--vv-ledger-screen-title-size: 29px",
      "--vv-ledger-row-text-size: 13.5px",
    ]) {
      expect(foundations).toContain(token)
    }
  })

  it("keeps the ink tiers opaque and the Bitcoin text and fill split", () => {
    const [dark, light] = foundations.split('[data-vv-theme="light"]')
    for (const token of [
      "--vv-ledger-ink-secondary: #a3aba6",
      "--vv-ledger-ink-meta: #8f9792",
      "--vv-ledger-bitcoin: #f7931a",
      "--vv-ledger-bitcoin-fill: #f7931a",
      "--vv-ledger-bitcoin-decimals: rgba(247, 147, 26, 0.75)",
      "--vv-ledger-bitcoin-soft: rgba(247, 147, 26, 0.12)",
      "--vv-ledger-soft-alpha: 12%",
      "--vv-ledger-phosphor: rgba(247, 147, 26, 0.3)",
    ]) {
      expect(dark).toContain(token)
    }
    for (const token of [
      "--vv-ledger-ink-secondary: #505452",
      "--vv-ledger-ink-meta: #5c605d",
      "--vv-ledger-bitcoin: #9e5104",
      "--vv-ledger-bitcoin-fill: #f7931a",
      "--vv-ledger-bitcoin-decimals: #9e5104",
      // The light soft fill is the light bitcoin text tone at 0.10 (FOUNDATIONS).
      "--vv-ledger-bitcoin-soft: rgba(158, 81, 4, 0.1)",
      "--vv-ledger-soft-alpha: 10%",
    ]) {
      expect(light).toContain(token)
    }
    expect(light).not.toContain("rgba(201, 106, 5")
    expect(foundations).not.toMatch(/--vv-ledger-ink-(secondary|meta): rgba/)
    expect(priceStyles).toMatch(
      /\.vv-price-hero__decimals\s*\{[^}]*color: var\(--vv-ledger-bitcoin-decimals\);/,
    )
    expect(priceStyles).not.toMatch(/\.vv-price-hero__decimals\s*\{[^}]*opacity/)
  })

  it("maps every Graphite status colour onto a ledger tone in both treatments", () => {
    const bridge = globalStyles.slice(
      globalStyles.indexOf(".vv-ledger-root {"),
      globalStyles.indexOf("*,\n*::before"),
    )
    for (const alias of [
      "--vv-warning: var(--vv-ledger-bitcoin)",
      "--vv-stale: var(--vv-ledger-bitcoin)",
      "--vv-info: var(--vv-ledger-ink-secondary)",
      "--vv-negative: var(--vv-ledger-loss)",
      "--vv-positive-dim: color-mix(in srgb, var(--vv-ledger-gain) var(--vv-ledger-soft-alpha), transparent)",
      "--vv-negative-dim: color-mix(in srgb, var(--vv-ledger-loss) var(--vv-ledger-soft-alpha), transparent)",
      "--vv-warning-dim: var(--vv-ledger-bitcoin-soft)",
      "--vv-info-dim: color-mix(in srgb, var(--vv-ledger-ink-secondary) var(--vv-ledger-soft-alpha), transparent)",
      "--vv-negative-line: color-mix(in srgb, var(--vv-ledger-loss) 42%, transparent)",
    ]) {
      expect(bridge).toContain(alias)
    }
    // Every consumer of a status colour reads the remapped name, never a literal.
    expect(componentStyles).toMatch(/\.vv-button--danger\s*\{[^}]*border-color: var\(--vv-negative-line\);/)
    expect(componentStyles).toMatch(/\.vv-badge--warning\s*\{[^}]*color: var\(--vv-warning\);/)
    expect(componentStyles).toMatch(/\.vv-badge--info\s*\{[^}]*color: var\(--vv-info\);/)
    expect(globalStyles).toMatch(/\.vv-stale\s*\{[^}]*color: var\(--vv-stale\);/)
    const literal = /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i
    expect(componentStyles).not.toMatch(literal)
    expect(priceStyles).not.toMatch(literal)
    expect(globalStyles).not.toMatch(literal)
    expect(foundationComponents).not.toMatch(literal)
    expect(foundationComponents).toContain('fill="var(--vv-ledger-mark-tile)"')
    expect(foundationComponents).toContain('stroke="var(--vv-ledger-mark-stroke)"')
    // The body paints nothing; the window carries the treatment until the shell mounts.
    expect(globalStyles).toMatch(/body\s*\{[^}]*background: transparent;/)
  })

  it("publishes the treatment's ledger background as the document theme colour", async () => {
    const readThemeColor = () =>
      document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null
    const mount = async () => {
      const container = document.createElement("div")
      document.body.append(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(
          <AppStateProvider>
            <AppShell sections={[]} activeId="dashboard" onNavigate={() => {}} topBar={null}>
              Ledger content
            </AppShell>
          </AppStateProvider>,
        )
      })
      return async () => {
        await act(async () => root.unmount())
        container.remove()
      }
    }

    document.head.querySelector('meta[name="theme-color"]')?.remove()
    window.localStorage.setItem("vogel-vault.ledger-theme", "light")
    let unmount = await mount()
    expect(readThemeColor()).toBe(LEDGER_WINDOW_BACKGROUND.light)
    expect(readThemeColor()).toBe("#f4f3ee")
    await unmount()

    window.localStorage.setItem("vogel-vault.ledger-theme", "dark")
    unmount = await mount()
    expect(readThemeColor()).toBe("#0a0d0c")
    await unmount()
    document.head.querySelector('meta[name="theme-color"]')?.remove()
  })

  it("holds the type floor at 11px and caps uppercase tracking at 0.10em", () => {
    for (const token of [
      "--vv-ledger-text-tab: 11px",
      "--vv-ledger-text-kpi-label: 11px",
      "--vv-ledger-text-meta: 11px",
      "--vv-ledger-text-chip: 11px",
      "--vv-ledger-text-body: 12px",
      "--vv-ledger-leading-body: 18px",
      "--vv-ledger-tracking-tab: 0.06em",
      "--vv-ledger-tracking-chip: 0.06em",
      "--vv-ledger-tracking-meta: 0.03em",
      "--vv-ledger-tracking-kpi-label: 0.1em",
      "--vv-ledger-tracking-label: 0.1em",
    ]) {
      expect(foundations).toContain(token)
    }
    // The SOVEREIGN / BUDGET APP wordmark is a brand lockup, not a type role.
    const tracking = `${componentStyles}${priceStyles}`
      .split("}")
      .filter((rule) => !rule.includes("wordmark"))
      .flatMap((rule) => [...rule.matchAll(/letter-spacing:\s*(-?[\d.]+)em/g)])
      .map((m) => Number(m[1]))
    expect(tracking.length).toBeGreaterThan(0)
    expect(Math.max(...tracking)).toBeLessThanOrEqual(0.1)
    // Only the brand lockups sit under 11px; every type role is on a token.
    const ledgerScope = componentStyles.slice(componentStyles.indexOf("Sovereign full-screen adoption"))
    const small = ledgerScope
      .split("}")
      .filter((rule) => !rule.includes("wordmark"))
      .flatMap((rule) => [...rule.matchAll(/font-size:\s*([\d.]+)px/g)])
      .map((m) => Number(m[1]))
      .filter((size) => size < 11)
    expect(small).toEqual([])
    expect(componentStyles).toMatch(/\.vv-kpi__label\s*\{[^}]*white-space: nowrap;/)
    expect(componentStyles).toMatch(/\.vv-navitem\s*\{[^}]*font-size: var\(--vv-ledger-text-tab\);/)
    expect(componentStyles).toMatch(/\.vv-page__subtitle,\s*\.vv-panel__source\s*\{[^}]*font-weight: 500;/)
  })

  it("bundles the official font locally for all required weights", () => {
    expect(globalStyles).toContain('@import "./ledger-foundations.css"')
    expect(foundations).toContain('url("../assets/fonts/source-code-pro/SourceCodePro[wght].ttf")')
    expect(foundations).toContain("font-weight: 300 700")
    expect(foundations).not.toMatch(/https?:\/\//)

    const hash = createHash("sha256").update(readFileSync(fontPath)).digest("hex")
    expect(hash).toBe("b400fc584e10aff25d0e775ce181b4fc1c5ea1b5dc37b81aeb2084375b945790")
  })

  it("keeps the exact Horizon, car, and paw geometry", () => {
    const horizon = renderToStaticMarkup(<HorizonMark title="Horizon" />)
    expect(horizon).toContain('transform="translate(12 9.4) scale(0.435) translate(-13 -12.7)"')
    expect(horizon).toContain("M11 3.2v2.8M11 19.4v2.8M13.6 3.2v2.8M13.6 19.4v2.8")
    expect(horizon).toContain('<rect x="0" y="15.1" width="24" height="1.6" fill-opacity=".5"></rect>')
    expect(horizon).toContain('<rect x="0" y="17.6" width="24" height="1.25" fill-opacity=".3"></rect>')
    expect(horizon).toContain('<rect x="0" y="19.75" width="24" height=".95" fill-opacity=".17"></rect>')

    const car = renderToStaticMarkup(<CarGlyph />)
    expect(car).toContain("M3 13.5 5 8h14l2 5.5v3.5h-2.6M3 13.5V17h2.6m0 0h11.8M5 13.5h14")
    expect(car).toContain("M5.6 17a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0M15 17a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0")

    const paw = renderToStaticMarkup(<PawGlyph />)
    expect(paw).toContain("M5.4 9.6a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0")
    expect(paw).toContain("M8.2 15.4c0-2.1 1.7-3.4 3.8-3.4s3.8 1.3 3.8 3.4")
  })

  it("keeps decoration inert and semantic colour paired with spoken text", () => {
    const overlay = renderToStaticMarkup(<LedgerScanlines />)
    expect(overlay).toContain('aria-hidden="true"')
    expect(overlay).toContain('role="presentation"')
    expect(foundations).toMatch(/\.vv-ledger-scanlines[\s\S]*?pointer-events: none/)
    expect(foundations).toContain("(prefers-reduced-transparency: reduce)")

    const value = renderToStaticMarkup(
      <LedgerSemanticValue tone="negative" meaning="Loss">
        -$12.00
      </LedgerSemanticValue>,
    )
    expect(value).toContain("vv-ledger-semantic--negative")
    expect(value).toContain('<span class="vv-sr-only">Loss: </span>-$12.00')
  })

  it("disables terminal effects in light without clearing stored preferences", () => {
    window.localStorage.setItem("vogel-vault.ledger-theme", "light")
    window.localStorage.setItem("vogel-vault.scanlines", "true")
    window.localStorage.setItem("vogel-vault.phosphor", "true")

    const shell = renderToStaticMarkup(
      <AppStateProvider>
        <AppShell sections={[]} activeId="dashboard" onNavigate={() => {}} topBar={null}>
          Ledger content
        </AppShell>
      </AppStateProvider>,
    )
    const settings = renderRoute("settings")

    expect(shell).toContain('data-vv-theme="light"')
    expect(shell).toContain('data-vv-phosphor="off"')
    expect(shell).not.toContain("vv-ledger-scanlines")
    for (const label of ["Phosphor glow", "Scanlines"]) {
      expect(settings).toMatch(
        new RegExp(
          `${label}[\\s\\S]*Dark theme only — Daylight is ink on paper\\.[\\s\\S]*aria-checked="false"[\\s\\S]*aria-disabled="true"[\\s\\S]*disabled=""`,
        ),
      )
    }
    expect(window.localStorage.getItem("vogel-vault.scanlines")).toBe("true")
    expect(window.localStorage.getItem("vogel-vault.phosphor")).toBe("true")
  })

  it("scopes phosphor glow to the available dark-theme price hero", () => {
    expect(componentStyles).not.toMatch(/data-vv-phosphor[^}]+vv-kpi/s)
    expect(componentStyles).not.toMatch(/data-vv-phosphor[^}]+vv-ledger-semantic/s)
    expect(foundations).not.toContain(".vv-ledger-glow")
    expect(priceStyles).toMatch(
      /\[data-vv-theme="dark"\]\[data-vv-phosphor="on"\][^{]+\.vv-price-hero__value:not\(\.vv-price-hero__value--unavailable\)[^{]+\{\s*text-shadow: 0 0 18px var\(--vv-ledger-phosphor\);/,
    )
  })

  it("keeps the price back control above metadata contrast", () => {
    expect(priceStyles).toMatch(
      /\.vv-price-back\s*\{[^}]*color: var\(--vv-ledger-ink-secondary\);/,
    )
    expect(priceStyles).toMatch(
      /\.vv-price-kicker,[^{]+\{[^}]*color: var\(--vv-ledger-ink-meta\);/,
    )
  })
})
