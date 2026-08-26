import type { MarketQuote } from "@vogel-vault/domain/finance"
import {
  SATS_PER_BTC,
  formatBtc,
  formatSats,
  formatUsd,
  satsToUsdCents,
  usdCentsToSats,
} from "@vogel-vault/domain/money"
import { type CSSProperties, useState } from "react"

import type { DisplayUnit } from "../../../data/bitcoinDisplay.ts"

import "./price.css"

export interface PriceHistoryPoint {
  readonly date: string
  readonly priceCents: bigint
}

export interface PricePageProps {
  readonly quote: MarketQuote | null
  readonly change24hBasisPoints: bigint | null
  readonly history: readonly PriceHistoryPoint[]
  readonly displayUnit: DisplayUnit
  readonly initialConversion?: string
  readonly onBack?: () => void
}

interface ConversionValues {
  readonly btc: string
  readonly sats: string
  readonly usd: string
}

const EMPTY_CONVERSION: ConversionValues = {
  btc: "—",
  sats: "—",
  usd: "—",
}

const UNIT_MARKS: Readonly<Record<DisplayUnit, string>> = {
  btc: "₿",
  sats: "sat",
  usd: "$",
}

const DEFAULT_CONVERSION: Readonly<Record<DisplayUnit, string>> = {
  btc: "1.00000000",
  sats: "100000000",
  usd: "100.00",
}

function operationalPrice(quote: MarketQuote | null): bigint | null {
  if (
    quote?.symbol !== "BTC" ||
    (quote.status !== "live" && quote.status !== "stale") ||
    quote.priceCents === null ||
    quote.priceCents <= 0n
  ) {
    return null
  }
  return quote.priceCents
}

function parseFixedPoint(value: string, scale: number): bigint | null {
  const match = new RegExp(`^(\\d+)(?:\\.(\\d{0,${scale}}))?$`).exec(value.trim())
  if (!match) return null

  const whole = match[1]
  if (whole === undefined) return null
  const fraction = (match[2] ?? "").padEnd(scale, "0")
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction || "0")
}

function conversionSats(value: string, unit: DisplayUnit, priceCents: bigint): bigint | null {
  switch (unit) {
    case "btc":
      return parseFixedPoint(value, 8)
    case "sats":
      return parseFixedPoint(value, 0)
    case "usd": {
      const cents = parseFixedPoint(value, 2)
      return cents === null ? null : usdCentsToSats(cents, priceCents)
    }
  }
}

function conversionValues(
  value: string,
  unit: DisplayUnit,
  priceCents: bigint | null,
): ConversionValues {
  if (priceCents === null) return EMPTY_CONVERSION
  const sats = conversionSats(value, unit, priceCents)
  if (sats === null) return EMPTY_CONVERSION

  return {
    btc: formatBtc(sats).replace(/ BTC$/, ""),
    sats: formatSats(sats).replace(/ sats$/, ""),
    usd: formatUsd(satsToUsdCents(sats, priceCents)),
  }
}

function usdPriceParts(priceCents: bigint): { readonly whole: string; readonly decimals: string } {
  const dollars = priceCents / 100n
  return {
    whole: new Intl.NumberFormat("en-US").format(dollars),
    decimals: `.${(priceCents % 100n).toString().padStart(2, "0")}`,
  }
}

function basisPointDelta(value: bigint | null): { readonly text: string; readonly tone: string } {
  if (value === null) return { text: "— 24H", tone: "neutral" }
  const absolute = value < 0n ? -value : value
  const percent = `${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}%`
  if (value < 0n) return { text: `▼ ${percent} 24H`, tone: "negative" }
  return { text: `▲ ${percent} 24H`, tone: "positive" }
}

function utcTime(instant: string | null): string | null {
  if (instant === null) return null
  const parsed = new Date(instant)
  if (!Number.isFinite(parsed.getTime())) return null
  return parsed.toISOString().slice(11, 19) + "Z"
}

function shortDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime())) return date.toUpperCase()
  const day = parsed.getUTCDate().toString().padStart(2, "0")
  const month = new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: "UTC",
  }).format(parsed).toUpperCase()
  return `${day} ${month}`
}

function historyBounds(history: readonly PriceHistoryPoint[]): {
  readonly high: bigint
  readonly low: bigint
} | null {
  const first = history[0]
  if (first === undefined) return null
  let high = first.priceCents
  let low = first.priceCents
  for (const point of history.slice(1)) {
    if (point.priceCents > high) high = point.priceCents
    if (point.priceCents < low) low = point.priceCents
  }
  return { high, low }
}

function wholeUsd(priceCents: bigint): string {
  return new Intl.NumberFormat("en-US").format(priceCents / 100n)
}

