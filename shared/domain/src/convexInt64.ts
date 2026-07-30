// With format: "convex_encoded_json", Convex serializes v.int64() values as an
// eight-byte signed little-endian integer wrapped in a tagged object. Keep this
// decoder strict: accepting alternate shapes or Base64 spellings makes malformed
// wire data look authoritative at the shared domain boundary.

export interface ConvexInt64WireValue {
  $integer: string
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const INT64_BYTE_LENGTH = 8
const SIGN_BIT = 0x80
const UINT64_MODULUS = 1n << 64n
const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n

export function isConvexInt64(value: bigint): boolean {
  return value >= INT64_MIN && value <= INT64_MAX
}

/** Encode a signed bigint as Convex's canonical convex_encoded_json v.int64() value. */
export function encodeConvexInt64(value: bigint): ConvexInt64WireValue {
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new RangeError("Convex int64 is outside the signed 64-bit range")
  }

  let unsigned = value < 0n ? value + UINT64_MODULUS : value
  const bytes: number[] = []
  for (let index = 0; index < INT64_BYTE_LENGTH; index += 1) {
    bytes.push(Number(unsigned & 0xffn))
    unsigned >>= 8n
  }

  return { $integer: encodeCanonicalBase64(bytes) }
}

/** Decode Convex's canonical convex_encoded_json representation of a signed v.int64(). */
export function decodeConvexInt64(value: unknown): bigint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Convex int64 must be a tagged object")
  }

  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== "$integer") {
    throw new TypeError('Convex int64 must contain only the "$integer" key')
  }

  const encoded = (value as Record<string, unknown>).$integer
  if (typeof encoded !== "string") {
    throw new TypeError('Convex int64 "$integer" must be a Base64 string')
  }

  const bytes = decodeCanonicalBase64(encoded)
  if (bytes.length !== INT64_BYTE_LENGTH) {
    throw new RangeError(`Convex int64 must contain exactly ${INT64_BYTE_LENGTH} bytes`)
  }

  let unsigned = 0n
  for (let index = 0; index < bytes.length; index += 1) {
    unsigned |= BigInt(bytes[index] ?? 0) << BigInt(index * 8)
  }

  return (bytes[INT64_BYTE_LENGTH - 1] ?? 0) & SIGN_BIT
    ? unsigned - UINT64_MODULUS
    : unsigned
}

function decodeCanonicalBase64(encoded: string): number[] {
  // Eight bytes have one and only one canonical standard-padded shape: eleven
  // alphabet characters followed by "=". The residual padding bits are checked
  // below so aliases that decode to the same bytes are rejected too.
  if (!/^[A-Za-z0-9+/]{11}=$/.test(encoded)) {
    throw new RangeError("Convex int64 must use canonical standard-padded Base64")
  }

  const bytes: number[] = []
  let accumulator = 0
  let bitCount = 0

  for (const character of encoded.slice(0, -1)) {
    const digit = BASE64_ALPHABET.indexOf(character)
    if (digit < 0) {
      throw new RangeError("Convex int64 contains an invalid Base64 character")
    }

    accumulator = (accumulator << 6) | digit
    bitCount += 6

    if (bitCount >= 8) {
      bitCount -= 8
      bytes.push((accumulator >> bitCount) & 0xff)
      accumulator &= (1 << bitCount) - 1
    }
  }

  if (bitCount !== 2 || accumulator !== 0) {
    throw new RangeError("Convex int64 Base64 has non-canonical padding bits")
  }

  return bytes
}

function encodeCanonicalBase64(bytes: readonly number[]): string {
  let encoded = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    const bits = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)

    encoded += BASE64_ALPHABET[(bits >> 18) & 0x3f]
    encoded += BASE64_ALPHABET[(bits >> 12) & 0x3f]
    encoded += second === undefined ? "=" : BASE64_ALPHABET[(bits >> 6) & 0x3f]
    encoded += third === undefined ? "=" : BASE64_ALPHABET[bits & 0x3f]
  }
  return encoded
}
