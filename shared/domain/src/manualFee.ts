/** Exact optional manual River fee in USD cents. */

const INT64_MAX = (1n << 63n) - 1n

/**
 * Parse a manually entered fee without deriving it from any other amount.
 * Missing and null mean an explicit zero fee.
 */
export function parseManualFeeUsdCents(value: unknown): bigint {
  if (value === undefined || value === null) return 0n

  let parsed: bigint
  if (typeof value === "bigint") {
    parsed = value
  } else if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    parsed = BigInt(value)
  } else {
    throw new RangeError("feeUsdCents must be an exact non-negative integer string or bigint")
  }

  if (parsed < 0n) throw new RangeError("feeUsdCents must not be negative")
  if (parsed > INT64_MAX) throw new RangeError("feeUsdCents must fit signed int64")
  return parsed
}
