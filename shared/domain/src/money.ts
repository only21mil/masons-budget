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
export const SHARES_DECIMAL_MAX_INTEGER_DIGITS = 12
export const SHARES_DECIMAL_MAX_SCALE = 12
export const SHARES_DECIMAL_MAX_PRECISION = 24
export const SHARES_DECIMAL_MAX_LENGTH = 25
/**
 * How long a share quantity may be *before* canonicalization.
 *
 * Quantization only ever removes fractional digits, so a stored value can be
 * longer than the canonical bound and still be legitimate — a lot written from
 * an IEEE-754 double arrives with 16 fractional digits. The slack is one extra
 * retained scale, far more fractional digits than a double can distinguish;
 * anything longer is corruption rather than float noise.
 */
export const SHARES_DECIMAL_MAX_RAW_LENGTH =
  SHARES_DECIMAL_MAX_LENGTH + SHARES_DECIMAL_MAX_SCALE
const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER)
/**
 * The sign group is always captured so the digit groups keep stable indices; a
 * leading minus is only *accepted* when the caller opts into signed quantities.
 * Exponents, whitespace, leading-zero ambiguity, and a bare "1." stay refused.
 */
const SHARES_DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/

/**
 * Holdings are position sizes and stay unsigned; lots are signed, because a
 * statement reconciliation lot removes shares and is stored as a negative
 * quantity. The flag is opt-in so the unsigned rule remains the default.
 */
export interface SharesDecimalOptions {
  readonly signed?: boolean
}

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

/** Budget amounts remain USD regardless of the persisted Bitcoin preference. */
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

/**
 * Convert USD cents to satoshis at an integer-cent BTC price.
 *
 * A missing or non-positive market price is not zero-valued evidence, so it is
 * rejected rather than converted to a confident zero.
 */
export function usdCentsToSats(cents: Cents, btcPriceCents: Cents): Sats {
  if (btcPriceCents <= 0n) {
    throw new RangeError(`BTC price must be positive integer cents: ${btcPriceCents}`)
  }
  return divideRoundedHalfAwayFromZero(cents * SATS_PER_BTC, btcPriceCents)
}

/**
 * Render a refused quantity for an error message without throwing on the way.
 *
 * `JSON.stringify` raises a TypeError on a bigint, which is exactly the input a
 * caller most easily reaches for when it means "an exact number" — and a
 * TypeError from the renderer replaces the RangeError this contract promises,
 * so the caller's own catch never sees the failure it was written for. Objects
 * collapse to their type rather than being serialized, since an unexpected
 * object here is as likely to be a whole financial record as a wrapper.
 */
function renderRejected(value: unknown): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value)
    case "bigint":
      return `${value}n`
    case "number":
    case "boolean":
    case "undefined":
      return String(value)
    default:
      return value === null ? "null" : typeof value
  }
}

/**
 * Assert an *already canonical* share quantity and hand it back unchanged.
 *
 * Canonical means: no exponent, no padding, no leading-zero ambiguity, no
 * trailing point, no minus zero, and every bound respected. Trailing fractional
 * zeroes are retained precision, not noise, so they survive. A value that only
 * needs quantizing is still refused here — canonicalizeSharesDecimal is the one
 * place allowed to change a quantity.
 */
export function assertSharesDecimal(
  value: unknown,
  options: SharesDecimalOptions = {},
): string {
  const signed = options.signed === true
  const maxLength = signed ? SHARES_DECIMAL_MAX_LENGTH + 1 : SHARES_DECIMAL_MAX_LENGTH
  if (typeof value !== "string" || value.length > maxLength) {
    throw new RangeError(`Not a canonical share quantity: ${renderRejected(value)}`)
  }
  const match = SHARES_DECIMAL_PATTERN.exec(value)
  if (!match) {
    throw new RangeError(`Not a canonical share quantity: ${renderRejected(value)}`)
  }
  const negative = match[1] === "-"
  const whole = match[2]!
  const fraction = match[3] ?? ""
  // An unsigned caller refuses the sign outright; a signed caller still refuses
  // minus zero, which has two spellings for one value and is therefore not
  // canonical.
  if (negative && (!signed || isZeroMagnitude(whole, fraction))) {
    throw new RangeError(`Not a canonical share quantity: ${renderRejected(value)}`)
  }
  if (
    whole.length > SHARES_DECIMAL_MAX_INTEGER_DIGITS ||
    fraction.length > SHARES_DECIMAL_MAX_SCALE ||
    whole.length + fraction.length > SHARES_DECIMAL_MAX_PRECISION
  ) {
    throw new RangeError(`Share quantity exceeds bounds: ${renderRejected(value)}`)
  }
  return value
}

