import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const css = (name: string) => readFileSync(new URL(`../src/renderer/styles/${name}.css`, import.meta.url), "utf8")
const foundations = css("ledger-foundations")
const components = css("components")
const bridge = css("global")
function capture(value: string, pattern: RegExp, group = 1): string {
  const result = value.match(pattern)?.[group]
  if (result === undefined) throw new Error(`Missing CSS match ${pattern}`)
  return result
}
const light = capture(foundations, /\[data-vv-theme="light"\]\s*\{([^}]+)\}/)
const tokens = Object.fromEntries([...`${foundations.split('[data-vv-theme="light"]')[0]}${bridge}${light}`.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]))

function resolve(value: string): string {
  return value.replace(/var\((--[\w-]+)\)/g, (_, token: string) => {
    if (!tokens[token]) throw new Error(`Unknown token ${token}`)
    return resolve(tokens[token])
  })
}

// sRGB channels in [0, 1]; retain fractional channels through alpha composition.
type RGB = [number, number, number]
type RGBA = [number, number, number, number]
function color(value: string): RGBA {
  const resolved = resolve(value)
  if (/^#[\da-f]{6}$/i.test(resolved)) {
    const channel = (start: number) => parseInt(resolved.slice(start, start + 2), 16) / 255
    return [channel(1), channel(3), channel(5), 1]
  }
  if (resolved.startsWith("rgba(")) {
    const [r, g, b, alpha] = capture(resolved, /^rgba\(([^)]+)\)$/).split(",").map(Number)
    if (r === undefined || g === undefined || b === undefined || alpha === undefined) {
      throw new Error(`Incomplete color ${resolved}`)
    }
    return [r / 255, g / 255, b / 255, alpha]
  }
  if (resolved.startsWith("oklch(")) {
    const [lightness, chroma, degrees] = capture(resolved, /^oklch\(([^)]+)\)$/).split(/\s+/).map(Number)
    if (lightness === undefined || chroma === undefined || degrees === undefined) {
      throw new Error(`Incomplete color ${resolved}`)
    }
    const a = chroma * Math.cos(degrees * Math.PI / 180)
    const b = chroma * Math.sin(degrees * Math.PI / 180)
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
    const linear: RGB = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ]
    // Daylight semantic inks stay in gamut, avoiding platform gamut-mapping differences.
    for (const channel of linear) {
      if (channel < 0 || channel > 1) throw new Error(`Out-of-gamut text ink ${resolved}`)
    }
    const encode = (channel: number) => channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055
    return [encode(linear[0]), encode(linear[1]), encode(linear[2]), 1]
  }
  throw new Error(`Unsupported color ${resolved}`)
}

function composite(fill: RGBA, panel: RGB | RGBA): RGB {
  const channel = (i: 0 | 1 | 2) => fill[i] * fill[3] + panel[i] * (1 - fill[3])
  return [channel(0), channel(1), channel(2)]
}

function contrast(foreground: RGB | RGBA, background: RGB | RGBA): number {
  const linear = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  const luminance = ([r, g, b]: RGB | RGBA) => linear(r) * 0.2126 + linear(g) * 0.7152 + linear(b) * 0.0722
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
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
    const base = capture(components, new RegExp(`\\.vv-badge--${tone}\\s*\\{([^}]+)\\}`))
    const fillValue = resolve(capture(base, /background:\s*([^;]+);/))
    const mix = fillValue.match(/^color-mix\(in srgb, .+ ([\d.]+)%, transparent\)$/)
    // Black is the darkest possible displayed fill. This lower bound covers
    // gain/loss gamut mapping as well as their actual tinted backgrounds.
    const alpha = mix ? Number(mix[1]) / 100 : color(fillValue)[3]
    const fill: RGBA = [0, 0, 0, alpha]
    const override = capture(components, /\[data-vv-theme="light"\] \.vv-badge--warning,[^{]+\{([^}]+)\}/, 0)
    expect(override).not.toBeNull()
    for (const item of tones) expect(override).toContain(`[data-vv-theme="light"] .vv-badge--${item}`)
    const foreground = color(capture(override, /color:\s*([^;]+);/))
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


describe("Daylight small text on ledger surfaces", () => {
  it.each(["ink", "ink-secondary", "ink-meta", "bitcoin", "gain", "loss"])(
    "keeps %s at 4.5:1 on opaque and selected surfaces",
    (role) => {
      const foreground = color(`var(--vv-ledger-${role})`)
      for (const panel of panels) {
        const background = color(`var(--vv-ledger-${panel})`)
        for (const selected of [false, true]) {
          const fill = selected ? composite(color("var(--vv-ledger-bitcoin-soft)"), background) : background
          expect(contrast(foreground, fill), `${role} on ${panel}, selected=${selected}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    },
  )
})
