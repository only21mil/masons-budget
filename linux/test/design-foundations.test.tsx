import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import {
  CarGlyph,
  HorizonMark,
  LedgerScanlines,
  LedgerSemanticValue,
  PawGlyph,
} from "../src/renderer/components/LedgerFoundations.tsx"

const here = dirname(fileURLToPath(import.meta.url))
const renderer = join(here, "..", "src", "renderer")
const foundations = readFileSync(join(renderer, "styles", "ledger-foundations.css"), "utf8")
const globalStyles = readFileSync(join(renderer, "styles", "global.css"), "utf8")
const fontPath = join(
  renderer,
  "assets",
  "fonts",
  "source-code-pro",
  "SourceCodePro[wght].ttf",
)

describe("ledger design foundations", () => {
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
      "--vv-ledger-meta-text-size: 9.5px",
      "--vv-ledger-bg: #f4f3ee",
      "--vv-ledger-panel: #edebe4",
      "--vv-ledger-panel-raised: #ffffff",
      "--vv-ledger-bitcoin: #c96a05",
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
})
