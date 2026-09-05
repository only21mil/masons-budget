// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AppStateProvider } from "../src/renderer/app/AppState.tsx"
import { AppShell } from "../src/renderer/components/AppShell.tsx"
import { DataTable, ROW_REVEAL_CAP, rowRevealStyle } from "../src/renderer/components/DataTable.tsx"
import { LoadingBlock } from "../src/renderer/components/StateBlock.tsx"
import {
  SETTLE_MS,
  easeOutCubic,
  interpolateBigInt,
  usePulseOnChange,
  useSettledNumber,
} from "../src/renderer/components/motion.ts"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const here = dirname(fileURLToPath(import.meta.url))
const renderer = join(here, "..", "src", "renderer")
const foundations = readFileSync(join(renderer, "styles", "ledger-foundations.css"), "utf8")
const componentStyles = readFileSync(join(renderer, "styles", "components.css"), "utf8")
const priceStyles = readFileSync(join(renderer, "pages", "finance", "price", "price.css"), "utf8")

const MOTION_TOKENS = [
  "chip",
  "control",
  "toggle",
  "progress",
  "settle",
  "theme",
  "pulse",
  "breathe",
  "reveal",
  "reveal-step",
  "cursor",
] as const

function block(source: string, opener: string): string {
  const start = source.indexOf(opener)
  expect(start, opener).toBeGreaterThanOrEqual(0)
  return source.slice(start, source.indexOf("}", start))
}

