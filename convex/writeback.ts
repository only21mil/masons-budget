// ─────────────────────────────────────────────────────────────────────────────
// THE VOGEL VAULT — VALIDATING WRITE PATH (hand entry + direct client writes)
//
// WHY THIS FILE EXISTS
// Until 2026-07-18 every write reached Convex through mission-control (MC2),
// which owned the JSON files and validated them on the way in. MC2 is gone. It
// was never pushed anywhere and died with the DGX Spark, and Convex is now the
// system of record rather than a sync target. Nothing upstream of Convex
// validates anything any more.
//
// That makes this module the ONLY thing between a typo and the family's
// financial record, and there is no second copy to reconcile against. So the
// rule here is REJECT, NEVER COERCE. A rejected write is a visible error the
// person who typed it can fix in five seconds. A coerced write is a wrong
// number that looks right, in the only copy, forever. Every guard below picks
// the first failure mode on purpose.
//
// WHAT IT IS NOT
// `dataFiles.ts` keeps the MC2-era doors open: `sync`/`syncBatch` replace whole
// files, `upsertTodo` carries last-write-wins for out-of-order bridge replays,
// and the mobile device-token path serves paired iPhones. Those stay exactly as
// they are. This file adds a narrow, strict, human-facing front door beside
// them; it does not replace or wrap them.
//
// STORAGE
// Records go into the SAME `dataFiles` blobs every shipped client already reads
// (`transactions`, `mason-transactions`, `maddox-transactions`, `todos`) and in
// the same record shape. A brand-new table would be correct-looking and
// invisible: no client reads it, so Victor's hand-entered rows would not appear
// on a single screen. When the blobs are migrated to real tables (task #45) this
// module moves with them; until then it writes where the data actually lives.
//
// No new query is exported. The audit log is a `dataFiles` document, so it is
// already readable through `dataFiles.get("writeback-audit")` behind the
// existing read-token gate — this module adds write surface only.
// ─────────────────────────────────────────────────────────────────────────────

import { ConvexError, v } from "convex/values";
import type { DataModel } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { requireIsoDate } from "./dateValidation";
import { mergeTodoPayload, normalizeTodoRecord } from "./todoNormalize";

export { isRealIsoDate } from "./dateValidation";

declare const process: { env: Record<string, string | undefined> };

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MIRROR of `validateSyncToken` in dataFiles.ts, including the escape-hatch
 * precedence documented in that file's banner (ALLOW_TOKENLESS_SYNC=true admits
 * the call even when CONVEX_SYNC_TOKEN is set — the hatch outranks the token, so
 * removing the hatch is the enforcement flip and re-setting it is the rollback).
 *
 * A mirror rather than an import because the canonical function is module-
 * private in `dataFiles.ts`, which this change does not own: that file is live
 * and enforcing in production and is not worth touching for a refactor. The
 * mirror is not trusted on inspection — `writeback.test.ts` drives this gate and
 * the real `dataFiles:sync` gate through the same env matrix and asserts they
 * accept and reject identically, so a future edit to one that is not mirrored to
 * the other fails the suite.
 *
 * The obvious cleanup (export the canonical one from dataFiles.ts and delete
 * this) is a one-line change for whoever next owns that file.
 *
 * Never logs a token or whether the caller supplied one that matched.
 */
