# Vogel Vault design foundations

This is the canonical cross-client reference for the redesign tracked by
[issue #246](https://github.com/only21mil/masons-budget/issues/246). It fixes
the accepted visual tokens and Horizon app mark in one place.
Platform teams must translate these values into native resources. They must not
copy prototype runtime, screen code, state, data, or behavior.

`Design/icons.jsx` remains the icon geometry authority. The SVG files under
`Design/assets/` are platform-neutral templates made from the same paths.
`Design/assets.sha256` pins every shared asset and font file in this reference.

## Status

| Item | Status | Rule |
| --- | --- | --- |
| Terminal Ledger dark treatment | Accepted | Primary dark treatment. |
| Daylight Ledger light treatment | Accepted | Light changes density and rule style as well as color. |
| Source Code Pro | Accepted | Use weights 300 through 700. Bundle locally. |
| Horizon app icon and icon-weight Bitcoin mark | Accepted | Use the exact geometry below. |
| `BtcGlyph` interface variant | Accepted, unchanged | It remains the default variant in `Design/icons.jsx`. |
| `CatGlyph` `car` | Proposed | Exact handoff path, not approved for a shipping screen. Review at 15px first. |
| `CatGlyph` `pet` | Proposed | Exact handoff path, not approved for a shipping screen. Review at 15px first. |

Adding a proposed glyph to a platform asset catalog does not accept it. A
platform change must preserve the status label until design review accepts the
glyph.

2026-09-05: the `fg2` and `fg3` tiers became opaque after the Fold readability
audit, chosen to clear 6:1 on the opaque fills because a 20 percent
rasterisation loss on a 6:1 nominal still leaves about 5:1 at the stroke body.
The same change split `btc` into text and fill tokens, raised the type floor to
11px, and made scanlines default off.

## Brand identity

The app name is `Sovereign Budget App`. The launcher label is the single word
`Sovereign` on both the Android application and launcher activity. Keep the full
name for store copy, splash, and settings.

The wordmark never appears inside the icon tile. Set `SOVEREIGN` in Source Code
Pro 600 with `0.055em` tracking. Set `BUDGET APP` below it in Source Code Pro
400 with `0.3em` tracking. Both lines are uppercase. Use the horizontal lockup
with a 40-unit icon for settings and the stacked lockup with an 80-unit icon for
the splash treatment.

## Handoff provenance

The authoritative archive is outside this repository:

```text
/home/victor/work/bitcoin-budget-redesign-intake/Bitcoin app redesign.zip
SHA-256 b3ed6b9bc452bee62fa48e92e14ab0bf4bfa85a88fca036697dc14c41710ec30
```

The inspected extraction was
`/home/victor/work/bitcoin-budget-redesign-intake/extracted/design_handoff_vogel_vault_redesign/`.
These hashes tie this reference to the archive contents:

| Handoff file | SHA-256 | Role |
| --- | --- | --- |
| `README.md` | `81d10cd1184c3822d5a21cb8f3b2b8a785ec98562a6afbeb4a9efa1979cd0230` | Written decision record and exact tokens. |
| `Bitcoin Budget Redesign.dc.html` | `c2b97d14fbd2c97ce15c778d268ccba3eff5777a232abc91fabe2439cc818309` | Options and accepted app-icon geometry. |
| `Bitcoin Budget App.dc.html` | `d334647c90262faba76fd2ba9de608c386eca07be55d95ce1f178c28c8c9d08d` | Working visual prototype and proposed category paths. |
| `icons.jsx` | `ec9b8100f0b2c3713df26e5480c04014d1456641c51b684fc13d36b9b7105a5d` | Convenience copy of the pre-foundation repo authority. |
| `support.js` | `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` | Prototype runtime only. |

The source mapping is exact:

| Foundation item | Handoff file | Turn and id |
| --- | --- | --- |
| Horizon shipping set | `Bitcoin Budget Redesign.dc.html` | Turn `t6`, ids `6a`, `6b`, `6c`, and `6d`. It locks `5a`, built from `4c`. |
| Horizon lockup | `Bitcoin Budget Redesign.dc.html` | Turn `t5`, id `5a`. |
| Horizon original | `Bitcoin Budget Redesign.dc.html` | Turn `t4`, id `4c`. |
| Dark and light treatments | `Bitcoin Budget Redesign.dc.html` | Turn `t1`, ids `1a` and `1c`. |
| Earlier category comparison | `Bitcoin Budget Redesign.dc.html` | Turn `t2`, id `2b`. That option used substitutes and requested real car and pet glyphs. |
| Proposed car | `Bitcoin Budget App.dc.html` | No turn or option id. In the `data-dc-script`, key `CAT_ICON['Auto & Transport']`. |
| Proposed pet/paw | `Bitcoin Budget App.dc.html` | No turn or option id. In the `data-dc-script`, key `CAT_ICON['Pets']`. |

The HTML files and `support.js` are inert evidence. Do not execute them, open
them in a browser, import them, or carry their runtime into production.
`support.js` contains a design-document evaluator and network loading paths.
None of that is an application dependency. The prototype's Google Fonts link,
floating-point examples, hard-coded data, navigation, state, and edit flows are
also non-production.

## Color

Bitcoin orange stays `#F7931A` for filled controls in both treatments; the ink
on a fill is always `#050505`. The light theme uses `#9E5104` for orange text
and line art, the lightest orange of that hue that clears 4.5:1 on `panel`.
`fg2` and `fg3` are opaque. The dark treatment uses Sats black with warm grey
ink tiers, approved on 2026-09-05. The accepted dark tertiary measures 5.83:1
on the raised panel, so its contrast floor is 5.8:1. Secondary ink still clears
6:1. Light ink tiers retain their existing values.

| Token | Dark | Light |
| --- | --- | --- |
| `bg` | `#050505` | `#F4F3EE` |
| `panel` | `#0E0E0E` | `#EDEBE4` |
| `panel2` | `#161616` | `#FFFFFF` |
| `line` | `rgba(245,242,234,0.10)` | `rgba(20,23,21,0.14)` |
| `line2` | `rgba(245,242,234,0.06)` | `rgba(20,23,21,0.08)` |
| `fg` | `#F5F2EA` | `#141715` |
| `fg2` | `#ABA8A1` | `#505452` |
| `fg3` | `#95928C` | `#5C605D` |
| `btc` (text and icons) | `#F7931A` | `#9E5104` |
| `btcFill` (filled controls, ink `#050505`) | `#F7931A` | `#F7931A` |
| `btcSoft` | `rgba(247,147,26,0.12)` | `rgba(158,81,4,0.10)` |
| `btcDecimals` (price hero decimals) | `rgba(247,147,26,0.75)` | `#9E5104` |
| `gain` | `oklch(0.74 0.155 158)` | `oklch(0.52 0.13 158)` |
| `loss` | `oklch(0.70 0.155 28)` | `oklch(0.52 0.15 28)` |
| `scan` | `rgba(255,255,255,0.022)` | `rgba(0,0,0,0.012)` |
| `knob` | `#F5F2EA` | `#FFFFFF` |

Do not use the options document's `#14100A` chrome as brand ink. Wordmarks use
`#F5F2EA` on dark, `#141715` on light, and the matching `btc` token for
`BUDGET APP`.

## Typography

Use Source Code Pro throughout. Use tabular figures on every monetary value and
count, even though the chosen face is monospaced.

| Role | Size, weight, tracking |
| --- | --- |
| Screen title | 26px, 600, -0.02em |
| Drilldown title | 24px, 600, -0.02em, line-height 1.15 |
| Screen subtitle | 11px, 500, 0.10em, uppercase |
| Hero numeral | 27 to 28px, 500 to 600, -0.02em to -0.03em |
| Price hero | 38px, 600, -0.03em; decimals 20px in `btcDecimals` |
| KPI label | 11px, 500, 0.10em, uppercase |
| KPI value | 19 to 20px, 500 |
| KPI sub | 11px, 500, 0.04em, uppercase |
| Section label | 11px, 600, 0.10em, uppercase |
| List primary | 12.5px, 400 |
| List meta | 11px, 500, 0.03em, uppercase |
| List figure | 12.5px, 500 |
| Chip | 11px, 600, 0.06em, uppercase |
| Tab label | 11px, 600, 0.06em, uppercase |
| Tab glyph | 17px, 400 |
| Body and assumptions | 12px, 400, line-height 18px |
| Button | 11px, 600, 0.10em, uppercase |
| Amount input | 26 to 28px, 500 |
| Text input | 14 to 15px, 400 |

The minimum type size is 11px. Metadata that carries a fact (dates,
categories, sources, hints) is at least weight 500 when set in `fg2` or `fg3`;
uppercase tracking stays at or under 0.10em so the wider labels keep the width
the old 0.18em labels had. The PLANNED and ACTUAL label pairs keep nowrap.

## Density, shape, and texture

| Foundation | Dark | Light |
| --- | --- | --- |
| Rule style | Solid | Dashed |
| Screen gutter | 20px | 22px |
| List-row vertical padding | 12px | 15px |
| Screen title | 26px | 29px |
| List primary | 12.5px | 13.5px |
| List meta | 11px | 11px |

- Card interior padding is 15 to 17px.
- A section starts 20 to 22px after the preceding content. Its label has 9px
  below it before the rule.
- Sibling chips have a 6px gap. Action buttons have a 7px gap.
- Chips, buttons, and inputs use a 3px radius. Cards use 4px. Toggle tracks use
  12px. Status dots are circular.
- Every tappable row is at least 44px tall. Standard steppers are 30 by 28px,
  category-editor steppers are 34 by 34px, and toggles are 42 by 24px.
- Folded test sizes are 411 by 891dp for the Pixel Fold cover and 345 by
  870dp for a narrow Galaxy Z Fold cover. The Galaxy size is an inferred test
  fixture, pending physical-device measurement and verification. Unfolded layout
  targets about 876 by 800dp with a 130dp rail and a 296dp secondary column
  where specified.
- The scanline is `repeating-linear-gradient(180deg, scan 0 1px, transparent 1px 3px)`.
  It never intercepts input or enters the accessibility tree.
- Scanlines and phosphor glow are separate settings. Scanlines default off
  since 2026-09-05; the texture is a preference, not a base layer. Phosphor
  glow defaults on. Reduce-motion or reduce-transparency settings force both
  effects off.

Transitions are 160ms for chips and navigation, 180ms for controls, 200ms for
the toggle knob, and 300ms for progress width and theme changes. The only
keyframe is the 1.1s step-end onboarding cursor blink.

## Accepted Horizon geometry

All geometry uses a 24 by 24 viewBox.

```text
body      M9.4 6h4.2c1.7 0 3 1.1 3 2.7 0 1.4-1 2.4-2.4 2.7 1.7.2 2.9 1.3 2.9 2.9 0 1.7-1.4 2.9-3.3 2.9H9.4V6z
crossbar  M9.4 11.4h4.6
serifs    M11 3.2v2.8M11 19.4v2.8M13.6 3.2v2.8M13.6 19.4v2.8
transform translate(12 9.4) scale(0.435) translate(-13 -12.7)
stroke    2.5, round caps, round joins
```

The three rules use `#F7931A` and fill the full canvas width:

```text
x=0 y=15.1  width=24 height=1.6  opacity=0.50
x=0 y=17.6  width=24 height=1.25 opacity=0.30
x=0 y=19.75 width=24 height=0.95 opacity=0.17
```

The mark fits the Android 66dp safe circle, exactly radius 7.333 in the 24-unit
viewBox at scale 0.435 with caps and half-stroke included. Meaningful mark
geometry stays inside the 72dp visible viewport, radius 8. The three rules are
the exception. They terminate at the canvas edge so launcher masks crop them
into different horizon chords. Never inset them.

The launcher artwork remains unchanged. Android uses a flat `#0A0D0C`
background layer, the foreground template, and a monochrome layer with the rule opacity ramp removed. iOS and macOS use an
opaque 1024 by 1024 source with no pre-rounded corners or alpha channel. The
system applies the mask. Do not shrink the color artwork for notification use;
use the flat monochrome geometry.

`BtcGlyph` now exposes `variant="app-icon"` for the heavier mark. The default
interface variant retains its 1.6 stroke and original serif geometry. The
accepted `HorizonGlyph` composes the app-icon paths and edge-to-edge rules.

## Proposed category geometry

Both glyphs use a 24 by 24 viewBox, no fill, 1.6 stroke, round caps, and round
joins. These paths are proven against the handoff but remain unreviewed visual
proposals.

```text
car path 1  M3 13.5 5 8h14l2 5.5v3.5h-2.6M3 13.5V17h2.6m0 0h11.8M5 13.5h14
car path 2  M5.6 17a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0M15 17a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0
pet path 1  M5.4 9.6a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M10.4 7.6a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M15.4 9.6a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0
pet path 2  M8.2 15.4c0-2.1 1.7-3.4 3.8-3.4s3.8 1.3 3.8 3.4c0 2.3-1.7 3.5-3.8 3.5s-3.8-1.2-3.8-3.5z
```

If visual review rejects either proposal, remove that mapping. Do not replace
it with an invented glyph or generic fallback. User-created categories without
an accepted mapping have no icon.

## Font source and license

The repository vendors unmodified upright TTF files for weights 300, 400, 500,
600, and 700 under `Design/fonts/source-code-pro/`. Platform packaging should
copy these pinned files into the app bundle. It must not fetch Google Fonts or
another font service at runtime.

| Field | Value |
| --- | --- |
| Upstream | `adobe-fonts/source-code-pro` |
| Release tag | `2.042R-u/1.062R-i/1.026R-vf` |
| Upright version | `2.042` |
| Release commit | `d3f1a5962cde503f9409c21e58527611d4a19ef1` |
| Published | 2023-04-12 |
| Official archive | `TTF-source-code-pro-2.042R-u_1.062R-i.zip` |
| Archive SHA-256 | `0c85bac90d15c040b82939aa92bc8404420fccc02e37bbcb9c93a7f21abb52c6` |
| License | SIL Open Font License 1.1, Reserved Font Name `Source` |
| License file | `Design/fonts/source-code-pro/LICENSE.md` |

Official release URL:
`https://github.com/adobe-fonts/source-code-pro/releases/tag/2.042R-u%2F1.062R-i%2F1.026R-vf`.

## Asset integrity

Run this from the repository root before adopting or changing an asset:

```bash
sha256sum --check Design/assets.sha256
```

The manifest pins the accepted templates, proposed templates, authoritative
icon source, five font files, and the font license. A status change for a
proposed glyph must update this document, the source, its SVG, and the checksum
manifest in one commit.