/**
 * Repair a stored share quantity into the canonical form, or throw.
 *
 * Two legacy shapes reach us from blobs written before the contract tightened:
 * quantities carrying IEEE-754 noise (15-16 fractional digits where 12 are
 * retained) and negative reconciliation lots the unsigned pattern refused
 * outright. Both are real data, so they are canonicalized rather than rejected.
 *
 * The rules, in order:
 *   - an already-canonical in-bounds value is returned byte-identical, so
 *     retained trailing zeroes ("2.5000") survive untouched;
 *   - fractional digits past SHARES_DECIMAL_MAX_SCALE are quantized half away
 *     from zero using only lexical and BigInt arithmetic, never a JS number,
 *     and the carry is allowed to cross the decimal point;
 *   - zeroes *created by* that quantization are trimmed, since they are an
 *     artefact of rounding rather than source precision;
 *   - minus zero in any spelling normalizes to plain "0";
 *   - every bound is re-checked afterwards, so genuine corruption (13 integer
 *     digits, an exponent, padding) still throws.
 *
 * A bounds failure names the canonicalized text, which is what actually
 * violated the contract.
 */
export function canonicalizeSharesDecimal(
  value: unknown,
  options: SharesDecimalOptions = {},
): string {
  const signed = options.signed === true
  const maxRawLength = signed
    ? SHARES_DECIMAL_MAX_RAW_LENGTH + 1
    : SHARES_DECIMAL_MAX_RAW_LENGTH
  if (typeof value !== "string" || value.length > maxRawLength) {
    throw new RangeError(`Not a canonical share quantity: ${renderRejected(value)}`)
  }
  const match = SHARES_DECIMAL_PATTERN.exec(value)
  if (!match) {
    throw new RangeError(`Not a canonical share quantity: ${renderRejected(value)}`)
  }
  const negative = match[1] === "-"
  if (negative && !signed) {
    throw new RangeError(`Not a canonical share quantity: ${renderRejected(value)}`)
  }

  const sourceWhole = match[2]!
  const sourceFraction = match[3] ?? ""
  const { whole, fraction } =
    sourceFraction.length <= SHARES_DECIMAL_MAX_SCALE
      ? { whole: sourceWhole, fraction: sourceFraction }
      : quantizeSharesMagnitude(sourceWhole, sourceFraction)

  const magnitude = fraction === "" ? whole : `${whole}.${fraction}`
  // Minus zero has no canonical spelling of its own, so every form of it —
  // including "-0.000", where the retained precision goes with the sign —
  // collapses to plain "0".
  const canonical = negative
    ? isZeroMagnitude(whole, fraction)
      ? "0"
      : `-${magnitude}`
    : magnitude
  return assertSharesDecimal(canonical, options)
}

/**
 * Drop fractional digits past the retained scale, rounding half away from zero.
 *
 * Only the first dropped digit decides, which is exactly what parseMinorUnits
 * does: a remainder whose leading digit is >= 5 is >= half the divisor. Digit
 * characters compare lexically, so no Number is constructed anywhere.
 */
function quantizeSharesMagnitude(
  whole: string,
  fraction: string,
): { whole: string; fraction: string } {
  const kept = fraction.slice(0, SHARES_DECIMAL_MAX_SCALE)
  const dropped = fraction.slice(SHARES_DECIMAL_MAX_SCALE)
  const scaled = BigInt(`${whole}${kept}`) + (dropped[0]! >= "5" ? 1n : 0n)
  // padStart guarantees at least one integer digit once the scale is sliced off,
  // and the BigInt round-trip absorbs a carry into the integer part.
  const digits = scaled.toString().padStart(SHARES_DECIMAL_MAX_SCALE + 1, "0")
  const boundary = digits.length - SHARES_DECIMAL_MAX_SCALE
  return {
    whole: digits.slice(0, boundary),
    fraction: digits.slice(boundary).replace(/0+$/, ""),
  }
}

/** The pattern forbids leading zeroes, so "0" is the only zero whole part. */
function isZeroMagnitude(whole: string, fraction: string): boolean {
  return whole === "0" && !/[1-9]/.test(fraction)
}

/**
 * Value an exact decimal share quantity at an integer-cent per-share price.
 *
 * `sharesDecimal` is the Convex wire representation. Parsing it lexically keeps
 * fractional shares out of IEEE-754 arithmetic and rounds the final cent half
 * away from zero, matching Swift Decimal and Kotlin BigDecimal.
 *
 * Only holding quantities reach this today (valueFinanceHolding is the sole
 * caller), so the default stays unsigned and a negative holding still throws —
 * a position size below zero is corruption. Lot-level valuation must opt in
 * with `{ signed: true }`; the sign is split off before the digits are
 * concatenated, so the magnitude never absorbs the minus and the rounding stays
 * away from zero on both sides.
 */
export function sharesToValueCents(
  sharesDecimal: string,
  pricePerShareCents: Cents,
  options: SharesDecimalOptions = {},
): Cents {
  const raw = assertSharesDecimal(sharesDecimal, options)
  const negative = raw.startsWith("-")
  const [whole = "0", fraction = ""] = (negative ? raw.slice(1) : raw).split(".")
  const magnitude = BigInt(`${whole}${fraction}`)
  const cents = divideRoundedHalfAwayFromZero(
    magnitude * pricePerShareCents,
    10n ** BigInt(fraction.length),
  )
  return negative ? -cents : cents
}

/** Format exact satoshis using the shared Apple/Android/Linux unit contract. */
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
