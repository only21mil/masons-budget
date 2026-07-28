// ─────────────────────────────────────────────────────────────────────────────
// dataFiles blobs → real Convex tables (one-time backfill)
//
// Convex is now the system of record, not a sync target. Everything the family
// owns currently lives as opaque JSON in `dataFiles.data`, one document per MC2
// file. This module projects the row-shaped files into real tables so queries
// can be indexed, while leaving the blobs untouched.
//
// FIVE PROPERTIES THIS FILE EXISTS TO GUARANTEE. Read them before changing it —
// this is the only copy of the family's financial record.
//
//   1. IDEMPOTENT.  Every projected row gets a deterministic E1 table id.
//      A second run finds the same ids, sees identical content, and writes
//      nothing. Running the migration twice cannot duplicate 905 transactions.
//
//   2. DRY RUN IS THE SAME CODE PATH.  `apply: false` runs the entire
//      projection and diff and reports what it *would* write, then returns
//      without touching the database. The report is not a separate estimator
//      that can drift from the writer — it IS the writer, stopped one line
//      short of `db.insert`.
//
//   3. REVIEWED PLAN BINDING.  Dry run emits backend SHA-256 fingerprints for
//      each source and the full source set. Apply requires the reviewed global
//      fingerprint and recomputes it in the mutation before any write. A blob
//      change between review and apply is a refusal, never a different write.
//
//   4. VERIFIED, NOT ASSUMED.  After writing, the rows are read back and
//      checked three ways: row count, exact summed money per field, and a
//      canonical-JSON comparison of the reconstructed array against the source
//      blob. When a whole file fits in one batch the check runs INSIDE the same
//      mutation, so a mismatch throws and Convex rolls the entire file back —
//      all-or-nothing. A migration that silently drops rows is worse than none.
//
//   5. THE BLOB IS NEVER TOUCHED.  Nothing here writes to, patches or deletes
//      `dataFiles` / `syncVersions`. The blob stays the fallback until every
//      client has moved off it. Cutover is a separate, later decision.
//
// MONEY: parsed from the *lexical* form into integer minor units (bigint) and
// never through float arithmetic. `parseMinorUnits` below is a deliberate copy
// of shared/domain/src/money.ts — Convex functions cannot import from outside
// convex/, the same constraint todoNormalize.ts documents. If you change the
// domain parser you MUST mirror it here; convex/migrate.test.ts asserts the two
// agree on a shared table of cases.
//
// AUTHORITY: these are internal functions on purpose. A backfill that rewrites
// the household ledger must not be reachable by anything holding
// CONVEX_SYNC_TOKEN — that token is in the clients. Internal functions require
// deploy-key auth, so the migration is admin-only by construction and there is
// no second copy of dataFiles.ts's auth gate here to drift out of sync with it.
// ─────────────────────────────────────────────────────────────────────────────

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";

// ─── Contract with convex/schema.ts and convex/tables.ts ───────────────────
//
// This module was written in parallel with the schema that defines these
// tables, against the shapes in shared/domain/src/readModel.ts and
// MasonsBudget/.../MC2DTOs.swift. Three things must line up, and only three:
//
//   • the target table names below,
//   • the column names in the `project*` functions,
//   • money columns being v.int64() (bigint minor units), not v.float64().
//
// Deliberately NOT depended on: any index. Idempotency loads the target table
// once per batch and keys in memory rather than calling `.withIndex(...)`, so
// this file does not care what the schema's indexes are named. At ~1k rows per
// table that costs nothing, and it removes the one coupling most likely to
// break on merge.

const TRANSACTIONS_TABLE = "transactions";
const BTC_BUYS_TABLE = "btcBuys";
const BTC_BILL_PAYS_TABLE = "btcBillPays";
const TODOS_TABLE = "todos";
const INCOME_TABLE = "income";
const BALANCE_DOCUMENTS_TABLE = "balanceDocuments";

/**
 * Which MC2 files this migration owns, and what each becomes.
 *
 * `fallbackOwner` mirrors the `fallbackOwner` argument the domain normalizers
 * take: MC2 tags untagged adult records as "victor", and the child files carry
 * no owner at all, so the file name is what tells you whose row it is.
 *
 * Most document-shaped files are modelled by the document projection lane.
 * `balances` is included here because it was absent from that declared source
 * list and otherwise had no migration path at all.
 */
export const MIGRATION_SOURCES = [
  {
    file: "transactions",
    table: TRANSACTIONS_TABLE,
    kind: "transaction",
    fallbackOwner: "victor",
    container: null,
  },
  {
    file: "mason-transactions",
    table: TRANSACTIONS_TABLE,
    kind: "transaction",
    fallbackOwner: "mason",
    container: null,
  },
  {
    file: "maddox-transactions",
    table: TRANSACTIONS_TABLE,
    kind: "transaction",
    fallbackOwner: "maddox",
    container: null,
  },
  {
    file: "bitcoin-buys",
    table: BTC_BUYS_TABLE,
    kind: "btcBuy",
    fallbackOwner: "victor",
    container: null,
  },
  {
    file: "mason-bitcoin-buys",
    table: BTC_BUYS_TABLE,
    kind: "btcBuy",
    fallbackOwner: "mason",
    container: null,
  },
  {
    file: "bitcoin-bill-pays",
    table: BTC_BILL_PAYS_TABLE,
    kind: "btcBillPay",
    fallbackOwner: "victor",
    // appendBillPay writes `{ bill_pays: [...] }`, not a bare array.
    container: "bill_pays",
  },
  {
    file: "todos",
    table: TODOS_TABLE,
    kind: "todo",
    fallbackOwner: "victor",
    // MC2TodosWrapper is `{ todos: [...] }`; older exports are a bare array.
    container: "todos",
  },
  {
    file: "income",
    table: INCOME_TABLE,
    kind: "income",
    fallbackOwner: "victor",
    container: null,
  },
  {
    file: "balances",
    table: BALANCE_DOCUMENTS_TABLE,
    kind: "balanceDocument",
    fallbackOwner: "victor",
    container: null,
  },
] as const;

export type MigrationSource = (typeof MIGRATION_SOURCES)[number];
export type MigrationKind = MigrationSource["kind"];

