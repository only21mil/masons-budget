// ─────────────────────────────────────────────────────────────────────────────
// dataFiles blobs → real Convex tables (one-time backfill)
//
// Convex is now the system of record, not a sync target. Everything the family
// owns currently lives as opaque JSON in `dataFiles.data`, one document per MC2
// file. This module projects the row-shaped files into real tables so queries
// can be indexed, while leaving the blobs untouched.
//
// FOUR PROPERTIES THIS FILE EXISTS TO GUARANTEE. Read them before changing it —
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
//   3. VERIFIED, NOT ASSUMED.  After writing, the rows are read back and
//      checked three ways: row count, exact summed money per field, and a
//      canonical-JSON comparison of the reconstructed array against the source
//      blob. When a whole file fits in one batch the check runs INSIDE the same
//      mutation, so a mismatch throws and Convex rolls the entire file back —
//      all-or-nothing. A migration that silently drops rows is worse than none.
//
//   4. THE BLOB IS NEVER TOUCHED.  Nothing here writes to, patches or deletes
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
import { internalMutation, internalQuery } from "./_generated/server";

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

/**
 * Which MC2 files this migration owns, and what each becomes.
 *
 * `fallbackOwner` mirrors the `fallbackOwner` argument the domain normalizers
 * take: MC2 tags untagged adult records as "victor", and the child files carry
 * no owner at all, so the file name is what tells you whose row it is.
 *
 * Document-shaped files (budget, mason-budget, btc-balance-snapshot, finances,
 * son-balances) are deliberately NOT here. They are single objects, not row
 * collections; their table shape is a modelling judgement that belongs with the
 * schema, and unlike a ledger they cannot silently lose rows. They stay in
 * `dataFiles` and are reported as `skipped` rather than quietly ignored.
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

/**
 * Parse a decimal value into integer minor units without going through Number.
 *
 * Accepts a string, a number, a bigint, or null/undefined. Numbers are
 * stringified first — for the values MC2 actually emits (2-dp USD, 8-dp BTC)
 * the shortest round-trip representation is exact, so this is lossless and
 * never accumulates the error that `value * 100` does.
 */
export function parseMinorUnits(value: unknown, scale: number): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value === "bigint") return value;

  const raw =
    typeof value === "number"
      ? numberToDecimalString(value)
      : String(value).trim();
  if (raw === "") return 0n;

  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) {
    throw new ConvexError(`Not a decimal value: ${JSON.stringify(String(value))}`);
  }

  const sign = match[1];
  const whole = match[2] ?? "";
  const frac = match[3] ?? "";
  if (whole === "" && frac === "") {
    throw new ConvexError(`Not a decimal value: ${JSON.stringify(String(value))}`);
  }

  // Pad or round the fraction to the target scale. Round half away from zero,
  // matching NSDecimalNumber's .plain mode used on the Swift side.
  const digits = frac.padEnd(scale, "0");
  let result = BigInt((whole || "0") + digits.slice(0, scale));

  const remainder = digits.slice(scale);
  if (remainder !== "" && Number(remainder[0]) >= 5) result += 1n;

  return sign === "-" ? -result : result;
}

function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ConvexError(`Not a finite number: ${value}`);
  }
  if (Math.abs(value) < 1e21) {
    return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(value);
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
 * The rule is deliberately odd and is copied rather than improved: an ABSENT
 * owner takes the file's fallback, but a PRESENT-BUT-UNRECOGNISED owner falls
 * back to "victor" even in a child's file. Behavioural parity with
 * normalizeTransaction/normalizeBTCBuy/normalizeTodo matters more here than
 * tidiness — the clients already read the blob this way, and the migrated rows
 * must land on the same owner the app is showing today.
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
  return (FAMILY_MEMBERS as readonly string[]).includes(raw as string)
    ? (raw as FamilyMember)
    : (fallbackOwner as FamilyMember);
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
 * SIGNS ARE PRESERVED, NOT NORMALISED. Child MC2 files record spend as a
 * positive magnitude; adult files sign it negative. `spendAmount()` in the
 * domain already handles both by keying off the category, so rewriting signs
 * here would change what every client displays. `sourceFile` keeps the
 * convention recoverable.
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
  const base = {
    sourceFile: context.sourceFile,
    owner: resolveOwner(raw.owner, context.fallbackOwner),
    updatedAtMs: 0,
    migrationRaw: raw,
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
  const rows = extractRows(data, source.container);
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
    for (const doc of docs) total += decodeMoney(doc[column], column);
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
    if (
      canonicalJson(ordered[index]!.migrationRaw) !==
      canonicalJson(blobRows[index]!)
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
  }
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

/**
 * What is here, before anything is written.
 *
 * Cheap enough to run against production whenever someone wants to know where
 * the cutover stands.
 */
export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const files = [];
    for (const source of MIGRATION_SOURCES) {
      const data = await readBlob(ctx, source.file);
      const rows = data === undefined ? null : extractRows(data, source.container);
      const migrated = await readMigrated(ctx, source);
      files.push({
        file: source.file,
        table: source.table,
        blobPresent: data !== undefined,
        blobRowCount: rows === null ? null : rows.length,
        blobUnreadable: data !== undefined && rows === null,
        migratedRowCount: migrated.size,
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

    return { files, skippedDocumentShapedFiles: skipped };
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

    const data = await readBlob(ctx, source.file);
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
      };
    }

    const projected = projectFile(source, data);
    if (projected === null) {
      throw new ConvexError(
        `The ${source.file} blob is not a row collection` +
          (source.container ? ` (expected an array or { ${source.container}: [...] })` : " (expected an array)") +
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
        if (apply) await ctx.db.insert(source.table, doc);
        continue;
      }

      if (contentFingerprint(existing) === contentFingerprint(doc)) {
        unchanged += 1;
        continue;
      }

      updated += 1;
      if (apply) await ctx.db.patch(existing._id, doc);
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
