#!/usr/bin/env node

// CI guard for the synthetic Convex wire golden fixtures.
//
// The committed fixtures in shared/domain/fixtures/convex-wire-golden/ must
// stay SYNTHETIC. They replaced verbatim production captures (audit finding
// 2026-09-02 #1), and this gate fails when fixture content drifts back toward
// production-shaped values:
//
//   * real platform/employer/bank/person-name markers in any string value
//   * member names (victor/rachel/mason/maddox) outside the `owner` field,
//     which is the one place the domain vocabulary requires them
//   * cent amounts that are not whole dollars and satoshi amounts that are
//     not round thousands (production ledgers carry odd precision)
//   * IDs and account keys that do not use the synthetic prefixes
//
// Field NAMES (weeklyRiverCents, coinbaseOneBalanceCents, ...) are part of the
// wire schema and are deliberately not scanned; only values are.

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const goldenRoot = path.join(repoRoot, "shared/domain/fixtures/convex-wire-golden")

// Real brands, institutions, employers, surnames, and person names that must
// never appear as fixture values. Matched case-insensitively on word-ish
// boundaries.
const FORBIDDEN_MARKERS = [
  "river",
  "strike",
  "coinbase",
  "coldcard",
  "trezor",
  "kraken",
  "gemini",
  "swan",
  "bitpay",
  "cash app",
  "paypal",
  "venmo",
  "chase",
  "wells fargo",
  "bank of america",
  "fidelity",
  "vanguard",
  "schwab",
  "robinhood",
  "vogel",
]

// The household member vocabulary is load-bearing domain state (decoder
// visibility rules); `owner` is its only legitimate home in a fixture value.
const MEMBER_VALUES = new Set(["victor", "rachel", "mason", "maddox"])
const SYNTHETIC_ID_PREFIXES = ["sample-", "synthetic-", "00000000-"]
const ID_KEYS = new Set([
  "txId",
  "buyId",
  "billPayId",
  "todoId",
  "archimedesRequestId",
  "reference",
  "key",
])

// Word-boundary matches, so "purchase" cannot trip "chase" and a compound
// synthetic ID cannot trip a member name.
function markerRegex(marker) {
  return new RegExp(`(?:^|[^a-z])${marker.trim().split(/\s+/).join("[^a-z]+")}(?:[^a-z]|$)`)
}

const MEMBER_REGEXES = [...MEMBER_VALUES].map((marker) => ({ marker, pattern: markerRegex(marker) }))
const FORBIDDEN_REGEXES = FORBIDDEN_MARKERS.map((marker) => ({ marker, pattern: markerRegex(marker) }))

function forbiddenMarker(value) {
  const lowered = value.toLowerCase()
  const member = MEMBER_REGEXES.find(({ pattern }) => pattern.test(lowered))
  if (member !== undefined) return "household member name"
  const hit = FORBIDDEN_REGEXES.find(({ pattern }) => pattern.test(lowered))
  return hit === undefined ? undefined : `"${hit.marker}"`
}

function decodeTaggedInt64(wrapper) {
  const encoded = wrapper?.$integer
  if (typeof encoded !== "string") throw new Error("$integer wrapper without a base64 string")
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.byteLength !== 8 || bytes.toString("base64") !== encoded) {
    throw new Error("not a canonical 8-byte base64 int64")
  }
  let unsigned = 0n
  for (let index = 0; index < 8; index += 1) {
    unsigned |= BigInt(bytes[index]) << BigInt(index * 8)
  }
  return unsigned >= 2n ** 63n ? unsigned - 2n ** 64n : unsigned
}

function* walk(value, keyPath) {
  const key = keyPath[keyPath.length - 1] ?? ""
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      yield* walk(entry, [...keyPath, String(index)])
    }
    return
  }
  if (value !== null && typeof value === "object") {
    if (typeof value.$integer === "string" && Object.keys(value).length === 1) {
      yield { keyPath, key, kind: "int64", value: decodeTaggedInt64(value) }
      return
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      yield* walk(childValue, [...keyPath, childKey])
    }
    return
  }
  const kind = typeof value === "number" ? "number" : typeof value === "string" ? "string" : "other"
  yield { keyPath, key, kind, value }
}

const failures = []
const files = (await readdir(goldenRoot)).filter((name) => name.endsWith(".json")).sort()

for (const filename of files) {
  const document = JSON.parse(await readFile(path.join(goldenRoot, filename), "utf8"))
  for (const { keyPath, key, kind, value } of walk(document, [filename])) {
    const where = `${filename}:${keyPath.join(".")}`
    if (kind === "string") {
      const lowered = value.toLowerCase()
      if (MEMBER_VALUES.has(lowered)) {
        if (key !== "owner") {
          failures.push(`${where}: member name outside the owner field`)
        }
        continue
      }
      const marker = forbiddenMarker(value)
      if (marker !== undefined) {
        failures.push(`${where}: production-shaped marker ${marker} in string value`)
        continue
      }
      if (ID_KEYS.has(key) && !SYNTHETIC_ID_PREFIXES.some((prefix) => value.startsWith(prefix))) {
        failures.push(`${where}: ${key} does not use a synthetic prefix`)
      }
      continue
    }
    if (kind === "int64") {
      if (key.endsWith("Cents") && value % 100n !== 0n) {
        failures.push(`${where}: cent amount is not whole dollars`)
      }
      if ((key === "sats" || key === "btcSpentSats") && value % 1000n !== 0n) {
        failures.push(`${where}: satoshi amount is not round thousands`)
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`FAIL: ${failure}\n`)
  }
  process.exit(1)
}

process.stdout.write(
  `PASS: ${files.length} wire golden fixture files are synthetic `
    + `(no production-shaped names, amounts, or IDs).\n`,
)
