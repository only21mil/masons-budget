// The Vogel Vault — decimal-safe money.
//
// Repo convention (AGENTS.md): "Money is Decimal, never Double." Swift gets that
// for free; JavaScript does not. Surviving legacy blobs carry money as JSON
// numbers, so the only safe move is to parse the *lexical* form into integer
// minor units before any arithmetic happens, and never let a value transit
// through float math.
//
// USD is held as bigint cents, BTC as bigint sats. Both are exact.

export type Cents = bigint
export type Sats = bigint

export const SATS_PER_BTC = 100_000_000n
export const PRICE_UNAVAILABLE = "Price unavailable"
const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER)

export const DISPLAY_UNITS = [
  { storageKey: "btc", label: "BTC" },
  { storageKey: "sats", label: "SATS" },
  { storageKey: "usd", label: "USD" },
] as const

export type DisplayUnit = (typeof DISPLAY_UNITS)[number]["storageKey"]
export type DisplaySurface = "bitcoin" | "net-worth" | "retirement" | "budget"

export function displayUnitFromStorageKey(value: unknown): DisplayUnit {
  return DISPLAY_UNITS.some((unit) => unit.storageKey === value)
    ? value as DisplayUnit
    : "btc"
}

/** Budget amounts are always USD, regardless of the persisted Bitcoin preference. */
export function displayUnitForSurface(
  surface: DisplaySurface,
  preferredUnit: DisplayUnit,
): DisplayUnit {
  return surface === "budget" ? "usd" : preferredUnit
}

/**
 * Parse a decimal value into integer minor units without going through Number.
 *
 * Accepts a string, a number, or null/undefined. JSON numbers are delegated to
 * jsonNumberToMinorUnits, which has stricter safety checks than lexical strings.
 */
export function parseMinorUnits(value: unknown, scale: number): bigint {
  if (value === null || value === undefined || value === "") return 0n
  if (typeof value === "number") return jsonNumberToMinorUnits(value, scale)

  assertScale(scale)

  const raw = String(value).trim()
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

function assertScale(scale: number): void {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 100) {
    throw new RangeError(`Minor-unit scale must be an integer from 0 through 100: ${scale}`)
  }
}

/**
 * Convert an already-parsed JSON number to integer minor units.
 *
 * `Number#toString()` is specified to return a shortest decimal representation
 * that round-trips to the same IEEE-754 double. We parse those decimal digits
 * directly with BigInt; the number is never multiplied by 10**scale.
 *
 * Decimal digits beyond `scale` round half away from zero. Non-finite inputs,
 * invalid scales, and results outside JavaScript's safe-integer magnitude are
 * refused with RangeError. The last rule prevents a source double from silently
 * choosing between minor-unit integers that it can no longer distinguish.
 */
export function jsonNumberToMinorUnits(value: number, scale: number): bigint {
  if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`)
  assertScale(scale)

  const shortestDecimal = value.toString()
  const match = /^(-)?(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(shortestDecimal)
  if (!match) {
    throw new RangeError(`Number has no decimal representation: ${shortestDecimal}`)
  }

  const [, sign, whole = "", fraction = "", exponentLexical = "0"] = match
  const coefficient = BigInt(`${whole}${fraction}`)
  const exponent = Number(exponentLexical)
  const minorUnitExponent = exponent - fraction.length + scale

  let magnitude: bigint
  if (minorUnitExponent >= 0) {
    magnitude = coefficient * 10n ** BigInt(minorUnitExponent)
  } else {
    const divisor = 10n ** BigInt(-minorUnitExponent)
    const quotient = coefficient / divisor
    const remainder = coefficient % divisor
    magnitude = quotient + (remainder * 2n >= divisor ? 1n : 0n)
  }

  if (magnitude > MAX_SAFE_MINOR_UNITS) {
    throw new RangeError(
      `Rounded minor units exceed Number.MAX_SAFE_INTEGER: ${shortestDecimal} at scale ${scale}`,
    )
  }

  return sign === "-" ? -magnitude : magnitude
}

export function jsonNumberToCents(value: number): Cents {
  return jsonNumberToMinorUnits(value, 2)
}

export function jsonNumberToSats(value: number): Sats {
  return jsonNumberToMinorUnits(value, 8)
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
  return divideRoundedHalfAwayFromZero(numerator, SATS_PER_BTC)
}

/** Convert exact USD cents to satoshis at a positive integer-cent BTC price. */
export function usdCentsToSats(cents: Cents, btcPriceCents: Cents): Sats {
  if (btcPriceCents <= 0n) {
    throw new RangeError(`BTC price must be positive integer cents: ${btcPriceCents}`)
  }
  return divideRoundedHalfAwayFromZero(cents * SATS_PER_BTC, btcPriceCents)
}

/**
 * Value an exact decimal share quantity without routing through IEEE-754.
 * The final cent rounds half away from zero, matching Swift Decimal.
 */
export function sharesToValueCents(
  sharesDecimal: string,
  pricePerShareCents: Cents,
): Cents {
  const raw = sharesDecimal.trim()
  const match = /^(-)?(\d+)(?:\.(\d*))?$/.exec(raw)
  if (!match) throw new RangeError(`Not a decimal share quantity: ${JSON.stringify(sharesDecimal)}`)

  const [, sign, whole = "", fraction = ""] = match
  const magnitude = BigInt(`${whole}${fraction}`)
  const signedMagnitude = sign === "-" ? -magnitude : magnitude
  return divideRoundedHalfAwayFromZero(
    signedMagnitude * pricePerShareCents,
    10n ** BigInt(fraction.length),
  )
}

/** Format exact satoshis using the persisted Apple/Android/Linux unit contract. */
export function formatBitcoin(
  sats: Sats,
  unit: DisplayUnit,
  btcPriceCents?: Cents | null,
): string {
  switch (unit) {
    case "btc":
      return formatBtc(sats)
    case "sats":
      return formatSats(sats)
    case "usd":
      return btcPriceCents !== null &&
        btcPriceCents !== undefined &&
        btcPriceCents > 0n
        ? formatUsd(satsToUsdCents(sats, btcPriceCents))
        : PRICE_UNAVAILABLE
  }
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

function divideRoundedHalfAwayFromZero(numerator: bigint, positiveDenominator: bigint): bigint {
  if (positiveDenominator <= 0n) {
    throw new RangeError(`Denominator must be positive: ${positiveDenominator}`)
  }
  const magnitude = numerator < 0n ? -numerator : numerator
  const rounded = (magnitude + positiveDenominator / 2n) / positiveDenominator
  return numerator < 0n ? -rounded : rounded
}