export const MIGRATION_FILES = MIGRATION_SOURCES.map((source) => source.file);

/**
 * Money columns per kind, used by the verification sums.
 *
 * Every money column a projection writes must appear here, or a drop in that
 * column would pass verification. convex/migrate.test.ts asserts the lists are
 * complete by diffing them against the projected documents.
 */
export const MONEY_COLUMNS: Record<MigrationKind, readonly string[]> = {
  transaction: ["amountCents"],
  btcBuy: ["sats", "priceUsdCents", "usdCents"],
  btcBillPay: [
    "amountUsdCents",
    "btcSpentSats",
    "btcPriceCents",
    "feeUsdCents",
  ],
  todo: [],
  income: ["amountCents"],
  balanceDocument: [
    "cashAppSats",
    "coldcardSats",
    "riverSats",
    "strikeSats",
    "zeusSats",
    "totalSats",
    "cashAppFiatCents",
    "coldcardFiatCents",
    "riverFiatCents",
    "strikeFiatCents",
    "zeusFiatCents",
    "totalFiatCents",
    "btcSync.anchorBalancesSats.cashAppSats",
    "btcSync.anchorBalancesSats.coldcardSats",
    "btcSync.anchorBalancesSats.riverSats",
    "btcSync.anchorBalancesSats.strikeSats",
    "btcSync.anchorBalancesSats.zeusSats",
    "btcSync.anchorBalancesSats.totalSats",
  ],
};

/** Scale of each money column, so sums can be reported as exact decimal text. */
export const MONEY_SCALES: Record<string, number> = {
  amountCents: 2,
  priceUsdCents: 2,
  usdCents: 2,
  amountUsdCents: 2,
  btcPriceCents: 2,
  feeUsdCents: 2,
  sats: 8,
  btcSpentSats: 8,
  cashAppSats: 8,
  coldcardSats: 8,
  riverSats: 8,
  strikeSats: 8,
  zeusSats: 8,
  totalSats: 8,
  cashAppFiatCents: 2,
  coldcardFiatCents: 2,
  riverFiatCents: 2,
  strikeFiatCents: 2,
  zeusFiatCents: 2,
  totalFiatCents: 2,
  "btcSync.anchorBalancesSats.cashAppSats": 8,
  "btcSync.anchorBalancesSats.coldcardSats": 8,
  "btcSync.anchorBalancesSats.riverSats": 8,
  "btcSync.anchorBalancesSats.strikeSats": 8,
  "btcSync.anchorBalancesSats.zeusSats": 8,
  "btcSync.anchorBalancesSats.totalSats": 8,
};

function sourceFor(file: string): MigrationSource {
  const source = MIGRATION_SOURCES.find((entry) => entry.file === file);
  if (!source) {
    throw new ConvexError(
      `Not a migratable file: ${JSON.stringify(file)}. Known: ${MIGRATION_FILES.join(", ")}`,
    );
  }
  return source;
}

// ─── Money ───────────────────────────────────────────────────────────────────
// Mirror of shared/domain/src/money.ts. See the header for why it is copied.

const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Parse a decimal value into integer minor units without going through Number.
 *
 * Accepts a string, a number, or null/undefined. JSON numbers are delegated to
 * jsonNumberToMinorUnits, which has stricter safety checks than lexical strings.
 */
export function parseMinorUnits(value: unknown, scale: number): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value === "number") return jsonNumberToMinorUnits(value, scale);

  assertScale(scale);

  const raw = String(value).trim();
  if (raw === "") return 0n;

  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) {
    throw new RangeError(`Not a decimal value: ${JSON.stringify(value)}`);
  }

  const sign = match[1];
  const whole = match[2] ?? "";
  const frac = match[3] ?? "";
  if (whole === "" && frac === "") {
    throw new RangeError(`Not a decimal value: ${JSON.stringify(value)}`);
  }

  // Pad or round the fraction to the target scale. Round half away from zero,
  // matching NSDecimalNumber's .plain mode used on the Swift side.
  const digits = frac.padEnd(scale, "0");
  let result = BigInt((whole || "0") + digits.slice(0, scale));

  const remainder = digits.slice(scale);
  if (remainder !== "" && Number(remainder[0]) >= 5) result += 1n;

  return sign === "-" ? -result : result;
}

function assertScale(scale: number): void {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 100) {
    throw new RangeError(
      `Minor-unit scale must be an integer from 0 through 100: ${scale}`,
    );
  }
}

/**
 * Convert an already-parsed JSON number to integer minor units.
 *
 * This is the Convex-local mirror of shared/domain/src/money.ts. Number#toString
 * supplies the shortest round-trippable decimal, then BigInt parses and rounds
 * those digits without multiplying the float. Values whose rounded minor units
 * exceed Number.MAX_SAFE_INTEGER are refused because their source double can no
 * longer reliably distinguish adjacent ledger units.
 */
