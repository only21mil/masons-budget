import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const css = (name: string) => readFileSync(new URL(`../src/renderer/styles/${name}.css`, import.meta.url), "utf8")
const foundations = css("ledger-foundations")
const components = css("components")
const bridge = css("global")
const light = foundations.split('[data-vv-theme="light"]')[1].split("}")[0]
const tokens = Object.fromEntries([...`${foundations.split('[data-vv-theme="light"]')[0]}${bridge}${light}`.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]))

function resolve(value: string): string {
  return value.replace(/var\((--[\w-]+)\)/g, (_, token: string) => {
    if (!tokens[token]) throw new Error(`Unknown token ${token}`)
    return resolve(tokens[token])
  })
}

// sRGB channels in [0, 1]; retain fractional channels through alpha composition.
function color(value: string): number[] {
  const resolved = resolve(value)
  if (/^#[\da-f]{6}$/i.test(resolved)) {
    return [1, 3, 5].map((start) => parseInt(resolved.slice(start, start + 2), 16) / 255).concat(1)
  }
  const rgba = resolved.match(/^rgba\(([^)]+)\)$/)
  if (rgba) {
    const [r, g, b, alpha] = rgba[1].split(",").map(Number)
    return [r / 255, g / 255, b / 255, alpha]
  }
  throw new Error(`Unsupported color ${resolved}`)
}

function composite(fill: number[], panel: number[]): number[] {
  return panel.slice(0, 3).map((channel, i) => fill[i] * fill[3] + channel * (1 - fill[3]))
}

function contrast(foreground: number[], background: number[]): number {
  const luminance = (rgb: number[]) => rgb.slice(0, 3).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
  const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
  return (values[1] + 0.05) / (values[0] + 0.05)
}

const tones = ["warning", "positive", "negative"] as const
const panels = ["bg", "panel", "panel-raised"] as const

describe("Daylight badge text contrast", () => {
  it("checks alpha composition and contrast against reference pairs", () => {
    expect(contrast(color("#000000"), color("#ffffff"))).toBe(21)
    expect(composite(color("rgba(0, 0, 0, 0.1)"), color("#ffffff"))).toEqual([0.9, 0.9, 0.9])
    expect(contrast(color("#9e5104"), composite(color("rgba(158, 81, 4, 0.1)"), color("#edebe4")))).toBeCloseTo(4.2443, 4)
  })

  it.each(tones)("keeps %s badge text above 4.5:1 on each supported surface", (tone) => {
    const base = components.match(new RegExp(`\\.vv-badge--${tone}\\s*\\{([^}]+)\\}`))![1]
    const fillValue = resolve(base.match(/background:\s*([^;]+);/)![1])
    const mix = fillValue.match(/^color-mix\(in srgb, .+ ([\d.]+)%, transparent\)$/)
    // Black is the darkest possible displayed fill. This lower bound covers
    // gain/loss gamut mapping as well as their actual tinted backgrounds.
    const alpha = mix ? Number(mix[1]) / 100 : color(fillValue)[3]
    const fill = [0, 0, 0, alpha]
    const override = components.match(/\[data-vv-theme="light"\] \.vv-badge--warning,[^{]+\{([^}]+)\}/)!
    expect(override).not.toBeNull()
    for (const item of tones) expect(override[0]).toContain(`[data-vv-theme="light"] .vv-badge--${item}`)
    const foreground = color(override[1].match(/color:\s*([^;]+);/)![1])
    for (const panel of panels) {
      const background = color(`var(--vv-ledger-${panel})`)
      // Include selected/hovered surfaces with the existing Bitcoin soft overlay.
      for (const selected of [false, true]) {
        const surface = selected ? composite(color("var(--vv-ledger-bitcoin-soft)"), background) : background
        const ratio = contrast(foreground, composite(fill, surface))
        expect(ratio, `${tone} on ${panel}, selected=${selected}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
