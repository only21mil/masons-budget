// The Vogel Vault — row tables.
//
// WHAT THIS FILE IS FOR
//
// MC2 (mission-control) died on 2026-07-18 and nothing has written to Convex
// since. Convex is now the system of record, not a sync target. The `dataFiles`
// blob shape cannot hold that job:
//
//   - all 905 transactions live in ONE document behind a v.any() blob;
//   - appendTransaction rewrites all 905 of them to add one;
//   - every write bumps a version that forces clients to re-download the array;
//   - there are no indexes, so "July, Mason" reads the whole file;
//   - whole-file replace means no per-record history on what is now the only
//     copy of the family's financial record.
//
// This file is the typed runtime API: queries and mutations over row collections
// (`transactions`, `todos`, `btcBuys`, `btcAccounts`) plus read queries over the
// atomic budget, BTC-balance and finance document tables. The one-shot backfill
// lives separately in convex/migrate.ts as an internal-only, dry-run-first path;
// document-shaped projection logic lives in convex/documentProjection.ts so the
// migration lane can wire it without colliding with this file.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//
// It does not touch `dataFiles` or `syncVersions`. Todo writes do maintain the
// separate compatibility `todoTombstones` markers that keep shipped blob readers
// from resurfacing stale content. The source blobs otherwise stay byte-identical
// until clients have moved and a later cutover removes them.
//
// THREE MIRRORS LIVE IN THIS FILE, ALL FOR THE SAME REASON
//
// Convex functions cannot import from outside `convex/`, so the auth gates
// (convex/dataFiles.ts), the visibility rule (shared/domain/src/family.ts, port
// of MasonsBudget/MasonsBudget/Models/SharedEnums.swift) and the decimal-safe
// money parser (shared/domain/src/money.ts) are hand-copied below. Each mirror
// names its canonical source. convex/todoNormalize.ts already does exactly this
// and says the same thing; the "auth" block in tables.test.ts pins the auth
// mirror against dataFiles.ts so the two cannot silently drift.

import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { query, mutation, type MutationCtx } from "./_generated/server";
import { isRealIsoDate, requireIsoDate } from "./dateValidation";
import { authenticateDevice, markDeviceSeen } from "./deviceAuth";
import {
  addDelta,
  applyBtcAccountDeltas,
  canonicalRiverAccountKey,
  riverAccountKey,
  type BtcTransferRow,
} from "./btcLedger";
import {
  type SharesDecimalOptions,
  canonicalizeSharesDecimal,
} from "./documentProjection";
import {
  btcBillPayBudgetEffectValidator,
  custodyValidator,
  familyMemberValidator,
  fiatValuationValidator,
} from "./schema";
import { normalizeTodoRecord, todoUpdatedMs } from "./todoNormalize";

declare const process: { env: Record<string, string | undefined> };

// ─────────────────────────────────────────────────────────────────────────────
// MIRROR 1 — auth gates
//
// CANONICAL SOURCE: convex/dataFiles.ts (validateReadToken / validateSyncToken).
// Copied verbatim, including the hatch-outranks-the-token precedence and the
// asymmetric throw types (sync throws Error, read throws ConvexError). Do not
// "tidy" either difference here: the point of a mirror is that a caller cannot
// tell which file answered it. If you change a gate in dataFiles.ts you MUST
// change it here, and the auth block in tables.test.ts will fail until you do.
//
// THE ESCAPE HATCH OUTRANKS THE TOKEN. ALLOW_TOKENLESS_{READ,SYNC}="true" admits
// the call even when the matching token IS configured, and is checked first. The
// full argument for that ordering is in the banner in dataFiles.ts; the short
// version is that the opposite ordering locks the whole household out remotely
// the instant a token is set, and nothing detects that.
//
// CONVEX_SYNC_TOKEN is the legacy full-admin write credential, not a paired
// device capability. It authorizes every mutation in this compatibility
// surface, including Bitcoin posting. Paired devices remain least-privilege and
// require their explicit resource capabilities below. Retire this broad route
// only through a coordinated client migration; do not describe it as
// `bitcoin:write`-scoped.
// ─────────────────────────────────────────────────────────────────────────────

function warnPermissive(hatchVar: string, tokenVar: string, tokenSet: boolean) {
  console.warn(
    tokenSet
      ? `PERMISSIVE: ${hatchVar}=true is admitting this call and ${tokenVar} ` +
          `is set but IGNORED. This deployment is NOT enforcing auth. Remove ` +
          `${hatchVar} to flip enforcement on.`
      : `PERMISSIVE: ${hatchVar}=true is admitting this call unauthenticated ` +
          `(${tokenVar} is not configured). This deployment is NOT enforcing auth.`,
  );
}

function validateSyncToken(token?: string) {
  const expected = process.env.CONVEX_SYNC_TOKEN;
  if (process.env.ALLOW_TOKENLESS_SYNC === "true") {
    warnPermissive(
      "ALLOW_TOKENLESS_SYNC",
      "CONVEX_SYNC_TOKEN",
      Boolean(expected),
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

function validateReadToken(token?: string) {
  const expected = process.env.CONVEX_READ_TOKEN;
  if (process.env.ALLOW_TOKENLESS_READ === "true") {
    warnPermissive(
      "ALLOW_TOKENLESS_READ",
      "CONVEX_READ_TOKEN",
      Boolean(expected),
    );
    return;
  }
  if (!expected) {
    throw new ConvexError(
      "Unauthorized: CONVEX_READ_TOKEN is not configured (fail-closed). " +
        "Set the token on the deployment, or set ALLOW_TOKENLESS_READ=true to " +
        "explicitly allow unauthenticated reads during cutover.",
    );
  }
  if (!token || token !== expected) {
    throw new ConvexError("Unauthorized: invalid read token");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIRROR 2 — the family / visibility rule
//
// CANONICAL SOURCE: shared/domain/src/family.ts, itself a port of
// MasonsBudget/MasonsBudget/Models/SharedEnums.swift. Parity for the TS and
// Kotlin ports is enforced by shared/domain/fixtures/visibility-cases.json;
// tables.test.ts re-checks both rules through these queries, on the same data.
//
// TWO RULES, DELIBERATELY DIFFERENT WIDTHS. Getting them backwards is the whole
// hazard:
//
//   canSeeDataOwnedBy — adults see EVERYONE, kids see only themselves. Wider.
//   sharesNetWorthWith — adults + adults only. Narrower. A child's stack must
//                        never roll into an adult net-worth total, even though
//                        an adult can see it on the child's profile.
//
// And the rule that gets forgotten in the other direction: Victor and Rachel are
// ONE household. Adult records default to owner "victor", so a strict
// `owner === viewer` check empties every one of Rachel's screens. That bug
// shipped in v0.3. Never strict equality — always go through these two.
// ─────────────────────────────────────────────────────────────────────────────

const FAMILY_MEMBERS = ["victor", "rachel", "mason", "maddox"] as const;
type FamilyMember = (typeof FAMILY_MEMBERS)[number];

/** MC2 tags untagged ADULT records as "victor". Mirrors the Swift default. */
const DEFAULT_OWNER: FamilyMember = "victor";

const ADULTS: ReadonlySet<string> = new Set(["victor", "rachel"]);

function isFamilyMember(value: unknown): value is FamilyMember {
  return (
    typeof value === "string" &&
    (FAMILY_MEMBERS as readonly string[]).includes(value)
  );
}

function isAdult(member: FamilyMember): boolean {
  return ADULTS.has(member);
}

function canSeeDataOwnedBy(viewer: FamilyMember, owner: FamilyMember): boolean {
  if (viewer === owner) return true;
  if (isAdult(viewer)) return true;
  return false;
}

function sharesNetWorthWith(
  viewer: FamilyMember,
  owner: FamilyMember,
): boolean {
  if (viewer === owner) return true;
  return isAdult(viewer) && isAdult(owner);
}

/**
 * The owners a viewer may be shown, as a concrete list.
 *
 * Rows let the server do the filtering that used to happen client-side after the
 * whole file had already been shipped. Turning the predicate into a list of
 * owners is what makes that an INDEX RANGE per owner rather than a table scan
 * plus a filter — the queries below never call `.filter()` on owner.
 *
 * HONEST SCOPE: `viewer` is asserted by the caller, and CONVEX_READ_TOKEN is one
 * shared household secret. This is not authorization and must not be described
 * as such — anyone holding the read token can pass any viewer. It is the same
 * trust level as today's client-side filter, with the bandwidth and correctness
 * win of doing it once, server-side, in one place. Per-identity auth is a
 * separate piece of work.
 */
type VisibilityScope = "visible" | "netWorth";

function ownersInScope(
  viewer: FamilyMember,
  scope: VisibilityScope,
): FamilyMember[] {
  const rule = scope === "netWorth" ? sharesNetWorthWith : canSeeDataOwnedBy;
  return FAMILY_MEMBERS.filter((owner) => rule(viewer, owner));
}

/**
 * The owner to store for a record, given the file it came from.
 *
 * DELIBERATELY STRICTER THAN readModel.normalizeTransaction, which falls back to
 * the file's owner only when `owner` is absent and otherwise runs coerceOwner —
 * and coerceOwner maps ANY unrecognised string to "victor", an ADULT. So a
 * single typo in mason-transactions.json ("Mason", "mason ", "mason\n") would
 * promote a child's row into the adult household view and into adult net worth.
 *
 * Here the file's own owner is the fallback for every value that is not exactly
 * a family member, absent or not. mason-transactions can only ever produce mason
 * rows. The schema's closed literal union then refuses anything else outright.
 */
function resolveOwner(raw: unknown, fileOwner: FamilyMember): FamilyMember {
  return isFamilyMember(raw) ? raw : fileOwner;
}

function postsToHouseholdBitcoinLedger(owner: FamilyMember): boolean {
  return owner === "victor" || owner === "rachel";
}

// ─────────────────────────────────────────────────────────────────────────────
// MIRROR 3 — decimal-safe money
//
// CANONICAL SOURCE: shared/domain/src/money.ts.
//
// Money is integer minor units everywhere: USD in cents, BTC in satoshis, both
// stored as int64. The blobs carry money as JSON numbers, so by the time a value
// reaches this code it is already a double — the job is to get out of float
// without making it worse. `value * 100` accumulates error (1.15 * 100 is
// 114.99999999999999); going through the LEXICAL form does not.
// ─────────────────────────────────────────────────────────────────────────────

function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value))
    throw new RangeError(`Not a finite number: ${value}`);
  // Avoid exponential notation for the magnitudes this data uses.
  if (Math.abs(value) < 1e21) {
    return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(value);
}

function parseMinorUnits(value: unknown, scale: number): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value === "bigint") return value;

  const raw =
    typeof value === "number"
      ? numberToDecimalString(value)
      : String(value).trim();
  if (raw === "") return 0n;

  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match)
    throw new RangeError(`Not a decimal value: ${JSON.stringify(value)}`);

  const [, sign, whole = "", frac = ""] = match;
  if (whole === "" && frac === "") {
    throw new RangeError(`Not a decimal value: ${JSON.stringify(value)}`);
  }

  // Pad or round the fraction to the target scale, half away from zero — the
  // same rounding NSDecimalNumber's .plain mode gives the Swift client.
  const digits = frac.padEnd(scale, "0");
  let result = BigInt((whole || "0") + digits.slice(0, scale));

  const remainder = digits.slice(scale);
  if (remainder !== "" && Number(remainder[0]) >= 5) result += 1n;

  return sign === "-" ? -result : result;
}

/** USD → integer cents. */
function parseCents(value: unknown): bigint {
  return parseMinorUnits(value, 2);
}

/** BTC → integer satoshis (8 dp). */
function parseBtcToSats(value: unknown): bigint {
  return parseMinorUnits(value, 8);
}

/**
 * Satoshis from an MC2 buy record.
 *
 * `amount_sats` is authoritative and `amount_btc` is a convenience mirror, so
 * the integer field wins whenever it is present. Same precedence as
 * readModel.normalizeBTCBuy.
 */
function satsFromBuy(raw: Record<string, unknown>): bigint {
  if (raw.amount_sats !== undefined && raw.amount_sats !== null) {
    return BigInt(String(raw.amount_sats));
  }
  return parseBtcToSats(raw.amount_btc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `yyyy-MM` for a `yyyy-MM-dd` date. Mirrors readModel.monthOf.
 *
 * A prefix, not a parsed Date: a transaction dated 2026-07-01 belongs to July in
 * every timezone, which is the behaviour a ledger needs. THE ONE PLACE the
 * denormalised `month` column is computed — every write path below goes through
 * here so the column cannot drift from `date`.
 */
function monthOf(date: string): string {
  return date.slice(0, 7);
}

function rejectRowDate(code: string, field: string, message: string): never {
  throw new ConvexError({ code, field, message });
}

function rejectDeviceDate(
  _code: string,
  _field: string,
  message: string,
): never {
  deviceFailure("VALIDATION_FAILED", message);
}

/** null, undefined and "" all mean "nothing here"; store the field as absent. */
function optionalText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  return text === "" ? undefined : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Newest first, with a stable tiebreak so paging cannot repeat or drop a row. */
function byDateDescending<T extends { date: string; _id: string }>(a: T, b: T) {
  if (a.date === b.date) return a._id < b._id ? 1 : -1;
  return a.date < b.date ? 1 : -1;
}

function byIncomeDateDescending<T extends { date: string; incomeId: string }>(
  a: T,
  b: T,
) {
  if (a.date === b.date) return a.incomeId < b.incomeId ? 1 : -1;
  return a.date < b.date ? 1 : -1;
}

// A no-limit request means "give me one complete replacement snapshot", not
// "return a convenient first page". 2,000 is intentionally above today's
// largest table (905 transactions) while staying below Convex's practical
// per-function read ceiling. If a table outgrows this, callers must move to a
// cursor contract rather than silently accepting a partial replacement set.
export const PUBLIC_SNAPSHOT_HARD_MAX = 2_000;

type PublicEnvelope<T> = {
  rows: T[];
  complete: boolean;
};

function requestedRowCap(limit: number | undefined, queryName: string): number {
  if (limit === undefined) return PUBLIC_SNAPSHOT_HARD_MAX + 1;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > PUBLIC_SNAPSHOT_HARD_MAX
  ) {
    throw new ConvexError(
      `${queryName}: limit must be an integer from 1 to ${PUBLIC_SNAPSHOT_HARD_MAX}.`,
    );
  }
  return limit;
}

function publicEnvelope<T>(
  rows: T[],
  limit: number | undefined,
  queryName: string,
): PublicEnvelope<T> {
  if (limit !== undefined) {
    // A bounded request is intentionally not a replacement snapshot. There is
    // no cursor in this narrow client contract, so never imply otherwise even
    // when today's table happens to contain fewer rows than the supplied cap.
    return { rows: rows.slice(0, limit), complete: false };
  }
  if (rows.length > PUBLIC_SNAPSHOT_HARD_MAX) {
    throw new ConvexError(
      `${queryName}: complete snapshot exceeds the hard maximum of ` +
        `${PUBLIC_SNAPSHOT_HARD_MAX} rows. Supply an explicit limit for a ` +
        `known-incomplete diagnostic read; do not replace a client snapshot.`,
    );
  }
  return { rows, complete: true };
}

// Public reads never return a Convex document directly. These explicit
// projections are the API allowlist: `_id`, `_creationTime`, `migrationRaw`,
// `migrationSourceIndex`, and source-file migration provenance cannot leak by a
// future schema addition or an object spread.
function projectTransaction(row: {
  txId: string;
  owner: FamilyMember;
  date: string;
  month: string;
  merchant: string;
  amountCents: bigint;
  category: string;
  card?: string;
  note?: string;
  amountSats?: bigint;
  bitcoinAccountKey?: string;
  balancePostingVersion?: bigint;
  updatedAtMs: number;
}) {
  // CANONICAL SOURCE: shared/domain/src/readModel.ts (spendAmount,
  // displaySpendAmount, hasOppositeSpendSign), mirrored by
  // MasonsBudget/MasonsBudget/Models/Transaction.swift.
  //
  const spendAmount = row.category === "Income" ? 0n : row.amountCents;
  const displaySpendAmount = spendAmount < 0n ? -spendAmount : spendAmount;

  return {
    txId: row.txId,
    owner: row.owner,
    date: row.date,
    month: row.month,
    merchant: row.merchant,
    amountCents: row.amountCents,
    spendAmount,
    displaySpendAmount,
    hasOppositeSpendSign: spendAmount < 0n,
    category: row.category,
    card: row.card,
    note: row.note,
    amountSats: row.amountSats,
    bitcoinAccountKey: row.bitcoinAccountKey,
    balancePostingVersion: row.balancePostingVersion,
    updatedAtMs: row.updatedAtMs,
  };
}

function projectIncome(row: {
  incomeId: string;
  owner: FamilyMember;
  date: string;
  month: string;
  amountCents: bigint;
  source: string;
  loggedBy?: string;
  note?: string;
  archimedesRequestId?: string;
  updatedAtMs: number;
}) {
  return {
    incomeId: row.incomeId,
    owner: row.owner,
    date: row.date,
    month: row.month,
    amountCents: row.amountCents,
    source: row.source,
    loggedBy: row.loggedBy,
    note: row.note,
    archimedesRequestId: row.archimedesRequestId,
    updatedAtMs: row.updatedAtMs,
  };
}

function projectTodo(row: {
  todoId: string;
  owner: FamilyMember;
  title: string;
  done: boolean;
  flagged: boolean;
  lane?: string;
  project?: string;
  area?: string;
  due?: string;
  notes?: string;
  priority?: bigint;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  updatedAtMs: number;
}) {
  return {
    todoId: row.todoId,
    owner: row.owner,
    title: row.title,
    done: row.done,
    flagged: row.flagged,
    lane: row.lane,
    project: row.project,
    area: row.area,
    due: row.due,
    notes: row.notes,
    priority: row.priority,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    updatedAtMs: row.updatedAtMs,
  };
}

function projectBtcBuy(row: {
  buyId: string;
  owner: FamilyMember;
  date: string;
  month: string;
  source: string;
  sats: bigint;
  priceUsdCents: bigint;
  usdCents: bigint;
  feeUsdCents?: bigint;
  note?: string;
  status?: string;
  costBasisStatus?: string;
  loggedBy?: string;
  archimedesRequestId?: string;
  updatedAtMs: number;
}) {
  return {
    buyId: row.buyId,
    owner: row.owner,
    date: row.date,
    month: row.month,
    source: row.source,
    sats: row.sats,
    priceUsdCents: row.priceUsdCents,
    usdCents: row.usdCents,
    feeUsdCents: row.feeUsdCents ?? 0n,
    note: row.note,
    status: row.status,
    costBasisStatus: row.costBasisStatus,
    loggedBy: row.loggedBy,
    archimedesRequestId: row.archimedesRequestId,
    updatedAtMs: row.updatedAtMs,
  };
}

function projectBtcBillPay(row: {
  billPayId: string;
  owner: FamilyMember;
  date: string;
  month: string;
  merchant: string;
  category: string;
  budgetEffect?: "budget_category" | "credit_card_payment";
  amountUsdCents: bigint;
  btcSpentSats: bigint;
  btcPriceCents: bigint;
  platform?: string;
  note?: string;
  feeUsdCents: bigint;
  reference?: string;
  updatedAtMs: number;
}) {
  return {
    billPayId: row.billPayId,
    owner: row.owner,
    date: row.date,
    month: row.month,
    merchant: row.merchant,
    category:
      (row.budgetEffect ?? "credit_card_payment") === "credit_card_payment"
        ? "Credit Card Payment"
        : row.category,
    budgetEffect: row.budgetEffect ?? "credit_card_payment",
    amountUsdCents: row.amountUsdCents,
    btcSpentSats: row.btcSpentSats,
    btcPriceCents: row.btcPriceCents,
    platform: row.platform,
    note: row.note,
    feeUsdCents: row.feeUsdCents,
    reference: row.reference,
    updatedAtMs: row.updatedAtMs,
  };
}

function projectBtcTransfer(row: {
  transferId: string;
  owner: FamilyMember;
  date: string;
  month: string;
  fromAccountKey: string;
  toAccountKey: string;
  sats: bigint;
  feeSats: bigint;
  note?: string;
  updatedAtMs: number;
}) {
  return {
    transferId: row.transferId,
    owner: row.owner,
    date: row.date,
    month: row.month,
    fromAccountKey: row.fromAccountKey,
    toAccountKey: row.toAccountKey,
    sats: row.sats,
    feeSats: row.feeSats,
    note: row.note,
    updatedAtMs: row.updatedAtMs,
  };
}

function projectBtcAccount(row: {
  key: string;
  owner: FamilyMember;
  label: string;
  custody: "exchange" | "self_custody";
  sats: bigint;
  fiatCents?: bigint;
  fiatValuation?: {
    cents: bigint;
    priceCents?: bigint;
    quotedAt?: string;
    source?: string;
    confidence?: string;
  };
  asOf: string;
  schemaVersion: bigint;
  updatedAtMs: number;
}) {
  return {
    key: row.key,
    owner: row.owner,
    label: row.label,
    custody: row.custody,
    sats: row.sats,
    fiatCents: row.fiatCents,
    fiatValuation: row.fiatValuation,
    asOf: row.asOf,
    schemaVersion: row.schemaVersion,
    updatedAtMs: row.updatedAtMs,
  };
}

function publicBudgetDocument(row: {
  owner: FamilyMember;
  month: string;
  coinbaseOneBalanceCents: bigint;
  categories: Array<{
    name: string;
    icon?: string;
    budgetCents: bigint;
  }>;
  effectiveApr?: string;
  strategyNote?: string;
  income?: {
    weeklyGrossCents: bigint;
    weeklyStrikeCents: bigint;
    weeklyRiverCents: bigint;
    payFrequency?: string;
    monthlyGrossCents: bigint;
    mtdIncomeCents: bigint;
    ytdIncomeCents: bigint;
    paychecks: Array<{
      date: string;
      platform?: string;
      source?: string;
      amountCents: bigint;
      netCents: bigint;
      note?: string;
    }>;
  };
  mtdIncomeCents: bigint;
  ytdIncomeCents: bigint;
  monthlyHistory: Array<{
    month: string;
    incomeCents: bigint;
    expensesCents: bigint;
    savingsBps: bigint;
  }>;
  allowance?: {
    weeklyCents: bigint;
    source: string;
  };
  updatedAtMs: number;
}) {
  return {
    owner: row.owner,
    month: row.month,
    coinbaseOneBalanceCents: row.coinbaseOneBalanceCents,
    categories: row.categories.map((category) => ({
      name: category.name,
      icon: category.icon,
      budgetCents: category.budgetCents,
    })),
    effectiveApr: row.effectiveApr,
    strategyNote: row.strategyNote,
    income: row.income
      ? {
          weeklyGrossCents: row.income.weeklyGrossCents,
          weeklyStrikeCents: row.income.weeklyStrikeCents,
          weeklyRiverCents: row.income.weeklyRiverCents,
          payFrequency: row.income.payFrequency,
          monthlyGrossCents: row.income.monthlyGrossCents,
          mtdIncomeCents: row.income.mtdIncomeCents,
          ytdIncomeCents: row.income.ytdIncomeCents,
          paychecks: row.income.paychecks.map((paycheck) => ({
            date: paycheck.date,
            platform: paycheck.platform,
            source: paycheck.source,
            amountCents: paycheck.amountCents,
            netCents: paycheck.netCents,
            note: paycheck.note,
          })),
        }
      : undefined,
    mtdIncomeCents: row.mtdIncomeCents,
    ytdIncomeCents: row.ytdIncomeCents,
    monthlyHistory: row.monthlyHistory.map((entry) => ({
      month: entry.month,
      incomeCents: entry.incomeCents,
      expensesCents: entry.expensesCents,
      savingsBps: entry.savingsBps,
    })),
    allowance: row.allowance
      ? {
          weeklyCents: row.allowance.weeklyCents,
          source: row.allowance.source,
        }
      : undefined,
    updatedAtMs: row.updatedAtMs,
  };
}

function publicBtcBalanceDocument(row: {
  sourceFile: string;
  owner: FamilyMember;
  schemaVersion: bigint;
  asOf: string;
  accounts: Array<{
    key: string;
    label: string;
    custody: "exchange" | "self_custody";
    sats: bigint;
    fiatCents?: bigint;
    fiatValuation?: {
      cents: bigint;
      priceCents?: bigint;
      quotedAt?: string;
      source?: string;
      confidence?: string;
    };
  }>;
  totals: {
    sats: bigint;
    fiatCents?: bigint;
    exchangeSats: bigint;
    selfCustodySats: bigint;
  };
  source?: string;
  basis?: string;
  confidence?: string;
  postingActivatedAtMs?: number;
  activationBaseline?: {
    asOf: string;
    baselinedIncomeTxIds: string[];
    skippedIncomeTxIds: string[];
  };
  updatedAtMs: number;
}) {
  return {
    sourceFile: row.sourceFile,
    owner: row.owner,
    schemaVersion: row.schemaVersion,
    asOf: row.asOf,
    accounts: row.accounts.map((account) => ({
      key: account.key,
      label: account.label,
      custody: account.custody,
      sats: account.sats,
      fiatCents: account.fiatCents,
      fiatValuation: account.fiatValuation,
    })),
    totals: {
      sats: row.totals.sats,
      fiatCents: row.totals.fiatCents,
      exchangeSats: row.totals.exchangeSats,
      selfCustodySats: row.totals.selfCustodySats,
    },
    source: row.source,
    basis: row.basis,
    confidence: row.confidence,
    postingActivatedAtMs: row.postingActivatedAtMs,
    // The runbook requires reading this back after activation; without it here
    // the record is written durably and is still unreachable to the operator.
    activationBaseline: row.activationBaseline,
    updatedAtMs: row.updatedAtMs,
  };
}

/**
 * Positional, non-private labels for the two share sites.
 *
 * These strings are the only text that survives into a thrown RangeError, and a
 * thrown RangeError reaches the Convex function log. They therefore say *which
 * field* failed and nothing about whose money it is: no account key, no holding
 * name, no ticker, no index, no quantity.
 */
const HOLDING_SHARES_CONTEXT = "financeDocuments holding sharesDecimal";
const LOT_SHARES_CONTEXT = "financeDocuments lot sharesDecimal";

/**
 * One repaired-or-not flag for a whole getFinanceDocument execution.
 *
 * Mutable rather than returned because the accounts are produced by a `map`; the
 * flag is a boolean and never a count, since a count of repaired lots is itself
 * a fact about the household's positions.
 */
interface SharesRepairTally {
  repaired: boolean;
}

function publicFinanceAccount(
  row: {
    key: string;
    owner: FamilyMember;
    provider: string;
    totalValueCents: bigint;
    weeklyContributionCents: bigint;
    weeklyContributionDay?: string;
    holdings: Array<{
      name: string;
      category: string;
      ticker?: string;
      valueCents: bigint;
      costBasisCents: bigint;
      gainBps: bigint;
      sharesDecimal: string;
      avgCostCents: bigint;
      currentPricePerShareCents: bigint;
      isProxy: boolean;
      proxyNote?: string;
      lots: Array<{
        date: string;
        type: string;
        pricePerShareCents: bigint;
        sharesDecimal: string;
        amountInvestedCents: bigint;
        note?: string;
      }>;
    }>;
  },
  repairs: SharesRepairTally,
) {
  return {
    key: row.key,
    owner: row.owner,
    provider: row.provider,
    totalValueCents: row.totalValueCents,
    weeklyContributionCents: row.weeklyContributionCents,
    weeklyContributionDay: row.weeklyContributionDay,
    holdings: row.holdings.map((holding) => ({
      name: holding.name,
      category: holding.category,
      ticker: holding.ticker,
      valueCents: holding.valueCents,
      costBasisCents: holding.costBasisCents,
      gainBps: holding.gainBps,
      sharesDecimal: canonicalStoredShares(
        holding.sharesDecimal,
        HOLDING_SHARES_CONTEXT,
        {},
        repairs,
      ),
      avgCostCents: holding.avgCostCents,
      currentPricePerShareCents: holding.currentPricePerShareCents,
      isProxy: holding.isProxy,
      proxyNote: holding.proxyNote,
      lots: holding.lots.map((lot) => ({
        date: lot.date,
        type: lot.type,
        pricePerShareCents: lot.pricePerShareCents,
        sharesDecimal: canonicalStoredShares(
          lot.sharesDecimal,
          LOT_SHARES_CONTEXT,
          { signed: true },
          repairs,
        ),
        amountInvestedCents: lot.amountInvestedCents,
        note: lot.note,
      })),
    })),
  };
}

/**
 * Read-time repair for quantities written before the shares contract tightened.
 *
 * The stored finance document predates both rules it now breaks: lots carry
 * IEEE-754 noise (15-16 fractional digits against a retained scale of 12) and a
 * statement-reconciliation lot is stored negative. Asserting made every
 * getFinanceDocument call throw and took the whole Fold finance screen down, so
 * the read canonicalizes and stays loud only for genuine corruption — an
 * exponent, padding, or 13 integer digits still throws exactly as before.
 *
 * Nothing is logged here. A per-value warning naming the account, ticker and lot
 * slot published which household accounts hold which securities into whatever
 * ships the function log, once per read, forever. The whole execution instead
 * emits at most the one constant line below.
 */
function canonicalStoredShares(
  value: string,
  context: string,
  options: SharesDecimalOptions,
  repairs: SharesRepairTally,
): string {
  const canonical = canonicalizeSharesDecimal(value, context, options);
  if (canonical !== value) repairs.repaired = true;
  return canonical;
}

/**
 * The whole repair signal: constant text, no identifiers, no counts, no values.
 *
 * It answers exactly one question — is the stored row still pre-canonical? — and
 * the answer is actionable on its own: re-run the finances migration, which
 * rewrites the row from the untouched source blob.
 */
const STORED_SHARES_REPAIRED_WARNING =
  "financeDocuments: repaired non-canonical stored share quantities at read " +
  "time. Re-run the finances migration to canonicalize the stored row.";

function budgetSourceFor(
  viewer: FamilyMember,
): "budget" | "mason-budget" | null {
  if (isAdult(viewer)) return "budget";
  if (viewer === "mason") return "mason-budget";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
//
// All reads take an optional token and go through validateReadToken, exactly
// like dataFiles.ts. All of them are owner-scoped through ownersInScope, and
// none of them filters on owner after the fact — the owner index does it.
// ─────────────────────────────────────────────────────────────────────────────

const scopeValidator = v.union(v.literal("visible"), v.literal("netWorth"));

/**
 * Executable index audit for public financial reads.
 *
 * Query handlers below use these exact descriptors, so the schema test proves
 * that the audited plan exists rather than merely documenting an intended plan.
 * `rowCounts` is deliberately absent: exact counts still scan every table and
 * replacing that with transactionally maintained counters is tracked by #76.
 */
export const PUBLIC_QUERY_INDEX_PLAN = {
  listTransactions: {
    table: "transactions",
    all: { name: "by_owner_date", fields: ["owner", "date"] },
    month: {
      name: "by_owner_month",
      fields: ["owner", "month"],
    },
  },
  listIncome: {
    table: "income",
    all: {
      name: "by_owner_date_income_id",
      fields: ["owner", "date", "incomeId"],
    },
    month: {
      name: "by_owner_month_date_income_id",
      fields: ["owner", "month", "date", "incomeId"],
    },
  },
  listTodos: {
    table: "todos",
    all: {
      name: "by_owner_done",
      fields: ["owner", "done", "updatedAtMs"],
    },
  },
  listBtcBuys: {
    table: "btcBuys",
    all: { name: "by_owner_date", fields: ["owner", "date"] },
    month: {
      name: "by_owner_month",
      fields: ["owner", "month"],
    },
  },
  listBtcBillPays: {
    table: "btcBillPays",
    all: { name: "by_owner_date", fields: ["owner", "date"] },
    month: {
      name: "by_owner_month",
      fields: ["owner", "month"],
    },
  },
  listBtcTransfers: {
    table: "btcTransfers",
    all: { name: "by_owner_date", fields: ["owner", "date"] },
    month: {
      name: "by_owner_month_date",
      fields: ["owner", "month", "date"],
    },
  },
  listBtcAccounts: {
    table: "btcAccounts",
    all: { name: "by_owner_key", fields: ["owner", "key"] },
  },
  listBalanceDocuments: {
    table: "balanceDocuments",
    all: { name: "by_owner", fields: ["owner"] },
  },
  getBudgetDocument: {
    table: "budgetDocuments",
    all: { name: "by_source_file", fields: ["sourceFile"] },
  },
  listBtcBalanceDocuments: {
    table: "btcBalanceDocuments",
    all: { name: "by_owner", fields: ["owner"] },
  },
  getBtcSnapshotMetadata: {
    table: "btcBalanceDocuments",
    all: { name: "by_owner", fields: ["owner"] },
  },
  getFinanceDocument: {
    table: "financeDocuments",
    all: { name: "by_source_file", fields: ["sourceFile"] },
  },
} as const;

/**
 * Transactions a viewer may see, newest first.
 *
 * Omitting `limit` requests a complete replacement snapshot and fails closed
 * above PUBLIC_SNAPSHOT_HARD_MAX. Supplying a limit is a deliberately incomplete
 * diagnostic read and returns `complete: false`.
 */
export const listTransactions = query({
  args: {
    viewer: familyMemberValidator,
    month: v.optional(v.string()),
    limit: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, month, limit, token }) => {
    validateReadToken(token);
    const owners = ownersInScope(viewer, "visible");
    const cap = requestedRowCap(limit, "listTransactions");

    const perOwner = await Promise.all(
      owners.map((owner) =>
        month
          ? ctx.db
              .query("transactions")
              .withIndex(
                PUBLIC_QUERY_INDEX_PLAN.listTransactions.month.name,
                (q) => q.eq("owner", owner).eq("month", month),
              )
              .collect()
          : ctx.db
              .query("transactions")
              .withIndex(
                PUBLIC_QUERY_INDEX_PLAN.listTransactions.all.name,
                (q) => q.eq("owner", owner),
              )
              .order("desc")
              .take(cap),
      ),
    );

    const rows = perOwner.flat();
    rows.sort(byDateDescending);
    return publicEnvelope(
      rows.slice(0, cap).map(projectTransaction),
      limit,
      "listTransactions",
    );
  },
});

/**
 * Canonical income ledger, newest first.
 *
 * Income is its own authoritative source. Transaction rows whose category is
 * "Income" are mirrors and are deliberately not consulted here.
 */
export const listIncome = query({
  args: {
    viewer: familyMemberValidator,
    month: v.optional(v.string()),
    limit: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, month, limit, token }) => {
    validateReadToken(token);
    const owners = ownersInScope(viewer, "visible");
    const cap = requestedRowCap(limit, "listIncome");

    const perOwner = await Promise.all(
      owners.map((owner) =>
        month
          ? ctx.db
              .query("income")
              .withIndex(PUBLIC_QUERY_INDEX_PLAN.listIncome.month.name, (q) =>
                q.eq("owner", owner).eq("month", month),
              )
              .order("desc")
              .take(cap)
          : ctx.db
              .query("income")
              .withIndex(PUBLIC_QUERY_INDEX_PLAN.listIncome.all.name, (q) =>
                q.eq("owner", owner),
              )
              .order("desc")
              .take(cap),
      ),
    );

    const rows = perOwner.flat();
    rows.sort(byIncomeDateDescending);
    return publicEnvelope(
      rows.slice(0, cap).map(projectIncome),
      limit,
      "listIncome",
    );
  },
});