function validateSyncToken(token?: string) {
  const expected = process.env.CONVEX_SYNC_TOKEN;
  if (process.env.ALLOW_TOKENLESS_SYNC === "true") {
    console.warn(
      expected
        ? "PERMISSIVE: ALLOW_TOKENLESS_SYNC=true is admitting this call and " +
            "CONVEX_SYNC_TOKEN is set but IGNORED. This deployment is NOT " +
            "enforcing auth. Remove ALLOW_TOKENLESS_SYNC to flip enforcement on."
        : "PERMISSIVE: ALLOW_TOKENLESS_SYNC=true is admitting this call " +
            "unauthenticated (CONVEX_SYNC_TOKEN is not configured). This " +
            "deployment is NOT enforcing auth.",
    );
    return;
  }
  if (!expected) {
    throw new Error(
      "Unauthorized: CONVEX_SYNC_TOKEN is not configured (fail-closed). " +
        "Set the token on the deployment, or set ALLOW_TOKENLESS_SYNC=true to " +
        "explicitly allow tokenless writes.",
    );
  }
  if (!token || token !== expected) {
    throw new Error("Unauthorized: invalid sync token");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rejection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A TYPE ALIAS, not an interface, and that distinction is load-bearing:
 * TypeScript gives type aliases an implicit index signature but not interfaces,
 * so an interface is not assignable to Convex's `Value` and `convex deploy`
 * rejects it. The suite never caught this because vitest does not run Convex's
 * own typecheck.
 */
export type WritebackErrorData = {
  readonly code: string;
  readonly field: string | null;
  readonly message: string;
};

/**
 * ConvexError carries structured data to the client, unlike a plain Error whose
 * message is scrubbed in production. A hand-entry form needs to know WHICH field
 * it has to put a red border around, so every rejection names one.
 *
 * Deliberately echoes the offending value in `message` for the shape-level
 * failures where seeing it is the whole point ("got 12.34" is what tells Victor
 * he typed dollars into a cents field). Never echoes a token.
 */
function reject(code: string, field: string | null, message: string): never {
  const data: WritebackErrorData = { code, field, message };
  throw new ConvexError(data);
}

// ─────────────────────────────────────────────────────────────────────────────
// Family — MIRROR of shared/domain/src/family.ts
//
// Convex functions cannot import from outside convex/ (same constraint that
// produced todoNormalize.ts), so the four members and the file routing are
// copied here and parity is asserted in the tests against the real domain
// module. If FAMILY_MEMBERS or the file routing changes there, the suite fails
// here.
// ─────────────────────────────────────────────────────────────────────────────

export const FAMILY_MEMBERS = ["victor", "rachel", "mason", "maddox"] as const;
type FamilyMember = (typeof FAMILY_MEMBERS)[number];

/** MC2 tags untagged adult records as "victor". Mirrors DEFAULT_OWNER. */
const DEFAULT_OWNER: FamilyMember = "victor";

const ADULTS: readonly FamilyMember[] = ["victor", "rachel"];

function isAdult(member: FamilyMember): boolean {
  return ADULTS.includes(member);
}

/** Mirror of mc2TransactionsFileName. Victor and Rachel share one file. */
export function transactionsFileFor(owner: FamilyMember): string {
  switch (owner) {
    case "victor":
    case "rachel":
      return "transactions";
    case "mason":
      return "mason-transactions";
    case "maddox":
      return "maddox-transactions";
  }
}

/**
 * Sign a SPEND carries in the file this owner's rows live in.
 *
 * Purchases are positive for every owner. Refunds are negative and Income is
 * positive. The caller states its intent with `kind`; a contradicting sign is
 * rejected rather than silently flipped.
 */
export function spendSignFor(_owner: FamilyMember): 1 {
  return 1;
}

function requireFamilyMember(value: string, field: string): FamilyMember {
  if (!(FAMILY_MEMBERS as readonly string[]).includes(value)) {
    reject(
      "invalid_owner",
      field,
      `${field} must be one of ${FAMILY_MEMBERS.join(", ")}, got ` +
        `${JSON.stringify(value)}`,
    );
  }
  return value as FamilyMember;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money — MIRROR of shared/domain/src/money.ts (the reader half)
// ─────────────────────────────────────────────────────────────────────────────

const MINOR_SCALE = 2;

/**
 * $1,000,000.00. A typo guard, not a policy: this household does not put a
 * seven-figure line item through a budget app, but it does fat-finger an extra
 * two zeros. Rejecting is recoverable in a way that a 100x-wrong row buried in
 * 905 others is not.
 */
const MAX_ABS_MINOR = 100_000_000;

/**
 * The wire type is float64 because that is what every Convex client can send
 * (v.int64 would require a BigInt on the wire, which the Swift and Kotlin
 * clients cannot produce). So "integer minor units" is enforced HERE, at
 * runtime, and a fractional value is rejected outright rather than rounded.
 *
 * `12.34` reaching this function almost always means the caller sent dollars
 * into a cents field, so the message says so.
 */
function requireMinorUnits(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    reject("invalid_amount", field, `${field} must be a finite number`);
  }
  if (!Number.isInteger(value)) {
    reject(
      "invalid_amount",
      field,
      `${field} must be an integer number of cents, got ${value} — ` +
        `send 1234 for $12.34, never a decimal. Rounding it here would put a ` +
        `number nobody typed into the ledger.`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    reject(
      "invalid_amount",
      field,
      `${field} is outside the exact-integer range and cannot be stored ` +
        "without loss",
    );
  }
  if (Math.abs(value) > MAX_ABS_MINOR) {
    reject(
      "amount_out_of_range",
      field,
      `${field} of ${value} cents exceeds the ${MAX_ABS_MINOR}-cent sanity ` +
        "limit; if this is real, the limit is the thing to change",
    );
  }
  return value;
}

/** Integer cents → the exact 2-dp decimal string, by string assembly only. */
export function minorUnitsToDecimalString(minor: number): string {
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(MINOR_SCALE + 1, "0");
  const whole = digits.slice(0, digits.length - MINOR_SCALE);
  const frac = digits.slice(digits.length - MINOR_SCALE);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * MIRROR of parseCents (shared/domain/src/money.ts) for a JSON number — the
 * exact path every reader takes to turn a stored `amount` back into cents.
 *
 * Mirrored rather than approximated because it is used below to PROVE the
 * round-trip, and a check against a different algorithm proves nothing. Parity
 * with the real `parseCents` is asserted in the tests.
 */
export function storedAmountToMinorUnits(value: number): bigint {
  if (!Number.isFinite(value)) {
    reject("invalid_amount", "amount", `stored amount is not finite: ${value}`);
  }
  const raw =
    Math.abs(value) < 1e21
      ? value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "")
      : String(value);

  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) {
    reject("invalid_amount", "amount", `stored amount is not decimal: ${raw}`);
  }
  const [, sign, whole = "", frac = ""] = match;
  const digits = frac.padEnd(MINOR_SCALE, "0");
  let result = BigInt((whole || "0") + digits.slice(0, MINOR_SCALE));
  const remainder = digits.slice(MINOR_SCALE);
  if (remainder !== "" && Number(remainder[0]) >= 5) result += 1n;
  return sign === "-" ? -result : result;
}

/**
 * Integer cents → the JSON number the clients decode as `amount`.
 *
 * The 905 existing rows carry `amount` as a JSON number and three clients
 * decode it that way (Swift `Decimal`, the TS read model, the Kotlin DTO), so
 * changing the stored representation to a string or adding an `amount_minor`
 * twin would either break them or leave two fields free to disagree. The
 * integer stays authoritative by construction instead: it never touches float
 * arithmetic on the way out (the decimal is assembled from digits), and the
 * result is parsed BACK through the readers' own algorithm and compared before
 * anything is written. A representation that cannot round-trip fails the write
 * rather than silently landing.
 */
export function minorUnitsToStoredAmount(minor: number, field: string): number {
  const text = minorUnitsToDecimalString(minor);
  const encoded = Number(text);
  const decoded = storedAmountToMinorUnits(encoded);
  if (decoded !== BigInt(minor)) {
    reject(
      "amount_not_representable",
      field,
      `${minor} cents does not survive the round-trip through the stored ` +
        `JSON number (${encoded} reads back as ${decoded}); refusing to write ` +
        "a value the clients would decode differently",
    );
  }
  return encoded;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Control characters, checked by code point rather than a regex literal so no
 * raw control byte ever has to live in this source file.
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Trim-equality rather than trimming for the caller: " Costco" and "Costco"
 * become two merchants in every group-by, and quietly fixing it here means the
 * client keeps sending the broken value forever. Bounded length so no single
 * field can push an audit entry (or the blob) toward Convex's document limit.
 */
function requireText(
  value: string,
  field: string,
  maxLength: number,
): string {
  if (value !== value.trim()) {
    reject(
      "invalid_text",
      field,
      `${field} has leading or trailing whitespace: ${JSON.stringify(value)}`,
    );
  }
  if (value === "") {
    reject("invalid_text", field, `${field} must not be empty`);
  }
  if (value.length > maxLength) {
    reject(
      "invalid_text",
      field,
      `${field} is ${value.length} characters; the limit is ${maxLength}`,
    );
  }
  if (hasControlChars(value)) {
    reject("invalid_text", field, `${field} contains control characters`);
  }
  return value;
}

/** Optional free text: absent preserves, null clears, a string is validated. */
function optionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === "") return null;
  return requireText(value, field, maxLength);
}

const MAX_ID = 128;
const MAX_MERCHANT = 200;
const MAX_CATEGORY = 64;
const MAX_NOTE = 2_000;
const MAX_TITLE = 500;
const MAX_NOTES = 4_000;
const MAX_ACTOR = 64;

/**
 * No character whitelist: the 905 existing rows carry MC2-generated ids in
 * several shapes and an edit has to be able to name any of them.
 */
function requireId(value: string, field: string): string {
  return requireText(value, field, MAX_ID);
}

/**
 * Who made the change, for the audit log. Free text rather than a family
 * member: "victor@linux" and "rachel@ios" are the useful answers, and a value
 * that cannot be attributed is worse than a coarse one.
 */
function requireActor(value: string): string {
  return requireText(value, "actor", MAX_ACTOR);
}

// ─────────────────────────────────────────────────────────────────────────────
// Categories
// ─────────────────────────────────────────────────────────────────────────────

function foldCategory(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Reject a near-miss of a category that already exists in this file.
 *
 * "groceries" next to "Groceries" is not two categories, it is one category and
 * a split budget line — and it is invisible until a month's numbers are wrong.
 * A genuinely new category still goes through untouched; only a value that
 * case-folds onto an existing one is refused, with the existing spelling named
 * so the caller can send it.
 */
function requireCategory(
  value: string,
  field: string,
  known: readonly string[],
): string {
  const category = requireText(value, field, MAX_CATEGORY);
  if (known.includes(category)) return category;
  const folded = foldCategory(category);
  const near = known.find((candidate) => foldCategory(candidate) === folded);
  if (near !== undefined) {
    reject(
      "category_near_miss",
      field,
      `${field} ${JSON.stringify(category)} differs only in case or spacing ` +
        `from the existing ${JSON.stringify(near)}; send that exact spelling ` +
        "or the two will split into separate budget lines",
    );
  }
  return category;
}

export const TODO_LANES = ["work", "personal", "sats"] as const;

/**
 * The todo "category" is one of three MC2 lanes. `normalizeTodoLane` COERCES
 * anything else to "sats", which is precisely the silent behaviour this door
 * exists to stop, so the value is checked before it gets there.
 */
function requireTodoLane(value: string): string {
  const lane = requireText(value, "category", MAX_CATEGORY);
  if (!(TODO_LANES as readonly string[]).includes(lane)) {
    reject(
      "invalid_category",
      "category",
      `category must be one of ${TODO_LANES.join(", ")}, got ` +
        `${JSON.stringify(lane)} (an unrecognised lane is silently filed under ` +
        `"sats" downstream, so it is refused here)`,
    );
  }
  return lane;
}

/** 0 none, 1 urgent/high, 2 medium, 3 low — the MC2 scale. */
function requirePriority(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    reject(
      "invalid_priority",
      "priority",
      `priority must be an integer 0-3 (0 none, 1 high, 2 medium, 3 low), ` +
        `got ${value}`,
    );
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON comparison
// ─────────────────────────────────────────────────────────────────────────────

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      deepEqual(left[key], right[key]),
  );
}

/**
 * Server-stamped fields, excluded from the retry comparison below.
 *
 * A retry arrives a second or two after the call it is repeating, so the
 * normalizer stamps it with a different `updatedAt`. Comparing those would make
 * every retry look like a conflicting write and reject the very case
 * idempotency exists for.
 */
const STAMP_FIELDS = [
  "createdAt",
  "created",
  "updatedAt",
  "updated_at",
  "completedAt",
];

function withoutStamps(record: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!STAMP_FIELDS.includes(key)) copy[key] = value;
  }
  return copy;
}