describe("ledger motion tokens", () => {
  it("names the first-wave durations once", () => {
    for (const token of [
      "--vv-ledger-motion-chip: 160ms ease",
      "--vv-ledger-motion-control: 180ms ease",
      "--vv-ledger-motion-toggle: 200ms ease",
      "--vv-ledger-motion-progress: 300ms ease",
      "--vv-ledger-motion-settle: 300ms",
      "--vv-ledger-motion-pulse: 600ms ease",
      "--vv-ledger-motion-breathe: 1.1s ease-in-out",
      "--vv-ledger-motion-reveal: 160ms ease",
      "--vv-ledger-motion-reveal-step: 20ms",
    ]) {
      expect(foundations).toContain(token)
    }
    expect(SETTLE_MS).toBe(300)
  })

  it("zeroes every token under the system query and under the app setting", () => {
    const system = block(foundations, "@media (prefers-reduced-motion: reduce) {\n  :root,")
    const app = block(foundations, '[data-vv-motion="off"] {')
    for (const token of MOTION_TOKENS) {
      expect(system).toContain(`--vv-ledger-motion-${token}: 0ms;`)
      expect(app).toContain(`--vv-ledger-motion-${token}: 0ms;`)
    }
  })

  it("keeps every transition and keyframe on a token", () => {
    const ledgerScope = componentStyles.slice(componentStyles.indexOf("Sovereign full-screen adoption"))
    const literalDurations = [...ledgerScope.matchAll(/(?:transition|animation)[^;]*\b\d+m?s\b(?![^;]*var\()/g)]
    expect(literalDurations.map((m) => m[0])).toEqual([])
    expect(componentStyles).toMatch(
      /\.vv-navitem,\s*\.vv-filter-chips \.vv-button,\s*\.vv-unit-toggle__option\s*\{[^}]*color var\(--vv-ledger-motion-chip\)/,
    )
    expect(componentStyles).toMatch(/\.vv-toggle\s*\{[^}]*border-color var\(--vv-ledger-motion-control\)/)
    expect(componentStyles).toMatch(/\.vv-toggle span\s*\{[^}]*transform var\(--vv-ledger-motion-toggle\)/)
    expect(componentStyles).toMatch(
      /input\[type="checkbox"\]\s*\{[^}]*background-color var\(--vv-ledger-motion-control\)/,
    )
    expect(componentStyles).toMatch(
      /\.vv-budget-progress__fill\s*\{[^}]*width var\(--vv-ledger-motion-progress, 300ms ease\)/,
    )
  })

  it("breathes the skeleton and holds it at .6 under both gates", () => {
    expect(componentStyles).not.toContain("vv-shimmer")
    expect(componentStyles).toMatch(
      /\.vv-loading\s*\{[^}]*animation: vv-breathe var\(--vv-ledger-motion-breathe, 1\.1s ease-in-out\) infinite alternate;/,
    )
    expect(componentStyles).toMatch(/@keyframes vv-breathe\s*\{\s*from\s*\{\s*opacity: 0\.45;[\s\S]*?to\s*\{\s*opacity: 0\.8;/)
    expect(componentStyles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.vv-state__icon--spin,\s*\.vv-loading\s*\{\s*animation: none;\s*\}\s*\.vv-loading\s*\{\s*opacity: 0\.6;/,
    )
    expect(componentStyles).toMatch(
      /\.vv-ledger-root\[data-vv-motion="off"\] \.vv-loading\s*\{\s*opacity: 0\.6;/,
    )
  })

  it("reveals rows 20ms apart, capped at index 7, and not at all under either gate", () => {
    expect(componentStyles).toMatch(
      /\.vv-ledger-root \.vv-table tbody tr\s*\{\s*animation: vv-row-reveal var\(--vv-ledger-motion-reveal\) both;\s*animation-delay: calc\(var\(--vv-row-index, 0\) \* var\(--vv-ledger-motion-reveal-step\)\);/,
    )
    expect(componentStyles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.vv-ledger-root \.vv-table tbody tr,[^{]*\{\s*animation: none;/,
    )
    expect(componentStyles).toMatch(
      /\.vv-ledger-root\[data-vv-motion="off"\] \.vv-table tbody tr,[^{]*\{\s*animation: none;/,
    )
    expect(ROW_REVEAL_CAP).toBe(7)
    expect(rowRevealStyle(3)).toEqual({ "--vv-row-index": 3 })
    expect(rowRevealStyle(40)).toEqual({ "--vv-row-index": 7 })

    const rows = Array.from({ length: 10 }, (_, index) => ({ id: `row-${index}` }))
    const markup = renderToStaticMarkup(
      <DataTable
        columns={[{ key: "id", header: "Id", render: (row: { id: string }) => row.id }]}
        rows={rows}
        rowKey={(row) => row.id}
      />,
    )
    expect(markup.match(/--vv-row-index:7/g)).toHaveLength(3)
    expect(markup).not.toContain("--vv-row-index:8")

    const skeleton = renderToStaticMarkup(<LoadingBlock />)
    expect(skeleton.match(/vv-loading__row/g)).toHaveLength(3)
    expect(skeleton).toContain("vv-loading__figure")
    expect(skeleton).not.toContain("animation-delay")
  })

  it("pulses the hero glow once per quote, only where the glow already lives", () => {
    expect(priceStyles).toMatch(
      /\[data-vv-theme="dark"\]\[data-vv-phosphor="on"\]\s*\.vv-price-hero__value--pulse:not\(\.vv-price-hero__value--unavailable\)\s*\{\s*animation: vv-phosphor-pulse var\(--vv-ledger-motion-pulse\) 1;/,
    )
    expect(priceStyles).toMatch(
      /@keyframes vv-phosphor-pulse\s*\{\s*0% \{ text-shadow: 0 0 18px rgba\(247,147,26,\.30\); \}\s*33% \{ text-shadow: 0 0 32px rgba\(247,147,26,\.30\); \}\s*100% \{ text-shadow: 0 0 18px rgba\(247,147,26,\.30\); \}/,
    )
    expect(priceStyles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.vv-price-hero__value--pulse\s*\{\s*animation: none;/,
    )
    expect(priceStyles).toMatch(
      /\.vv-ledger-root\[data-vv-motion="off"\] \.vv-price-hero__value--pulse\s*\{\s*animation: none;/,
    )
  })

  it("carries the app setting onto the ledger root", () => {
    const shell = () => renderToStaticMarkup(
      <AppStateProvider>
        <AppShell sections={[]} activeId="dashboard" onNavigate={() => {}} topBar={null}>
          Ledger content
        </AppShell>
      </AppStateProvider>,
    )
    expect(shell()).toContain('data-vv-motion="on"')
    window.localStorage.setItem("vogel-vault.reduce-motion", "true")
    expect(shell()).toContain('data-vv-motion="off"')
    window.localStorage.clear()
  })
})

describe("hero numeral settle", () => {
  it("eases out without overshoot and lands exactly on the target", () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(0.5)).toBe(0.875)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(2)).toBe(1)
    expect(interpolateBigInt(0n, 1000n, 0.5)).toBe(875n)
    expect(interpolateBigInt(7_813_900n, 7_900_000n, 1)).toBe(7_900_000n)
    expect(interpolateBigInt(7_813_900n, 7_900_000n, 0)).toBe(7_813_900n)
    expect(interpolateBigInt(1000n, 0n, 0.5)).toBe(125n)
  })

  const mountedRoots = new Set<Root>()
  let systemReduced = false

  function Probe({ target }: { readonly target: bigint | null }) {
    const shown = useSettledNumber(target)
    const pulse = usePulseOnChange(target)
    return createElement(
      "output",
      { "data-pulsing": String(pulse.pulsing), onClick: pulse.endPulse },
      shown === null ? "null" : shown.toString(),
    )
  }

  async function mount(target: bigint | null) {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    mountedRoots.add(root)
    const render = async (next: bigint | null) => {
      await act(async () => {
        root.render(createElement(Probe, { target: next }))
      })
    }
    await render(target)
    const output = () => container.querySelector("output")!
    return { render, output }
  }

  beforeEach(() => {
    systemReduced = false
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date", "setTimeout"],
    })
    window.matchMedia = ((query: string) => ({
      matches: query.includes("reduce") && systemReduced,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
  })

  afterEach(async () => {
    for (const root of mountedRoots) {
      await act(async () => root.unmount())
    }
    mountedRoots.clear()
    document.body.replaceChildren()
    vi.useRealTimers()
  })

  it("prints the first reading cold, then counts onto a new one over 300ms", async () => {
    const probe = await mount(100_000n)
    expect(probe.output().textContent).toBe("100000")
    expect(probe.output().dataset.pulsing).toBe("false")

    await probe.render(200_000n)
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    const midway = BigInt(probe.output().textContent ?? "0")
    expect(midway).toBeGreaterThan(100_000n)
    expect(midway).toBeLessThan(200_000n)
    expect(probe.output().dataset.pulsing).toBe("true")

    await act(async () => {
      vi.advanceTimersByTime(SETTLE_MS)
    })
    expect(probe.output().textContent).toBe("200000")

    await act(async () => {
      probe.output().click()
    })
    expect(probe.output().dataset.pulsing).toBe("false")
  })

  it("lands at once and never pulses when the system asks for reduced motion", async () => {
    systemReduced = true
    const probe = await mount(100_000n)
    await probe.render(200_000n)
    expect(probe.output().textContent).toBe("200000")
    expect(probe.output().dataset.pulsing).toBe("false")
  })

  it("lands at once and never pulses when the app setting is on", async () => {
    window.localStorage.setItem("vogel-vault.reduce-motion", "true")
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    mountedRoots.add(root)
    const render = async (target: bigint) => {
      await act(async () => {
        root.render(createElement(AppStateProvider, {
          mutationAdapter: null,
          children: createElement(Probe, { target }),
        }))
      })
    }
    await render(100_000n)
    await render(200_000n)
    const output = container.querySelector("output")!
    expect(output.textContent).toBe("200000")
    expect(output.dataset.pulsing).toBe("false")
    window.localStorage.clear()
  })

  it("shows a reading that arrives from nothing without counting up from zero", async () => {
    const probe = await mount(null)
    expect(probe.output().textContent).toBe("null")
    await probe.render(7_813_900n)
    expect(probe.output().textContent).toBe("7813900")
    expect(probe.output().dataset.pulsing).toBe("false")
  })
})