/** Todos owned by the exact active profile, most recently updated first. */
export const listTodos = query({
  args: {
    viewer: familyMemberValidator,
    done: v.optional(v.boolean()),
    limit: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, done, limit, token }) => {
    validateReadToken(token);
    const cap = requestedRowCap(limit, "listTodos");
    const wanted = done === undefined ? [false, true] : [done];

    const perOwner = await Promise.all(
      wanted.map((doneValue) =>
        ctx.db
          .query("todos")
          .withIndex(PUBLIC_QUERY_INDEX_PLAN.listTodos.all.name, (q) =>
            q.eq("owner", viewer).eq("done", doneValue),
          )
          .order("desc")
          .take(cap),
      ),
    );

    const rows = perOwner.flat();
    rows.sort((a, b) =>
      a.updatedAtMs === b.updatedAtMs
        ? a.todoId < b.todoId
          ? 1
          : -1
        : b.updatedAtMs - a.updatedAtMs,
    );
    return publicEnvelope(
      rows.slice(0, cap).map(projectTodo),
      limit,
      "listTodos",
    );
  },
});

/**
 * Bitcoin buys, newest first. `scope` is required so a caller must name whether
 * it wants the wider viewer-visible set or the narrower net-worth set.
 */
export const listBtcBuys = query({
  args: {
    viewer: familyMemberValidator,
    scope: scopeValidator,
    month: v.optional(v.string()),
    limit: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, scope, month, limit, token }) => {
    validateReadToken(token);
    const owners = ownersInScope(viewer, scope);
    const cap = requestedRowCap(limit, "listBtcBuys");

    const perOwner = await Promise.all(
      owners.map((owner) =>
        month
          ? ctx.db
              .query("btcBuys")
              .withIndex(PUBLIC_QUERY_INDEX_PLAN.listBtcBuys.month.name, (q) =>
                q.eq("owner", owner).eq("month", month),
              )
              .collect()
          : ctx.db
              .query("btcBuys")
              .withIndex(PUBLIC_QUERY_INDEX_PLAN.listBtcBuys.all.name, (q) =>
                q.eq("owner", owner),
              )
              .order("desc")
              .take(cap),
      ),
    );

    const rows = perOwner.flat();
    rows.sort(byDateDescending);
    return publicEnvelope(
      rows.slice(0, cap).map(projectBtcBuy),
      limit,
      "listBtcBuys",
    );
  },
});

/** Bitcoin bill payments with the same explicit visibility/net-worth scope. */
export const listBtcBillPays = query({
  args: {
    viewer: familyMemberValidator,
    scope: scopeValidator,
    month: v.optional(v.string()),
    limit: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, scope, month, limit, token }) => {
    validateReadToken(token);
    const owners = ownersInScope(viewer, scope);
    const cap = requestedRowCap(limit, "listBtcBillPays");

    const perOwner = await Promise.all(
      owners.map((owner) =>
        month
          ? ctx.db
              .query("btcBillPays")
              .withIndex(
                PUBLIC_QUERY_INDEX_PLAN.listBtcBillPays.month.name,
                (q) => q.eq("owner", owner).eq("month", month),
              )
              .collect()
          : ctx.db
              .query("btcBillPays")
              .withIndex(
                PUBLIC_QUERY_INDEX_PLAN.listBtcBillPays.all.name,
                (q) => q.eq("owner", owner),
              )
              .order("desc")
              .take(cap),
      ),
    );

    const rows = perOwner.flat();
    rows.sort(byDateDescending);
    return publicEnvelope(
      rows.slice(0, cap).map(projectBtcBillPay),
      limit,
      "listBtcBillPays",
    );
  },
});

/** Owned-wallet transfers, newest first, for correction and audit. */
export const listBtcTransfers = query({
  args: {
    viewer: familyMemberValidator,
    scope: scopeValidator,
    month: v.optional(v.string()),
    limit: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, scope, month, limit, token }) => {
    validateReadToken(token);
    const owners = ownersInScope(viewer, scope);
    const cap = requestedRowCap(limit, "listBtcTransfers");
    const perOwner = await Promise.all(
      owners.map((owner) =>
        month
          ? ctx.db
              .query("btcTransfers")
              .withIndex(
                PUBLIC_QUERY_INDEX_PLAN.listBtcTransfers.month.name,
                (q) => q.eq("owner", owner).eq("month", month),
              )
              .collect()
          : ctx.db
              .query("btcTransfers")
              .withIndex(
                PUBLIC_QUERY_INDEX_PLAN.listBtcTransfers.all.name,
                (q) => q.eq("owner", owner),
              )
              .order("desc")
              .take(cap),
      ),
    );
    const rows = perOwner.flat();
    rows.sort(byDateDescending);
    return publicEnvelope(
      rows.slice(0, cap).map(projectBtcTransfer),
      limit,
      "listBtcTransfers",
    );
  },
});

/** Bitcoin accounts with explicit viewer-visible versus net-worth scope. */
export const listBtcAccounts = query({
  args: {
    viewer: familyMemberValidator,
    scope: scopeValidator,
    limit: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, scope, limit, token }) => {
    validateReadToken(token);
    const owners = ownersInScope(viewer, scope);
    const cap = requestedRowCap(limit, "listBtcAccounts");

    const perOwner = await Promise.all(
      owners.map((owner) =>
        ctx.db
          .query("btcAccounts")
          .withIndex(PUBLIC_QUERY_INDEX_PLAN.listBtcAccounts.all.name, (q) =>
            q.eq("owner", owner),
          )
          .take(cap),
      ),
    );

    const rows = perOwner.flat();
    rows.sort((a, b) =>
      a.owner === b.owner
        ? a.key < b.key
          ? -1
          : 1
        : a.owner < b.owner
          ? -1
          : 1,
    );
    return publicEnvelope(
      rows.slice(0, cap).map(projectBtcAccount),
      limit,
      "listBtcAccounts",
    );
  },
});

/**
 * The stranded `balances` document is adult-household BTC. Scope is applied at
 * the indexed document owner boundary, matching btcBalanceDocuments: wider
 * `visible` reads may include child-owned documents, while `netWorth` excludes
 * them. The current source produces only the canonical adult owner.
 */
export const listBalanceDocuments = query({
  args: {
    viewer: familyMemberValidator,
    scope: scopeValidator,
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, scope, token }) => {
    validateReadToken(token);
    const owners = ownersInScope(viewer, scope);
    const rows = (
      await Promise.all(
        owners.map((owner) =>
          ctx.db
            .query("balanceDocuments")
            .withIndex(
              PUBLIC_QUERY_INDEX_PLAN.listBalanceDocuments.all.name,
              (q) => q.eq("owner", owner),
            )
            .collect(),
        ),
      )
    ).flat();

    rows.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
    return {
      rows: rows.map((row) => ({
        owner: row.owner,
        cashAppSats: row.cashAppSats,
        coldcardSats: row.coldcardSats,
        riverSats: row.riverSats,
        strikeSats: row.strikeSats,
        zeusSats: row.zeusSats,
        totalSats: row.totalSats,
        cashAppFiatCents: row.cashAppFiatCents,
        coldcardFiatCents: row.coldcardFiatCents,
        riverFiatCents: row.riverFiatCents,
        strikeFiatCents: row.strikeFiatCents,
        zeusFiatCents: row.zeusFiatCents,
        totalFiatCents: row.totalFiatCents,
        lastRefreshed: row.lastRefreshed,
        btcSync: row.btcSync,
        updatedAtMs: row.updatedAtMs,
      })),
      complete: true,
    };
  },
});

/**
 * Typed budget document from the atomic typed table.
 *
 * Budget is a net-worth concern, so callers must pass the literal `netWorth` at
 * the call site. Adults receive the shared household document (canonically owned
 * by Victor); children receive only their own document. Reported category spend
 * is omitted and must be derived from listTransactions for `document.month`.
 */
export const getBudgetDocument = query({
  args: {
    viewer: familyMemberValidator,
    scope: v.literal("netWorth"),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, token }) => {
    validateReadToken(token);
    const source = budgetSourceFor(viewer);
    if (source === null) return { document: null, complete: true };
    const doc = await ctx.db
      .query("budgetDocuments")
      .withIndex(PUBLIC_QUERY_INDEX_PLAN.getBudgetDocument.all.name, (q) =>
        q.eq("sourceFile", source),
      )
      .unique();
    return {
      document: doc ? publicBudgetDocument(doc) : null,
      complete: true,
    };
  },
});

/**
 * Complete typed BTC balance documents, explicitly scoped for visibility or
 * net worth. An adult visible read includes Mason for oversight; an adult
 * net-worth read cannot reach Mason's son-balances row.
 */
export const listBtcBalanceDocuments = query({
  args: {
    viewer: familyMemberValidator,
    scope: scopeValidator,
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, scope, token }) => {
    validateReadToken(token);
    const owners = ownersInScope(viewer, scope);
    const rows = (
      await Promise.all(
        owners.map((owner) =>
          ctx.db
            .query("btcBalanceDocuments")
            .withIndex(
              PUBLIC_QUERY_INDEX_PLAN.listBtcBalanceDocuments.all.name,
              (q) => q.eq("owner", owner),
            )
            .collect(),
        ),
      )
    ).flat();

    rows.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
    return { rows: rows.map(publicBtcBalanceDocument), complete: true };
  },
});

/**
 * Compatibility metadata view over the typed BTC balance documents. It keeps
 * the existing public API while removing all reads from dataFiles.data.
 */
export const getBtcSnapshotMetadata = query({
  args: {
    viewer: familyMemberValidator,
    scope: scopeValidator,
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, scope, token }) => {
    validateReadToken(token);
    const owners = ownersInScope(viewer, scope);
    const rows = (
      await Promise.all(
        owners.map((owner) =>
          ctx.db
            .query("btcBalanceDocuments")
            .withIndex(
              PUBLIC_QUERY_INDEX_PLAN.getBtcSnapshotMetadata.all.name,
              (q) => q.eq("owner", owner),
            )
            .collect(),
        ),
      )
    )
      .flat()
      .map((row) => ({
        owner: row.owner,
        schemaVersion: row.schemaVersion,
        asOf: row.asOf,
        source: row.source,
        basis: row.basis,
        confidence: row.confidence,
        updatedAtMs: row.updatedAtMs,
      }));
    rows.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
    return { rows, complete: true };
  },
});

/**
 * Typed finances document with account-level scope applied before it leaves
 * Convex. In particular, `mason_401k` is visible to adults but excluded from
 * their net-worth response.
 */
export const getFinanceDocument = query({
  args: {
    viewer: familyMemberValidator,
    scope: scopeValidator,
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, scope, token }) => {
    validateReadToken(token);
    const doc = await ctx.db
      .query("financeDocuments")
      .withIndex(PUBLIC_QUERY_INDEX_PLAN.getFinanceDocument.all.name, (q) =>
        q.eq("sourceFile", "finances"),
      )
      .unique();
    if (!doc) return { document: null, complete: true };

    const rule = scope === "netWorth" ? sharesNetWorthWith : canSeeDataOwnedBy;
    // One flag for the whole execution, so a document full of float-noise lots
    // still produces at most one constant log line rather than one per value.
    const repairs: SharesRepairTally = { repaired: false };
    const accounts = doc.accounts
      .filter((account) => rule(viewer, account.owner))
      .map((account) => publicFinanceAccount(account, repairs));
    if (repairs.repaired) console.warn(STORED_SHARES_REPAIRED_WARNING);
    if (accounts.length === 0) {
      return { document: null, complete: true };
    }

    return {
      document: {
        lastUpdated: doc.lastUpdated,
        retirementTotalCents: accounts.some((account) => isAdult(account.owner))
          ? doc.retirementTotalCents
          : undefined,
        accounts,
        updatedAtMs: doc.updatedAtMs,
      },
      complete: true,
    };
  },
});