export function jsonNumberToMinorUnits(
  value: number,
  scale: number,
): bigint {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Not a finite number: ${value}`);
  }
  assertScale(scale);

  const shortestDecimal = value.toString();
  const match =
    /^(-)?(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(shortestDecimal);
  if (!match) {
    throw new RangeError(
      `Number has no decimal representation: ${shortestDecimal}`,
    );
  }

  const sign = match[1];
  const whole = match[2] ?? "";
  const fraction = match[3] ?? "";
  const exponentLexical = match[4] ?? "0";
  const coefficient = BigInt(`${whole}${fraction}`);
  const exponent = Number(exponentLexical);
  const minorUnitExponent = exponent - fraction.length + scale;

  let magnitude: bigint;
  if (minorUnitExponent >= 0) {
    magnitude = coefficient * 10n ** BigInt(minorUnitExponent);
  } else {
    const divisor = 10n ** BigInt(-minorUnitExponent);
    const quotient = coefficient / divisor;
    const remainder = coefficient % divisor;
    magnitude = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }

  if (magnitude > MAX_SAFE_MINOR_UNITS) {
    throw new RangeError(
      `Rounded minor units exceed Number.MAX_SAFE_INTEGER: ${shortestDecimal} at scale ${scale}`,
    );
  }

  return sign === "-" ? -magnitude : magnitude;
}

export function jsonNumberToCents(value: number): bigint {
  return jsonNumberToMinorUnits(value, 2);
}

export function jsonNumberToSats(value: number): bigint {
  return jsonNumberToMinorUnits(value, 8);
}

export function parseCents(value: unknown): bigint {
  return parseMinorUnits(value, 2);
}

export function parseBtcToSats(value: unknown): bigint {
  return parseMinorUnits(value, 8);
}

/** Exact decimal text for a minor-unit amount. Never a float, never rounded. */
export function formatMinorUnits(amount: bigint, scale: number): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount)
    .toString()
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = scale > 0 ? `.${digits.slice(digits.length - scale)}` : "";
  return `${negative ? "-" : ""}${whole}${frac}`;
}

/**
 * Read a money column back off a stored document.
 *
 * Accepts bigint (v.int64, what the projections write) and integral number
 * (v.float64, if the schema landed that way instead). A non-integral number is
 * a float that reached a money column — the exact defect this migration exists
 * to prevent — so it throws rather than rounding.
 */
export function decodeMoney(value: unknown, column: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ConvexError(
        `Money column ${column} holds ${value}, which is not an exact integer ` +
          `count of minor units. Money must never transit a float.`,
      );
    }
    return BigInt(value);
  }
  throw new ConvexError(
    `Money column ${column} holds ${typeof value}, expected bigint minor units.`,
  );
}

// ─── Owner ───────────────────────────────────────────────────────────────────
// Mirror of shared/domain/src/family.ts, including its exact fallback rule.

const FAMILY_MEMBERS = ["victor", "rachel", "mason", "maddox"] as const;
type FamilyMember = (typeof FAMILY_MEMBERS)[number];

/**
 * Resolve a row's owner exactly the way the domain normalizers do.
 *
 * An ABSENT owner takes the file's reviewed fallback. A PRESENT owner must be
 * one of the four closed-union values. Migration is the point where an unknown
 * owner would become durable row data, so it is refused rather than coerced.
 *
 * Household note: owner is stored, never compared with strict equality.
 * canSeeDataOwnedBy (adults see everyone) is wider than sharesNetWorthWith
 * (adults with adults only). Victor and Rachel are one household; adult rows
 * default to "victor", so `owner === activeMember` empties Rachel's screens.
 */
export function resolveOwner(
  raw: unknown,
  fallbackOwner: string,
): FamilyMember {
  if (raw === undefined || raw === null) {
    if ((FAMILY_MEMBERS as readonly string[]).includes(fallbackOwner)) {
      return fallbackOwner as FamilyMember;
    }
    throw new ConvexError(
      `Invalid migration fallback owner: ${JSON.stringify(fallbackOwner)}`,
    );
  }
  if ((FAMILY_MEMBERS as readonly unknown[]).includes(raw)) {
    return raw as FamilyMember;
  }
  throw new ConvexError(
    `Unknown owner ${JSON.stringify(String(raw))}; owner is a closed union.`,
  );
}

/**
 * Closed owner resolution for newly discovered sources.
 *
 * Absence uses the source's canonical owner. A present value must be a member
 * of the closed family union and, for adult-household files, must be an adult.
 * Unknown values and child/adult source disagreements are refused, never
 * rewritten to a more privileged owner.
 */
export function resolveClosedAdultOwner(
  raw: unknown,
  fallbackOwner: FamilyMember,
  sourceFile: string,
): FamilyMember {
  if (raw === null || raw === undefined || raw === "") return fallbackOwner;
  if (!(FAMILY_MEMBERS as readonly unknown[]).includes(raw)) {
    throw new ConvexError(
      `${sourceFile}.owner is not a known family member: ${JSON.stringify(raw)}`,
    );
  }
  const owner = raw as FamilyMember;
  if (owner !== "victor" && owner !== "rachel") {
    throw new ConvexError(
      `${sourceFile} is an adult-household source but record owner is ${owner}`,
    );
  }
  return owner;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  return text === "" ? undefined : text;
}

function monthOf(date: string): string {
  return /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : "";
}

function sourceTimestamp(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConvexError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") {
    throw new ConvexError(`${path} must be a non-empty string`);
  }
  return value;
}

function requiredMoney(
  value: unknown,
  scale: number,
  path: string,
): bigint {
  if (value === null || value === undefined || value === "") {
    throw new ConvexError(`${path} is required`);
  }
  return parseMinorUnits(value, scale);
}

function optionalMoney(
  value: unknown,
  scale: number,
): bigint | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return parseMinorUnits(value, scale);
}

// ─── Canonical JSON ──────────────────────────────────────────────────────────

/**
 * Deterministic serialisation used for content comparison and hashing.
 *
 * Keys are sorted, so it does not depend on Convex preserving object key order
 * through a round-trip. `undefined` members are dropped (JSON has none) and
 * bigints get an explicit suffix so 1n and 1 are never confused.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

// ─── Frozen plan fingerprint ─────────────────────────────────────────────────

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const SHA256_ROUND = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, places: number): number {
  return (value >>> places) | (value << (32 - places));
}

/**
 * SHA-256 implemented locally because Convex functions cannot import Node's
 * crypto module. TextEncoder supplies the specified UTF-8 byte representation.
 */
export function sha256(text: string): string {
  const input = new TextEncoder().encode(text);
  const bitLength = BigInt(input.length) * 8n;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  for (let index = 0; index < 8; index += 1) {
    bytes[paddedLength - 1 - index] = Number(
      (bitLength >> BigInt(index * 8)) & 0xffn,
    );
  }

  const hash: number[] = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] =
        ((bytes[start]! << 24) |
          (bytes[start + 1]! << 16) |
          (bytes[start + 2]! << 8) |
          bytes[start + 3]!) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]!;
      const b = words[index - 2]!;
      const sigma0 =
        rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const sigma1 =
        rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      words[index] =
        (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 =
        rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choose = (e! & f!) ^ (~e! & g!);
      const temp1 =
        (h! + sum1 + choose + SHA256_ROUND[index]! + words[index]!) >>> 0;
      const sum0 =
        rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }

  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * 64-bit FNV-1a over UTF-16 code units, two bytes at a time.
 *
 * Only used for rows with no `id` — a collision there would merge two distinct
 * rows into one, so 32 bits (a ~1-in-8000 chance across a thousand rows) is not
 * good enough and 64 bits (~1-in-3e13) is. The verification pass catches it
 * either way; this just keeps it from ever being reached.
 */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET_64;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    hash = ((hash ^ BigInt(unit & 0xff)) * FNV_PRIME_64) & MASK_64;
    hash = ((hash ^ BigInt(unit >> 8)) * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Deterministic identity for a source row.
 *
 * `id` when there is one, otherwise a content hash. Either way the key is then
 * made unique by occurrence ordinal, because both cases genuinely happen in
 * this data: MC2 has shipped duplicate ids, and two identical id-less rows
 * (same coffee, same day, same amount) are two real transactions, not one.
 * Collapsing them would be a silent drop.
 *
 * `seen` must be a per-file counter shared across the whole scan.
 */
export function sourceKeyFor(
  raw: Record<string, unknown>,
  seen: Map<string, number>,
): { sourceKey: string; externalId: string | null } {
  const rawId = raw.id;
  const id =
    rawId === undefined || rawId === null ? "" : String(rawId).trim();
  const base = id !== "" ? `id:${id}` : `hash:${fnv1a64(canonicalJson(raw))}`;

  const ordinal = seen.get(base) ?? 0;
  seen.set(base, ordinal + 1);

  return {
    sourceKey: ordinal === 0 ? base : `${base}#${ordinal}`,
    externalId: id !== "" ? id : null,
  };
}

