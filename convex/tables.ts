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
// It does not touch `dataFiles`, `syncVersions` or `todoTombstones` — not one
// write. Every shipped client still reads the blobs and production is live, so
// the blob path has to keep working byte-for-byte throughout the transition.
// `dataFiles` gets deleted in a later change, after the clients have moved, not
// in this one.
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

import { query, mutation } from "./_generated/server";
import { custodyValidator, familyMemberValidator } from "./schema";
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
    warnPermissive("ALLOW_TOKENLESS_SYNC", "CONVEX_SYNC_TOKEN", Boolean(expected));
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
    warnPermissive("ALLOW_TOKENLESS_READ", "CONVEX_READ_TOKEN", Boolean(expected));
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

function sharesNetWorthWith(viewer: FamilyMember, owner: FamilyMember): boolean {
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
  if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`);
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
    typeof value === "number" ? numberToDecimalString(value) : String(value).trim();
  if (raw === "") return 0n;

  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) throw new RangeError(`Not a decimal value: ${JSON.stringify(value)}`);

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
  if (!Number.isInteger(limit) || limit < 1 || limit > PUBLIC_SNAPSHOT_HARD_MAX) {
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
  updatedAtMs: number;
}) {
  // CANONICAL SOURCE: shared/domain/src/readModel.ts (spendAmount,
  // displaySpendAmount, hasOppositeSpendSign), mirrored by
  // MasonsBudget/MasonsBudget/Models/Transaction.swift.
  //
  const spendAmount =
    row.category === "Income"
      ? 0n
      : row.amountCents;
  const displaySpendAmount =
    spendAmount < 0n ? -spendAmount : spendAmount;

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
    category: row.category,
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

function projectBtcAccount(row: {
  key: string;
  owner: FamilyMember;
  label: string;
  custody: "exchange" | "self_custody";
  sats: bigint;
  fiatCents: bigint;
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
  owner: FamilyMember;
  schemaVersion: bigint;
  asOf: string;
  accounts: Array<{
    key: string;
    label: string;
    custody: "exchange" | "self_custody";
    sats: bigint;
    fiatCents: bigint;
  }>;
  totals: {
    sats: bigint;
    fiatCents: bigint;
    exchangeSats: bigint;
    selfCustodySats: bigint;
  };
  source?: string;
  basis?: string;
  confidence?: string;
  updatedAtMs: number;
}) {
  return {
    owner: row.owner,
    schemaVersion: row.schemaVersion,
    asOf: row.asOf,
    accounts: row.accounts.map((account) => ({
      key: account.key,
      label: account.label,
      custody: account.custody,
      sats: account.sats,
      fiatCents: account.fiatCents,
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
    updatedAtMs: row.updatedAtMs,
  };
}

function publicFinanceAccount(row: {
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
}) {
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
      sharesDecimal: holding.sharesDecimal,
      avgCostCents: holding.avgCostCents,
      currentPricePerShareCents: holding.currentPricePerShareCents,
      isProxy: holding.isProxy,
      proxyNote: holding.proxyNote,
      lots: holding.lots.map((lot) => ({
        date: lot.date,
        type: lot.type,
        pricePerShareCents: lot.pricePerShareCents,
        sharesDecimal: lot.sharesDecimal,
        amountInvestedCents: lot.amountInvestedCents,
        note: lot.note,
      })),
    })),
  };
}

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

/** Todos a viewer may see, most recently updated first. */
export const listTodos = query({
  args: {
    viewer: familyMemberValidator,
    done: v.optional(v.boolean()),
    limit: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, done, limit, token }) => {
    validateReadToken(token);
    const owners = ownersInScope(viewer, "visible");
    const cap = requestedRowCap(limit, "listTodos");
    const wanted = done === undefined ? [false, true] : [done];

    const perOwner = await Promise.all(
      owners.flatMap((owner) =>
        wanted.map((doneValue) =>
          ctx.db
            .query("todos")
            .withIndex(PUBLIC_QUERY_INDEX_PLAN.listTodos.all.name, (q) =>
              q.eq("owner", owner).eq("done", doneValue),
            )
            .order("desc")
            .take(cap),
        ),
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
              .withIndex(PUBLIC_QUERY_INDEX_PLAN.listBtcBillPays.all.name, (q) =>
                q.eq("owner", owner),
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
    const accounts = doc.accounts
      .filter((account) => rule(viewer, account.owner))
      .map(publicFinanceAccount);
    if (accounts.length === 0) {
      return { document: null, complete: true };
    }

    return {
      document: {
        lastUpdated: doc.lastUpdated,
        retirementTotalCents: accounts.some((account) =>
          isAdult(account.owner),
        )
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
      btcAccounts: (await ctx.db.query("btcAccounts").collect()).length,
      income: (await ctx.db.query("income").collect()).length,
      balanceDocuments: (await ctx.db.query("balanceDocuments").collect()).length,
      budgetDocuments: (await ctx.db.query("budgetDocuments").collect()).length,
      btcBalanceDocuments: (
        await ctx.db.query("btcBalanceDocuments").collect()
      ).length,
      financeDocuments: (await ctx.db.query("financeDocuments").collect()).length,
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

async function upsertTransactionRow(
  ctx: any,
  row: ReturnType<typeof buildTransactionRow>,
): Promise<UpsertOutcome> {
  const existing = await ctx.db
    .query("transactions")
    .withIndex("by_source_tx_id", (q: any) =>
      q.eq("sourceFile", row.sourceFile).eq("txId", row.txId),
    )
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, row);
    return "updated";
  }
  await ctx.db.insert("transactions", row);
  return "inserted";
}

async function upsertTodoRow(
  ctx: any,
  row: ReturnType<typeof buildTodoRow>,
): Promise<UpsertOutcome> {
  const existing = await ctx.db
    .query("todos")
    .withIndex("by_todo_id", (q: any) => q.eq("todoId", row.todoId))
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, row);
    return "updated";
  }
  await ctx.db.insert("todos", row);
  return "inserted";
}

async function upsertBtcBuyRow(
  ctx: any,
  row: ReturnType<typeof buildBtcBuyRow>,
): Promise<UpsertOutcome> {
  const existing = await ctx.db
    .query("btcBuys")
    .withIndex("by_source_buy_id", (q: any) =>
      q.eq("sourceFile", row.sourceFile).eq("buyId", row.buyId),
    )
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, row);
    return "updated";
  }
  await ctx.db.insert("btcBuys", row);
  return "inserted";
}

async function upsertBtcBillPayRow(
  ctx: any,
  row: {
    billPayId: string;
    sourceFile: string;
  } & Record<string, unknown>,
): Promise<UpsertOutcome> {
  const existing = await ctx.db
    .query("btcBillPays")
    .withIndex("by_source_bill_pay_id", (q: any) =>
      q.eq("sourceFile", row.sourceFile).eq("billPayId", row.billPayId),
    )
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, row);
    return "updated";
  }
  await ctx.db.insert("btcBillPays", row);
  return "inserted";
}

async function upsertBtcAccountRow(ctx: any, row: any): Promise<UpsertOutcome> {
  const existing = await ctx.db
    .query("btcAccounts")
    .withIndex("by_owner_key", (q: any) =>
      q.eq("owner", row.owner).eq("key", row.key),
    )
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, row);
    return "updated";
  }
  await ctx.db.insert("btcAccounts", row);
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
    throw new ConvexError(
      "upsertTransaction: amountCents must not be zero — a zero-value " +
        "transaction has no sign to check.",
    );
  }
  if (category === "Income" && kind !== "credit") {
    throw new ConvexError(
      'upsertTransaction: a transaction categorised "Income" must be sent ' +
        'with kind "credit".',
    );
  }

  const expectedNegative = category !== "Income" && kind === "credit";
  if ((minor < 0n) !== expectedNegative) {
    const sourceFile = isAdult(owner) ? "transactions" : `${owner}-transactions`;
    throw new ConvexError(
      `upsertTransaction: a ${kind} for ${owner} must be ` +
        `${expectedNegative ? "negative" : "positive"} in ${sourceFile} ` +
        `(purchases are positive and refunds are negative for every owner), ` +
        `got ${minor}. The sign is not corrected here on purpose.`,
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
  owner: v.optional(familyMemberValidator),
});

/** Insert or replace ONE transaction. Compare with dataFiles:appendTransaction,
 *  which rewrites all 905 to do this. */
export const upsertTransaction = mutation({
  args: {
    transaction: transactionInput,
    sourceFile: v.optional(v.string()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { transaction, sourceFile, token }) => {
    validateSyncToken(token);
    const file = sourceFile ?? "transactions";
    const fileOwner = ownerForSourceFile(file, "transactions");
    const date = transaction.date;
    const owner = resolveOwner(transaction.owner, fileOwner);
    requireSignAgrees(
      transaction.amountCents,
      owner,
      transaction.kind ?? "spend",
      transaction.category,
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
      sourceFile: file,
      updatedAtMs: Date.now(),
    };
    const outcome = await upsertTransactionRow(ctx, row);
    return { txId: row.txId, owner: row.owner, month: row.month, outcome };
  },
});

/**
 * Delete ONE transaction row, scoped to its source file.
 *
 * A missing row is an idempotent success (`removed: false`), matching
 * `deleteTodo`: clients may safely retry after losing a response without
 * turning an already-completed delete into an error.
 *
 * Deliberately does NOT write a tombstone. `todoTombstones` is part of the
 * blob todo convergence path and cannot represent transaction deletes. As with
 * `deleteTodo`, a row deleted here would return if the internal migration were
 * re-run from a blob that still contains it; transaction tombstones belong in
 * a reviewed row-native convergence design when `dataFiles` is retired.
 */
export const deleteTransaction = mutation({
  args: {
    txId: v.string(),
    owner: v.optional(familyMemberValidator),
    sourceFile: v.optional(v.string()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { txId, owner: rawOwner, sourceFile, token }) => {
    validateSyncToken(token);
    const file = sourceFile ?? "transactions";
    const fileOwner = ownerForSourceFile(file, "transactions");
    const owner = resolveOwner(rawOwner, fileOwner);
    const existing = await ctx.db
      .query("transactions")
      .withIndex("by_source_tx_id", (q) =>
        q.eq("sourceFile", file).eq("txId", txId),
      )
      .first();
    if (!existing) return { txId, owner, removed: false };
    await ctx.db.delete(existing._id);
    return { txId, owner: existing.owner, removed: true };
  },
});

/** Insert or replace ONE todo, keyed on its MC2 id. */
export const upsertTodo = mutation({
  args: {
    todo: v.any(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { todo, token }) => {
    validateSyncToken(token);
    const raw = asRecord(todo);
    if (!raw) throw new ConvexError("upsertTodo: todo must be an object");
    if (
      Object.prototype.hasOwnProperty.call(raw, "owner") &&
      !isFamilyMember(raw.owner)
    ) {
      throw new ConvexError(
        `upsertTodo: owner must be one of ${FAMILY_MEMBERS.join(", ")}, got ` +
          `${JSON.stringify(raw.owner)}.`,
      );
    }
    const row = buildTodoRow(raw, DEFAULT_OWNER, "todos", Date.now());
    const outcome = await upsertTodoRow(ctx, row);
    return { todoId: row.todoId, owner: row.owner, done: row.done, outcome };
  },
});

/**
 * Delete ONE todo row.
 *
 * Deliberately does NOT write a `todoTombstones` entry: that table belongs to
 * the blob path, which this change must leave untouched. The consequence is
 * named rather than hidden — a row deleted here would come back if the todo
 * the internal migration were re-run from a blob that still contains it.
 * Row-native deletes get their own tombstone table when `dataFiles` is retired.
 */
export const deleteTodo = mutation({
  args: { todoId: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { todoId, token }) => {
    validateSyncToken(token);
    const existing = await ctx.db
      .query("todos")
      .withIndex("by_todo_id", (q) => q.eq("todoId", todoId))
      .first();
    if (!existing) return { todoId, removed: false };
    await ctx.db.delete(existing._id);
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
    sourceFile: v.optional(v.string()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { buy, sourceFile, token }) => {
    validateSyncToken(token);
    const file = sourceFile ?? "bitcoin-buys";
    const fileOwner = ownerForSourceFile(file, "btcBuys");
    const row = {
      buyId: buy.id,
      owner: resolveOwner(buy.owner, fileOwner),
      date: buy.date,
      month: monthOf(buy.date),
      source: buy.source,
      sats: buy.sats,
      priceUsdCents: buy.priceUsdCents,
      usdCents: buy.usdCents,
      note: optionalText(buy.note),
      status: optionalText(buy.status),
      costBasisStatus: optionalText(buy.costBasisStatus),
      loggedBy: optionalText(buy.loggedBy),
      archimedesRequestId: optionalText(buy.archimedesRequestId),
      sourceFile: file,
      updatedAtMs: Date.now(),
    };
    const outcome = await upsertBtcBuyRow(ctx, row);
    return { buyId: row.buyId, owner: row.owner, month: row.month, outcome };
  },
});

const btcBillPayInput = v.object({
  id: v.string(),
  date: v.string(),
  merchant: v.string(),
  category: v.string(),
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
    token: v.optional(v.string()),
  },
  handler: async (ctx, { billPay, sourceFile, token }) => {
    validateSyncToken(token);
    const file = sourceFile ?? "bitcoin-bill-pays";
    const fileOwner = ownerForSourceFile(file, "btcBillPays");
    const row = {
      billPayId: billPay.id,
      owner: resolveOwner(billPay.owner, fileOwner),
      date: billPay.date,
      month: monthOf(billPay.date),
      merchant: billPay.merchant,
      category: billPay.category,
      amountUsdCents: billPay.amountUsdCents,
      btcSpentSats: billPay.btcSpentSats,
      btcPriceCents: billPay.btcPriceCents,
      platform: optionalText(billPay.platform),
      note: optionalText(billPay.note),
      feeUsdCents: billPay.feeUsdCents,
      reference: optionalText(billPay.reference),
      sourceFile: file,
      updatedAtMs: Date.now(),
    };
    const outcome = await upsertBtcBillPayRow(ctx, row);
    return {
      billPayId: row.billPayId,
      owner: row.owner,
      month: row.month,
      outcome,
    };
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
      fiatCents: v.int64(),
      asOf: v.string(),
      schemaVersion: v.optional(v.int64()),
    }),
    sourceFile: v.optional(v.string()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { account, sourceFile, token }) => {
    validateSyncToken(token);
    const file = sourceFile ?? "btc-balance-snapshot";
    const fileOwner = ownerForSourceFile(file, "btcAccounts");
    if (account.owner !== fileOwner) {
      throw new ConvexError(
        `upsertBtcAccount: source file "${file}" belongs to ${fileOwner}, ` +
          `not ${account.owner}.`,
      );
    }
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

    const existing = await ctx.db
      .query("budgetDocuments")
      .withIndex("by_source_file", (q) => q.eq("sourceFile", sourceFile))
      .unique();
    if (!existing) {
      throw new ConvexError(
        `upsertBudgetCategory: budget document "${sourceFile}" does not exist; ` +
          "a category edit does not create a whole budget document.",
      );
    }
    if (!sharesNetWorthWith(viewer, existing.owner)) {
      throw new ConvexError(
        `upsertBudgetCategory: ${viewer} cannot write ${existing.owner}'s budget.`,
      );
    }
    if (month !== existing.month) {
      throw new ConvexError(
        `upsertBudgetCategory: requested month ${JSON.stringify(month)} does ` +
          `not match ${sourceFile}'s month ${JSON.stringify(existing.month)}.`,
      );
    }

    const categoryIndex = existing.categories.findIndex(
      (candidate) => candidate.name === category.name,
    );
    const categories = [...existing.categories];
    const normalizedCategory = {
      name: category.name,
      icon: optionalText(category.icon),
      budgetCents: category.budgetCents,
    };
    const outcome: UpsertOutcome = categoryIndex === -1 ? "inserted" : "updated";
    if (categoryIndex === -1) {
      categories.push(normalizedCategory);
    } else {
      categories[categoryIndex] = normalizedCategory;
    }

    await ctx.db.patch(existing._id, {
      categories,
      updatedAtMs: Date.now(),
    });
    return {
      owner: existing.owner,
      month: existing.month,
      name: category.name,
      outcome,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Source-file ownership validation for public row upserts.
// ─────────────────────────────────────────────────────────────────────────────

type BlobKind =
  | "transactions"
  | "todos"
  | "btcBuys"
  | "btcBillPays"
  | "btcAccounts";

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