/** Row counts per table — metadata only, including all typed projections. */
export const rowCounts = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    validateReadToken(token);
    return {
      transactions: (await ctx.db.query("transactions").collect()).length,
      todos: (await ctx.db.query("todos").collect()).length,
      btcBuys: (await ctx.db.query("btcBuys").collect()).length,
      btcBillPays: (await ctx.db.query("btcBillPays").collect()).length,
      btcTransfers: (await ctx.db.query("btcTransfers").collect()).length,
      btcAccounts: (await ctx.db.query("btcAccounts").collect()).length,
      income: (await ctx.db.query("income").collect()).length,
      balanceDocuments: (await ctx.db.query("balanceDocuments").collect())
        .length,
      budgetDocuments: (await ctx.db.query("budgetDocuments").collect()).length,
      btcBalanceDocuments: (await ctx.db.query("btcBalanceDocuments").collect())
        .length,
      financeDocuments: (await ctx.db.query("financeDocuments").collect())
        .length,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Row builders
//
// Builders normalize the legacy-shaped values accepted by the runtime API.
// convex/migrate.ts projects its own rows against the authoritative schema and
// preserves migration-only provenance for exact round-trip verification.
// ─────────────────────────────────────────────────────────────────────────────

function buildTransactionRow(
  raw: Record<string, unknown>,
  fileOwner: FamilyMember,
  sourceFile: string,
  now: number,
) {
  const date = String(raw.date ?? "");
  return {
    txId: String(raw.id ?? ""),
    owner: resolveOwner(raw.owner, fileOwner),
    date,
    month: monthOf(date),
    merchant: String(raw.merchant ?? ""),
    amountCents: parseCents(raw.amount),
    category: String(raw.category ?? "Other"),
    card: optionalText(raw.card),
    note: optionalText(raw.note),
    sourceFile,
    updatedAtMs: now,
  };
}

function buildTodoRow(
  raw: Record<string, unknown>,
  fileOwner: FamilyMember,
  sourceFile: string,
  now: number,
) {
  // Reuse the canonical normalizer rather than re-deriving title/done/aliases:
  // it is already the arbiter of done-vs-status, flag-vs-flagged and
  // dueDate-vs-due_date for the blob path, and two arbiters would disagree.
  // defaultTimestamps:false so a historical todo is not stamped with "now".
  const normalized = normalizeTodoRecord(raw as Record<string, any>, {
    now,
    defaultTimestamps: false,
  });

  const updatedAtMs = todoUpdatedMs(normalized);
  return {
    todoId: String(normalized.id),
    // normalizeTodoRecord defaults a missing owner to the string "victor";
    // resolveOwner still runs so an unrecognised value lands on the file's owner
    // rather than being coerced to an adult.
    owner: resolveOwner(normalized.owner, fileOwner),
    title: String(normalized.title ?? ""),
    done: Boolean(normalized.done),
    flagged: Boolean(normalized.flag),
    lane: optionalText(normalized.category),
    project: optionalText(normalized.project),
    area: optionalText(normalized.area),
    due: optionalText(normalized.dueDate),
    notes: optionalText(normalized.notes),
    priority: BigInt(Math.trunc(Number(normalized.priority) || 0)),
    createdAt: optionalText(normalized.createdAt),
    updatedAt: optionalText(normalized.updatedAt),
    completedAt: optionalText(normalized.completedAt),
    // 0 when the source carried no parsable stamp. Left as 0 rather than
    // back-filled with `now`: a fabricated timestamp would win a last-write-wins
    // comparison it has no business winning.
    updatedAtMs,
    sourceFile,
  };
}

function buildBtcBuyRow(
  raw: Record<string, unknown>,
  fileOwner: FamilyMember,
  sourceFile: string,
  now: number,
) {
  const date = String(raw.date ?? "");
  return {
    buyId: String(raw.id ?? ""),
    owner: resolveOwner(raw.owner, fileOwner),
    date,
    month: monthOf(date),
    source: String(raw.source ?? ""),
    sats: satsFromBuy(raw),
    priceUsdCents: parseCents(raw.price_usd),
    usdCents: parseCents(raw.usd),
    note: optionalText(raw.note),
    status: optionalText(raw.status),
    costBasisStatus: optionalText(raw.cost_basis_status),
    loggedBy: optionalText(raw.logged_by),
    archimedesRequestId: optionalText(raw.archimedes_request_id),
    sourceFile,
    updatedAtMs: now,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Upsert cores
//
// Natural-key upserts keep every runtime write path idempotent.
// ─────────────────────────────────────────────────────────────────────────────

type UpsertOutcome = "inserted" | "updated";
type RowEntityType =
  | "transaction"
  | "todo"
  | "budgetCategory"
  | "btcBuy"
  | "btcBillPay"
  | "btcTransfer"
  | "btcAccount";

type DeviceErrorCode =
  | "DEVICE_UNAUTHORIZED"
  | "ENTITY_CONFLICT"
  | "ENTITY_DELETED"
  | "ENTITY_NOT_FOUND"
  | "OWNER_MISMATCH"
  | "OWNER_SOURCE_MISMATCH"
  | "REVISION_REQUIRED"
  | "VALIDATION_FAILED";

function deviceFailure(
  code: DeviceErrorCode,
  message: string,
  entityType?: RowEntityType,
  entityId?: string,
): never {
  throw new ConvexError({
    code,
    message,
    ...(entityType === undefined ? {} : { entityType }),
    ...(entityId === undefined ? {} : { entityId }),
  });
}

/** Tasks are private to the profile selected through the client's auth gate. */
function requireTodoProfileOwner(
  activeProfile: FamilyMember,
  owner: FamilyMember,
  todoId: string,
) {
  if (activeProfile !== owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Active profile ${activeProfile} may not access todos owned by ${owner}.`,
      "todo",
      todoId,
    );
  }
}

const DEVICE_MAX_IDENTIFIER = 256;
const DEVICE_MAX_TEXT = 16_384;
const DEVICE_CONTROL = /[\u0000-\u001f\u007f]/;
const DEVICE_MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const DEVICE_ISO_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,9}))?Z$/;

function requireDeviceText(
  value: string,
  field: string,
  options: { max?: number; allowEmpty?: boolean; canonical?: boolean } = {},
): string {
  const max = options.max ?? DEVICE_MAX_TEXT;
  if (
    (!options.allowEmpty && value.length === 0) ||
    value.length > max ||
    DEVICE_CONTROL.test(value) ||
    (options.canonical && value !== value.trim())
  ) {
    deviceFailure(
      "VALIDATION_FAILED",
      `${field} must be ${options.allowEmpty ? "" : "non-empty, "}at most ${max} ` +
        "characters, free of control characters" +
        (options.canonical ? ", and have no surrounding whitespace." : "."),
    );
  }
  return value;
}

function requireDeviceIdentifier(value: string, field: string): string {
  return requireDeviceText(value, field, {
    max: DEVICE_MAX_IDENTIFIER,
    canonical: true,
  });
}

function requireDeviceOptionalText(
  value: string | undefined,
  field: string,
  max = DEVICE_MAX_TEXT,
) {
  if (value !== undefined) {
    requireDeviceText(value, field, { max, allowEmpty: true });
  }
}

function requireDeviceCalendarDate(value: string | undefined, field: string) {
  if (value === undefined) return;
  requireDeviceText(value, field, { max: 10 });
  if (!isRealIsoDate(value)) {
    deviceFailure(
      "VALIDATION_FAILED",
      `${field} must be a real ISO calendar date (yyyy-MM-dd).`,
    );
  }
}

function requireDeviceTimestamp(value: string | undefined, field: string) {
  if (value === undefined) return;
  requireDeviceText(value, field, { max: 30 });
  const match = DEVICE_ISO_TIMESTAMP.exec(value);
  const parsed = Date.parse(value);
  if (match === null || !Number.isFinite(parsed)) {
    deviceFailure(
      "VALIDATION_FAILED",
      `${field} must be a UTC ISO timestamp with at most 9 fractional digits.`,
    );
  }
  const milliseconds = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
  const canonical = new Date(parsed).toISOString();
  if (`${match[1]}.${milliseconds}Z` !== canonical) {
    deviceFailure(
      "VALIDATION_FAILED",
      `${field} must identify a real UTC instant without normalization.`,
    );
  }
}

function requireDeviceRevision(value: number | undefined, required: boolean) {
  if (
    (required && value === undefined) ||
    (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
  ) {
    deviceFailure(
      value === undefined ? "REVISION_REQUIRED" : "VALIDATION_FAILED",
      value === undefined
        ? "baseUpdatedAtMs is required for this operation."
        : "baseUpdatedAtMs must be a non-negative safe integer.",
    );
  }
}

function requireDeviceMonth(value: string) {
  requireDeviceText(value, "month", { max: 7 });
  if (!DEVICE_MONTH.test(value)) {
    deviceFailure("VALIDATION_FAILED", "month must be yyyy-MM.");
  }
}

function trustedCurrentMonth(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

function requireDeviceNonnegative(value: bigint, field: string) {
  if (value < 0n) {
    deviceFailure("VALIDATION_FAILED", `${field} must not be negative.`);
  }
}

function requireDevicePositive(value: bigint, field: string) {
  if (value <= 0n) {
    deviceFailure("VALIDATION_FAILED", `${field} must be positive.`);
  }
}

async function lockRuntimeSource(ctx: MutationCtx, sourceFile: string) {
  const existing = await ctx.db
    .query("runtimeSourceLocks")
    .withIndex("by_source_file", (q) => q.eq("sourceFile", sourceFile))
    .unique();
  if (!existing) {
    await ctx.db.insert("runtimeSourceLocks", {
      sourceFile,
      lockedAtMs: Date.now(),
    });
  }
}

function nextUpdatedAtMs(previous: number): number {
  return Math.max(Date.now(), previous + 1);
}

type OptimisticWrite = { baseUpdatedAtMs?: number };
type TodoRestoreCapsule = Omit<Doc<"todos">, "_id" | "_creationTime">;

function captureTodoForRestore(row: Doc<"todos">): TodoRestoreCapsule {
  const { _id, _creationTime, ...capsule } = row;
  void _id;
  void _creationTime;
  return capsule;
}

async function findRowTombstone(
  ctx: MutationCtx,
  entityType: RowEntityType,
  sourceFile: string,
  entityId: string,
) {
  return await ctx.db
    .query("rowTombstones")
    .withIndex("by_entity", (q) =>
      q
        .eq("entityType", entityType)
        .eq("sourceFile", sourceFile)
        .eq("entityId", entityId),
    )
    .unique();
}

async function clearRowTombstone(
  ctx: MutationCtx,
  entityType: RowEntityType,
  sourceFile: string,
  entityId: string,
) {
  const tombstone = await findRowTombstone(
    ctx,
    entityType,
    sourceFile,
    entityId,
  );
  if (tombstone) await ctx.db.delete(tombstone._id);
}

async function upsertRowTombstone(
  ctx: MutationCtx,
  entityType: RowEntityType,
  sourceFile: string,
  entityId: string,
  owner: FamilyMember,
  deletedFromUpdatedAtMs?: number,
  todoRestoreCapsule?: TodoRestoreCapsule,
) {
  const now = Date.now();
  const existing = await findRowTombstone(
    ctx,
    entityType,
    sourceFile,
    entityId,
  );
  const record = {
    entityType,
    sourceFile,
    entityId,
    owner,
    deletedAtMs: now,
    ...(deletedFromUpdatedAtMs === undefined ? {} : { deletedFromUpdatedAtMs }),
    ...(todoRestoreCapsule === undefined ? {} : { todoRestoreCapsule }),
  };
  if (existing) await ctx.db.patch(existing._id, record);
  else await ctx.db.insert("rowTombstones", record);
}

async function upsertLegacyTodoTombstone(ctx: MutationCtx, todoId: string) {
  const existing = await ctx.db
    .query("todoTombstones")
    .withIndex("by_todo_id", (q) => q.eq("id", todoId))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, { deletedAt: Date.now() });
  } else {
    await ctx.db.insert("todoTombstones", {
      id: todoId,
      deletedAt: Date.now(),
    });
  }
}

async function clearLegacyTodoTombstone(ctx: MutationCtx, todoId: string) {
  const existing = await ctx.db
    .query("todoTombstones")
    .withIndex("by_todo_id", (q) => q.eq("id", todoId))
    .unique();
  if (existing) await ctx.db.delete(existing._id);
}

function sameTransaction(
  existing: Doc<"transactions">,
  row: Omit<Doc<"transactions">, "_id" | "_creationTime">,
): boolean {
  return (
    existing.owner === row.owner &&
    existing.date === row.date &&
    existing.month === row.month &&
    existing.merchant === row.merchant &&
    existing.amountCents === row.amountCents &&
    existing.category === row.category &&
    existing.card === row.card &&
    existing.note === row.note &&
    existing.amountSats === row.amountSats &&
    (row.bitcoinAccountKey === undefined ||
      existing.bitcoinAccountKey === row.bitcoinAccountKey)
  );
}

export const BITCOIN_PAYMENT_SOURCES = new Set([
  "river",
  "zeus_lightning",
  "zeus_on_chain",
  "strike",
]);
const LEGACY_BITCOIN_SPEND_PAYMENT_SOURCES = new Set([
  "lightning",
  "on_chain",
]);
export const FIAT_PAYMENT_SOURCES = new Set([
  "coinbase_card",
  "aven",
  "sofi_card",
  "capital_one_vx",
]);

function isActiveBitcoinPaymentSource(row: {
  card?: string;
}): boolean {
  return row.card !== undefined && BITCOIN_PAYMENT_SOURCES.has(row.card);
}

function isLegacyBitcoinSpendTransaction(row: { card?: string }): boolean {
  return (
    row.card !== undefined && LEGACY_BITCOIN_SPEND_PAYMENT_SOURCES.has(row.card)
  );
}

function isBitcoinPostingTransaction(row: { card?: string }): boolean {
  return isActiveBitcoinPaymentSource(row) || isLegacyBitcoinSpendTransaction(row);
}

function requireBitcoinPaymentSourceDirection(
  card: string | undefined,
  kind: "spend" | "credit",
  category: string,
  transactionId: string,
) {
  const row = { card };
  if (!isBitcoinPostingTransaction(row)) return;
  const expectedKind =
    isActiveBitcoinPaymentSource(row) && category === "Income"
      ? "credit"
      : "spend";
  if (kind !== expectedKind) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Bitcoin payment-source direction must match spend or Income intent.",
      "transaction",
      transactionId,
    );
  }
}

function validateDeviceTransactionPaymentSource(
  row: {
    id: string;
    card?: string;
    amountSats?: bigint;
    bitcoinAccountKey?: string;
  },
  existing: Doc<"transactions"> | null,
) {
  const source = optionalText(row.card);
  if (source === undefined) {
    const existingSource = optionalText(existing?.card);
    if (
      existingSource !== undefined &&
      existingSource !== "river_bitcoin_bill_pay" &&
      !FIAT_PAYMENT_SOURCES.has(existingSource) &&
      !BITCOIN_PAYMENT_SOURCES.has(existingSource)
    ) {
      deviceFailure(
        "VALIDATION_FAILED",
        "Unknown legacy transaction payment sources may only round-trip unchanged.",
        "transaction",
        row.id,
      );
    }
    return;
  }
  if (source === "river_bitcoin_bill_pay") {
    deviceFailure(
      "VALIDATION_FAILED",
      "river_bitcoin_bill_pay must use upsertBtcBillPayFromDevice.",
      "transaction",
      row.id,
    );
  }
  if (FIAT_PAYMENT_SOURCES.has(source)) {
    if (row.amountSats !== undefined || row.bitcoinAccountKey !== undefined) {
      deviceFailure(
        "VALIDATION_FAILED",
        "Card payment sources must not carry Bitcoin posting fields.",
        "transaction",
        row.id,
      );
    }
    return;
  }
  if (BITCOIN_PAYMENT_SOURCES.has(source)) return;

  const requestedAccountKey = optionalText(row.bitcoinAccountKey);
  if (
    existing === null ||
    source !== existing.card ||
    row.amountSats !== existing.amountSats ||
    (requestedAccountKey !== undefined &&
      requestedAccountKey !== existing.bitcoinAccountKey)
  ) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Unknown legacy transaction payment sources may only round-trip unchanged.",
      "transaction",
      row.id,
    );
  }
}

function validateTransactionBitcoinFields(
  row: Omit<Doc<"transactions">, "_id" | "_creationTime">,
) {
  if (row.card === "river_bitcoin_bill_pay") {
    deviceFailure(
      "VALIDATION_FAILED",
      "river_bitcoin_bill_pay must use upsertBtcBillPay.",
      "transaction",
      row.txId,
    );
  }
  if (isBitcoinPostingTransaction(row)) {
    if (!postsToHouseholdBitcoinLedger(row.owner)) {
      deviceFailure(
        "VALIDATION_FAILED",
        "Bitcoin payment-source transactions are available only for the adult household ledger.",
        "transaction",
        row.txId,
      );
    }
    if (
      (isLegacyBitcoinSpendTransaction(row) && row.category === "Income") ||
      row.amountSats === undefined ||
      row.amountSats <= 0n ||
      row.bitcoinAccountKey === undefined ||
      !row.bitcoinAccountKey.trim()
    ) {
      deviceFailure(
        "VALIDATION_FAILED",
        isLegacyBitcoinSpendTransaction(row)
          ? "Retired Bitcoin payment sources remain debit-only and require a non-Income category, positive amountSats, and bitcoinAccountKey."
          : "Bitcoin payment-source transactions require positive amountSats and bitcoinAccountKey.",
        "transaction",
        row.txId,
      );
    }
    return;
  }

  if (row.amountSats !== undefined) {
    if (row.category !== "Income" || row.amountSats <= 0n) {
      deviceFailure(
        "VALIDATION_FAILED",
        "Only Income or Bitcoin payment-source transactions may carry positive amountSats.",
        "transaction",
        row.txId,
      );
    }
    if (row.bitcoinAccountKey !== undefined && !row.bitcoinAccountKey.trim()) {
      deviceFailure(
        "VALIDATION_FAILED",
        "bitcoinAccountKey must not be empty.",
        "transaction",
        row.txId,
      );
    }
  } else if (row.bitcoinAccountKey !== undefined) {
    deviceFailure(
      "VALIDATION_FAILED",
      "bitcoinAccountKey requires amountSats.",
      "transaction",
      row.txId,
    );
  }
}

function storedTransactionBalanceDelta(row: {
  txId: string;
  category: string;
  card?: string;
  amountSats?: bigint;
  bitcoinAccountKey?: string;
  balancePostingVersion?: bigint;
}): { accountKey: string; delta: bigint } | null {
  if (row.balancePostingVersion !== 1n) return null;
  if (row.amountSats === undefined || row.bitcoinAccountKey === undefined) {
    throw new ConvexError("Posted transaction is missing its Bitcoin posting fields.");
  }
  // This row is already posted, so category is authoritative for its stored
  // sign. Source and account metadata select the posting family and account.
  if (row.category === "Income") {
    return { accountKey: row.bitcoinAccountKey, delta: row.amountSats };
  }
  if (isBitcoinPostingTransaction(row)) {
    return { accountKey: row.bitcoinAccountKey, delta: -row.amountSats };
  }
  throw new ConvexError(`Posted transaction ${row.txId} has no Bitcoin posting source.`);
}

async function requestedTransactionBalanceDelta(
  ctx: MutationCtx,
  row: Omit<Doc<"transactions">, "_id" | "_creationTime">,
  existingIncomeAccountKey?: string,
): Promise<{ accountKey: string; delta: bigint } | null> {
  if (!postsToHouseholdBitcoinLedger(row.owner) || row.amountSats === undefined) {
    return null;
  }
  // Incoming input is attacker-shaped. Pin an existing Income account before
  // dispatch; wrappers validate kind/category, so a wire never infers direction.
  const requestedAccountKey = row.bitcoinAccountKey?.trim();
  if (
    existingIncomeAccountKey !== undefined &&
    requestedAccountKey !== undefined &&
    requestedAccountKey !== existingIncomeAccountKey
  ) {
    deviceFailure(
      "VALIDATION_FAILED",
      "A posted sat-denominated Income row cannot change its Bitcoin account; record a transfer instead.",
      "transaction",
      row.txId,
    );
  }
  if (isActiveBitcoinPaymentSource(row) && row.category === "Income") {
    return { accountKey: requestedAccountKey!, delta: row.amountSats };
  }
  if (isBitcoinPostingTransaction(row)) {
    return {
      accountKey: requestedAccountKey!,
      delta: -row.amountSats,
    };
  }
  if (row.category !== "Income") return null;
  const accountKey = existingIncomeAccountKey ?? await riverAccountKey(ctx, row.owner);
  if (
    requestedAccountKey !== undefined &&
    requestedAccountKey !== accountKey
  ) {
    deviceFailure(
      "VALIDATION_FAILED",
      existingIncomeAccountKey === undefined
        ? "Sat-denominated Income must post to the canonical River account."
        : "A posted sat-denominated Income row cannot change its Bitcoin account; record a transfer instead.",
      "transaction",
      row.txId,
    );
  }
  return { accountKey, delta: row.amountSats };
}

async function upsertTransactionRow(
  ctx: MutationCtx,
  row: Omit<Doc<"transactions">, "_id" | "_creationTime">,
  optimistic?: OptimisticWrite,
): Promise<UpsertOutcome> {
  validateTransactionBitcoinFields(row);
  const existing = await ctx.db
    .query("transactions")
    .withIndex("by_source_tx_id", (q: any) =>
      q.eq("sourceFile", row.sourceFile).eq("txId", row.txId),
    )
    .unique();
  // Loaded for every caller, not only optimistic ones. A delayed create
  // retried through the full-admin path must not resurrect a deleted row
  // and re-apply its balance legs.
  const tombstone = await findRowTombstone(ctx, "transaction", row.sourceFile, row.txId)
  if (existing) {
    if (existing.owner !== row.owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        `Transaction ${row.txId} belongs to ${existing.owner}, not ${row.owner}.`,
        "transaction",
        row.txId,
      );
    }
    if (sameTransaction(existing, row)) return "updated";
    if (
      existing.balancePostingVersion === 1n &&
      optimistic?.baseUpdatedAtMs === undefined
    ) {
      deviceFailure(
        "REVISION_REQUIRED",
        "baseUpdatedAtMs is required to edit a posted Bitcoin transaction.",
        "transaction",
        row.txId,
      );
    }
    if (optimistic && optimistic.baseUpdatedAtMs === undefined) {
      deviceFailure(
        "REVISION_REQUIRED",
        "baseUpdatedAtMs is required to update an existing transaction.",
        "transaction",
        row.txId,
      );
    }
    if (optimistic && optimistic.baseUpdatedAtMs !== existing.updatedAtMs) {
      deviceFailure(
        "ENTITY_CONFLICT",
        "The transaction changed after it was read.",
        "transaction",
        row.txId,
      );
    }
    const oldPosting = storedTransactionBalanceDelta(existing);
    if (
      oldPosting &&
      existing.category === "Income" &&
      row.category === "Income" &&
      row.amountSats === undefined
    ) {
      deviceFailure(
        "VALIDATION_FAILED",
        "Editing posted sat-denominated Income requires explicit amountSats.",
        "transaction",
        row.txId,
      );
    }
    const nextPosting = await requestedTransactionBalanceDelta(
      ctx,
      row,
      existing.category === "Income" ? oldPosting?.accountKey : undefined,
    );
    const deltas = new Map<string, bigint>();
    if (oldPosting) addDelta(deltas, oldPosting.accountKey, -oldPosting.delta);
    if (nextPosting) addDelta(deltas, nextPosting.accountKey, nextPosting.delta);
    if (oldPosting || nextPosting) await applyBtcAccountDeltas(ctx, row.owner, deltas);
    const storedRow = nextPosting
      ? {
          ...row,
          bitcoinAccountKey: nextPosting.accountKey,
          balancePostingVersion: 1n,
        }
      : {
          ...row,
          amountSats: undefined,
          bitcoinAccountKey: undefined,
          balancePostingVersion: undefined,
        };
    await lockRuntimeSource(ctx, row.sourceFile);
    await ctx.db.patch(existing._id, {
      ...storedRow,
      updatedAtMs: optimistic
        ? nextUpdatedAtMs(existing.updatedAtMs)
        : row.updatedAtMs,
    });
    await clearRowTombstone(ctx, "transaction", row.sourceFile, row.txId);
    return "updated";
  }
  if (optimistic?.baseUpdatedAtMs !== undefined) {
    deviceFailure(
      tombstone ? "ENTITY_DELETED" : "ENTITY_NOT_FOUND",
      tombstone
        ? "The transaction was deleted after it was read."
        : "The transaction to update does not exist.",
      "transaction",
      row.txId,
    );
  }
  if (tombstone) {
    deviceFailure(
      "ENTITY_DELETED",
      "A deleted transaction id cannot be silently resurrected.",
      "transaction",
      row.txId,
    );
  }
  const posting = await requestedTransactionBalanceDelta(ctx, row);
  let storedRow = row;
  if (posting) {
    const deltas = new Map<string, bigint>();
    addDelta(deltas, posting.accountKey, posting.delta);
    await applyBtcAccountDeltas(ctx, row.owner, deltas);
    storedRow = {
      ...row,
      bitcoinAccountKey: posting.accountKey,
      balancePostingVersion: 1n,
    };
  }
  await lockRuntimeSource(ctx, row.sourceFile);
  await ctx.db.insert("transactions", storedRow);
  await clearRowTombstone(ctx, "transaction", row.sourceFile, row.txId);
  return "inserted";
}

async function upsertTodoRow(
  ctx: MutationCtx,
  row: ReturnType<typeof buildTodoRow>,
  optimistic?: OptimisticWrite,
): Promise<UpsertOutcome> {
  const existing = await ctx.db
    .query("todos")
    .withIndex("by_todo_id", (q: any) => q.eq("todoId", row.todoId))
    .unique();
  const tombstone = optimistic
    ? await findRowTombstone(ctx, "todo", row.sourceFile, row.todoId)
    : null;
  if (tombstone && tombstone.owner !== row.owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Deleted todo ${row.todoId} belongs to ${tombstone.owner}, not ${row.owner}.`,
      "todo",
      row.todoId,
    );
  }
  if (existing) {
    if (existing.owner !== row.owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        `Todo ${row.todoId} belongs to ${existing.owner}, not ${row.owner}.`,
        "todo",
        row.todoId,
      );
    }
    if (optimistic && optimistic.baseUpdatedAtMs === undefined) {
      deviceFailure(
        "REVISION_REQUIRED",
        "baseUpdatedAtMs is required to update an existing todo.",
        "todo",
        row.todoId,
      );
    }
    if (optimistic && optimistic.baseUpdatedAtMs !== existing.updatedAtMs) {
      deviceFailure(
        "ENTITY_CONFLICT",
        "The todo changed after it was read.",
        "todo",
        row.todoId,
      );
    }
    await lockRuntimeSource(ctx, row.sourceFile);
    await ctx.db.patch(existing._id, {
      ...row,
      updatedAtMs: optimistic
        ? nextUpdatedAtMs(existing.updatedAtMs)
        : row.updatedAtMs,
    });
    await clearRowTombstone(ctx, "todo", row.sourceFile, row.todoId);
    // A compatibility tombstone retained by Undo must keep suppressing the
    // surviving legacy blob. Row-native edits cannot clear it because they do
    // not also rewrite that blob with the authoritative row.
    return "updated";
  }
  if (optimistic?.baseUpdatedAtMs !== undefined) {
    deviceFailure(
      tombstone ? "ENTITY_DELETED" : "ENTITY_NOT_FOUND",
      tombstone
        ? "The todo was deleted after it was read."
        : "The todo to update does not exist.",
      "todo",
      row.todoId,
    );
  }
  if (tombstone) {
    deviceFailure(
      "ENTITY_DELETED",
      "A deleted todo id cannot be silently resurrected.",
      "todo",
      row.todoId,
    );
  }
  await lockRuntimeSource(ctx, row.sourceFile);
  await ctx.db.insert("todos", row);
  await clearRowTombstone(ctx, "todo", row.sourceFile, row.todoId);
  await clearLegacyTodoTombstone(ctx, row.todoId);
  return "inserted";
}

async function upsertBtcBuyRow(
  ctx: MutationCtx,
  row: Omit<Doc<"btcBuys">, "_id" | "_creationTime">,
  optimistic?: OptimisticWrite,
): Promise<UpsertOutcome> {
  requireDevicePositive(row.sats, "buy.sats");
  requireDevicePositive(row.priceUsdCents, "buy.priceUsdCents");
  requireDevicePositive(row.usdCents, "buy.usdCents");
  requireDeviceNonnegative(row.feeUsdCents ?? 0n, "buy.feeUsdCents");
  const existing = await ctx.db
    .query("btcBuys")
    .withIndex("by_source_buy_id", (q: any) =>
      q.eq("sourceFile", row.sourceFile).eq("buyId", row.buyId),
    )
    .unique();
  // Loaded for every caller, not only optimistic ones. A delayed create
  // retried through the full-admin path must not resurrect a deleted row
  // and re-apply its balance legs.
  const tombstone = await findRowTombstone(ctx, "btcBuy", row.sourceFile, row.buyId)
  if (existing) {
    if (existing.owner !== row.owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        `Bitcoin buy ${row.buyId} belongs to ${existing.owner}, not ${row.owner}.`,
        "btcBuy",
        row.buyId,
      );
    }
    if (existing.linkedIncomeId !== row.linkedIncomeId) {
      deviceFailure(
        "ENTITY_CONFLICT",
        "A Bitcoin buy cannot enter or leave the paired-income contract through an ordinary upsert.",
        "btcBuy",
        row.buyId,
      );
    }
    const same =
      existing.date === row.date &&
      existing.month === row.month &&
      existing.source === row.source &&
      existing.sats === row.sats &&
      existing.priceUsdCents === row.priceUsdCents &&
      existing.usdCents === row.usdCents &&
      (existing.feeUsdCents ?? 0n) === (row.feeUsdCents ?? 0n) &&
      existing.note === row.note &&
      existing.status === row.status &&
      existing.costBasisStatus === row.costBasisStatus &&
      existing.loggedBy === row.loggedBy &&
      existing.archimedesRequestId === row.archimedesRequestId &&
      existing.linkedIncomeId === row.linkedIncomeId;
    if (same) return "updated";
    if (existing.linkedIncomeId !== undefined) {
      deviceFailure(
        "ENTITY_CONFLICT",
        "Linked income and its Bitcoin buy are immutable in this contract version.",
        "btcBuy",
        row.buyId,
      );
    }
    if (
      existing.balancePostingVersion === 1n &&
      optimistic?.baseUpdatedAtMs === undefined
    ) {
      deviceFailure(
        "REVISION_REQUIRED",
        "baseUpdatedAtMs is required to edit a posted Bitcoin buy.",
        "btcBuy",
        row.buyId,
      );
    }
    if (optimistic && optimistic.baseUpdatedAtMs === undefined) {
      deviceFailure(
        "REVISION_REQUIRED",
        "baseUpdatedAtMs is required to update an existing bitcoin buy.",
        "btcBuy",
        row.buyId,
      );
    }
    if (optimistic && optimistic.baseUpdatedAtMs !== existing.updatedAtMs) {
      deviceFailure(
        "ENTITY_CONFLICT",
        "The bitcoin buy changed after it was read.",
        "btcBuy",
        row.buyId,
      );
    }
    let storedRow = row;
    if (existing.balancePostingVersion === 1n) {
      const key = existing.balanceAccountKey;
      if (!key) throw new ConvexError("Posted Bitcoin buy is missing its account key.");
      const deltas = new Map<string, bigint>();
      addDelta(deltas, key, row.sats - existing.sats);
      await applyBtcAccountDeltas(ctx, row.owner, deltas);
      storedRow = {
        ...row,
        balanceAccountKey: key,
        balancePostingVersion: 1n,
      };
    }
    await lockRuntimeSource(ctx, row.sourceFile);
    await ctx.db.patch(existing._id, {
      ...storedRow,
      updatedAtMs: optimistic
        ? nextUpdatedAtMs(existing.updatedAtMs)
        : row.updatedAtMs,
    });
    await clearRowTombstone(ctx, "btcBuy", row.sourceFile, row.buyId);
    return "updated";
  }
  if (optimistic?.baseUpdatedAtMs !== undefined) {
    deviceFailure(
      tombstone ? "ENTITY_DELETED" : "ENTITY_NOT_FOUND",
      tombstone
        ? "The bitcoin buy was deleted after it was read."
        : "The bitcoin buy to update does not exist.",
      "btcBuy",
      row.buyId,
    );
  }
  if (tombstone) {
    deviceFailure(
      "ENTITY_DELETED",
      "A deleted bitcoin buy id cannot be silently resurrected.",
      "btcBuy",
      row.buyId,
    );
  }
  let storedRow = row;
  if (postsToHouseholdBitcoinLedger(row.owner)) {
    const key = await riverAccountKey(ctx, row.owner);
    const deltas = new Map<string, bigint>();
    addDelta(deltas, key, row.sats);
    await applyBtcAccountDeltas(ctx, row.owner, deltas);
    storedRow = {
      ...row,
      balanceAccountKey: key,
      balancePostingVersion: 1n,
    };
  }
  await lockRuntimeSource(ctx, row.sourceFile);
  await ctx.db.insert("btcBuys", storedRow);
  await clearRowTombstone(ctx, "btcBuy", row.sourceFile, row.buyId);
  return "inserted";
}