// ─── Blob → rows ─────────────────────────────────────────────────────────────

/**
 * Pull the row array out of a blob.
 *
 * Both shapes are live in production: `transactions` and `bitcoin-buys` are
 * bare arrays, `bitcoin-bill-pays` is `{ bill_pays: [...] }`, and `todos` has
 * been written both ways over the years. An unrecognised shape returns null
 * rather than an empty array, so "we could not read this file" never reports as
 * "this file has no rows".
 */
export function extractRows(
  data: unknown,
  container: string | null,
): Record<string, unknown>[] | null {
  let rows: unknown = null;
  if (Array.isArray(data)) {
    rows = data;
  } else if (container !== null && typeof data === "object" && data !== null) {
    rows = (data as Record<string, unknown>)[container];
  }

  if (!Array.isArray(rows)) return null;

  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      return null;
    }
  }
  return rows as Record<string, unknown>[];
}

const BALANCE_KEYS = [
  "cashapp",
  "coldcard",
  "river",
  "strike",
  "zeus",
  "total",
] as const;

function projectBalanceSats(
  raw: Record<string, unknown>,
  path: string,
): Record<string, bigint | undefined> {
  const allowed = new Set<string>(BALANCE_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ConvexError(
        `${path} contains unknown BTC balance key ${JSON.stringify(key)}`,
      );
    }
  }
  return {
    cashAppSats: optionalMoney(raw.cashapp, 8),
    coldcardSats: optionalMoney(raw.coldcard, 8),
    riverSats: optionalMoney(raw.river, 8),
    strikeSats: optionalMoney(raw.strike, 8),
    zeusSats: optionalMoney(raw.zeus, 8),
    totalSats: optionalMoney(raw.total, 8),
  };
}

function projectBalanceDocument(
  raw: Record<string, unknown>,
  context: {
    sourceFile: string;
    sourceIndex: number;
    fallbackOwner: string;
  },
): Record<string, unknown> {
  const btcSync = asRecord(raw.btc_sync, "balances.btc_sync");
  const anchorBalances = asRecord(
    btcSync.anchor_balances,
    "balances.btc_sync.anchor_balances",
  );

  return {
    sourceFile: "balances",
    owner: resolveClosedAdultOwner(
      raw.owner,
      context.fallbackOwner as FamilyMember,
      "balances",
    ),
    cashAppSats: requiredMoney(raw.cashapp, 8, "balances.cashapp"),
    coldcardSats: requiredMoney(raw.coldcard, 8, "balances.coldcard"),
    riverSats: requiredMoney(raw.river, 8, "balances.river"),
    strikeSats: requiredMoney(raw.strike, 8, "balances.strike"),
    zeusSats: requiredMoney(raw.zeus, 8, "balances.zeus"),
    totalSats: requiredMoney(raw.total, 8, "balances.total"),
    cashAppFiatCents: optionalMoney(raw.cashapp_fiat, 2),
    coldcardFiatCents: optionalMoney(raw.coldcard_fiat, 2),
    riverFiatCents: optionalMoney(raw.river_fiat, 2),
    strikeFiatCents: optionalMoney(raw.strike_fiat, 2),
    zeusFiatCents: optionalMoney(raw.zeus_fiat, 2),
    totalFiatCents: optionalMoney(raw.total_fiat, 2),
    lastRefreshed: requiredString(
      raw.lastRefreshed,
      "balances.lastRefreshed",
    ),
    btcSync: {
      anchorBalancesSats: projectBalanceSats(
        anchorBalances,
        "balances.btc_sync.anchor_balances",
      ),
      anchorDate: optionalString(btcSync.anchor_date),
      anchorSource: optionalString(btcSync.anchor_source),
      notes:
        btcSync.notes === null || btcSync.notes === undefined
          ? undefined
          : btcSync.notes,
      reconciledAt: optionalString(btcSync.reconciled_at),
      reconciledFromEvents:
        btcSync.reconciled_from_events === null ||
        btcSync.reconciled_from_events === undefined
          ? undefined
          : btcSync.reconciled_from_events,
    },
    updatedAtMs: 0,
    raw,
    migrationSourceIndex: context.sourceIndex,
  };
}

/**
 * Project one source row into its target document.
 *
 * `migrationRaw` is carried verbatim on every row, deliberately. The typed columns are a
 * projection and projections lose things — `archimedes_request_id` is on every
 * BTC buy and appears in no domain type, and the todo dialect has twenty-odd
 * optional fields. Keeping the original object means a column nobody thought of
 * is a query away rather than a data-loss event, and it is what makes the exact
 * round-trip check in `verifyFile` possible at all.
 *
 * SIGNS ARE PRESERVED, NOT NORMALISED. Production purchases are positive for
 * every owner and refunds are negative. Rewriting stored values here would be
 * data corruption; the public read projection supplies the budget contract.
 */