// ─────────────────────────────────────────────────────────────────────────────
// dataFiles plumbing (mirrors the private helpers in dataFiles.ts)
// ─────────────────────────────────────────────────────────────────────────────

type DataFileDoc = DataModel["dataFiles"]["document"];

async function loadDataFile(
  ctx: MutationCtx,
  name: string,
): Promise<DataFileDoc | null> {
  return await ctx.db
    .query("dataFiles")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
}

async function writeDataFile(
  ctx: MutationCtx,
  existing: DataFileDoc | null,
  name: string,
  data: unknown,
  now: number,
): Promise<number> {
  const version = (existing?.version ?? 0) + 1;
  if (existing) {
    await ctx.db.patch(existing._id, { data, version, updatedAt: now });
  } else {
    await ctx.db.insert("dataFiles", { name, data, version, updatedAt: now });
  }

  const versionDoc = await ctx.db
    .query("syncVersions")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
  if (versionDoc) {
    await ctx.db.patch(versionDoc._id, {
      version,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("syncVersions", { name, version, updatedAt: now });
  }
  return version;
}

function asRecordArray(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function indexOfId(rows: readonly Record<string, unknown>[], id: string): number {
  return rows.findIndex(
    (row) => row !== null && typeof row === "object" && row.id === id,
  );
}

/**
 * `todos` is stored either as a bare array or as `{ todos: [...] }` depending on
 * which MC2 writer last touched it; `applyTodoUpsert` handles both and so must
 * this, or a write to one shape silently reshapes the file for every reader.
 */
function readTodoRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return [...(data as Record<string, unknown>[])];
  if (data && typeof data === "object") {
    const wrapped = (data as { todos?: unknown }).todos;
    if (Array.isArray(wrapped)) return [...(wrapped as Record<string, unknown>[])];
  }
  return [];
}

function writeTodoRows(
  data: unknown,
  rows: Record<string, unknown>[],
): unknown {
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Array.isArray((data as { todos?: unknown }).todos)
  ) {
    return { ...(data as Record<string, unknown>), todos: rows };
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG
//
// THE QUESTION THIS ANSWERS: this is the only copy of the family's finances, and
// the MC2-era write path (`sync`, whole-file replace) kept no history at all. A
// wrong edit is therefore not just wrong, it is unrecoverable — nobody can say
// what the row said an hour ago. So an edit here PRESERVES WHAT IT REPLACED: the
// exact prior record, verbatim, before any normalization.
//
// It lives in a `dataFiles` document (`writeback-audit`) rather than a new
// table. Same Convex mutation, so the audit entry and the record commit together
// or not at all — there is no window where the ledger moved and the log did not.
// A dedicated table is the better long-term home and belongs with the task-#45
// migration; this ships the history now, without a schema change.
//
// BOUNDED ON PURPOSE. A Convex document is capped at 1 MiB, so an unbounded log
// would eventually start throwing — and because it shares the mutation, its
// failure would block the ledger write itself. An audit that can lock the family
// out of their own books is worse than one that forgets its oldest entries, so
// the log evicts from the front and counts what it dropped. `dropped` climbing
// is the signal to move it to a table.
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIT_FILE = "writeback-audit";
const AUDIT_SCHEMA = "writeback-audit/1";
export const MAX_AUDIT_ENTRIES = 2_000;
/** Half of Convex's 1 MiB document limit, leaving room for the wrapper. */
export const MAX_AUDIT_BYTES = 512 * 1024;

interface AuditEntry {
  seq: number;
  at: number;
  atIso: string;
  op: "create" | "edit";
  entity: "transaction" | "todo";
  file: string;
  id: string;
  actor: string;
  /** The exact stored record this write replaced; null for a create. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}

interface AuditLog {
  schema: string;
  nextSeq: number;
  dropped: number;
  droppedThroughSeq: number | null;
  entries: AuditEntry[];
}

export function readAuditLog(data: unknown): AuditLog {
  const source = (data ?? {}) as Partial<AuditLog>;
  const entries = Array.isArray(source.entries)
    ? (source.entries as AuditEntry[])
    : [];
  return {
    schema: AUDIT_SCHEMA,
    nextSeq:
      typeof source.nextSeq === "number" && Number.isSafeInteger(source.nextSeq)
        ? source.nextSeq
        : entries.length + 1,
    dropped: typeof source.dropped === "number" ? source.dropped : 0,
    droppedThroughSeq:
      typeof source.droppedThroughSeq === "number"
        ? source.droppedThroughSeq
        : null,
    entries,
  };
}

export function trimAuditLog(log: AuditLog): AuditLog {
  while (log.entries.length > MAX_AUDIT_ENTRIES) {
    const dropped = log.entries.shift();
    log.dropped += 1;
    if (dropped) log.droppedThroughSeq = dropped.seq;
  }
  // One serialization in the common case; the loop only re-measures when the
  // log is actually over budget, which is rare.
  while (
    log.entries.length > 1 &&
    JSON.stringify(log.entries).length > MAX_AUDIT_BYTES
  ) {
    const dropped = log.entries.shift();
    log.dropped += 1;
    if (dropped) log.droppedThroughSeq = dropped.seq;
  }
  return log;
}

/**
 * Append one entry and return its sequence number. Runs inside the caller's
 * mutation, so it shares that mutation's transaction.
 */
async function appendAudit(
  ctx: MutationCtx,
  now: number,
  entry: Omit<AuditEntry, "seq" | "at" | "atIso">,
): Promise<number> {
  const existing = await loadDataFile(ctx, AUDIT_FILE);
  const log = readAuditLog(existing?.data);
  const seq = log.nextSeq;
  log.entries.push({
    seq,
    at: now,
    atIso: new Date(now).toISOString(),
    ...entry,
  });
  log.nextSeq = seq + 1;
  await writeDataFile(ctx, existing, AUDIT_FILE, trimAuditLog(log), now);
  return seq;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `spend` is money leaving; `credit` is money arriving (income, a refund, a
 * reimbursement). It exists so the SIGN can be checked instead of imposed:
 * purchases are positive for every owner, refunds are negative, and Income is
 * positive. Flipping a contradictory number would be a coerced money value,
 * which is the one thing this module will not do.
 */
const kindValidator = v.union(v.literal("spend"), v.literal("credit"));

function requireSignAgrees(
  minor: number,
  owner: FamilyMember,
  kind: "spend" | "credit",
  category: string,
) {
  if (minor === 0) {
    reject(
      "invalid_amount",
      "amountMinor",
      "amountMinor must not be zero — a zero-value transaction has no sign to " +
        "check and is a typo in every case seen so far",
    );
  }
  // "Income" is load-bearing downstream: the read model zeroes its spend
  // contribution. A row categorised Income but declared spend would drop out of
  // the budget while looking like a purchase on the transactions screen.
  if (category === "Income" && kind !== "credit") {
    reject(
      "sign_mismatch",
      "kind",
      'a transaction categorised "Income" must be sent with kind "credit"',
    );
  }
  const expected = category === "Income" || kind === "spend" ? 1 : -1;
  const actual = minor < 0 ? -1 : 1;
  if (actual !== expected) {
    const file = transactionsFileFor(owner);
    reject(
      "sign_mismatch",
      "amountMinor",
      `a ${kind} for ${owner} must be ${expected < 0 ? "negative" : "positive"} ` +
        `in ${file} (purchases are positive and refunds are negative for every owner), ` +
        `got ${minor}. The sign is not corrected here on purpose.`,
    );
  }
}

export const createTransaction = mutation({
  args: {
    /**
     * Client-supplied, and the whole basis of idempotency: a retry after a
     * dropped connection carries the same id, finds its own row already there,
     * and returns the original result instead of entering the purchase twice.
     */
    id: v.string(),
    owner: v.string(),
    date: v.string(),
    merchant: v.string(),
    /** Integer minor units (cents). A float is rejected, never rounded. */
    amountMinor: v.float64(),
    kind: v.optional(kindValidator),
    category: v.string(),
    card: v.optional(v.union(v.string(), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
    /** Who is making the change, recorded in the audit log. */
    actor: v.string(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateSyncToken(args.token);
    const now = Date.now();

    const id = requireId(args.id, "id");
    const actor = requireActor(args.actor);
    const owner = requireFamilyMember(args.owner, "owner");
    const file = transactionsFileFor(owner);
    // 30 days forward: a purchase is dated when it happened, and a future date
    // beyond a pending charge is a typed year or month.
    const date = requireIsoDate(args.date, "date", now, 30, reject);
    const merchant = requireText(args.merchant, "merchant", MAX_MERCHANT);
    const amountMinor = requireMinorUnits(args.amountMinor, "amountMinor");
    const kind = args.kind ?? "spend";
    const card = optionalText(args.card, "card", MAX_MERCHANT) ?? null;
    const note = optionalText(args.note, "note", MAX_NOTE) ?? null;

    const existingFile = await loadDataFile(ctx, file);
    const rows = asRecordArray(existingFile?.data);
    const known = knownCategories(rows);
    const category = requireCategory(args.category, "category", known);
    requireSignAgrees(amountMinor, owner, kind, category);

    const record: Record<string, unknown> = {
      id,
      date,
      merchant,
      amount: minorUnitsToStoredAmount(amountMinor, "amountMinor"),
      category,
      card,
      note,
      owner,
    };

    const index = indexOfId(rows, id);
    if (index >= 0) {
      const stored = rows[index] as Record<string, unknown>;
      if (deepEqual(stored, record)) {
        // The retry case. Nothing changed, so the version does not move (a bump
        // would tell every polling client to re-fetch an identical file) and no
        // audit entry is written, because no edit happened.
        return {
          ok: true as const,
          file,
          id,
          version: existingFile?.version ?? 0,
          created: false,
          idempotent: true,
          auditSeq: null as number | null,
        };
      }
      reject(
        "id_conflict",
        "id",
        `a transaction with id ${JSON.stringify(id)} already exists in ${file} ` +
          "with different content. This is an id collision or a stale retry of " +
          "a superseded write, not a duplicate delivery — use " +
          "writeback:editTransaction to change the existing row.",
      );
    }

    const next = [...rows, record];
    const version = await writeDataFile(
      ctx,
      existingFile,
      file,
      next,
      now,
    );
    const auditSeq = await appendAudit(ctx, now, {
      op: "create",
      entity: "transaction",
      file,
      id,
      actor,
      before: null,
      after: record,
    });

    return {
      ok: true as const,
      file,
      id,
      version,
      created: true,
      idempotent: false,
      auditSeq,
    };
  },
});

function knownCategories(rows: readonly Record<string, unknown>[]): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    const value = row?.category;
    if (typeof value === "string" && value !== "" && !seen.includes(value)) {
      seen.push(value);
    }
  }
  return seen;
}

export const editTransaction = mutation({
  args: {
    id: v.string(),
    /**
     * Required, and required to MATCH the stored row. It selects the file, and
     * checking it means a client that thinks it is editing Mason's row can
     * never land the edit on an adult row that happens to share an id.
     */
    owner: v.string(),
    date: v.optional(v.string()),
    merchant: v.optional(v.string()),
    amountMinor: v.optional(v.float64()),
    kind: v.optional(kindValidator),
    category: v.optional(v.string()),
    card: v.optional(v.union(v.string(), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
    actor: v.string(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateSyncToken(args.token);
    const now = Date.now();

    const id = requireId(args.id, "id");
    const actor = requireActor(args.actor);
    const owner = requireFamilyMember(args.owner, "owner");
    const file = transactionsFileFor(owner);

    const existingFile = await loadDataFile(ctx, file);
    const rows = asRecordArray(existingFile?.data);
    const index = indexOfId(rows, id);
    if (index < 0) {
      // Not an upsert. A mistyped id on an edit means the caller is editing
      // something it cannot see; creating a new row for it would hide the
      // mistake behind a plausible-looking transaction.
      reject(
        "not_found",
        "id",
        `no transaction with id ${JSON.stringify(id)} in ${file}; ` +
          "editTransaction does not create rows",
      );
    }
    const stored = rows[index] as Record<string, unknown>;

    // Adult rows written by MC2 omit `owner` and mean "victor" by convention.
    const storedOwner =
      typeof stored.owner === "string" ? stored.owner : DEFAULT_OWNER;
    if (storedOwner !== owner) {
      reject(
        "owner_mismatch",
        "owner",
        `transaction ${JSON.stringify(id)} is owned by ${storedOwner}, not ` +
          `${owner}. Changing an owner moves the row between files, which is a ` +
          "move rather than an edit and is not supported here.",
      );
    }

    // Spread the stored row so MC2 keys this module does not model survive the
    // edit. A whole-record rewrite is what made the old sync path lossy.
    const record: Record<string, unknown> = { ...stored };

    if (args.date !== undefined) {
      record.date = requireIsoDate(args.date, "date", now, 30, reject);
    }
    if (args.merchant !== undefined) {
      record.merchant = requireText(args.merchant, "merchant", MAX_MERCHANT);
    }
    if (args.category !== undefined) {
      record.category = requireCategory(
        args.category,
        "category",
        knownCategories(rows),
      );
    }
    if (args.card !== undefined) {
      record.card = optionalText(args.card, "card", MAX_MERCHANT) ?? null;
    }
    if (args.note !== undefined) {
      record.note = optionalText(args.note, "note", MAX_NOTE) ?? null;
    }
    if (args.amountMinor !== undefined) {
      record.amount = minorUnitsToStoredAmount(
        requireMinorUnits(args.amountMinor, "amountMinor"),
        "amountMinor",
      );
    } else if (args.kind !== undefined) {
      reject(
        "invalid_argument",
        "kind",
        "kind only describes an amount; send amountMinor with it",
      );
    }

    // Sign and category are one invariant, so it is checked against the row's
    // FINAL state rather than against whichever half the caller happened to
    // send. Re-categorising a negative adult row as "Income" is the case that
    // matters: it changes what the budget maths does with the row, and doing it
    // without restating the amount used to slip through untouched.
    //
    // Only when one of the two actually moved. Some of the 905 imported rows
    // may not follow the convention, and an edit to an unrelated field must not
    // be blocked by a sign this module did not write.
    if (args.category !== undefined || args.amountMinor !== undefined) {
      const finalMinor = Number(
        storedAmountToMinorUnits(
          typeof record.amount === "number" ? record.amount : 0,
        ),
      );
      // With no `kind` to go on, read the intent off the sign already there;
      // the sign check then passes trivially and the Income rule is what bites.
      const kind =
        args.kind ??
        (typeof record.category === "string" && record.category === "Income"
          ? "credit"
          : args.amountMinor === undefined
          ? finalMinor < 0 === (spendSignFor(owner) < 0)
            ? "spend"
            : "credit"
          : "spend");
      requireSignAgrees(
        finalMinor,
        owner,
        kind,
        typeof record.category === "string" ? record.category : "",
      );
    }

    if (deepEqual(stored, record)) {
      // Replaying an edit that already landed. No write, no version bump, and
      // no audit entry for a change that did not happen.
      return {
        ok: true as const,
        file,
        id,
        version: existingFile?.version ?? 0,
        changed: false,
        idempotent: true,
        auditSeq: null as number | null,
      };
    }

    const next = [...rows];
    next[index] = record;
    const version = await writeDataFile(
      ctx,
      existingFile,
      file,
      next,
      now,
    );
    const auditSeq = await appendAudit(ctx, now, {
      op: "edit",
      entity: "transaction",
      file,
      id,
      actor,
      before: stored,
      after: record,
    });

    return {
      ok: true as const,
      file,
      id,
      version,
      changed: true,
      idempotent: false,
      auditSeq,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// TODOS
//
// Normalization is NOT reimplemented: these mutations validate, then hand off to
// the same `normalizeTodoRecord` / `mergeTodoPayload` that `dataFiles.upsertTodo`
// uses, so a todo written here is byte-identical in shape to one written by the
// existing path. Only the read-merge-write plumbing is duplicated, because
// `applyTodoUpsert` is module-private in a file this change does not own.
//
// Unlike `upsertTodo` there is no last-write-wins branch. LWW makes out-of-order
// legacy blob replays safe; these mutations are direct edits that
// the server stamps itself, and a client-supplied `updated_at` deciding who wins
// a ledger conflict is a clock nobody controls. Neither mutation declares a
// timestamp argument, and Convex refuses any argument its validator does not
// declare, so a client simply cannot supply one.
// ─────────────────────────────────────────────────────────────────────────────

const TODO_FILE = "todos";

export const createTodo = mutation({
  args: {
    /** Client-supplied, for the same retry reason as createTransaction. */
    id: v.string(),
    title: v.string(),
    /** One of the three MC2 lanes: work, personal, sats. */
    category: v.string(),
    owner: v.string(),
    assignee: v.optional(v.string()),
    project: v.optional(v.string()),
    area: v.optional(v.string()),
    notes: v.optional(v.string()),
    dueDate: v.optional(v.union(v.string(), v.null())),
    priority: v.optional(v.float64()),
    flag: v.optional(v.boolean()),
    done: v.optional(v.boolean()),
    actor: v.string(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateSyncToken(args.token);
    const now = Date.now();

    const id = requireId(args.id, "id");
    const actor = requireActor(args.actor);
    const owner = requireFamilyMember(args.owner, "owner");
    const assignee =
      args.assignee === undefined
        ? owner
        : requireFamilyMember(args.assignee, "assignee");
    const title = requireText(args.title, "title", MAX_TITLE);
    const category = requireTodoLane(args.category);
    // Ten years forward: a due date is allowed to be genuinely distant, unlike
    // a transaction date.
    const dueDate =
      args.dueDate === undefined || args.dueDate === null || args.dueDate === ""
        ? ""
        : requireIsoDate(args.dueDate, "dueDate", now, 3_650, reject);

    const payload: Record<string, unknown> = {
      id,
      title,
      text: title,
      category,
      owner,
      assignee,
      project: args.project === undefined ? undefined : requireText(args.project, "project", MAX_CATEGORY),
      area: args.area === undefined ? undefined : requireText(args.area, "area", MAX_CATEGORY),
      notes: args.notes === undefined ? undefined : requireText(args.notes, "notes", MAX_NOTES),
      dueDate,
      priority: args.priority === undefined ? 0 : requirePriority(args.priority),
      flag: args.flag ?? false,
      done: args.done ?? false,
      created_by: "vogel-vault",
      sync_source: "vogel-vault",
      createdAt: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    };

    const existingFile = await loadDataFile(ctx, TODO_FILE);
    const rows = readTodoRows(existingFile?.data);
    const record = normalizeTodoRecord(payload, { now });

    const index = indexOfId(rows, id);
    if (index >= 0) {
      const stored = rows[index] as Record<string, unknown>;
      // Stamps excluded: a retry is normalized with a later `now`, so an exact
      // comparison would call every retry a conflict.
      if (deepEqual(withoutStamps(stored), withoutStamps(record))) {
        return {
          ok: true as const,
          file: TODO_FILE,
          id,
          version: existingFile?.version ?? 0,
          created: false,
          idempotent: true,
          auditSeq: null as number | null,
        };
      }
      reject(
        "id_conflict",
        "id",
        `a todo with id ${JSON.stringify(id)} already exists with different ` +
          "content; use writeback:editTodo to change it",
      );
    }

    const next = [...rows, record];
    const version = await writeDataFile(
      ctx,
      existingFile,
      TODO_FILE,
      writeTodoRows(existingFile?.data, next),
      now,
    );
    const auditSeq = await appendAudit(ctx, now, {
      op: "create",
      entity: "todo",
      file: TODO_FILE,
      id,
      actor,
      before: null,
      after: record,
    });

    return {
      ok: true as const,
      file: TODO_FILE,
      id,
      version,
      created: true,
      idempotent: false,
      auditSeq,
    };
  },
});

export const editTodo = mutation({
  args: {
    id: v.string(),
    title: v.optional(v.string()),
    category: v.optional(v.string()),
    owner: v.optional(v.string()),
    assignee: v.optional(v.string()),
    project: v.optional(v.string()),
    area: v.optional(v.string()),
    notes: v.optional(v.string()),
    /** null clears the due date; absent preserves it. */
    dueDate: v.optional(v.union(v.string(), v.null())),
    priority: v.optional(v.float64()),
    flag: v.optional(v.boolean()),
    done: v.optional(v.boolean()),
    actor: v.string(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateSyncToken(args.token);
    const now = Date.now();

    const id = requireId(args.id, "id");
    const actor = requireActor(args.actor);

    const existingFile = await loadDataFile(ctx, TODO_FILE);
    const rows = readTodoRows(existingFile?.data);
    const index = indexOfId(rows, id);
    if (index < 0) {
      reject(
        "not_found",
        "id",
        `no todo with id ${JSON.stringify(id)}; editTodo does not create todos`,
      );
    }
    const stored = rows[index] as Record<string, unknown>;

    // Only the keys the caller actually sent reach the merge. `undefined` is
    // "preserve" and never reaches normalizeTodoRecord, which would default it.
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) {
      const title = requireText(args.title, "title", MAX_TITLE);
      patch.title = title;
      patch.text = title;
    }
    if (args.category !== undefined) patch.category = requireTodoLane(args.category);
    if (args.owner !== undefined) {
      patch.owner = requireFamilyMember(args.owner, "owner");
    }
    if (args.assignee !== undefined) {
      patch.assignee = requireFamilyMember(args.assignee, "assignee");
    }
    if (args.project !== undefined) {
      patch.project = requireText(args.project, "project", MAX_CATEGORY);
    }
    if (args.area !== undefined) {
      patch.area = requireText(args.area, "area", MAX_CATEGORY);
    }
    if (args.notes !== undefined) {
      patch.notes = args.notes === "" ? "" : requireText(args.notes, "notes", MAX_NOTES);
    }
    if (args.dueDate !== undefined) {
      patch.dueDate =
        args.dueDate === null || args.dueDate === ""
          ? ""
          : requireIsoDate(args.dueDate, "dueDate", now, 3_650, reject);
    }
    if (args.priority !== undefined) patch.priority = requirePriority(args.priority);
    if (args.flag !== undefined) patch.flag = args.flag;
    if (args.done !== undefined) patch.done = args.done;

    if (Object.keys(patch).length === 0) {
      reject("invalid_argument", null, "editTodo needs at least one field to change");
    }

    // Server stamp, set explicitly: mergeTodoPayload would otherwise inherit the
    // stored `updated_at` and the edit would look older than it is.
    patch.updated_at = new Date(now).toISOString();

    const record = normalizeTodoRecord(mergeTodoPayload(stored, patch, { now }), {
      now,
    });

    if (deepEqual(withoutStamps(stored), withoutStamps(record))) {
      return {
        ok: true as const,
        file: TODO_FILE,
        id,
        version: existingFile?.version ?? 0,
        changed: false,
        idempotent: true,
        auditSeq: null as number | null,
      };
    }

    const next = [...rows];
    next[index] = record;
    const version = await writeDataFile(
      ctx,
      existingFile,
      TODO_FILE,
      writeTodoRows(existingFile?.data, next),
      now,
    );
    const auditSeq = await appendAudit(ctx, now, {
      op: "edit",
      entity: "todo",
      file: TODO_FILE,
      id,
      actor,
      before: stored,
      after: record,
    });

    return {
      ok: true as const,
      file: TODO_FILE,
      id,
      version,
      changed: true,
      idempotent: false,
      auditSeq,
    };
  },
});