type LinkedIncomeInput = {
  id: string;
  owner: FamilyMember;
  date: string;
  amountCents: bigint;
  source: string;
  sourceFile: "income";
  loggedBy?: string;
  note?: string;
  archimedesRequestId?: string;
};

type LinkedIncomeRow = Omit<Doc<"income">, "_id" | "_creationTime">;

function linkedIncomeRow(
  buy: Omit<Doc<"btcBuys">, "_id" | "_creationTime">,
  linkedIncome: LinkedIncomeInput,
  now: number,
): LinkedIncomeRow {
  const linkedOwner = canonicalLedgerOwner(linkedIncome.owner);
  if (!buy.buyId.trim() || !linkedIncome.source.trim()) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Linked income id and source must not be empty.",
      "btcBuy",
      buy.buyId,
    );
  }
  if (!postsToHouseholdBitcoinLedger(buy.owner) || linkedOwner !== "victor") {
    deviceFailure(
      "VALIDATION_FAILED",
      "Linked Bitcoin-buy income is available only for the adult household ledger.",
      "btcBuy",
      buy.buyId,
    );
  }
  if (
    linkedIncome.id !== buy.buyId ||
    linkedOwner !== buy.owner ||
    linkedIncome.date !== buy.date
  ) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Linked income must have the same id, owner, and date as its Bitcoin buy.",
      "btcBuy",
      buy.buyId,
    );
  }
  if (linkedIncome.amountCents !== buy.usdCents) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Linked income amountCents must equal the Bitcoin buy usdCents.",
      "btcBuy",
      buy.buyId,
    );
  }
  requireDevicePositive(linkedIncome.amountCents, "linkedIncome.amountCents");
  return {
    sourceKey: `id:${linkedIncome.id}`,
    incomeId: linkedIncome.id,
    owner: linkedOwner,
    date: linkedIncome.date,
    month: monthOf(linkedIncome.date),
    amountCents: linkedIncome.amountCents,
    source: linkedIncome.source,
    loggedBy: optionalText(linkedIncome.loggedBy),
    note: optionalText(linkedIncome.note),
    archimedesRequestId: optionalText(linkedIncome.archimedesRequestId),
    sourceFile: "income",
    updatedAtMs: now,
  };
}

function sameLinkedIncome(existing: Doc<"income">, row: LinkedIncomeRow): boolean {
  return (
    existing.sourceKey === row.sourceKey &&
    existing.incomeId === row.incomeId &&
    existing.owner === row.owner &&
    existing.date === row.date &&
    existing.month === row.month &&
    existing.amountCents === row.amountCents &&
    existing.source === row.source &&
    existing.loggedBy === row.loggedBy &&
    existing.note === row.note &&
    existing.archimedesRequestId === row.archimedesRequestId &&
    existing.sourceFile === row.sourceFile
  );
}

/**
 * Create the canonical income side of an income-plus-buy pair.
 *
 * Paired income is intentionally immutable in this first contract. Exact retry
 * is a no-op, while changed content fails before the buy can be changed. Convex
 * rolls back the income insert if the later buy upsert fails.
 */
async function upsertLinkedIncomeRow(
  ctx: MutationCtx,
  row: LinkedIncomeRow,
): Promise<UpsertOutcome> {
  const existing = await ctx.db
    .query("income")
    .withIndex("by_source_key", (q) =>
      q.eq("sourceFile", "income").eq("sourceKey", row.sourceKey),
    )
    .unique();
  if (existing) {
    if (sameLinkedIncome(existing, row)) return "updated";
    deviceFailure(
      "ENTITY_CONFLICT",
      "Linked income is immutable; correct or delete the pair through a future paired flow.",
      "btcBuy",
      row.incomeId,
    );
  }
  await lockRuntimeSource(ctx, "income");
  await ctx.db.insert("income", row);
  return "inserted";
}

async function upsertBtcBillPayRow(
  ctx: MutationCtx,
  row: Omit<Doc<"btcBillPays">, "_id" | "_creationTime">,
  optimistic?: OptimisticWrite,
): Promise<UpsertOutcome> {
  const existing = await ctx.db
    .query("btcBillPays")
    .withIndex("by_source_bill_pay_id", (q: any) =>
      q.eq("sourceFile", row.sourceFile).eq("billPayId", row.billPayId),
    )
    .unique();
  // Loaded for every caller, not only optimistic ones. A delayed create
  // retried through the full-admin path must not resurrect a deleted row
  // and re-apply its balance legs.
  const tombstone = await findRowTombstone(ctx, "btcBillPay", row.sourceFile, row.billPayId)
  if (existing) {
    // Bill pays deliberately share ONE source file and carry `owner` per row,
    // unlike transactions which separate owners by file. The natural key is
    // therefore (sourceFile, billPayId) alone, so a write reusing another
    // member's id would patch THEIR row and flip its owner — destroying an
    // adult payment and dropping the survivor out of every adult netWorth read.
    // An upsert may change a row's money and metadata; it may never change who
    // it belongs to.
    if (existing.owner !== row.owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        `Bitcoin bill pay ${row.billPayId} belongs to ${existing.owner}, not ${row.owner}.`,
        "btcBillPay",
        row.billPayId,
      );
    }
    const existingBudgetEffect = existing.budgetEffect ?? "credit_card_payment";
    const existingCategory = existingBudgetEffect === "credit_card_payment"
      ? "Credit Card Payment"
      : existing.category;
    const same =
      existing.date === row.date &&
      existing.month === row.month &&
      existing.merchant === row.merchant &&
      existingCategory === row.category &&
      existingBudgetEffect === row.budgetEffect &&
      existing.amountUsdCents === row.amountUsdCents &&
      existing.btcSpentSats === row.btcSpentSats &&
      existing.btcPriceCents === row.btcPriceCents &&
      existing.platform === row.platform &&
      existing.note === row.note &&
      existing.feeUsdCents === row.feeUsdCents &&
      existing.reference === row.reference;
    if (same) return "updated";
    if (
      existing.balancePostingVersion === 1n &&
      optimistic?.baseUpdatedAtMs === undefined
    ) {
      deviceFailure(
        "REVISION_REQUIRED",
        "baseUpdatedAtMs is required to edit a posted Bitcoin bill pay.",
        "btcBillPay",
        row.billPayId,
      );
    }
    if (optimistic && optimistic.baseUpdatedAtMs === undefined) {
      deviceFailure(
        "REVISION_REQUIRED",
        "baseUpdatedAtMs is required to update an existing bill pay.",
        "btcBillPay",
        row.billPayId,
      );
    }
    if (optimistic && optimistic.baseUpdatedAtMs !== existing.updatedAtMs) {
      deviceFailure(
        "ENTITY_CONFLICT",
        "The bitcoin bill pay changed after it was read.",
        "btcBillPay",
        row.billPayId,
      );
    }
    let storedRow = row;
    if (existing.balancePostingVersion === 1n) {
      const key = existing.balanceAccountKey;
      if (!key) throw new ConvexError("Posted Bitcoin bill pay is missing its account key.");
      const deltas = new Map<string, bigint>();
      addDelta(deltas, key, existing.btcSpentSats - row.btcSpentSats);
      await applyBtcAccountDeltas(ctx, row.owner, deltas);
      storedRow = {
        ...row,
        balanceAccountKey: key,
        balancePostingVersion: 1n,
      };
    }
    await lockRuntimeSource(ctx, row.sourceFile);
    await ctx.db.patch(existing._id, {
      ...storedRow,
      updatedAtMs: optimistic
        ? nextUpdatedAtMs(existing.updatedAtMs)
        : row.updatedAtMs,
    });
    await clearRowTombstone(ctx, "btcBillPay", row.sourceFile, row.billPayId);
    return "updated";
  }
  if (optimistic?.baseUpdatedAtMs !== undefined) {
    deviceFailure(
      tombstone ? "ENTITY_DELETED" : "ENTITY_NOT_FOUND",
      tombstone
        ? "The bitcoin bill pay was deleted after it was read."
        : "The bitcoin bill pay to update does not exist.",
      "btcBillPay",
      row.billPayId,
    );
  }
  if (tombstone) {
    deviceFailure(
      "ENTITY_DELETED",
      "A deleted bill pay id cannot be silently resurrected.",
      "btcBillPay",
      row.billPayId,
    );
  }
  let storedRow = row;
  if (postsToHouseholdBitcoinLedger(row.owner)) {
    const key = await riverAccountKey(ctx, row.owner);
    const deltas = new Map<string, bigint>();
    addDelta(deltas, key, -row.btcSpentSats);
    await applyBtcAccountDeltas(ctx, row.owner, deltas);
    storedRow = {
      ...row,
      balanceAccountKey: key,
      balancePostingVersion: 1n,
    };
  }
  await lockRuntimeSource(ctx, row.sourceFile);
  await ctx.db.insert("btcBillPays", storedRow);
  await clearRowTombstone(ctx, "btcBillPay", row.sourceFile, row.billPayId);
  return "inserted";
}

function validateBtcTransfer(row: BtcTransferRow) {
  if (!postsToHouseholdBitcoinLedger(row.owner)) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Bitcoin transfers are available only for the adult household ledger.",
      "btcTransfer",
      row.transferId,
    );
  }
  if (!row.transferId.trim()) {
    deviceFailure("VALIDATION_FAILED", "Transfer id must not be empty.", "btcTransfer");
  }
  if (!row.fromAccountKey.trim() || !row.toAccountKey.trim()) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Transfer source and destination accounts are required.",
      "btcTransfer",
      row.transferId,
    );
  }
  if (row.fromAccountKey === row.toAccountKey) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Transfer source and destination must be different accounts.",
      "btcTransfer",
      row.transferId,
    );
  }
  if (row.sats <= 0n || row.feeSats < 0n) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Transfer sats must be positive and feeSats must be nonnegative.",
      "btcTransfer",
      row.transferId,
    );
  }
  if (row.sats + row.feeSats > (1n << 63n) - 1n) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Transfer debit exceeds signed int64.",
      "btcTransfer",
      row.transferId,
    );
  }
}

function sameBtcTransfer(
  existing: Doc<"btcTransfers">,
  row: BtcTransferRow,
): boolean {
  return (
    existing.owner === row.owner &&
    existing.date === row.date &&
    existing.fromAccountKey === row.fromAccountKey &&
    existing.toAccountKey === row.toAccountKey &&
    existing.sats === row.sats &&
    existing.feeSats === row.feeSats &&
    existing.note === row.note
  );
}

async function upsertBtcTransferRow(
  ctx: MutationCtx,
  row: BtcTransferRow,
  optimistic?: OptimisticWrite,
): Promise<UpsertOutcome> {
  validateBtcTransfer(row);
  const existing = await ctx.db
    .query("btcTransfers")
    .withIndex("by_transfer_id", (q) => q.eq("transferId", row.transferId))
    .unique();
  // Loaded for every caller, not only optimistic ones. A delayed retry of the
  // original full-admin create, arriving after the transfer was deleted, would
  // otherwise miss the tombstone and repost both balance legs.
  const tombstone = await findRowTombstone(
    ctx,
    "btcTransfer",
    row.sourceFile,
    row.transferId,
  );
  if (existing) {
    if (existing.owner !== row.owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        `Bitcoin transfer ${row.transferId} belongs to ${existing.owner}, not ${row.owner}.`,
        "btcTransfer",
        row.transferId,
      );
    }
    // A lost create response may be retried without the revision it never
    // received. Exact replay is a no-op; changed content still needs a fence.
    if (sameBtcTransfer(existing, row)) return "updated";
    // Changing a transfer moves money on two accounts, so every caller needs the
    // revision it read — authorization is not a concurrency fence. Exact replay
    // already returned above, so this cannot break a lost-response retry. The
    // permissive path is deletion only, which the cutover runbook drives.
    if (optimistic?.baseUpdatedAtMs === undefined) {
      deviceFailure(
        "REVISION_REQUIRED",
        "baseUpdatedAtMs is required to edit a Bitcoin transfer.",
        "btcTransfer",
        row.transferId,
      );
    }
    if (optimistic.baseUpdatedAtMs !== existing.updatedAtMs) {
      deviceFailure(
        "ENTITY_CONFLICT",
        "The Bitcoin transfer changed after it was read.",
        "btcTransfer",
        row.transferId,
      );
    }
    const deltas = new Map<string, bigint>();
    addDelta(deltas, existing.fromAccountKey, existing.sats + existing.feeSats);
    addDelta(deltas, existing.toAccountKey, -existing.sats);
    addDelta(deltas, row.fromAccountKey, -(row.sats + row.feeSats));
    addDelta(deltas, row.toAccountKey, row.sats);
    await applyBtcAccountDeltas(ctx, row.owner, deltas);
    await lockRuntimeSource(ctx, row.sourceFile);
    await ctx.db.patch(existing._id, {
      ...row,
      // Monotonic for every writer: a raw wall-clock stamp can land below a
      // revision a concurrent reader already holds.
      updatedAtMs: nextUpdatedAtMs(existing.updatedAtMs),
    });
    await clearRowTombstone(ctx, "btcTransfer", row.sourceFile, row.transferId);
    return "updated";
  }
  if (optimistic?.baseUpdatedAtMs !== undefined) {
    deviceFailure(
      tombstone ? "ENTITY_DELETED" : "ENTITY_NOT_FOUND",
      tombstone
        ? "The Bitcoin transfer was deleted after it was read."
        : "The Bitcoin transfer to update does not exist.",
      "btcTransfer",
      row.transferId,
    );
  }
  if (tombstone) {
    deviceFailure(
      "ENTITY_DELETED",
      "A deleted Bitcoin transfer id cannot be silently resurrected.",
      "btcTransfer",
      row.transferId,
    );
  }
  const deltas = new Map<string, bigint>();
  addDelta(deltas, row.fromAccountKey, -(row.sats + row.feeSats));
  addDelta(deltas, row.toAccountKey, row.sats);
  await applyBtcAccountDeltas(ctx, row.owner, deltas);
  await lockRuntimeSource(ctx, row.sourceFile);
  await ctx.db.insert("btcTransfers", row);
  await clearRowTombstone(ctx, "btcTransfer", row.sourceFile, row.transferId);
  return "inserted";
}