export function projectRow(
  kind: MigrationKind,
  raw: Record<string, unknown>,
  context: {
    sourceFile: string;
    sourceKey: string;
    sourceIndex: number;
    externalId: string | null;
    fallbackOwner: string;
  },
): Record<string, unknown> {
  if (kind === "balanceDocument") {
    return projectBalanceDocument(raw, context);
  }

  const owner =
    kind === "income"
      ? resolveClosedAdultOwner(
          raw.owner,
          context.fallbackOwner as FamilyMember,
          context.sourceFile,
        )
      : resolveOwner(raw.owner, context.fallbackOwner);
  const base = {
    sourceFile: context.sourceFile,
    owner,
    updatedAtMs: 0,
    ...(kind === "income" ? { raw } : { migrationRaw: raw }),
    migrationSourceIndex: context.sourceIndex,
  };
  const id =
    context.externalId === null
      ? context.sourceKey
      : context.externalId +
        context.sourceKey.slice(`id:${context.externalId}`.length);

  switch (kind) {
    case "transaction": {
      const date = String(raw.date ?? "");
      return {
        ...base,
        txId: id,
        date,
        month: monthOf(date),
        merchant: String(raw.merchant ?? ""),
        amountCents: parseCents(raw.amount),
        category: String(raw.category ?? "Other"),
        card: optionalString(raw.card),
        note: optionalString(raw.note),
      };
    }

    case "btcBuy": {
      const date = String(raw.date ?? "");
      return {
        ...base,
        buyId: id,
        date,
        month: monthOf(date),
        source: String(raw.source ?? ""),
        // amount_sats is authoritative; amount_btc is a convenience mirror that
        // only carries 8 dp of a double. Same precedence as normalizeBTCBuy.
        sats:
          raw.amount_sats !== undefined && raw.amount_sats !== null
            ? parseMinorUnits(String(raw.amount_sats), 0)
            : parseBtcToSats(raw.amount_btc),
        priceUsdCents: parseCents(raw.price_usd),
        usdCents: parseCents(raw.usd),
        note: optionalString(raw.note),
        status: optionalString(raw.status),
        costBasisStatus: optionalString(raw.cost_basis_status),
        loggedBy: optionalString(raw.logged_by),
        archimedesRequestId: optionalString(raw.archimedes_request_id),
      };
    }

    case "btcBillPay": {
      const date = String(raw.date ?? "");
      return {
        ...base,
        billPayId: id,
        date,
        month: monthOf(date),
        merchant: String(raw.merchant ?? ""),
        category: String(raw.category ?? "Other"),
        amountUsdCents: parseCents(raw.amount_usd),
        btcSpentSats: parseBtcToSats(raw.btc_spent),
        btcPriceCents: parseCents(raw.btc_price),
        platform: optionalString(raw.platform),
        note: optionalString(raw.note),
        feeUsdCents: parseCents(raw.fee_usd),
        reference: optionalString(raw.reference),
      };
    }

    case "todo":
      return {
        ...base,
        todoId: id,
        title: String(raw.title ?? raw.text ?? ""),
        done: Boolean(raw.done ?? raw.completed ?? false),
        flagged: Boolean(raw.flagged ?? raw.flag ?? false),
        lane: optionalString(raw.lane ?? raw.category),
        project: optionalString(raw.project),
        area: optionalString(raw.area),
        due: optionalString(raw.due ?? raw.due_date ?? raw.dueDate),
        notes: optionalString(raw.notes ?? raw.note),
        priority:
          raw.priority === null || raw.priority === undefined || raw.priority === ""
            ? undefined
            : BigInt(Math.trunc(Number(raw.priority) || 0)),
        createdAt: optionalString(raw.created_at ?? raw.createdAt),
        updatedAt: optionalString(raw.updated_at ?? raw.updatedAt),
        completedAt: optionalString(
          raw.completed_at ?? raw.completedAt ?? raw.completion_date,
        ),
        updatedAtMs: sourceTimestamp(raw.updated_at ?? raw.updatedAt),
      };

    case "income": {
      const date = requiredString(raw.date, "income.date");
      return {
        ...base,
        sourceKey: context.sourceKey,
        incomeId: id,
        date,
        month: monthOf(date),
        amountCents: requiredMoney(raw.amount, 2, "income.amount"),
        source: requiredString(raw.source, "income.source"),
        loggedBy: optionalString(raw.logged_by),
        note: optionalString(raw.note),
        archimedesRequestId: optionalString(raw.archimedes_request_id),
      };
    }
  }
}

/**
 * Project a whole blob. Pure — no ctx, no writes — so the dry run, the write
 * and the verification all reason about one identical list of documents.
 */
export function projectFile(
  source: MigrationSource,
  data: unknown,
): { rows: Record<string, unknown>[]; docs: Record<string, unknown>[] } | null {
  const rows =
    source.kind === "balanceDocument"
      ? typeof data === "object" && data !== null && !Array.isArray(data)
        ? [data as Record<string, unknown>]
        : null
      : extractRows(data, source.container);
  if (rows === null) return null;

  const seen = new Map<string, number>();
  const docs = rows.map((raw, sourceIndex) => {
    const { sourceKey, externalId } = sourceKeyFor(raw, seen);
    return projectRow(source.kind, raw, {
      sourceFile: source.file,
      sourceKey,
      sourceIndex,
      externalId,
      fallbackOwner: source.fallbackOwner,
    });
  });

  return { rows, docs };
}

/**
 * Fields excluded from the "has this row changed?" comparison.
 *
 * Convex's system fields are excluded; all application columns participate.
 */
const VOLATILE_FIELDS = new Set(["_id", "_creationTime"]);

export function contentFingerprint(doc: Record<string, unknown>): string {
  const stable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!VOLATILE_FIELDS.has(key)) stable[key] = value;
  }
  return canonicalJson(stable);
}

// ─── Sums ────────────────────────────────────────────────────────────────────