function Sparkline({ history }: { readonly history: readonly PriceHistoryPoint[] }) {
  const bounds = historyBounds(history)
  const range = bounds === null ? 0n : bounds.high - bounds.low
  const middle = history[Math.floor((history.length - 1) / 2)]

  return (
    <section className="vv-price-chart" aria-labelledby="vv-price-chart-title">
      <div className="vv-price-chart__heading">
        <h2 id="vv-price-chart-title">30 DAY</h2>
        <span>
          {bounds === null
            ? "H — · L —"
            : `H ${wholeUsd(bounds.high)} · L ${wholeUsd(bounds.low)}`}
        </span>
      </div>
      <div
        className="vv-price-sparkline"
        role="img"
        aria-label={`${history.length} bar BTC price sparkline`}
      >
        {history.map((point, index) => {
          const scaled = range === 0n
            ? 100n
            : 30n + ((point.priceCents - (bounds?.low ?? 0n)) * 70n) / range
          const style = { "--vv-price-bar-height": `${scaled}%` } as CSSProperties
          return (
            <span
              key={`${point.date}-${index}`}
              className={index === history.length - 1
                ? "vv-price-sparkline__bar vv-price-sparkline__bar--current"
                : "vv-price-sparkline__bar"}
              data-price-bar=""
              style={style}
            />
          )
        })}
      </div>
      <div className="vv-price-chart__ticks" aria-hidden="true">
        <span>{history[0] === undefined ? "—" : shortDate(history[0].date)}</span>
        <span>{middle === undefined ? "—" : shortDate(middle.date)}</span>
        <span>{history.at(-1) === undefined ? "—" : shortDate(history.at(-1)!.date)}</span>
      </div>
    </section>
  )
}

function Converter({
  displayUnit,
  initialConversion,
  priceCents,
}: {
  readonly displayUnit: DisplayUnit
  readonly initialConversion: string
  readonly priceCents: bigint | null
}) {
  const [input, setInput] = useState(initialConversion)
  const converted = conversionValues(input, displayUnit, priceCents)
  const outputUnits = (["usd", "btc", "sats"] as const).filter((unit) => unit !== displayUnit)

  return (
    <section className="vv-price-convert" aria-labelledby="vv-price-convert-title">
      <h2 id="vv-price-convert-title">CONVERT</h2>
      <label className="vv-price-convert__label" htmlFor="vv-price-convert-input">
        AMOUNT · {displayUnit.toUpperCase()}
      </label>
      <div className="vv-price-convert__input-row" data-input-unit={displayUnit}>
        <span aria-hidden="true">{UNIT_MARKS[displayUnit]}</span>
        <input
          id="vv-price-convert-input"
          inputMode={displayUnit === "sats" ? "numeric" : "decimal"}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          aria-describedby="vv-price-convert-note"
        />
      </div>
      <p id="vv-price-convert-note" className="vv-price-convert__note">
        Uses the operational BTC quote shown above.
      </p>
      <div className="vv-price-convert__outputs">
        {outputUnits.map((unit) => (
          <div key={unit} className={unit === "sats" ? "vv-price-convert__output--sats" : undefined}>
            <span>{unit.toUpperCase()}</span>
            <strong>{converted[unit]}</strong>
          </div>
        ))}
      </div>
    </section>
  )
}

export function PricePage({
  quote,
  change24hBasisPoints,
  history,
  displayUnit,
  initialConversion,
  onBack,
}: PricePageProps) {
  const priceCents = operationalPrice(quote)
  const price = priceCents === null ? null : usdPriceParts(priceCents)
  const delta = basisPointDelta(change24hBasisPoints)
  const fetched = utcTime(quote?.fetchedAt ?? null)

  return (
    <article className="vv-price-page">
      <header className="vv-price-hero">
        <button type="button" className="vv-price-back" onClick={onBack}>
          ‹ BITCOIN
        </button>
        <p className="vv-price-kicker">BTC / USD · VOGEL VAULT</p>
        <h1 className={price === null ? "vv-price-hero__value vv-price-hero__value--unavailable" : "vv-price-hero__value"}>
          {price === null ? "PRICE UNAVAILABLE" : (
            <>
              <span className="vv-sr-only">$</span>{price.whole}
              <span className="vv-price-hero__decimals">{price.decimals}</span>
            </>
          )}
        </h1>
        <div className="vv-price-hero__meta">
          <span className={`vv-price-delta vv-price-delta--${delta.tone}`}>{delta.text}</span>
          <span>1 BTC = {new Intl.NumberFormat("en-US").format(SATS_PER_BTC)} SATS</span>
        </div>
      </header>

      <Sparkline history={history} />
      <Converter
        key={displayUnit}
        displayUnit={displayUnit}
        initialConversion={initialConversion ?? DEFAULT_CONVERSION[displayUnit]}
        priceCents={priceCents}
      />

      <footer className="vv-price-footer">
        {fetched === null
          ? "OPERATIONAL QUOTE · UNAVAILABLE"
          : `OPERATIONAL QUOTE · FETCHED ${fetched} · ${quote?.source.toUpperCase() ?? "UNKNOWN"}`}
      </footer>
    </article>
  )
}