async function deleteBtcTransferCore(
  ctx: MutationCtx,
  owner: FamilyMember,
  transferId: string,
  optimistic?: OptimisticWrite,
): Promise<boolean> {
  if (!postsToHouseholdBitcoinLedger(owner)) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Bitcoin transfers are available only for the adult household ledger.",
      "btcTransfer",
      transferId,
    );
  }
  const sourceFile = "btc-transfers";
  const existing = await ctx.db
    .query("btcTransfers")
    .withIndex("by_transfer_id", (q) => q.eq("transferId", transferId))
    .unique();
  const tombstone = optimistic
    ? await findRowTombstone(ctx, "btcTransfer", sourceFile, transferId)
    : null;
  if (!existing) {
    if (optimistic?.baseUpdatedAtMs !== undefined) {
      if (tombstone?.deletedFromUpdatedAtMs === optimistic.baseUpdatedAtMs) {
        return false;
      }
      deviceFailure(
        tombstone ? "ENTITY_CONFLICT" : "ENTITY_NOT_FOUND",
        "The Bitcoin transfer deletion does not match the current revision.",
        "btcTransfer",
        transferId,
      );
    }
    await lockRuntimeSource(ctx, sourceFile);
    await upsertRowTombstone(ctx, "btcTransfer", sourceFile, transferId, owner);
    return false;
  }
  if (existing.owner !== owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Bitcoin transfer ${transferId} belongs to ${existing.owner}, not ${owner}.`,
      "btcTransfer",
      transferId,
    );
  }
  // Same split as the edit path: devices must present the revision they read,
  // while the full-admin sync token used by the cutover runbook is fenced by
  // credential. Without this the runbook's own verification step fails closed.
  if (optimistic && optimistic.baseUpdatedAtMs === undefined) {
    deviceFailure(
      "REVISION_REQUIRED",
      "baseUpdatedAtMs is required to delete a Bitcoin transfer.",
      "btcTransfer",
      transferId,
    );
  }
  if (optimistic && optimistic.baseUpdatedAtMs !== existing.updatedAtMs) {
    deviceFailure(
      "ENTITY_CONFLICT",
      "The Bitcoin transfer deletion does not match the current revision.",
      "btcTransfer",
      transferId,
    );
  }
  const deltas = new Map<string, bigint>();
  addDelta(deltas, existing.fromAccountKey, existing.sats + existing.feeSats);
  addDelta(deltas, existing.toAccountKey, -existing.sats);
  await applyBtcAccountDeltas(ctx, existing.owner, deltas);
  await lockRuntimeSource(ctx, sourceFile);
  await ctx.db.delete(existing._id);
  await upsertRowTombstone(
    ctx,
    "btcTransfer",
    sourceFile,
    transferId,
    owner,
    optimistic?.baseUpdatedAtMs,
  );
  return true;
}

async function upsertBtcAccountRow(
  ctx: MutationCtx,
  row: Omit<Doc<"btcAccounts">, "_id" | "_creationTime">,
): Promise<UpsertOutcome> {
  const existing = await ctx.db
    .query("btcAccounts")
    .withIndex("by_owner_key", (q: any) =>
      q.eq("owner", row.owner).eq("key", row.key),
    )
    .unique();
  if (existing) {
    await lockRuntimeSource(ctx, row.sourceFile);
    await ctx.db.patch(existing._id, row);
    await clearRowTombstone(ctx, "btcAccount", row.sourceFile, row.key);
    return "updated";
  }
  await lockRuntimeSource(ctx, row.sourceFile);
  await ctx.db.insert("btcAccounts", row);
  await clearRowTombstone(ctx, "btcAccount", row.sourceFile, row.key);
  return "inserted";
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
//
// All writes go through validateSyncToken, exactly like dataFiles.ts.
//
// Money arrives as integer minor units (int64) — these entry points never accept
// a decimal dollar amount, so no float can enter the ledger through a client.
// Legacy-shaped helpers parse decimal values lexically; public mutation inputs
// accept only integer minor units.
// ─────────────────────────────────────────────────────────────────────────────

const transactionKindValidator = v.union(
  v.literal("spend"),
  v.literal("credit"),
);

function requireSignAgrees(
  minor: bigint,
  owner: FamilyMember,
  kind: "spend" | "credit",
  category: string,
) {
  if (minor === 0n) {
    deviceFailure(
      "VALIDATION_FAILED",
      "upsertTransaction: amountCents must not be zero — a zero-value " +
        "transaction has no sign to check.",
    );
  }
  if (category === "Income" && kind !== "credit") {
    deviceFailure(
      "VALIDATION_FAILED",
      'upsertTransaction: a transaction categorised "Income" must be sent ' +
        'with kind "credit".',
    );
  }

  const expectedNegative = category !== "Income" && kind === "credit";
  if (minor < 0n !== expectedNegative) {
    const sourceFile = isAdult(owner)
      ? "transactions"
      : `${owner}-transactions`;
    deviceFailure(
      "VALIDATION_FAILED",
      `upsertTransaction: a ${kind} for ${owner} must be ` +
        `${expectedNegative ? "negative" : "positive"} in ${sourceFile} ` +
        `(purchases are positive and refunds are negative for every owner), ` +
        `got ${minor}. The sign is not corrected here on purpose.`,
    );
  }
}

/** A bill payment is money leaving, in both currencies. Mirrors the intent of
 *  requireSignAgrees: state the convention, refuse a violation, and never
 *  silently correct it — a corrected sign hides a client bug until an aggregate
 *  is already wrong. `feeUsdCents` may legitimately be zero; the rest may not. */
function requireBillPayAmounts(billPay: {
  id: string;
  amountUsdCents: bigint;
  btcSpentSats: bigint;
  btcPriceCents: bigint;
  feeUsdCents: bigint;
}) {
  const positive: Array<[string, bigint]> = [
    ["amountUsdCents", billPay.amountUsdCents],
    ["btcSpentSats", billPay.btcSpentSats],
    ["btcPriceCents", billPay.btcPriceCents],
  ];
  for (const [field, value] of positive) {
    if (value <= 0n) {
      deviceFailure(
        "VALIDATION_FAILED",
        `upsertBtcBillPay: ${field} for ${billPay.id} must be positive ` +
          `(a bill payment is a spend), got ${value}. The sign is not ` +
          `corrected here on purpose.`,
      );
    }
  }
  if (billPay.feeUsdCents < 0n) {
    deviceFailure(
      "VALIDATION_FAILED",
      `upsertBtcBillPay: feeUsdCents for ${billPay.id} must not be negative, ` +
        `got ${billPay.feeUsdCents}.`,
    );
  }
}

function requireBillPayBudgetEffect(billPay: {
  category: string;
  budgetEffect: "budget_category" | "credit_card_payment";
}) {
  if (billPay.budgetEffect === "credit_card_payment") {
    if (billPay.category !== "Credit Card Payment") {
      deviceFailure(
        "VALIDATION_FAILED",
        'credit_card_payment bill pays require category "Credit Card Payment".',
      );
    }
    return;
  }
  if (!billPay.category.trim()) {
    deviceFailure(
      "VALIDATION_FAILED",
      "budget_category bill pays require a selected category.",
    );
  }
}

const transactionInput = v.object({
  id: v.string(),
  date: v.string(),
  merchant: v.string(),
  amountCents: v.int64(),
  kind: v.optional(transactionKindValidator),
  category: v.string(),
  card: v.optional(v.string()),
  note: v.optional(v.string()),
  amountSats: v.optional(v.int64()),
  bitcoinAccountKey: v.optional(v.string()),
  owner: v.optional(familyMemberValidator),
});

const transactionDeviceInput = v.object({
  id: v.string(),
  date: v.string(),
  merchant: v.string(),
  amountCents: v.int64(),
  kind: transactionKindValidator,
  category: v.string(),
  card: v.optional(v.string()),
  note: v.optional(v.string()),
  amountSats: v.optional(v.int64()),
  bitcoinAccountKey: v.optional(v.string()),
  owner: familyMemberValidator,
});

const btcTransferInput = v.object({
  id: v.string(),
  owner: familyMemberValidator,
  date: v.string(),
  fromAccountKey: v.string(),
  toAccountKey: v.string(),
  sats: v.int64(),
  feeSats: v.int64(),
  note: v.optional(v.string()),
});

const btcTransferSourceValidator = v.literal("btc-transfers");

const transactionSourceValidator = v.union(
  v.literal("transactions"),
  v.literal("mason-transactions"),
  v.literal("maddox-transactions"),
);

const todoDeviceInput = v.object({
  id: v.string(),
  owner: familyMemberValidator,
  title: v.string(),
  done: v.boolean(),
  flagged: v.boolean(),
  lane: v.optional(v.string()),
  project: v.optional(v.string()),
  area: v.optional(v.string()),
  due: v.optional(v.string()),
  notes: v.optional(v.string()),
  priority: v.optional(v.int64()),
  createdAt: v.optional(v.string()),
  updatedAt: v.optional(v.string()),
  completedAt: v.optional(v.string()),
});

const btcBuyDeviceInput = v.object({
  id: v.string(),
  owner: familyMemberValidator,
  date: v.string(),
  source: v.string(),
  sats: v.int64(),
  priceUsdCents: v.int64(),
  usdCents: v.int64(),
  feeUsdCents: v.optional(v.int64()),
  note: v.optional(v.string()),
  status: v.optional(v.string()),
  costBasisStatus: v.optional(v.string()),
  loggedBy: v.optional(v.string()),
  archimedesRequestId: v.optional(v.string()),
});

const linkedIncomeInput = v.object({
  id: v.string(),
  owner: familyMemberValidator,
  date: v.string(),
  amountCents: v.int64(),
  source: v.string(),
  sourceFile: v.literal("income"),
  loggedBy: v.optional(v.string()),
  note: v.optional(v.string()),
  archimedesRequestId: v.optional(v.string()),
});

const btcBuySourceValidator = v.union(
  v.literal("bitcoin-buys"),
  v.literal("mason-bitcoin-buys"),
);

const btcBillPayDeviceInput = v.object({
  id: v.string(),
  owner: familyMemberValidator,
  date: v.string(),
  merchant: v.string(),
  category: v.string(),
  budgetEffect: v.optional(btcBillPayBudgetEffectValidator),
  amountUsdCents: v.int64(),
  btcSpentSats: v.int64(),
  btcPriceCents: v.int64(),
  platform: v.optional(v.string()),
  note: v.optional(v.string()),
  feeUsdCents: v.int64(),
  reference: v.optional(v.string()),
});

const budgetCategoryDeviceInput = v.object({
  name: v.string(),
  icon: v.optional(v.string()),
  budgetCents: v.int64(),
});

const budgetSourceValidator = v.union(
  v.literal("budget"),
  v.literal("mason-budget"),
);

const btcAccountDeviceInput = v.object({
  key: v.string(),
  owner: familyMemberValidator,
  label: v.string(),
  custody: custodyValidator,
  sats: v.int64(),
  asOf: v.string(),
  schemaVersion: v.optional(v.int64()),
  fiatValuation: v.optional(
    v.object({
      cents: v.int64(),
      priceCents: v.optional(v.int64()),
      quotedAt: v.optional(v.string()),
      source: v.optional(v.string()),
      confidence: v.optional(v.string()),
    }),
  ),
});

const btcAccountSourceValidator = v.union(
  v.literal("btc-balance-snapshot"),
  v.literal("son-balances"),
);

const deviceUpsertResultValidator = v.object({
  ok: v.literal(true),
  entityId: v.string(),
  outcome: v.union(v.literal("inserted"), v.literal("updated")),
});

const deviceDeleteResultValidator = v.object({
  ok: v.literal(true),
  entityId: v.string(),
  removed: v.boolean(),
});

const deviceRestoreResultValidator = v.object({
  ok: v.literal(true),
  entityId: v.string(),
  updatedAtMs: v.float64(),
});

/** Insert or replace ONE transaction. Compare with dataFiles:appendTransaction,
 *  which rewrites all 905 to do this. */
export const upsertTransaction = mutation({
  args: {
    transaction: transactionInput,
    sourceFile: v.optional(v.string()),
    baseUpdatedAtMs: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { transaction, sourceFile, baseUpdatedAtMs, token }) => {
    validateSyncToken(token);
    const file = sourceFile ?? "transactions";
    const fileOwner = ownerForSourceFile(file, "transactions");
    const now = Date.now();
    const date = requireIsoDate(
      transaction.date,
      "date",
      now,
      30,
      rejectRowDate,
    );
    // During the compatibility window, older clients may omit owner or send
    // Rachel for the shared adult ledger. The source file is already the
    // authoritative ownership boundary, so canonicalize here without breaking
    // those clients. Once all shipped clients send both fields, the staged
    // contract can require them and reject mismatches.
    const owner = fileOwner;
    requireSignAgrees(
      transaction.amountCents,
      owner,
      transaction.kind ?? "spend",
      transaction.category,
    );
    requireBitcoinPaymentSourceDirection(
      optionalText(transaction.card),
      transaction.kind ?? "spend",
      transaction.category,
      transaction.id,
    );
    const row = {
      txId: transaction.id,
      owner,
      date,
      month: monthOf(date),
      merchant: transaction.merchant,
      amountCents: transaction.amountCents,
      category: transaction.category,
      card: optionalText(transaction.card),
      note: optionalText(transaction.note),
      amountSats: transaction.amountSats,
      bitcoinAccountKey: optionalText(transaction.bitcoinAccountKey),
      sourceFile: file,
      updatedAtMs: now,
    };
    const outcome = await upsertTransactionRow(
      ctx,
      row,
      baseUpdatedAtMs === undefined ? undefined : { baseUpdatedAtMs },
    );
    // Return the accepted revision so a client can fence its very next edit or
    // delete instead of waiting for a later sync to learn it. Without this an
    // immediate add -> edit round trip fails on a revision the client cannot know.
    const stored = await ctx.db
      .query("transactions")
      .withIndex("by_source_tx_id", (q) =>
        q.eq("sourceFile", file).eq("txId", row.txId),
      )
      .unique();
    return {
      txId: row.txId,
      owner: row.owner,
      month: row.month,
      outcome,
      updatedAtMs: stored?.updatedAtMs,
    };
  },
});

/**
 * Delete ONE transaction row, scoped to its source file.
 *
 * A missing row is an idempotent success (`removed: false`), matching
 * `deleteTodo`: clients may safely retry after losing a response without
 * turning an already-completed delete into an error.
 *
 * The natural-key tombstone is written even when the row is already absent, so
 * retrying is idempotent and a later migration cannot resurrect the blob row.
 */
export const deleteTransaction = mutation({
  args: {
    txId: v.string(),
    owner: v.optional(familyMemberValidator),
    sourceFile: v.optional(v.string()),
    baseUpdatedAtMs: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { txId, owner: rawOwner, sourceFile, baseUpdatedAtMs, token },
  ) => {
    validateSyncToken(token);
    const file = sourceFile ?? "transactions";
    const fileOwner = ownerForSourceFile(file, "transactions");
    const owner = resolveOwner(rawOwner, fileOwner);
    const existing = await ctx.db
      .query("transactions")
      .withIndex("by_source_tx_id", (q) =>
        q.eq("sourceFile", file).eq("txId", txId),
      )
      .unique();
    const tombstone = await findRowTombstone(
      ctx,
      "transaction",
      file,
      txId,
    );
    if (!existing) {
      if (baseUpdatedAtMs !== undefined) {
        if (tombstone?.deletedFromUpdatedAtMs === baseUpdatedAtMs) {
          return { txId, owner, removed: false };
        }
        deviceFailure(
          tombstone ? "ENTITY_CONFLICT" : "ENTITY_NOT_FOUND",
          "The transaction deletion does not match the current revision.",
          "transaction",
          txId,
        );
      }
      if (tombstone) return { txId, owner, removed: false };
      await lockRuntimeSource(ctx, file);
      await upsertRowTombstone(ctx, "transaction", file, txId, owner);
      return { txId, owner, removed: false };
    }
    // The `owner` argument used to be resolved and then never consulted, so the
    // row was found by (sourceFile, txId) alone. Transaction ids DO collide
    // across source files — the neighbouring test seeds "shared-id" in both
    // `transactions` and `mason-transactions` on purpose. That made
    // deleteTransaction({txId, owner: "mason"}) with sourceFile omitted default
    // to the ADULT file and permanently delete Victor's row while reporting
    // success. There is no transaction tombstone, so the row is simply gone.
    // Fail closed instead: an explicit owner must match the row we found.
    if (isFamilyMember(rawOwner) && existing.owner !== rawOwner) {
      throw new ConvexError(
        `deleteTransaction: ${txId} in ${file} belongs to ${existing.owner}, ` +
          `not ${rawOwner}. Pass the matching sourceFile for that owner; this ` +
          `is not corrected here on purpose because the delete is irreversible.`,
      );
    }
    if (existing.balancePostingVersion === 1n) {
      if (baseUpdatedAtMs === undefined) {
        deviceFailure(
          "REVISION_REQUIRED",
          "baseUpdatedAtMs is required to delete a posted Bitcoin transaction.",
          "transaction",
          txId,
        );
      }
      if (baseUpdatedAtMs !== existing.updatedAtMs) {
        deviceFailure(
          "ENTITY_CONFLICT",
          "The transaction changed after it was read.",
          "transaction",
          txId,
        );
      }
      const posting = storedTransactionBalanceDelta(existing);
      if (!posting) throw new ConvexError("Posted transaction lost its Bitcoin posting.");
      const deltas = new Map<string, bigint>();
      addDelta(deltas, posting.accountKey, -posting.delta);
      await applyBtcAccountDeltas(ctx, existing.owner, deltas);
    }
    await lockRuntimeSource(ctx, file);
    await ctx.db.delete(existing._id);
    await upsertRowTombstone(
      ctx,
      "transaction",
      file,
      txId,
      existing.owner,
      baseUpdatedAtMs,
    );
    return { txId, owner: existing.owner, removed: true };
  },
});

/** Insert or replace ONE todo, keyed on its MC2 id. */
export const upsertTodo = mutation({
  args: {
    activeProfile: familyMemberValidator,
    todo: v.any(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { activeProfile, todo, token }) => {
    validateSyncToken(token);
    const raw = asRecord(todo);
    if (!raw) throw new ConvexError("upsertTodo: todo must be an object");
    if (!isFamilyMember(raw.owner)) {
      throw new ConvexError(
        `upsertTodo: owner must be one of ${FAMILY_MEMBERS.join(", ")}, got ` +
          `${JSON.stringify(raw.owner)}.`,
      );
    }
    requireTodoProfileOwner(activeProfile, raw.owner, String(raw.id ?? ""));
    const row = buildTodoRow(raw, DEFAULT_OWNER, "todos", Date.now());
    const outcome = await upsertTodoRow(ctx, row);
    return { todoId: row.todoId, owner: row.owner, done: row.done, outcome };
  },
});

/**
 * Delete ONE todo row.
 *
 * Writes both row-native and legacy todo tombstones. The legacy marker remains
 * required while shipped clients still converge through the todos blob.
 */
export const deleteTodo = mutation({
  args: {
    activeProfile: familyMemberValidator,
    owner: familyMemberValidator,
    todoId: v.string(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { activeProfile, owner, todoId, token }) => {
    validateSyncToken(token);
    requireTodoProfileOwner(activeProfile, owner, todoId);
    const existing = await ctx.db
      .query("todos")
      .withIndex("by_todo_id", (q) => q.eq("todoId", todoId))
      .unique();
    if (existing && existing.owner !== owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        `Todo ${todoId} belongs to ${existing.owner}, not ${owner}.`,
        "todo",
        todoId,
      );
    }
    if (!existing) {
      await lockRuntimeSource(ctx, "todos");
      const tombstone = await findRowTombstone(ctx, "todo", "todos", todoId);
      if (tombstone && tombstone.owner !== owner) {
        deviceFailure(
          "OWNER_MISMATCH",
          `Deleted todo ${todoId} belongs to ${tombstone.owner}, not ${owner}.`,
          "todo",
          todoId,
        );
      }
      if (!tombstone) {
        await upsertRowTombstone(ctx, "todo", "todos", todoId, owner);
      }
      await upsertLegacyTodoTombstone(ctx, todoId);
      return { todoId, removed: false };
    }
    await lockRuntimeSource(ctx, existing.sourceFile);
    await ctx.db.delete(existing._id);
    await upsertRowTombstone(
      ctx,
      "todo",
      existing.sourceFile,
      todoId,
      existing.owner,
    );
    await upsertLegacyTodoTombstone(ctx, todoId);
    return { todoId, removed: true };
  },
});

const btcBuyInput = v.object({
  id: v.string(),
  date: v.string(),
  source: v.string(),
  sats: v.int64(),
  priceUsdCents: v.int64(),
  usdCents: v.int64(),
  feeUsdCents: v.optional(v.int64()),
  note: v.optional(v.string()),
  status: v.optional(v.string()),
  costBasisStatus: v.optional(v.string()),
  loggedBy: v.optional(v.string()),
  archimedesRequestId: v.optional(v.string()),
  owner: v.optional(familyMemberValidator),
});

export const upsertBtcBuy = mutation({
  args: {
    buy: btcBuyInput,
    linkedIncome: v.optional(linkedIncomeInput),
    sourceFile: v.optional(v.string()),
    baseUpdatedAtMs: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { buy, linkedIncome, sourceFile, baseUpdatedAtMs, token },
  ) => {
    validateSyncToken(token);
    const file = sourceFile ?? "bitcoin-buys";
    const fileOwner = ownerForSourceFile(file, "btcBuys");
    const now = Date.now();
    const date = requireIsoDate(buy.date, "date", now, 30, rejectRowDate);
    const resolvedOwner = resolveOwner(buy.owner, fileOwner);
    const owner = linkedIncome
      ? canonicalLedgerOwner(resolvedOwner)
      : resolvedOwner;
    if (linkedIncome) requireSourceOwner(file, "btcBuys", owner);
    const row = {
      buyId: buy.id,
      owner,
      date,
      month: monthOf(date),
      source: buy.source,
      sats: buy.sats,
      priceUsdCents: buy.priceUsdCents,
      usdCents: buy.usdCents,
      feeUsdCents: buy.feeUsdCents ?? 0n,
      note: optionalText(buy.note),
      status: optionalText(buy.status),
      costBasisStatus: optionalText(buy.costBasisStatus),
      loggedBy: optionalText(buy.loggedBy),
      archimedesRequestId: optionalText(buy.archimedesRequestId),
      ...(linkedIncome === undefined
        ? {}
        : { linkedIncomeId: linkedIncome.id }),
      sourceFile: file,
      updatedAtMs: now,
    };
    if (linkedIncome) {
      await upsertLinkedIncomeRow(ctx, linkedIncomeRow(row, linkedIncome, now));
    }
    const outcome = await upsertBtcBuyRow(
      ctx,
      row,
      baseUpdatedAtMs === undefined ? undefined : { baseUpdatedAtMs },
    );
    return { buyId: row.buyId, owner: row.owner, month: row.month, outcome };
  },
});

const btcBillPayInput = v.object({
  id: v.string(),
  date: v.string(),
  merchant: v.string(),
  category: v.string(),
  budgetEffect: v.optional(btcBillPayBudgetEffectValidator),
  amountUsdCents: v.int64(),
  btcSpentSats: v.int64(),
  btcPriceCents: v.int64(),
  platform: v.optional(v.string()),
  note: v.optional(v.string()),
  feeUsdCents: v.int64(),
  reference: v.optional(v.string()),
  owner: v.optional(familyMemberValidator),
});

export const upsertBtcBillPay = mutation({
  args: {
    billPay: btcBillPayInput,
    sourceFile: v.optional(v.string()),
    baseUpdatedAtMs: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { billPay, sourceFile, baseUpdatedAtMs, token }) => {
    validateSyncToken(token);
    const file = sourceFile ?? "bitcoin-bill-pays";
    const fileOwner = ownerForSourceFile(file, "btcBillPays");
    const now = Date.now();
    const date = requireIsoDate(billPay.date, "date", now, 30, rejectRowDate);
    // NOTE: deliberately NOT the upsertBtcAccount guard (owner must equal
    // fileOwner). There is exactly one bill-pay source file and no child
    // equivalent, so bill pays carry `owner` per row and rely on read-time
    // visibility scoping — a child's row is visible to an adult but excluded
    // from adult netWorth. Requiring owner === fileOwner here would forbid
    // child bill pays outright. The cross-owner hijack is instead blocked in
    // upsertBtcBillPayRow, which refuses to change an existing row's owner.
    //
    // A bill payment is a spend. Money keeps the repo-wide convention:
    // purchases are POSITIVE, and the sign is never corrected here on purpose.
    // upsertTransaction enforces this via requireSignAgrees; bill pays had no
    // equivalent, so a client still carrying the pre-fix inverted convention
    // could store negatives and make every aggregate under-report by twice the
    // payment.
    requireBillPayAmounts(billPay);
    const budgetEffect = billPay.budgetEffect ?? "credit_card_payment";
    const category = budgetEffect === "credit_card_payment"
      ? "Credit Card Payment"
      : billPay.category;
    requireBillPayBudgetEffect({ category, budgetEffect });
    const row = {
      billPayId: billPay.id,
      owner: resolveOwner(billPay.owner, fileOwner),
      date,
      month: monthOf(date),
      merchant: billPay.merchant,
      category,
      budgetEffect,
      amountUsdCents: billPay.amountUsdCents,
      btcSpentSats: billPay.btcSpentSats,
      btcPriceCents: billPay.btcPriceCents,
      platform: optionalText(billPay.platform),
      note: optionalText(billPay.note),
      feeUsdCents: billPay.feeUsdCents,
      reference: optionalText(billPay.reference),
      sourceFile: file,
      updatedAtMs: now,
    };
    const outcome = await upsertBtcBillPayRow(
      ctx,
      row,
      baseUpdatedAtMs === undefined ? undefined : { baseUpdatedAtMs },
    );
    return {
      billPayId: row.billPayId,
      owner: row.owner,
      month: row.month,
      outcome,
    };
  },
});

export const upsertBtcTransfer = mutation({
  args: {
    transfer: btcTransferInput,
    sourceFile: v.optional(btcTransferSourceValidator),
    baseUpdatedAtMs: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { transfer, sourceFile, baseUpdatedAtMs, token }) => {
    validateSyncToken(token);
    const owner = canonicalLedgerOwner(transfer.owner);
    const now = Date.now();
    const date = requireIsoDate(transfer.date, "date", now, 30, rejectRowDate);
    const row: BtcTransferRow = {
      transferId: transfer.id,
      owner,
      date,
      month: monthOf(date),
      fromAccountKey: transfer.fromAccountKey.trim(),
      toAccountKey: transfer.toAccountKey.trim(),
      sats: transfer.sats,
      feeSats: transfer.feeSats,
      note: optionalText(transfer.note),
      sourceFile: sourceFile ?? "btc-transfers",
      balancePostingVersion: 1n,
      updatedAtMs: now,
    };
    const outcome = await upsertBtcTransferRow(
      ctx,
      row,
      baseUpdatedAtMs === undefined ? undefined : { baseUpdatedAtMs },
    );
    return { transferId: row.transferId, owner, outcome };
  },
});

export const deleteBtcTransfer = mutation({
  args: {
    transferId: v.string(),
    owner: familyMemberValidator,
    baseUpdatedAtMs: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { transferId, owner, baseUpdatedAtMs, token }) => {
    validateSyncToken(token);
    const ledgerOwner = canonicalLedgerOwner(owner);
    const removed = await deleteBtcTransferCore(
      ctx,
      ledgerOwner,
      transferId,
      baseUpdatedAtMs === undefined ? undefined : { baseUpdatedAtMs },
    );
    return { transferId, owner: ledgerOwner, removed };
  },
});

export const upsertBtcAccount = mutation({
  args: {
    account: v.object({
      key: v.string(),
      owner: familyMemberValidator,
      label: v.string(),
      custody: custodyValidator,
      sats: v.int64(),
      // Optional: the read model and the cutover runbook both allow an account
      // with no fiat valuation, and posting strips it. Requiring it here forced
      // an operator repairing a mirror to invent a number.
      fiatCents: v.optional(v.int64()),
      // The operator can also supply the complete quote. Without this the
      // full-admin path could never repair a mirror that differs only in
      // priceCents/quotedAt/source/confidence, because it had no way to say so.
      fiatValuation: v.optional(fiatValuationValidator),
      asOf: v.string(),
      schemaVersion: v.optional(v.int64()),
    }),
    sourceFile: v.optional(v.string()),
    baseUpdatedAtMs: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { account, sourceFile, baseUpdatedAtMs, token }) => {
    validateSyncToken(token);
    const file = sourceFile ?? "btc-balance-snapshot";
    const fileOwner = ownerForSourceFile(file, "btcAccounts");
    if (account.owner !== fileOwner) {
      throw new ConvexError(
        `upsertBtcAccount: source file "${file}" belongs to ${fileOwner}, ` +
        `not ${account.owner}.`,
      );
    }
    if (file !== "btc-balance-snapshot" && file !== "son-balances") {
      throw new ConvexError(`Unknown Bitcoin account source file "${file}".`);
    }
    const document = await ctx.db
      .query("btcBalanceDocuments")
      .withIndex("by_source_file", (q) => q.eq("sourceFile", file))
      .unique();
    if (document) {
      const outcome = await upsertBtcAccountCore(
        ctx,
        file,
        {
          key: account.key,
          owner: account.owner,
          label: account.label,
          custody: account.custody,
          sats: account.sats,
          asOf: account.asOf,
          schemaVersion: account.schemaVersion,
          fiatValuation:
            account.fiatValuation ??
            (account.fiatCents === undefined
              ? undefined
              : { cents: account.fiatCents }),
        },
        document.postingActivatedAtMs !== undefined || baseUpdatedAtMs !== undefined
          ? { baseUpdatedAtMs }
          : undefined,
      );
      return { key: account.key.trim(), owner: account.owner, outcome };
    }
    // Legacy bootstrap may populate the compatibility table before the typed
    // document migration creates its authority. Once that document exists,
    // every sync-token write above is routed through the atomic document path.
    const row = {
      ...account,
      schemaVersion: account.schemaVersion ?? 0n,
      sourceFile: file,
      updatedAtMs: Date.now(),
    };
    const outcome = await upsertBtcAccountRow(ctx, row);
    return { key: row.key, owner: row.owner, outcome };
  },
});

/**
 * Insert or replace ONE category in the budget document visible to `viewer`.
 *
 * The document itself must already exist: creating one would require defaults
 * for income, history and other fields that a category edit does not own. A new
 * category name is appended to the existing document; an exact name match is
 * replaced in place so category ordering remains stable.
 *
 * `month` is an optimistic scope guard, not a month selector. getBudgetDocument
 * exposes the one document selected by budgetSourceFor(viewer), and callers
 * derive spend from that document's own month. Refusing a stale month here keeps
 * a category edit made from a June screen from changing the July document.
 */
function budgetOwnerForSource(
  sourceFile: "budget" | "mason-budget",
): FamilyMember {
  return sourceFile === "budget" ? "victor" : "mason";
}

/** Rachel shares the canonical adult financial ledger stored under Victor. */
function canonicalLedgerOwner(owner: FamilyMember): FamilyMember {
  return owner === "rachel" ? "victor" : owner;
}

function foldedCategoryName(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Budget category name must not be empty.",
    );
  }
  return normalized.toLocaleLowerCase("en-US");
}

async function upsertBudgetCategoryCore(
  ctx: MutationCtx,
  sourceFile: "budget" | "mason-budget",
  owner: FamilyMember,
  month: string,
  category: {
    name: string;
    icon?: string;
    budgetCents: bigint;
  },
  previousName?: string,
  optimistic?: OptimisticWrite,
): Promise<{ entityId: string; outcome: UpsertOutcome }> {
  const expectedOwner = budgetOwnerForSource(sourceFile);
  if (owner !== expectedOwner) {
    deviceFailure(
      "OWNER_SOURCE_MISMATCH",
      `Budget source "${sourceFile}" belongs to ${expectedOwner}, not ${owner}.`,
    );
  }
  const existing = await ctx.db
    .query("budgetDocuments")
    .withIndex("by_source_file", (q) => q.eq("sourceFile", sourceFile))
    .unique();
  if (!existing) {
    deviceFailure(
      "ENTITY_NOT_FOUND",
      `Budget document "${sourceFile}" does not exist; a category edit ` +
        "does not create a whole budget document.",
      "budgetCategory",
      previousName ?? category.name,
    );
  }
  if (existing.owner !== owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Budget document "${sourceFile}" belongs to ${existing.owner}, not ${owner}.`,
      "budgetCategory",
      previousName ?? category.name,
    );
  }
  if (month !== existing.month) {
    deviceFailure(
      "ENTITY_CONFLICT",
      `requested month ${JSON.stringify(month)} does not match ` +
        `${sourceFile}'s month ${JSON.stringify(existing.month)}.`,
      "budgetCategory",
      previousName ?? category.name,
    );
  }
  if (optimistic && optimistic.baseUpdatedAtMs === undefined) {
    deviceFailure(
      "REVISION_REQUIRED",
      "baseUpdatedAtMs is required to edit a budget document.",
      "budgetCategory",
      previousName ?? category.name,
    );
  }
  if (optimistic && optimistic.baseUpdatedAtMs !== existing.updatedAtMs) {
    deviceFailure(
      "ENTITY_CONFLICT",
      "The budget changed after it was read.",
      "budgetCategory",
      previousName ?? category.name,
    );
  }

  const name = category.name.trim();
  const targetFold = foldedCategoryName(name);
  const sourceFold =
    previousName === undefined ? targetFold : foldedCategoryName(previousName);
  const sourceIndex = existing.categories.findIndex(
    (candidate) => foldedCategoryName(candidate.name) === sourceFold,
  );
  const targetIndex = existing.categories.findIndex(
    (candidate) => foldedCategoryName(candidate.name) === targetFold,
  );
  if (previousName !== undefined && sourceIndex === -1) {
    deviceFailure(
      "ENTITY_NOT_FOUND",
      `Budget category ${JSON.stringify(previousName)} does not exist.`,
      "budgetCategory",
      previousName,
    );
  }
  if (
    previousName !== undefined &&
    targetIndex !== -1 &&
    targetIndex !== sourceIndex
  ) {
    deviceFailure(
      "VALIDATION_FAILED",
      `Budget category ${JSON.stringify(name)} already exists; rename refused.`,
      "budgetCategory",
      name,
    );
  }

  const categories = [...existing.categories];
  const normalizedCategory = {
    name,
    icon: optionalText(category.icon),
    budgetCents: category.budgetCents,
  };
  const writeIndex = previousName !== undefined ? sourceIndex : targetIndex;
  const outcome: UpsertOutcome = writeIndex === -1 ? "inserted" : "updated";
  if (writeIndex === -1) categories.push(normalizedCategory);
  else categories[writeIndex] = normalizedCategory;

  await lockRuntimeSource(ctx, sourceFile);
  await ctx.db.patch(existing._id, {
    categories,
    updatedAtMs: optimistic
      ? nextUpdatedAtMs(existing.updatedAtMs)
      : Date.now(),
  });
  if (previousName !== undefined && sourceFold !== targetFold) {
    await upsertRowTombstone(
      ctx,
      "budgetCategory",
      sourceFile,
      sourceFold,
      owner,
      optimistic?.baseUpdatedAtMs,
    );
  }
  await clearRowTombstone(ctx, "budgetCategory", sourceFile, targetFold);
  return { entityId: name, outcome };
}