export function sumMoneyColumns(
  kind: MigrationKind,
  docs: readonly Record<string, unknown>[],
): Record<string, bigint> {
  const totals: Record<string, bigint> = {};
  for (const column of MONEY_COLUMNS[kind]) {
    let total = 0n;
    for (const doc of docs) {
      const value = column
        .split(".")
        .reduce<unknown>(
          (current, part) =>
            typeof current === "object" && current !== null
              ? (current as Record<string, unknown>)[part]
              : undefined,
          doc,
        );
      // Optional document fields contribute zero when absent. Their presence is
      // still proved independently by the canonical raw round-trip.
      if (value !== undefined) total += decodeMoney(value, column);
    }
    totals[column] = total;
  }
  return totals;
}

/** Sums as exact decimal text, safe to send over the wire and to compare. */
export function formatSums(totals: Record<string, bigint>): Record<string, string> {
  const formatted: Record<string, string> = {};
  for (const [column, total] of Object.entries(totals)) {
    formatted[column] = formatMinorUnits(total, MONEY_SCALES[column] ?? 0);
  }
  return formatted;
}

// ─── Verification ────────────────────────────────────────────────────────────

export interface VerificationReport {
  file: string;
  table: string;
  ok: boolean;
  blobRowCount: number;
  tableRowCount: number;
  rowCountMatches: boolean;
  blobSums: Record<string, string>;
  tableSums: Record<string, string>;
  moneySumsMatch: boolean;
  /**
   * Whether every row present on both sides has byte-equivalent canonical
   * provenance at the same source index. Count is deliberately reported
   * separately so a missing final row can be diagnosed as a count-only defect.
   */
  roundTripRowsMatch: boolean;
  exactRoundTrip: boolean;
  /** Index of the first row that did not round-trip; null when all did. */
  firstMismatchIndex: number | null;
  problems: string[];
}

/**
 * Compare what the blob says against what the table holds.
 *
 * Three independent checks, because each catches something the others miss:
 *
 *   count       — catches drops and duplicates outright.
 *   money sums  — catches a value corrupted in transit even when the count is
 *                 right. Both sides use the same parser, so this is not a
 *                 proof of the parser; it is a proof that nothing was lost or
 *                 altered between parsing and reading back.
 *   round trip  — reconstructs the source array from stored `migrationRaw` in
 *                 `migrationSourceIndex` order and canonical-JSON compares it to the
 *                 blob. This is the check that does not trust the projection at
 *                 all: if it passes, the blob can be rebuilt from the tables.
 */
export function verifyProjection(
  source: MigrationSource,
  blobRows: readonly Record<string, unknown>[],
  expectedDocs: readonly Record<string, unknown>[],
  storedDocs: readonly Record<string, unknown>[],
): VerificationReport {
  const problems: string[] = [];

  const ordered = [...storedDocs].sort(
    (a, b) =>
      Number(a.migrationSourceIndex ?? 0) -
      Number(b.migrationSourceIndex ?? 0),
  );

  const rowCountMatches = ordered.length === blobRows.length;
  if (!rowCountMatches) {
    problems.push(
      `row count ${ordered.length} in ${source.table} does not match ` +
        `${blobRows.length} in the ${source.file} blob`,
    );
  }

  const blobSums = sumMoneyColumns(source.kind, expectedDocs);
  const tableSums = sumMoneyColumns(source.kind, ordered);
  let moneySumsMatch = true;
  for (const column of MONEY_COLUMNS[source.kind]) {
    if (blobSums[column] !== tableSums[column]) {
      moneySumsMatch = false;
      problems.push(
        `summed ${column} is ${formatMinorUnits(tableSums[column]!, MONEY_SCALES[column] ?? 0)} ` +
          `in ${source.table} but ${formatMinorUnits(blobSums[column]!, MONEY_SCALES[column] ?? 0)} ` +
          `in the ${source.file} blob`,
      );
    }
  }

  let firstMismatchIndex: number | null = null;
  const compared = Math.min(ordered.length, blobRows.length);
  for (let index = 0; index < compared; index += 1) {
    const storedRaw =
      source.kind === "income" || source.kind === "balanceDocument"
        ? ordered[index]!.raw
        : ordered[index]!.migrationRaw;
    if (
      canonicalJson(storedRaw) !== canonicalJson(blobRows[index]!)
    ) {
      firstMismatchIndex = index;
      problems.push(
        `row ${index} of ${source.file} does not round-trip: the stored copy ` +
          `differs from the blob`,
      );
      break;
    }
  }

  const roundTripRowsMatch = firstMismatchIndex === null;
  const exactRoundTrip = roundTripRowsMatch && rowCountMatches;

  return {
    file: source.file,
    table: source.table,
    ok: problems.length === 0,
    blobRowCount: blobRows.length,
    tableRowCount: ordered.length,
    rowCountMatches,
    blobSums: formatSums(blobSums),
    tableSums: formatSums(tableSums),
    moneySumsMatch,
    roundTripRowsMatch,
    exactRoundTrip,
    firstMismatchIndex,
    problems,
  };
}

// ─── Convex helpers ──────────────────────────────────────────────────────────

// `ctx` is `any` in these helpers for the same reason dataFiles.ts's shared
// helpers are: the test stub for ./_generated/server leaves the data model
// unbound, so there is no generated `DatabaseReader` type to name. The table
// names these touch are the reconcile list at the top of this file.

async function readBlob(ctx: any, file: string): Promise<unknown | undefined> {
  const doc = await ctx.db
    .query("dataFiles")
    .withIndex("by_name", (q: any) => q.eq("name", file))
    .first();
  return doc?.data;
}

function rowKey(source: MigrationSource, doc: Record<string, unknown>): string {
  switch (source.kind) {
    case "transaction":
      return String(doc.txId);
    case "btcBuy":
      return String(doc.buyId);
    case "btcBillPay":
      return String(doc.billPayId);
    case "todo":
      return String(doc.todoId);
    case "income":
      return String(doc.sourceKey);
    case "balanceDocument":
      return String(doc.sourceFile);
  }
}

