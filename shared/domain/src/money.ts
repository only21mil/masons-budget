// The Vogel Vault — decimal-safe money.
//
// Repo convention (AGENTS.md): "Money is Decimal, never Double." Swift gets that
// for free; JavaScript does not. MC2 JSON carries money as JSON numbers, so the
// only safe move is to parse the *lexical* form into integer minor units before
// any arithmetic happens, and never let a value transit through float math.
//
// USD is held as bigint cents, BTC as bigint sats. Both are exact.

export type Cents = bigint
export type Sats = bigint

export const SATS_PER_BTC = 100_000_000n

/**
 * Parse a decimal value into integer minor units without going through Number.
 *
 * Accepts a string, a number, or null/undefined. Numbers are stringified first —
 * for values MC2 actually emits (2-dp USD, 8-dp BTC) the shortest round-trip
 * representation is exact, so this is lossless in practice and never silently
 * accumulates float error the way `value * 100` does.
 */
export function parseMinorUnits(value: unknown, scale: number): bigint {
  if (value === null || value === undefined || value === "") return 0n

  const raw = typeof value === "number" ? numberToDecimalString(value) : String(value).trim()
  if (raw === "") return 0n

  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(raw)
  if (!match) throw new RangeError(`Not a decimal value: ${JSON.stringify(value)}`)

  const [, sign, whole = "", frac = ""] = match
  if (whole === "" && frac === "") throw new RangeError(`Not a decimal value: ${JSON.stringify(value)}`)

  // Pad or round the fraction to the target scale. Round half away from zero,
  // matching NSDecimalNumber's .plain rounding mode used on the Swift side.
  let digits = frac.padEnd(scale, "0")
  let result = BigInt((whole || "0") + digits.slice(0, scale))

  const remainder = digits.slice(scale)
  if (remainder !== "" && Number(remainder[0]) >= 5) result += 1n

  return sign === "-" ? -result : result
}

function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`)
  // Avoid exponential notation for the magnitudes MC2 uses.
  if (Math.abs(value) < 1e21) return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "")
  return String(value)
}

export function parseCents(value: unknown): Cents {
  return parseMinorUnits(value, 2)
}

/** BTC amounts carry 8 decimal places; the result is satoshis. */
export function parseBtcToSats(value: unknown): Sats {
  return parseMinorUnits(value, 8)
}

export function formatMinorUnits(amount: bigint, scale: number): string {
  const negative = amount < 0n
  const digits = (negative ? -amount : amount).toString().padStart(scale + 1, "0")
  const whole = digits.slice(0, digits.length - scale)
  const frac = scale > 0 ? `.${digits.slice(digits.length - scale)}` : ""
  return `${negative ? "-" : ""}${whole}${frac}`
}

/** "1234.5" cents=123450 → "$1,234.50". Grouping is applied to the whole part. */
export function formatUsd(cents: Cents, options: { showSign?: boolean } = {}): string {
  const negative = cents < 0n
  const plain = formatMinorUnits(negative ? -cents : cents, 2)
  // formatMinorUnits(_, 2) always yields "<whole>.<2 digits>", but the compiler
  // cannot know that, and defaulting is cheaper than asserting.
  const [whole = "0", frac = "00"] = plain.split(".")
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  const sign = negative ? "-" : options.showSign ? "+" : ""
  return `${sign}$${grouped}.${frac}`
}

/**
 * Sats rendered with space grouping, e.g. "1 234 567 sats".
 *
 * Deliberately an ASCII space, not U+202F. The repo QA guards scan static text
 * for non-ASCII glyphs, and a narrow no-break space also breaks copy-paste into
 * spreadsheets and the CSV export path.
 */
export function formatSats(sats: Sats): string {
  const negative = sats < 0n
  const grouped = (negative ? -sats : sats).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return `${negative ? "-" : ""}${grouped} sats`
}

/** Sats rendered as BTC with 8 dp, trailing zeros kept — ledger convention. */
export function formatBtc(sats: Sats): string {
  return `${formatMinorUnits(sats, 8)} BTC`
}

export function satsToUsdCents(sats: Sats, btcPriceCents: Cents): Cents {
  // (sats / 1e8) * price → integer math, rounded half away from zero.
  const numerator = sats * btcPriceCents
  const half = SATS_PER_BTC / 2n
  if (numerator >= 0n) return (numerator + half) / SATS_PER_BTC
  return -((-numerator + half) / SATS_PER_BTC)
}

export function sum(values: Iterable<bigint>): bigint {
  let total = 0n
  for (const value of values) total += value
  return total
}

/** Percentage of `part` against `whole`, in basis points, guarding divide-by-zero. */
export function basisPoints(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0
  return Number((part * 10_000n) / whole)
}