async function deleteBudgetCategoryCore(
  ctx: MutationCtx,
  sourceFile: "budget" | "mason-budget",
  owner: FamilyMember,
  month: string,
  name: string,
  optimistic?: OptimisticWrite,
): Promise<boolean> {
  const currentMonth = trustedCurrentMonth();
  if (month !== currentMonth) {
    deviceFailure(
      "ENTITY_CONFLICT",
      `Budget category deletion is limited to the current month ${currentMonth}.`,
      "budgetCategory",
      name,
    );
  }
  const expectedOwner = budgetOwnerForSource(sourceFile);
  if (owner !== expectedOwner) {
    deviceFailure(
      "OWNER_SOURCE_MISMATCH",
      `Budget source "${sourceFile}" belongs to ${expectedOwner}, not ${owner}.`,
    );
  }
  const existing = await ctx.db
    .query("budgetDocuments")
    .withIndex("by_source_file", (q) => q.eq("sourceFile", sourceFile))
    .unique();
  if (!existing) {
    deviceFailure(
      "ENTITY_NOT_FOUND",
      `Budget document "${sourceFile}" does not exist.`,
      "budgetCategory",
      name,
    );
  }
  if (existing.owner !== owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Budget document "${sourceFile}" belongs to ${existing.owner}, not ${owner}.`,
      "budgetCategory",
      name,
    );
  }
  if (month !== existing.month) {
    deviceFailure(
      "ENTITY_CONFLICT",
      `requested month ${JSON.stringify(month)} does not match ` +
        `${sourceFile}'s month ${JSON.stringify(existing.month)}.`,
      "budgetCategory",
      name,
    );
  }
  if (optimistic && optimistic.baseUpdatedAtMs === undefined) {
    deviceFailure(
      "REVISION_REQUIRED",
      "baseUpdatedAtMs is required to delete a budget category.",
      "budgetCategory",
      name,
    );
  }
  if (optimistic?.baseUpdatedAtMs !== undefined && optimistic.baseUpdatedAtMs <= 0) {
    deviceFailure(
      "VALIDATION_FAILED",
      "baseUpdatedAtMs must be a positive exact revision for category deletion.",
      "budgetCategory",
      name,
    );
  }
  const targetFold = foldedCategoryName(name);
  const foldedMatches = existing.categories
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => foldedCategoryName(candidate.name) === targetFold);
  if (foldedMatches.length > 1) {
    deviceFailure(
      "VALIDATION_FAILED",
      `Budget category ${JSON.stringify(name)} has a case-folded identity collision.`,
      "budgetCategory",
      name,
    );
  }
  const index = foldedMatches[0]?.index ?? -1;
  const tombstoneId = targetFold;
  const tombstone = optimistic
    ? await findRowTombstone(ctx, "budgetCategory", sourceFile, tombstoneId)
    : null;
  if (index === -1 && optimistic) {
    if (tombstone?.deletedFromUpdatedAtMs === optimistic.baseUpdatedAtMs) {
      return false;
    }
    deviceFailure(
      tombstone ? "ENTITY_CONFLICT" : "ENTITY_NOT_FOUND",
      tombstone
        ? "The category deletion does not match the current revision."
        : "The budget category to delete does not exist.",
      "budgetCategory",
      foldedMatches[0]?.candidate.name ?? name,
    );
  }
  if (optimistic && optimistic.baseUpdatedAtMs !== existing.updatedAtMs) {
    deviceFailure(
      "ENTITY_CONFLICT",
      "The budget changed after it was read.",
      "budgetCategory",
      name,
    );
  }
  if (index !== -1) {
    const categories = [...existing.categories];
    categories.splice(index, 1);
    await lockRuntimeSource(ctx, sourceFile);
    await ctx.db.patch(existing._id, {
      categories,
      updatedAtMs: optimistic
        ? nextUpdatedAtMs(existing.updatedAtMs)
        : Date.now(),
    });
  }
  if (index === -1) await lockRuntimeSource(ctx, sourceFile);
  await upsertRowTombstone(
    ctx,
    "budgetCategory",
    sourceFile,
    tombstoneId,
    owner,
    optimistic?.baseUpdatedAtMs,
  );
  return index !== -1;
}

export const upsertBudgetCategory = mutation({
  args: {
    viewer: familyMemberValidator,
    month: v.string(),
    category: v.object({
      name: v.string(),
      icon: v.optional(v.string()),
      budgetCents: v.int64(),
    }),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, month, category, token }) => {
    validateSyncToken(token);
    const sourceFile = budgetSourceFor(viewer);
    if (sourceFile === null) {
      throw new ConvexError(
        `upsertBudgetCategory: ${viewer} has no budget document.`,
      );
    }

    const owner = budgetOwnerForSource(sourceFile);
    const result = await upsertBudgetCategoryCore(
      ctx,
      sourceFile,
      owner,
      month,
      category,
    );
    return {
      owner,
      month,
      name: result.entityId,
      outcome: result.outcome,
    };
  },
});

function requireSourceOwner(
  sourceFile: string,
  kind: BlobKind,
  owner: FamilyMember,
) {
  const expectedOwner = ownerForSourceFile(sourceFile, kind);
  if (owner !== expectedOwner) {
    deviceFailure(
      "OWNER_SOURCE_MISMATCH",
      `Source file "${sourceFile}" belongs to ${expectedOwner}, not ${owner}.`,
    );
  }
}

function deviceTodoRow(
  todo: {
    id: string;
    owner: FamilyMember;
    title: string;
    done: boolean;
    flagged: boolean;
    lane?: string;
    project?: string;
    area?: string;
    due?: string;
    notes?: string;
    priority?: bigint;
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string;
  },
  now: number,
) {
  return buildTodoRow(
    {
      id: todo.id,
      owner: todo.owner,
      title: todo.title,
      done: todo.done,
      flagged: todo.flagged,
      category: todo.lane,
      project: todo.project,
      area: todo.area,
      dueDate: todo.due,
      notes: todo.notes,
      priority: todo.priority,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
      completedAt: todo.completedAt,
    },
    todo.owner,
    "todos",
    now,
  );
}

function validateDeviceTodo(
  todo: Parameters<typeof deviceTodoRow>[0],
) {
  requireDeviceIdentifier(todo.id, "todo.id");
  requireDeviceText(todo.title, "todo.title");
  requireDeviceOptionalText(todo.lane, "todo.lane");
  requireDeviceOptionalText(todo.project, "todo.project");
  requireDeviceOptionalText(todo.area, "todo.area");
  requireDeviceCalendarDate(todo.due, "todo.due");
  requireDeviceOptionalText(todo.notes, "todo.notes");
  requireDeviceTimestamp(todo.createdAt, "todo.createdAt");
  requireDeviceTimestamp(todo.updatedAt, "todo.updatedAt");
  requireDeviceTimestamp(todo.completedAt, "todo.completedAt");
}

async function deleteTransactionCore(
  ctx: MutationCtx,
  sourceFile: string,
  owner: FamilyMember,
  txId: string,
  optimistic?: OptimisticWrite,
) {
  requireSourceOwner(sourceFile, "transactions", owner);
  const existing = await ctx.db
    .query("transactions")
    .withIndex("by_source_tx_id", (q) =>
      q.eq("sourceFile", sourceFile).eq("txId", txId),
    )
    .unique();
  const tombstone = optimistic
    ? await findRowTombstone(ctx, "transaction", sourceFile, txId)
    : null;
  if (optimistic && optimistic.baseUpdatedAtMs === undefined) {
    deviceFailure(
      "REVISION_REQUIRED",
      "baseUpdatedAtMs is required to delete a transaction.",
      "transaction",
      txId,
    );
  }
  if (!existing && optimistic) {
    if (tombstone?.deletedFromUpdatedAtMs === optimistic.baseUpdatedAtMs) {
      return false;
    }
    deviceFailure(
      tombstone ? "ENTITY_CONFLICT" : "ENTITY_NOT_FOUND",
      tombstone
        ? "The transaction deletion does not match the current revision."
        : "The transaction to delete does not exist.",
      "transaction",
      txId,
    );
  }
  if (existing && existing.owner !== owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Transaction ${txId} belongs to ${existing.owner}, not ${owner}.`,
      "transaction",
      txId,
    );
  }
  if (
    existing &&
    optimistic &&
    optimistic.baseUpdatedAtMs !== existing.updatedAtMs
  ) {
    deviceFailure(
      "ENTITY_CONFLICT",
      "The transaction changed after it was read.",
      "transaction",
      txId,
    );
  }
  if (existing?.balancePostingVersion === 1n) {
    const posting = storedTransactionBalanceDelta(existing);
    if (!posting) throw new ConvexError("Posted transaction lost its Bitcoin posting.");
    const deltas = new Map<string, bigint>();
    addDelta(deltas, posting.accountKey, -posting.delta);
    await applyBtcAccountDeltas(ctx, existing.owner, deltas);
  }
  await lockRuntimeSource(ctx, sourceFile);
  if (existing) await ctx.db.delete(existing._id);
  await upsertRowTombstone(
    ctx,
    "transaction",
    sourceFile,
    txId,
    owner,
    optimistic?.baseUpdatedAtMs,
  );
  return existing !== null;
}

async function deleteTodoCore(
  ctx: MutationCtx,
  owner: FamilyMember,
  todoId: string,
  optimistic?: OptimisticWrite,
) {
  const existing = await ctx.db
    .query("todos")
    .withIndex("by_todo_id", (q) => q.eq("todoId", todoId))
    .unique();
  const tombstone = optimistic
    ? await findRowTombstone(ctx, "todo", "todos", todoId)
    : null;
  if (tombstone && tombstone.owner !== owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Deleted todo ${todoId} belongs to ${tombstone.owner}, not ${owner}.`,
      "todo",
      todoId,
    );
  }
  if (optimistic && optimistic.baseUpdatedAtMs === undefined) {
    deviceFailure(
      "REVISION_REQUIRED",
      "baseUpdatedAtMs is required to delete a todo.",
      "todo",
      todoId,
    );
  }
  if (!existing && optimistic) {
    if (tombstone?.deletedFromUpdatedAtMs === optimistic.baseUpdatedAtMs) {
      return false;
    }
    deviceFailure(
      tombstone ? "ENTITY_CONFLICT" : "ENTITY_NOT_FOUND",
      tombstone
        ? "The todo deletion does not match the current revision."
        : "The todo to delete does not exist.",
      "todo",
      todoId,
    );
  }
  if (existing && existing.owner !== owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Todo ${todoId} belongs to ${existing.owner}, not ${owner}.`,
      "todo",
      todoId,
    );
  }
  if (
    existing &&
    optimistic &&
    optimistic.baseUpdatedAtMs !== existing.updatedAtMs
  ) {
    deviceFailure(
      "ENTITY_CONFLICT",
      "The todo changed after it was read.",
      "todo",
      todoId,
    );
  }
  await lockRuntimeSource(ctx, "todos");
  if (existing) await ctx.db.delete(existing._id);
  await upsertRowTombstone(
    ctx,
    "todo",
    "todos",
    todoId,
    owner,
    optimistic?.baseUpdatedAtMs,
    existing === null ? undefined : captureTodoForRestore(existing),
  );
  await upsertLegacyTodoTombstone(ctx, todoId);
  return existing !== null;
}

async function restoreTodoCore(
  ctx: MutationCtx,
  owner: FamilyMember,
  requestedRow: ReturnType<typeof deviceTodoRow>,
  baseUpdatedAtMs: number,
) {
  const existing = await ctx.db
    .query("todos")
    .withIndex("by_todo_id", (q) => q.eq("todoId", requestedRow.todoId))
    .unique();
  if (existing) {
    if (existing.owner !== owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        `Todo ${requestedRow.todoId} belongs to ${existing.owner}, not ${owner}.`,
        "todo",
        requestedRow.todoId,
      );
    }
    deviceFailure(
      "ENTITY_CONFLICT",
      "The todo is not deleted and cannot be restored.",
      "todo",
      requestedRow.todoId,
    );
  }

  const tombstone = await findRowTombstone(
    ctx,
    "todo",
    "todos",
    requestedRow.todoId,
  );
  if (!tombstone) {
    deviceFailure(
      "ENTITY_NOT_FOUND",
      "No deleted todo revision exists to restore.",
      "todo",
      requestedRow.todoId,
    );
  }
  if (tombstone.owner !== owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Deleted todo ${requestedRow.todoId} belongs to ${tombstone.owner}, not ${owner}.`,
      "todo",
      requestedRow.todoId,
    );
  }
  if (tombstone.deletedFromUpdatedAtMs !== baseUpdatedAtMs) {
    deviceFailure(
      "ENTITY_CONFLICT",
      "The todo deletion does not match the revision being restored.",
      "todo",
      requestedRow.todoId,
    );
  }

  const capsule = tombstone.todoRestoreCapsule;
  if (
    !capsule ||
    capsule.todoId !== requestedRow.todoId ||
    capsule.owner !== owner ||
    capsule.sourceFile !== "todos" ||
    capsule.updatedAtMs !== baseUpdatedAtMs
  ) {
    deviceFailure(
      "ENTITY_CONFLICT",
      "The deleted todo revision has no matching authoritative restore data.",
      "todo",
      requestedRow.todoId,
    );
  }

  // The restored row receives a new revision above both the deleted row and
  // its tombstone. A later delete therefore cannot be undone by replaying this
  // restore request with the old base revision.
  const updatedAtMs = nextUpdatedAtMs(
    Math.max(baseUpdatedAtMs, tombstone.deletedAtMs),
  );
  await lockRuntimeSource(ctx, "todos");
  await ctx.db.insert("todos", { ...capsule, updatedAtMs });
  await ctx.db.delete(tombstone._id);
  // The legacy blob still contains the pre-row-authority value. Keep its
  // compatibility tombstone until a later cutover removes or rewrites that
  // source; clearing it here would show stale content on Apple/legacy clients.
  await upsertLegacyTodoTombstone(ctx, requestedRow.todoId);
  return updatedAtMs;
}