/**
 * The frozen plan hashes every application field of every projected document.
 *
 * The only excluded field is `migratedAt`: if a future schema adds that
 * execution-time wall-clock timestamp, it cannot be known during dry run and
 * would make identical inputs hash differently. No current projection writes
 * it. In particular, deterministic source timestamps such as `updatedAtMs`,
 * row ids/keys, owners, integer-minor-unit money values, and `migrationRaw` are
 * all included. Convex `_id` and `_creationTime` are not exclusions: they do
 * not exist on a pre-insert projected document and therefore are never part of
 * the plan in the first place.
 */
const PLAN_NONDETERMINISTIC_FIELDS = new Set(["migratedAt"]);

function frozenPlanDocument(
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const stable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!PLAN_NONDETERMINISTIC_FIELDS.has(key)) stable[key] = value;
  }
  return stable;
}

interface FrozenSourcePlan {
  file: string;
  table: string;
  state: "missing" | "unreadable" | "projected";
  rows?: { key: string; document: Record<string, unknown> }[];
  unreadableBlob?: unknown;
}

function frozenSourcePlan(
  source: MigrationSource,
  data: unknown | undefined,
): FrozenSourcePlan {
  if (data === undefined) {
    return { file: source.file, table: source.table, state: "missing", rows: [] };
  }

  const projected = projectFile(source, data);
  if (projected === null) {
    // An unreadable source can never be applied, but hashing its exact value
    // keeps a change elsewhere in the source set from evading the global bind.
    return {
      file: source.file,
      table: source.table,
      state: "unreadable",
      unreadableBlob: data,
    };
  }

  return {
    file: source.file,
    table: source.table,
    state: "projected",
    rows: projected.docs.map((doc) => ({
      key: rowKey(source, doc),
      document: frozenPlanDocument(doc),
    })),
  };
}

function fingerprintSourcePlan(plan: FrozenSourcePlan): string {
  return `sha256:${sha256(canonicalJson(plan))}`;
}

interface FrozenPlan {
  frozenPlanFingerprint: string;
  sourceFingerprints: Map<string, string>;
  dataByFile: Map<string, unknown | undefined>;
}

async function buildFrozenPlan(ctx: any): Promise<FrozenPlan> {
  const plans: FrozenSourcePlan[] = [];
  const sourceFingerprints = new Map<string, string>();
  const dataByFile = new Map<string, unknown | undefined>();

  for (const source of MIGRATION_SOURCES) {
    const data = await readBlob(ctx, source.file);
    const plan = frozenSourcePlan(source, data);
    plans.push(plan);
    dataByFile.set(source.file, data);
    sourceFingerprints.set(source.file, fingerprintSourcePlan(plan));
  }

  const envelope = {
    schema: "vogel-vault.convex-migration-plan",
    version: 1,
    sources: plans,
  };
  return {
    frozenPlanFingerprint: `sha256:${sha256(canonicalJson(envelope))}`,
    sourceFingerprints,
    dataByFile,
  };
}

/** Every already-migrated row for one source file, keyed by E1's row id. */
async function readMigrated(
  ctx: any,
  source: MigrationSource,
): Promise<Map<string, Record<string, unknown>>> {
  const existing = await ctx.db.query(source.table).collect();
  const byKey = new Map<string, Record<string, unknown>>();
  for (const doc of existing) {
    if (doc.sourceFile !== source.file) continue;
    byKey.set(rowKey(source, doc), doc);
  }
  return byKey;
}

// ─── Internal administrative surface ────────────────────────────────────────

const DEFAULT_BATCH_SIZE = 1000;

type MigrationTable = MigrationSource["table"];
type NewMigrationDocument<Table extends MigrationTable> = Omit<
  Doc<Table>,
  "_id" | "_creationTime"
>;
type CorrelatedMigrationWrite = {
  [Table in MigrationTable]: {
    table: Table;
    document: NewMigrationDocument<Table>;
    existingId: Id<Table> | undefined;
  };
}[MigrationTable];

function assertNeverMigrationWrite(write: never): never {
  const unhandled = write as { table: unknown };
  throw new Error(`Unhandled migration table: ${String(unhandled.table)}`);
}

export async function writeProjectedDocument(
  ctx: MutationCtx,
  source: MigrationSource,
  document: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
): Promise<void> {
  // `projectFile` projects several table shapes into loose records, so
  // TypeScript cannot preserve the correlation between `source.table`, the
  // projected document, and an existing row's id. Assert that correlated
  // triple once at this boundary. The real safety net is runtime and
  // transactional: Convex validates every insert (and patch) against the
  // schema, and the three-way verification — row count, exact summed money per
  // column, and canonical round-trip — runs against stored rows before the
  // mutation commits.
  const write = {
    table: source.table,
    document,
    existingId: existing?._id,
  } as CorrelatedMigrationWrite;

  switch (write.table) {
    case TRANSACTIONS_TABLE:
    case BTC_BUYS_TABLE:
    case BTC_BILL_PAYS_TABLE:
    case TODOS_TABLE:
    case INCOME_TABLE:
    case BALANCE_DOCUMENTS_TABLE:
      if (write.existingId === undefined) {
        await ctx.db.insert(write.table, write.document);
      } else {
        await ctx.db.patch(write.existingId, write.document);
      }
      break;
    default:
      assertNeverMigrationWrite(write);
  }
}

/**
 * What is here, before anything is written.
 *
 * Cheap enough to run against production whenever someone wants to know where
 * the cutover stands.
 */
export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const plan = await buildFrozenPlan(ctx);
    const files = [];
    for (const source of MIGRATION_SOURCES) {
      const data = plan.dataByFile.get(source.file);
      const projected =
        data === undefined ? null : projectFile(source, data);
      const migrated = await readMigrated(ctx, source);
      files.push({
        file: source.file,
        table: source.table,
        blobPresent: data !== undefined,
        blobRowCount: projected === null ? null : projected.rows.length,
        blobUnreadable: data !== undefined && projected === null,
        migratedRowCount: migrated.size,
        planFingerprint: plan.sourceFingerprints.get(source.file)!,
      });
    }

    // Named so a reader of the output can see what was left behind on purpose.
    const skipped = [];
    for (const name of [
      "budget",
      "mason-budget",
      "btc-balance-snapshot",
      "finances",
      "son-balances",
    ]) {
      const data = await readBlob(ctx, name);
      if (data !== undefined) skipped.push(name);
    }

    return {
      files,
      skippedDocumentShapedFiles: skipped,
      frozenPlanFingerprint: plan.frozenPlanFingerprint,
    };
  },
});