async function deleteBtcBuyCore(
  ctx: MutationCtx,
  sourceFile: string,
  owner: FamilyMember,
  buyId: string,
  optimistic?: OptimisticWrite,
) {
  requireSourceOwner(sourceFile, "btcBuys", owner);
  const existing = await ctx.db
    .query("btcBuys")
    .withIndex("by_source_buy_id", (q) =>
      q.eq("sourceFile", sourceFile).eq("buyId", buyId),
    )
    .unique();
  const tombstone = optimistic
    ? await findRowTombstone(ctx, "btcBuy", sourceFile, buyId)
    : null;
  if (optimistic && optimistic.baseUpdatedAtMs === undefined) {
    deviceFailure(
      "REVISION_REQUIRED",
      "baseUpdatedAtMs is required to delete a bitcoin buy.",
      "btcBuy",
      buyId,
    );
  }
  if (!existing && optimistic) {
    if (tombstone?.deletedFromUpdatedAtMs === optimistic.baseUpdatedAtMs) {
      return false;
    }
    deviceFailure(
      tombstone ? "ENTITY_CONFLICT" : "ENTITY_NOT_FOUND",
      tombstone
        ? "The bitcoin buy deletion does not match the current revision."
        : "The bitcoin buy to delete does not exist.",
      "btcBuy",
      buyId,
    );
  }
  if (existing && existing.owner !== owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Bitcoin buy ${buyId} belongs to ${existing.owner}, not ${owner}.`,
      "btcBuy",
      buyId,
    );
  }
  if (
    existing &&
    optimistic &&
    optimistic.baseUpdatedAtMs !== existing.updatedAtMs
  ) {
    deviceFailure(
      "ENTITY_CONFLICT",
      "The bitcoin buy changed after it was read.",
      "btcBuy",
      buyId,
    );
  }
  if (existing?.linkedIncomeId !== undefined) {
    deviceFailure(
      "VALIDATION_FAILED",
      "A linked income Bitcoin buy cannot be deleted until paired correction and deletion are implemented.",
      "btcBuy",
      buyId,
    );
  }
  if (existing?.balancePostingVersion === 1n) {
    if (!existing.balanceAccountKey) {
      throw new ConvexError("Posted Bitcoin buy is missing its account key.");
    }
    const deltas = new Map<string, bigint>();
    addDelta(deltas, existing.balanceAccountKey, -existing.sats);
    await applyBtcAccountDeltas(ctx, existing.owner, deltas);
  }
  await lockRuntimeSource(ctx, sourceFile);
  if (existing) await ctx.db.delete(existing._id);
  await upsertRowTombstone(
    ctx,
    "btcBuy",
    sourceFile,
    buyId,
    owner,
    optimistic?.baseUpdatedAtMs,
  );
  return existing !== null;
}

async function deleteBtcBillPayCore(
  ctx: MutationCtx,
  owner: FamilyMember,
  billPayId: string,
  optimistic?: OptimisticWrite,
) {
  const sourceFile = "bitcoin-bill-pays";
  const existing = await ctx.db
    .query("btcBillPays")
    .withIndex("by_source_bill_pay_id", (q) =>
      q.eq("sourceFile", sourceFile).eq("billPayId", billPayId),
    )
    .unique();
  const tombstone = optimistic
    ? await findRowTombstone(ctx, "btcBillPay", sourceFile, billPayId)
    : null;
  if (optimistic && optimistic.baseUpdatedAtMs === undefined) {
    deviceFailure(
      "REVISION_REQUIRED",
      "baseUpdatedAtMs is required to delete a bitcoin bill pay.",
      "btcBillPay",
      billPayId,
    );
  }
  if (!existing && optimistic) {
    if (tombstone?.deletedFromUpdatedAtMs === optimistic.baseUpdatedAtMs) {
      return false;
    }
    deviceFailure(
      tombstone ? "ENTITY_CONFLICT" : "ENTITY_NOT_FOUND",
      tombstone
        ? "The bill pay deletion does not match the current revision."
        : "The bitcoin bill pay to delete does not exist.",
      "btcBillPay",
      billPayId,
    );
  }
  if (existing && existing.owner !== owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Bitcoin bill pay ${billPayId} belongs to ${existing.owner}, not ${owner}.`,
      "btcBillPay",
      billPayId,
    );
  }
  if (
    existing &&
    optimistic &&
    optimistic.baseUpdatedAtMs !== existing.updatedAtMs
  ) {
    deviceFailure(
      "ENTITY_CONFLICT",
      "The bitcoin bill pay changed after it was read.",
      "btcBillPay",
      billPayId,
    );
  }
  if (existing?.balancePostingVersion === 1n) {
    if (!existing.balanceAccountKey) {
      throw new ConvexError("Posted Bitcoin bill pay is missing its account key.");
    }
    const deltas = new Map<string, bigint>();
    addDelta(deltas, existing.balanceAccountKey, existing.btcSpentSats);
    await applyBtcAccountDeltas(ctx, existing.owner, deltas);
  }
  await lockRuntimeSource(ctx, sourceFile);
  if (existing) await ctx.db.delete(existing._id);
  await upsertRowTombstone(
    ctx,
    "btcBillPay",
    sourceFile,
    billPayId,
    owner,
    optimistic?.baseUpdatedAtMs,
  );
  return existing !== null;
}

function btcAccountTotals(
  accounts: Array<{
    custody: "exchange" | "self_custody";
    sats: bigint;
    fiatCents?: bigint;
    fiatValuation?: { cents: bigint };
  }>,
) {
  const totals = accounts.reduce(
    (totals, account) => ({
      sats: totals.sats + account.sats,
      exchangeSats:
        totals.exchangeSats +
        (account.custody === "exchange" ? account.sats : 0n),
      selfCustodySats:
        totals.selfCustodySats +
        (account.custody === "self_custody" ? account.sats : 0n),
    }),
    {
      sats: 0n,
      exchangeSats: 0n,
      selfCustodySats: 0n,
    },
  );
  const fiatValues = accounts.map(
    (account) => account.fiatValuation?.cents ?? account.fiatCents,
  );
  return {
    ...totals,
    fiatCents: fiatValues.every((value): value is bigint => value !== undefined)
      ? fiatValues.reduce((sum, value) => sum + value, 0n)
      : undefined,
  };
}

type BtcFiatValuation = {
  cents: bigint;
  priceCents?: bigint;
  quotedAt?: string;
  source?: string;
  confidence?: string;
};

/**
 * Every field the request actually carries must already match. A request with
 * no valuation means "leave it alone"; one that names only `cents` stays as
 * idempotent as it always was; and a refreshed quote — which carries
 * `priceCents`, `quotedAt`, `source` and `confidence` — stops matching as soon
 * as any of them moves, so it can no longer be silently discarded on an account
 * whose cents happen to be unchanged.
 */
/** Rows migrated before valuations existed carry only a bare `fiatCents`. */
function effectiveFiatValuation(record: {
  fiatCents?: bigint;
  fiatValuation?: BtcFiatValuation;
}): BtcFiatValuation | undefined {
  if (record.fiatValuation !== undefined) return record.fiatValuation;
  return record.fiatCents === undefined ? undefined : { cents: record.fiatCents };
}

function sameFiatValuation(
  requested: BtcFiatValuation | undefined,
  stored: BtcFiatValuation | undefined,
): boolean {
  if (requested === undefined) return true;
  if (stored === undefined) return false;
  if (stored.cents !== requested.cents) return false;
  if (
    requested.priceCents !== undefined &&
    stored.priceCents !== requested.priceCents
  ) {
    return false;
  }
  if (
    requested.quotedAt !== undefined &&
    stored.quotedAt !== requested.quotedAt
  ) {
    return false;
  }
  if (requested.source !== undefined && stored.source !== requested.source) {
    return false;
  }
  return (
    requested.confidence === undefined ||
    stored.confidence === requested.confidence
  );
}

function btcAccountMirrorKey(
  sourceFile: "btc-balance-snapshot" | "son-balances",
  canonicalKey: string,
) {
  return sourceFile === "son-balances"
    ? `son-${canonicalKey}-mason`
    : canonicalKey;
}

async function hasPostedBtcAccountReference(
  ctx: MutationCtx,
  owner: FamilyMember,
  accountKey: string,
): Promise<boolean> {
  const rowOwners: FamilyMember[] =
    owner === "victor" ? ["victor", "rachel"] : [owner];
  for (const rowOwner of rowOwners) {
    const [transactions, buys, billPays, transfers] = await Promise.all([
      ctx.db
        .query("transactions")
        .withIndex("by_owner_date", (q) => q.eq("owner", rowOwner))
        .collect(),
      ctx.db
        .query("btcBuys")
        .withIndex("by_owner_date", (q) => q.eq("owner", rowOwner))
        .collect(),
      ctx.db
        .query("btcBillPays")
        .withIndex("by_owner_date", (q) => q.eq("owner", rowOwner))
        .collect(),
      ctx.db
        .query("btcTransfers")
        .withIndex("by_owner_date", (q) => q.eq("owner", rowOwner))
        .collect(),
    ]);
    if (
      transactions.some(
        (row) =>
          row.balancePostingVersion === 1n &&
          row.bitcoinAccountKey === accountKey,
      ) ||
      buys.some(
        (row) =>
          row.balancePostingVersion === 1n &&
          row.balanceAccountKey === accountKey,
      ) ||
      billPays.some(
        (row) =>
          row.balancePostingVersion === 1n &&
          row.balanceAccountKey === accountKey,
      ) ||
      transfers.some(
        (row) =>
          row.balancePostingVersion === 1n &&
          (row.fromAccountKey === accountKey || row.toAccountKey === accountKey),
      )
    ) {
      return true;
    }
  }
  return false;
}