/**
 * Migrate (or dry-run) one file.
 *
 * `apply: false` is the default and does the entire projection and diff without
 * a single write, so the plan cannot disagree with the write.
 *
 * When the whole file fits in one batch (`cursor: 0` and `done`), an applied run
 * verifies inside this same transaction and throws on any mismatch, which rolls
 * the file back in full. Convex gives us that atomicity for free and it is the
 * strongest safety property available here — prefer a batch size that fits the
 * file over a smaller one.
 */
export const migrateFile = internalMutation({
  args: {
    file: v.string(),
    apply: v.optional(v.boolean()),
    expectedPlanFingerprint: v.optional(v.string()),
    cursor: v.optional(v.float64()),
    batchSize: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const source = sourceFor(args.file);
    const apply = args.apply ?? false;
    const cursor = args.cursor ?? 0;
    const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;

    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new ConvexError(`cursor must be a non-negative integer, got ${cursor}`);
    }
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new ConvexError(`batchSize must be a positive integer, got ${batchSize}`);
    }

    const plan = await buildFrozenPlan(ctx);
    if (apply) {
      if (args.expectedPlanFingerprint === undefined) {
        throw new ConvexError(
          "Refusing to apply without expectedPlanFingerprint from a reviewed dry run.",
        );
      }
      if (args.expectedPlanFingerprint !== plan.frozenPlanFingerprint) {
        throw new ConvexError(
          "Plan fingerprint mismatch. The source blobs no longer match the reviewed dry run; refusing this write.",
        );
      }
    }

    const data = plan.dataByFile.get(source.file);
    const planFingerprint = plan.sourceFingerprints.get(source.file)!;
    if (data === undefined) {
      return {
        file: source.file,
        table: source.table,
        applied: apply,
        blobPresent: false,
        blobRowCount: 0,
        scanned: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        cursor,
        nextCursor: null as number | null,
        done: true,
        verifiedInTransaction: false,
        verification: null as VerificationReport | null,
        planFingerprint,
        frozenPlanFingerprint: plan.frozenPlanFingerprint,
      };
    }

    const projected = projectFile(source, data);
    if (projected === null) {
      throw new ConvexError(
        `The ${source.file} blob ${
          source.kind === "balanceDocument"
            ? "is not a document"
            : "is not a row collection"
        }` +
          (source.kind === "balanceDocument"
            ? " (expected an object)"
            : source.container
              ? ` (expected an array or { ${source.container}: [...] })`
              : " (expected an array)") +
          ". Refusing to migrate a shape this migration does not understand.",
      );
    }

    const { rows, docs } = projected;
    const existingByKey = await readMigrated(ctx, source);

    const end = Math.min(cursor + batchSize, docs.length);
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;

    for (let index = cursor; index < end; index += 1) {
      const doc = docs[index]!;
      const existing = existingByKey.get(rowKey(source, doc));

      if (existing === undefined) {
        inserted += 1;
        if (apply) {
          await writeProjectedDocument(ctx, source, doc, undefined);
        }
        continue;
      }

      if (contentFingerprint(existing) === contentFingerprint(doc)) {
        unchanged += 1;
        continue;
      }

      updated += 1;
      if (apply) {
        await writeProjectedDocument(ctx, source, doc, existing);
      }
    }

    const done = end >= docs.length;
    const wholeFileInOneBatch = cursor === 0 && done;

    let verification: VerificationReport | null = null;
    if (apply && wholeFileInOneBatch) {
      // Read back what we just wrote, in the same transaction. A mismatch
      // throws, Convex rolls the whole file back, and the blob is untouched.
      const storedByKey = await readMigrated(ctx, source);
      verification = verifyProjection(source, rows, docs, [...storedByKey.values()]);
      if (!verification.ok) {
        throw new ConvexError(
          `Refusing to commit the ${source.file} migration — it did not verify: ` +
            verification.problems.join("; "),
        );
      }
    }

    return {
      file: source.file,
      table: source.table,
      applied: apply,
      blobPresent: true,
      blobRowCount: docs.length,
      scanned: end - cursor,
      inserted,
      updated,
      unchanged,
      cursor,
      nextCursor: done ? null : end,
      done,
      verifiedInTransaction: verification !== null,
      verification,
      planFingerprint,
      frozenPlanFingerprint: plan.frozenPlanFingerprint,
    };
  },
});

/**
 * Read the rows back and prove they match the blob.
 *
 * Separate from the write so a batched migration — one that could not be
 * verified inside a single transaction — still gets checked, and so anyone can
 * re-run the proof later without touching anything.
 */
export const verifyFile = internalQuery({
  args: { file: v.string() },
  handler: async (ctx, { file }) => {
    const source = sourceFor(file);

    const data = await readBlob(ctx, source.file);
    if (data === undefined) {
      const migrated = await readMigrated(ctx, source);
      return {
        file: source.file,
        table: source.table,
        ok: migrated.size === 0,
        blobRowCount: 0,
        tableRowCount: migrated.size,
        rowCountMatches: migrated.size === 0,
        blobSums: {},
        tableSums: {},
        moneySumsMatch: true,
        roundTripRowsMatch: true,
        exactRoundTrip: migrated.size === 0,
        firstMismatchIndex: null,
        problems:
          migrated.size === 0
            ? []
            : [`${migrated.size} rows in ${source.table} have no ${source.file} blob to verify against`],
      } satisfies VerificationReport;
    }

    const projected = projectFile(source, data);
    if (projected === null) {
      throw new ConvexError(
        `The ${source.file} blob is not a row collection; nothing to verify against.`,
      );
    }

    const storedByKey = await readMigrated(ctx, source);
    return verifyProjection(source, projected.rows, projected.docs, [
      ...storedByKey.values(),
    ]);
  },
});

/* eslint-enable @typescript-eslint/no-explicit-any */