async function upsertBtcAccountCore(
  ctx: MutationCtx,
  sourceFile: "btc-balance-snapshot" | "son-balances",
  account: {
    key: string;
    owner: FamilyMember;
    label: string;
    custody: "exchange" | "self_custody";
    sats: bigint;
    asOf: string;
    schemaVersion?: bigint;
    fiatValuation?: {
      cents: bigint;
      priceCents?: bigint;
      quotedAt?: string;
      source?: string;
      confidence?: string;
    };
  },
  optimistic?: OptimisticWrite,
): Promise<UpsertOutcome> {
  requireSourceOwner(sourceFile, "btcAccounts", account.owner);
  const key = account.key.trim();
  if (!key) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Bitcoin account key must not be empty.",
      "btcAccount",
      account.key,
    );
  }
  const existingDocument = await ctx.db
    .query("btcBalanceDocuments")
    .withIndex("by_source_file", (q) => q.eq("sourceFile", sourceFile))
    .unique();
  // Loaded for every caller, not only optimistic ones. A delayed create
  // retried through the full-admin path must not resurrect a deleted row
  // and re-apply its balance legs.
  const tombstone = await findRowTombstone(ctx, "btcAccount", sourceFile, key)
  if (existingDocument && existingDocument.owner !== account.owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Bitcoin document "${sourceFile}" belongs to ` +
        `${existingDocument.owner}, not ${account.owner}.`,
      "btcAccount",
      key,
    );
  }
  if (
    optimistic &&
    !existingDocument &&
    optimistic.baseUpdatedAtMs !== undefined
  ) {
    deviceFailure(
      tombstone ? "ENTITY_DELETED" : "ENTITY_NOT_FOUND",
      tombstone
        ? "The bitcoin account was deleted after it was read."
        : "The bitcoin account document to update does not exist.",
      "btcAccount",
      key,
    );
  }
  if (optimistic && !existingDocument && tombstone) {
    deviceFailure(
      "ENTITY_DELETED",
      "A deleted bitcoin account id cannot be silently resurrected.",
      "btcAccount",
      key,
    );
  }
  const accounts = existingDocument ? [...existingDocument.accounts] : [];
  const index = accounts.findIndex((candidate) => candidate.key === key);
  const previousAccount = index === -1 ? undefined : accounts[index];
  const requestedFiatCents =
    account.fiatValuation?.cents ??
    previousAccount?.fiatValuation?.cents ??
    previousAccount?.fiatCents;
  const mirrorRowKey = btcAccountMirrorKey(sourceFile, key);
  const existingMirror = await ctx.db
    .query("btcAccounts")
    .withIndex("by_owner_key", (q) =>
      q.eq("owner", account.owner).eq("key", mirrorRowKey),
    )
    .unique();
  // The no-op shortcut must agree with BOTH sides of the pair. A document that
  // already matches while its mirror is missing or divergent is exactly the
  // state `reconcileBtcAccounts` refuses to activate, and the cutover runbook
  // sends the operator back through here to repair it — so short-circuiting on
  // the document alone would report success and leave activation wedged.
  if (
    existingDocument &&
    previousAccount &&
    previousAccount.label === account.label &&
    previousAccount.custody === account.custody &&
    previousAccount.sats === account.sats &&
    (previousAccount.fiatValuation?.cents ?? previousAccount.fiatCents) ===
      requestedFiatCents &&
    existingDocument.asOf === account.asOf &&
    existingDocument.schemaVersion ===
      (account.schemaVersion ?? existingDocument.schemaVersion) &&
    existingMirror &&
    existingMirror.owner === account.owner &&
    existingMirror.sourceFile === sourceFile &&
    existingMirror.label === account.label &&
    existingMirror.custody === account.custody &&
    existingMirror.sats === account.sats &&
    (existingMirror.fiatValuation?.cents ?? existingMirror.fiatCents) ===
      requestedFiatCents &&
    existingMirror.asOf === account.asOf &&
    existingMirror.schemaVersion ===
      (account.schemaVersion ?? existingDocument.schemaVersion) &&
    // Cents alone is not the valuation. A quote refresh that leaves cents
    // unchanged still carries a new price, timestamp, source or confidence, and
    // discarding it would freeze that account's provenance silently — most
    // visibly on a zero-sat account, where cents never move.
    sameFiatValuation(
      account.fiatValuation,
      effectiveFiatValuation(previousAccount),
    ) &&
    sameFiatValuation(
      account.fiatValuation,
      effectiveFiatValuation(existingMirror),
    )
  ) {
    return "updated";
  }
  if (
    optimistic &&
    existingDocument &&
    optimistic.baseUpdatedAtMs === undefined
  ) {
    deviceFailure(
      "REVISION_REQUIRED",
      "baseUpdatedAtMs is required to edit an existing bitcoin document.",
      "btcAccount",
      key,
    );
  }
  if (
    optimistic &&
    existingDocument &&
    optimistic.baseUpdatedAtMs !== existingDocument.updatedAtMs
  ) {
    deviceFailure(
      "ENTITY_CONFLICT",
      "The bitcoin balance document changed after it was read.",
      "btcAccount",
      key,
    );
  }
  if (existingDocument?.postingActivatedAtMs !== undefined) {
    if (optimistic?.baseUpdatedAtMs === undefined) {
      deviceFailure(
        "REVISION_REQUIRED",
        "baseUpdatedAtMs is required to edit an activated bitcoin document.",
        "btcAccount",
        key,
      );
    }
    if (previousAccount && previousAccount.sats !== account.sats) {
      deviceFailure(
        "ENTITY_CONFLICT",
        "Bitcoin account quantity is ledger-controlled after activation.",
        "btcAccount",
        key,
      );
    }
    if (!previousAccount && account.sats !== 0n) {
      deviceFailure(
        "ENTITY_CONFLICT",
        "A new Bitcoin account must start at zero after ledger activation.",
        "btcAccount",
        key,
      );
    }
  }
  const fiatValuation =
    account.fiatValuation ??
    previousAccount?.fiatValuation ??
    (previousAccount?.fiatCents === undefined
      ? undefined
      : { cents: previousAccount.fiatCents });
  const normalizedAccount = {
    key,
    label: account.label,
    custody: account.custody,
    sats: account.sats,
    fiatCents: fiatValuation?.cents,
    fiatValuation,
  };
  const outcome: UpsertOutcome = index === -1 ? "inserted" : "updated";
  if (index === -1) accounts.push(normalizedAccount);
  else accounts[index] = normalizedAccount;
  if (existingDocument?.postingActivatedAtMs !== undefined) {
    canonicalRiverAccountKey(accounts);
  }
  // Monotonic for every writer, not just fenced ones: a full-admin sync-token
  // write landing in the same millisecond as a posting must not move the
  // document revision backwards and invalidate a device's baseUpdatedAtMs.
  const now = existingDocument
    ? nextUpdatedAtMs(existingDocument.updatedAtMs)
    : Date.now();
  const documentPatch = {
    owner: account.owner,
    schemaVersion:
      account.schemaVersion ?? existingDocument?.schemaVersion ?? 0n,
    asOf: account.asOf,
    accounts,
    totals: btcAccountTotals(accounts),
    updatedAtMs: now,
  };
  if (existingDocument) {
    await lockRuntimeSource(ctx, sourceFile);
    await ctx.db.patch(existingDocument._id, documentPatch);
  } else {
    await lockRuntimeSource(ctx, sourceFile);
    await ctx.db.insert("btcBalanceDocuments", {
      sourceFile,
      ...documentPatch,
    });
  }

  const mirrorRow = {
    ...normalizedAccount,
    key: mirrorRowKey,
    owner: account.owner,
    asOf: account.asOf,
    schemaVersion: documentPatch.schemaVersion,
    sourceFile,
    updatedAtMs: now,
  };
  if (existingMirror) await ctx.db.patch(existingMirror._id, mirrorRow);
  else await ctx.db.insert("btcAccounts", mirrorRow);
  await clearRowTombstone(ctx, "btcAccount", sourceFile, key);
  return outcome;
}

async function deleteBtcAccountCore(
  ctx: MutationCtx,
  sourceFile: "btc-balance-snapshot" | "son-balances",
  owner: FamilyMember,
  key: string,
  optimistic?: OptimisticWrite,
) {
  requireSourceOwner(sourceFile, "btcAccounts", owner);
  const accountKey = key.trim();
  if (!accountKey) {
    deviceFailure(
      "VALIDATION_FAILED",
      "Bitcoin account key must not be empty.",
      "btcAccount",
      key,
    );
  }
  const document = await ctx.db
    .query("btcBalanceDocuments")
    .withIndex("by_source_file", (q) => q.eq("sourceFile", sourceFile))
    .unique();
  const tombstone = optimistic
    ? await findRowTombstone(ctx, "btcAccount", sourceFile, accountKey)
    : null;
  if (optimistic && optimistic.baseUpdatedAtMs === undefined) {
    deviceFailure(
      "REVISION_REQUIRED",
      "baseUpdatedAtMs is required to delete a bitcoin account.",
      "btcAccount",
      accountKey,
    );
  }
  if (document && document.owner !== owner) {
    deviceFailure(
      "OWNER_MISMATCH",
      `Bitcoin document "${sourceFile}" belongs to ${document.owner}, not ${owner}.`,
      "btcAccount",
      accountKey,
    );
  }
  const accounts = document
    ? document.accounts.filter((account) => account.key !== accountKey)
    : [];
  const removed =
    document !== null && accounts.length !== document.accounts.length;
  if (!removed && optimistic) {
    if (tombstone?.deletedFromUpdatedAtMs === optimistic.baseUpdatedAtMs) {
      return false;
    }
    deviceFailure(
      tombstone ? "ENTITY_CONFLICT" : "ENTITY_NOT_FOUND",
      tombstone
        ? "The account deletion does not match the current revision."
        : "The bitcoin account to delete does not exist.",
      "btcAccount",
      accountKey,
    );
  }
  if (
    document &&
    optimistic &&
    optimistic.baseUpdatedAtMs !== document.updatedAtMs
  ) {
    deviceFailure(
      "ENTITY_CONFLICT",
      "The bitcoin balance document changed after it was read.",
      "btcAccount",
      accountKey,
    );
  }
  const removedAccount = document?.accounts.find(
    (account) => account.key === accountKey,
  );
  if (document && removedAccount) {
    if (removedAccount.sats !== 0n) {
      deviceFailure(
        "ENTITY_CONFLICT",
        "A Bitcoin account must have a zero balance before deletion.",
        "btcAccount",
        accountKey,
      );
    }
    if (await hasPostedBtcAccountReference(ctx, owner, accountKey)) {
      deviceFailure(
        "ENTITY_CONFLICT",
        "A Bitcoin account referenced by posted activity cannot be deleted.",
        "btcAccount",
        accountKey,
      );
    }
    if (document.postingActivatedAtMs !== undefined) {
      canonicalRiverAccountKey(accounts);
    }
  }
  if (document && removed) {
    await lockRuntimeSource(ctx, sourceFile);
    await ctx.db.patch(document._id, {
      accounts,
      totals: btcAccountTotals(accounts),
      updatedAtMs: optimistic
        ? nextUpdatedAtMs(document.updatedAtMs)
        : Date.now(),
    });
  }
  if (!removed) await lockRuntimeSource(ctx, sourceFile);
  const mirror = await ctx.db
    .query("btcAccounts")
    .withIndex("by_owner_key", (q) =>
      q
        .eq("owner", owner)
        .eq("key", btcAccountMirrorKey(sourceFile, accountKey)),
    )
    .unique();
  if (mirror) await ctx.db.delete(mirror._id);
  await upsertRowTombstone(
    ctx,
    "btcAccount",
    sourceFile,
    accountKey,
    owner,
    optimistic?.baseUpdatedAtMs,
  );
  return removed;
}

export const upsertTransactionFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    owner: familyMemberValidator,
    sourceFile: transactionSourceValidator,
    baseUpdatedAtMs: v.optional(v.float64()),
    transaction: transactionDeviceInput,
  },
  returns: deviceUpsertResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "transactions:write",
    );
    const existing = await ctx.db
      .query("transactions")
      .withIndex("by_source_tx_id", (q) =>
        q.eq("sourceFile", args.sourceFile).eq("txId", args.transaction.id),
      )
      .unique();
    if (
      args.transaction.amountSats !== undefined ||
      existing?.balancePostingVersion === 1n
    ) {
      await authenticateDevice(
        ctx,
        args.deviceId,
        args.deviceToken,
        "bitcoin:write",
      );
    }
    requireDeviceRevision(args.baseUpdatedAtMs, false);
    requireDeviceIdentifier(args.transaction.id, "transaction.id");
    requireDeviceText(args.transaction.merchant, "transaction.merchant");
    requireDeviceText(args.transaction.category, "transaction.category");
    requireDeviceOptionalText(args.transaction.card, "transaction.card");
    requireDeviceOptionalText(args.transaction.note, "transaction.note");
    requireDeviceOptionalText(
      args.transaction.bitcoinAccountKey,
      "transaction.bitcoinAccountKey",
    );
    validateDeviceTransactionPaymentSource(args.transaction, existing);
    const ledgerOwner = canonicalLedgerOwner(args.owner);
    requireSourceOwner(args.sourceFile, "transactions", ledgerOwner);
    if (args.transaction.owner !== args.owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        "Transaction owner does not match request owner.",
        "transaction",
        args.transaction.id,
      );
    }
    const now = Date.now();
    const date = requireIsoDate(
      args.transaction.date,
      "date",
      now,
      30,
      rejectDeviceDate,
    );
    requireSignAgrees(
      args.transaction.amountCents,
      ledgerOwner,
      args.transaction.kind,
      args.transaction.category,
    );
    requireBitcoinPaymentSourceDirection(
      optionalText(args.transaction.card),
      args.transaction.kind,
      args.transaction.category,
      args.transaction.id,
    );
    const outcome = await upsertTransactionRow(
      ctx,
      {
        txId: args.transaction.id,
        owner: ledgerOwner,
        date,
        month: monthOf(date),
        merchant: args.transaction.merchant,
        amountCents: args.transaction.amountCents,
        category: args.transaction.category,
        card: optionalText(args.transaction.card),
        note: optionalText(args.transaction.note),
        amountSats: args.transaction.amountSats,
        bitcoinAccountKey: optionalText(args.transaction.bitcoinAccountKey),
        sourceFile: args.sourceFile,
        updatedAtMs: now,
      },
      { baseUpdatedAtMs: args.baseUpdatedAtMs },
    );
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: args.transaction.id, outcome };
  },
});

export const deleteTransactionFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    owner: familyMemberValidator,
    sourceFile: transactionSourceValidator,
    entityId: v.string(),
    baseUpdatedAtMs: v.float64(),
  },
  returns: deviceDeleteResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "transactions:write",
    );
    const existing = await ctx.db
      .query("transactions")
      .withIndex("by_source_tx_id", (q) =>
        q.eq("sourceFile", args.sourceFile).eq("txId", args.entityId),
      )
      .unique();
    if (existing?.balancePostingVersion === 1n) {
      await authenticateDevice(
        ctx,
        args.deviceId,
        args.deviceToken,
        "bitcoin:write",
      );
    }
    requireDeviceRevision(args.baseUpdatedAtMs, true);
    requireDeviceIdentifier(args.entityId, "entityId");
    const removed = await deleteTransactionCore(
      ctx,
      args.sourceFile,
      canonicalLedgerOwner(args.owner),
      args.entityId,
      { baseUpdatedAtMs: args.baseUpdatedAtMs },
    );
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: args.entityId, removed };
  },
});

export const upsertTodoFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    activeProfile: familyMemberValidator,
    owner: familyMemberValidator,
    sourceFile: v.literal("todos"),
    baseUpdatedAtMs: v.optional(v.float64()),
    todo: todoDeviceInput,
  },
  returns: deviceUpsertResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "todos:write",
    );
    requireTodoProfileOwner(args.activeProfile, args.owner, args.todo.id);
    requireDeviceRevision(args.baseUpdatedAtMs, false);
    validateDeviceTodo(args.todo);
    if (args.todo.owner !== args.owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        "Todo owner does not match request owner.",
        "todo",
        args.todo.id,
      );
    }
    const outcome = await upsertTodoRow(
      ctx,
      deviceTodoRow(args.todo, Date.now()),
      { baseUpdatedAtMs: args.baseUpdatedAtMs },
    );
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: args.todo.id, outcome };
  },
});

/**
 * Restore one device-deleted todo without opening the normal upsert path.
 * `baseUpdatedAtMs` is the exact revision accepted by deleteTodoFromDevice;
 * it must still be recorded on the current tombstone. The complete authoritative
 * row comes from the server-owned restore capsule captured by delete; the client
 * projection supplies only the compatible request identity/owner shape.
 */
export const restoreTodoFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    activeProfile: familyMemberValidator,
    owner: familyMemberValidator,
    sourceFile: v.literal("todos"),
    baseUpdatedAtMs: v.float64(),
    todo: todoDeviceInput,
  },
  returns: deviceRestoreResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "todos:write",
    );
    requireTodoProfileOwner(args.activeProfile, args.owner, args.todo.id);
    requireDeviceRevision(args.baseUpdatedAtMs, true);
    validateDeviceTodo(args.todo);
    if (args.todo.owner !== args.owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        "Todo owner does not match request owner.",
        "todo",
        args.todo.id,
      );
    }
    const updatedAtMs = await restoreTodoCore(
      ctx,
      args.owner,
      deviceTodoRow(args.todo, Date.now()),
      args.baseUpdatedAtMs,
    );
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: args.todo.id, updatedAtMs };
  },
});

export const deleteTodoFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    activeProfile: familyMemberValidator,
    owner: familyMemberValidator,
    sourceFile: v.literal("todos"),
    entityId: v.string(),
    baseUpdatedAtMs: v.float64(),
  },
  returns: deviceDeleteResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "todos:write",
    );
    requireTodoProfileOwner(args.activeProfile, args.owner, args.entityId);
    requireDeviceRevision(args.baseUpdatedAtMs, true);
    requireDeviceIdentifier(args.entityId, "entityId");
    const removed = await deleteTodoCore(ctx, args.owner, args.entityId, {
      baseUpdatedAtMs: args.baseUpdatedAtMs,
    });
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: args.entityId, removed };
  },
});

export const upsertBudgetCategoryFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    owner: familyMemberValidator,
    sourceFile: budgetSourceValidator,
    month: v.string(),
    previousName: v.optional(v.string()),
    baseUpdatedAtMs: v.optional(v.float64()),
    category: budgetCategoryDeviceInput,
  },
  returns: deviceUpsertResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "budget:write",
    );
    requireDeviceRevision(args.baseUpdatedAtMs, false);
    requireDeviceMonth(args.month);
    requireDeviceIdentifier(args.category.name, "category.name");
    requireDeviceOptionalText(args.category.icon, "category.icon");
    requireDeviceNonnegative(args.category.budgetCents, "category.budgetCents");
    if (args.previousName !== undefined) {
      requireDeviceIdentifier(args.previousName, "previousName");
    }
    const result = await upsertBudgetCategoryCore(
      ctx,
      args.sourceFile,
      canonicalLedgerOwner(args.owner),
      args.month,
      args.category,
      args.previousName,
      { baseUpdatedAtMs: args.baseUpdatedAtMs },
    );
    await markDeviceSeen(ctx, device);
    return { ok: true as const, ...result };
  },
});

export const deleteBudgetCategoryFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    owner: familyMemberValidator,
    sourceFile: budgetSourceValidator,
    month: v.string(),
    entityId: v.string(),
    baseUpdatedAtMs: v.float64(),
  },
  returns: deviceDeleteResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "budget:write",
    );
    requireDeviceRevision(args.baseUpdatedAtMs, true);
    requireDeviceMonth(args.month);
    requireDeviceIdentifier(args.entityId, "entityId");
    const removed = await deleteBudgetCategoryCore(
      ctx,
      args.sourceFile,
      canonicalLedgerOwner(args.owner),
      args.month,
      args.entityId,
      { baseUpdatedAtMs: args.baseUpdatedAtMs },
    );
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: args.entityId, removed };
  },
});

export const upsertBtcBuyFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    owner: familyMemberValidator,
    sourceFile: btcBuySourceValidator,
    baseUpdatedAtMs: v.optional(v.float64()),
    buy: btcBuyDeviceInput,
    linkedIncome: v.optional(linkedIncomeInput),
  },
  returns: deviceUpsertResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "bitcoin:write",
    );
    if (args.linkedIncome) {
      await authenticateDevice(
        ctx,
        args.deviceId,
        args.deviceToken,
        "transactions:write",
      );
    }
    requireDeviceRevision(args.baseUpdatedAtMs, false);
    requireDeviceIdentifier(args.buy.id, "buy.id");
    requireDeviceText(args.buy.source, "buy.source");
    requireDevicePositive(args.buy.sats, "buy.sats");
    requireDevicePositive(args.buy.priceUsdCents, "buy.priceUsdCents");
    requireDevicePositive(args.buy.usdCents, "buy.usdCents");
    requireDeviceNonnegative(args.buy.feeUsdCents ?? 0n, "buy.feeUsdCents");
    requireDeviceOptionalText(args.buy.note, "buy.note");
    requireDeviceOptionalText(args.buy.status, "buy.status");
    requireDeviceOptionalText(args.buy.costBasisStatus, "buy.costBasisStatus");
    requireDeviceOptionalText(args.buy.loggedBy, "buy.loggedBy");
    requireDeviceOptionalText(
      args.buy.archimedesRequestId,
      "buy.archimedesRequestId",
    );
    if (args.linkedIncome) {
      requireDeviceIdentifier(args.linkedIncome.id, "linkedIncome.id");
      requireDeviceText(args.linkedIncome.source, "linkedIncome.source");
      requireDeviceOptionalText(args.linkedIncome.note, "linkedIncome.note");
      requireDeviceOptionalText(
        args.linkedIncome.loggedBy,
        "linkedIncome.loggedBy",
      );
      requireDeviceOptionalText(
        args.linkedIncome.archimedesRequestId,
        "linkedIncome.archimedesRequestId",
      );
      if (args.linkedIncome.owner !== args.buy.owner) {
        deviceFailure(
          "OWNER_MISMATCH",
          "Linked income owner must match the Bitcoin buy owner.",
          "btcBuy",
          args.buy.id,
        );
      }
    }
    const ledgerOwner = canonicalLedgerOwner(args.owner);
    requireSourceOwner(args.sourceFile, "btcBuys", ledgerOwner);
    if (args.buy.owner !== args.owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        "Bitcoin buy owner does not match request owner.",
        "btcBuy",
        args.buy.id,
      );
    }
    const now = Date.now();
    const date = requireIsoDate(
      args.buy.date,
      "date",
      now,
      30,
      rejectDeviceDate,
    );
    const row = {
      buyId: args.buy.id,
      owner: ledgerOwner,
      date,
      month: monthOf(date),
      source: args.buy.source,
      sats: args.buy.sats,
      priceUsdCents: args.buy.priceUsdCents,
      usdCents: args.buy.usdCents,
      feeUsdCents: args.buy.feeUsdCents ?? 0n,
      note: optionalText(args.buy.note),
      status: optionalText(args.buy.status),
      costBasisStatus: optionalText(args.buy.costBasisStatus),
      loggedBy: optionalText(args.buy.loggedBy),
      archimedesRequestId: optionalText(args.buy.archimedesRequestId),
      ...(args.linkedIncome === undefined
        ? {}
        : { linkedIncomeId: args.linkedIncome.id }),
      sourceFile: args.sourceFile,
      updatedAtMs: now,
    };
    if (args.linkedIncome) {
      await upsertLinkedIncomeRow(
        ctx,
        linkedIncomeRow(row, args.linkedIncome, now),
      );
    }
    const outcome = await upsertBtcBuyRow(
      ctx,
      row,
      { baseUpdatedAtMs: args.baseUpdatedAtMs },
    );
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: args.buy.id, outcome };
  },
});

export const deleteBtcBuyFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    owner: familyMemberValidator,
    sourceFile: btcBuySourceValidator,
    entityId: v.string(),
    baseUpdatedAtMs: v.float64(),
  },
  returns: deviceDeleteResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "bitcoin:write",
    );
    requireDeviceRevision(args.baseUpdatedAtMs, true);
    requireDeviceIdentifier(args.entityId, "entityId");
    const removed = await deleteBtcBuyCore(
      ctx,
      args.sourceFile,
      canonicalLedgerOwner(args.owner),
      args.entityId,
      { baseUpdatedAtMs: args.baseUpdatedAtMs },
    );
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: args.entityId, removed };
  },
});

export const upsertBtcBillPayFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    owner: familyMemberValidator,
    sourceFile: v.literal("bitcoin-bill-pays"),
    baseUpdatedAtMs: v.optional(v.float64()),
    billPay: btcBillPayDeviceInput,
  },
  returns: deviceUpsertResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "bitcoin:write",
    );
    requireDeviceRevision(args.baseUpdatedAtMs, false);
    requireDeviceIdentifier(args.billPay.id, "billPay.id");
    requireDeviceText(args.billPay.merchant, "billPay.merchant");
    requireDeviceText(args.billPay.category, "billPay.category");
    requireDeviceOptionalText(args.billPay.platform, "billPay.platform");
    if (args.billPay.platform !== "river_bitcoin_bill_pay") {
      deviceFailure(
        "VALIDATION_FAILED",
        "Bitcoin bill pay platform must be river_bitcoin_bill_pay.",
        "btcBillPay",
        args.billPay.id,
      );
    }
    requireDeviceOptionalText(args.billPay.note, "billPay.note");
    requireDeviceOptionalText(args.billPay.reference, "billPay.reference");
    if (args.billPay.owner !== args.owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        "Bitcoin bill pay owner does not match request owner.",
        "btcBillPay",
        args.billPay.id,
      );
    }
    const ledgerOwner = canonicalLedgerOwner(args.owner);
    requireSourceOwner(args.sourceFile, "btcBillPays", ledgerOwner);
    requireBillPayAmounts(args.billPay);
    const budgetEffect = args.billPay.budgetEffect ?? "credit_card_payment";
    const category = budgetEffect === "credit_card_payment"
      ? "Credit Card Payment"
      : args.billPay.category;
    requireBillPayBudgetEffect({ category, budgetEffect });
    const now = Date.now();
    const date = requireIsoDate(
      args.billPay.date,
      "date",
      now,
      30,
      rejectDeviceDate,
    );
    const outcome = await upsertBtcBillPayRow(
      ctx,
      {
        billPayId: args.billPay.id,
        owner: ledgerOwner,
        date,
        month: monthOf(date),
        merchant: args.billPay.merchant,
        category,
        budgetEffect,
        amountUsdCents: args.billPay.amountUsdCents,
        btcSpentSats: args.billPay.btcSpentSats,
        btcPriceCents: args.billPay.btcPriceCents,
        platform: optionalText(args.billPay.platform),
        note: optionalText(args.billPay.note),
        feeUsdCents: args.billPay.feeUsdCents,
        reference: optionalText(args.billPay.reference),
        sourceFile: args.sourceFile,
        updatedAtMs: now,
      },
      { baseUpdatedAtMs: args.baseUpdatedAtMs },
    );
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: args.billPay.id, outcome };
  },
});

export const deleteBtcBillPayFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    owner: familyMemberValidator,
    sourceFile: v.literal("bitcoin-bill-pays"),
    entityId: v.string(),
    baseUpdatedAtMs: v.float64(),
  },
  returns: deviceDeleteResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "bitcoin:write",
    );
    requireDeviceRevision(args.baseUpdatedAtMs, true);
    requireDeviceIdentifier(args.entityId, "entityId");
    const ledgerOwner = canonicalLedgerOwner(args.owner);
    requireSourceOwner(args.sourceFile, "btcBillPays", ledgerOwner);
    const removed = await deleteBtcBillPayCore(
      ctx,
      ledgerOwner,
      args.entityId,
      { baseUpdatedAtMs: args.baseUpdatedAtMs },
    );
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: args.entityId, removed };
  },
});

export const upsertBtcTransferFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    owner: familyMemberValidator,
    sourceFile: btcTransferSourceValidator,
    baseUpdatedAtMs: v.optional(v.float64()),
    transfer: btcTransferInput,
  },
  returns: deviceUpsertResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "bitcoin:write",
    );
    requireDeviceRevision(args.baseUpdatedAtMs, false);
    requireDeviceIdentifier(args.transfer.id, "transfer.id");
    requireDeviceIdentifier(
      args.transfer.fromAccountKey,
      "transfer.fromAccountKey",
    );
    requireDeviceIdentifier(
      args.transfer.toAccountKey,
      "transfer.toAccountKey",
    );
    requireDevicePositive(args.transfer.sats, "transfer.sats");
    requireDeviceNonnegative(args.transfer.feeSats, "transfer.feeSats");
    requireDeviceOptionalText(args.transfer.note, "transfer.note");
    if (args.transfer.owner !== args.owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        "Bitcoin transfer owner does not match request owner.",
        "btcTransfer",
        args.transfer.id,
      );
    }
    const owner = canonicalLedgerOwner(args.owner);
    const now = Date.now();
    const date = requireIsoDate(
      args.transfer.date,
      "date",
      now,
      30,
      rejectDeviceDate,
    );
    const row: BtcTransferRow = {
      transferId: args.transfer.id,
      owner,
      date,
      month: monthOf(date),
      fromAccountKey: args.transfer.fromAccountKey.trim(),
      toAccountKey: args.transfer.toAccountKey.trim(),
      sats: args.transfer.sats,
      feeSats: args.transfer.feeSats,
      note: optionalText(args.transfer.note),
      sourceFile: args.sourceFile,
      balancePostingVersion: 1n,
      updatedAtMs: now,
    };
    const outcome = await upsertBtcTransferRow(ctx, row, {
      baseUpdatedAtMs: args.baseUpdatedAtMs,
    });
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: row.transferId, outcome };
  },
});

export const deleteBtcTransferFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    owner: familyMemberValidator,
    sourceFile: btcTransferSourceValidator,
    entityId: v.string(),
    baseUpdatedAtMs: v.float64(),
  },
  returns: deviceDeleteResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "bitcoin:write",
    );
    requireDeviceRevision(args.baseUpdatedAtMs, true);
    requireDeviceIdentifier(args.entityId, "entityId");
    const removed = await deleteBtcTransferCore(
      ctx,
      canonicalLedgerOwner(args.owner),
      args.entityId,
      { baseUpdatedAtMs: args.baseUpdatedAtMs },
    );
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: args.entityId, removed };
  },
});

export const upsertBtcAccountFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    owner: familyMemberValidator,
    sourceFile: btcAccountSourceValidator,
    baseUpdatedAtMs: v.optional(v.float64()),
    account: btcAccountDeviceInput,
  },
  returns: deviceUpsertResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "bitcoin:write",
    );
    requireDeviceRevision(args.baseUpdatedAtMs, false);
    requireDeviceIdentifier(args.account.key, "account.key");
    requireDeviceText(args.account.label, "account.label");
    requireDeviceNonnegative(args.account.sats, "account.sats");
    requireDeviceTimestamp(args.account.asOf, "account.asOf");
    if (args.account.schemaVersion !== undefined) {
      requireDeviceNonnegative(
        args.account.schemaVersion,
        "account.schemaVersion",
      );
    }
    if (args.account.fiatValuation !== undefined) {
      requireDeviceNonnegative(
        args.account.fiatValuation.cents,
        "account.fiatValuation.cents",
      );
      if (args.account.fiatValuation.priceCents !== undefined) {
        requireDeviceNonnegative(
          args.account.fiatValuation.priceCents,
          "account.fiatValuation.priceCents",
        );
      }
      requireDeviceTimestamp(
        args.account.fiatValuation.quotedAt,
        "account.fiatValuation.quotedAt",
      );
      requireDeviceOptionalText(
        args.account.fiatValuation.source,
        "account.fiatValuation.source",
      );
      requireDeviceOptionalText(
        args.account.fiatValuation.confidence,
        "account.fiatValuation.confidence",
      );
    }
    if (args.account.owner !== args.owner) {
      deviceFailure(
        "OWNER_MISMATCH",
        "Bitcoin account owner does not match request owner.",
        "btcAccount",
        args.account.key,
      );
    }
    const account = {
      ...args.account,
      owner: canonicalLedgerOwner(args.account.owner),
    };
    const outcome = await upsertBtcAccountCore(ctx, args.sourceFile, account, {
      baseUpdatedAtMs: args.baseUpdatedAtMs,
    });
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId: args.account.key, outcome };
  },
});

export const deleteBtcAccountFromDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    owner: familyMemberValidator,
    sourceFile: btcAccountSourceValidator,
    entityId: v.string(),
    baseUpdatedAtMs: v.float64(),
  },
  returns: deviceDeleteResultValidator,
  handler: async (ctx, args) => {
    const device = await authenticateDevice(
      ctx,
      args.deviceId,
      args.deviceToken,
      "bitcoin:write",
    );
    requireDeviceRevision(args.baseUpdatedAtMs, true);
    requireDeviceIdentifier(args.entityId, "entityId");
    const entityId = args.entityId;
    const removed = await deleteBtcAccountCore(
      ctx,
      args.sourceFile,
      canonicalLedgerOwner(args.owner),
      entityId,
      { baseUpdatedAtMs: args.baseUpdatedAtMs },
    );
    await markDeviceSeen(ctx, device);
    return { ok: true as const, entityId, removed };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Source-file ownership validation for public row upserts.
// ─────────────────────────────────────────────────────────────────────────────

type BlobKind =
  "transactions" | "todos" | "btcBuys" | "btcBillPays" | "btcAccounts";

/**
 * Every source file the runtime upserts accept, and the owner its records
 * belong to when the record itself does not say.
 *
 * A closed map with NO default. An unknown file name throws rather than falling
 * back to "victor": silently tagging an unrecognised file's records as an adult
 * is precisely how a child's data would end up in the adult household view.
 * Adding a file to MC2 means adding a line here, on purpose.
 */
const BLOB_SOURCES: Record<string, { kind: BlobKind; owner: FamilyMember }> = {
  transactions: { kind: "transactions", owner: DEFAULT_OWNER },
  "mason-transactions": { kind: "transactions", owner: "mason" },
  "maddox-transactions": { kind: "transactions", owner: "maddox" },
  todos: { kind: "todos", owner: DEFAULT_OWNER },
  "bitcoin-buys": { kind: "btcBuys", owner: DEFAULT_OWNER },
  "mason-bitcoin-buys": { kind: "btcBuys", owner: "mason" },
  "bitcoin-bill-pays": { kind: "btcBillPays", owner: DEFAULT_OWNER },
  "btc-balance-snapshot": { kind: "btcAccounts", owner: DEFAULT_OWNER },
  "son-balances": { kind: "btcAccounts", owner: "mason" },
};

function blobSource(sourceFile: string, expectedKind?: BlobKind) {
  const entry = BLOB_SOURCES[sourceFile];
  if (!entry) {
    throw new ConvexError(
      `Unknown source file "${sourceFile}". Known files: ` +
        `${Object.keys(BLOB_SOURCES).join(", ")}. Add it to BLOB_SOURCES in ` +
        `convex/tables.ts with an explicit owner — there is no default, ` +
        `because guessing one puts a child's records in the adult view.`,
    );
  }
  if (expectedKind && entry.kind !== expectedKind) {
    // "transactions" is a file name AND a table name; without this check
    // upsertTransaction({sourceFile: "todos"}) would happily write a
    // transaction row tagged with a todo file's provenance.
    throw new ConvexError(
      `Source file "${sourceFile}" holds ${entry.kind}, not ${expectedKind}.`,
    );
  }
  return entry;
}

function ownerForSourceFile(
  sourceFile: string,
  expectedKind: BlobKind,
): FamilyMember {
  return blobSource(sourceFile, expectedKind).owner;
}
