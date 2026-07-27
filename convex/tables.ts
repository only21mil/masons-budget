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
// This file is the row-shaped runtime API: queries and mutations over
// `transactions`, `todos`, `btcBuys` and `btcAccounts`. The one-shot backfill
// lives separately in convex/migrate.ts as an internal-only, dry-run-first path.
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

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
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
  // Legacy rows have no write-side `kind`, so a valid credit and a corrupt row
  // with the opposite sign are intentionally indistinguishable on read.
  const spendAmount =
    row.category === "Income"
      ? 0n
      : isAdult(row.owner)
        ? -row.amountCents
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

function projectBudgetDocument(
  raw: Record<string, unknown>,
  owner: FamilyMember,
  updatedAtMs: number,
) {
  const strategy = asRecord(raw.strategy);
  const income = asRecord(raw.income);
  return {
    owner,
    month: String(raw.month ?? ""),
    coinbaseOneBalanceCents: parseCents(raw.coinbase_one_balance),
    // Reported category spend is deliberately not public. Budget spend is
    // derived from the month-scoped transaction snapshot in every client.
    categories: asRecordArray(raw.categories).map((entry) => ({
      name: String(entry.name ?? ""),
      icon: optionalText(entry.icon),
      budgetCents: parseCents(entry.budget),
    })),
    effectiveApr: strategy ? optionalText(strategy.effective_apr) : undefined,
    strategyNote: strategy ? optionalText(strategy.strategy_note) : undefined,
    income: income
      ? {
          weeklyGrossCents: parseCents(income.weekly_gross),
          weeklyStrikeCents: parseCents(income.weekly_strike),
          weeklyRiverCents: parseCents(income.weekly_river),
          payFrequency: optionalText(income.pay_frequency),
          monthlyGrossCents: parseCents(income.monthly_gross),
          mtdIncomeCents: parseCents(income.mtd_income),
          ytdIncomeCents: parseCents(income.ytd_income),
          paychecks: asRecordArray(income.paychecks).map((entry) => ({
            date: String(entry.date ?? ""),
            platform: optionalText(entry.platform),
            source: optionalText(entry.source),
            amountCents: parseCents(entry.amount),
            netCents: parseCents(entry.net),
            note: optionalText(entry.note),
          })),
        }
      : undefined,
    mtdIncomeCents: parseCents(raw.mtd_income),
    ytdIncomeCents: parseCents(raw.ytd_income),
    monthlyHistory: asRecordArray(raw.monthly_history).map((entry) => ({
      month: String(entry.month ?? ""),
      incomeCents: parseCents(entry.income),
      expensesCents: parseCents(entry.expenses),
      savingsBps: Number(parseCents(entry.savings_pct)),
    })),
    updatedAtMs,
  };
}

function budgetSourceFor(viewer: FamilyMember): {
  name: string;
  owner: FamilyMember;
} {
  if (isAdult(viewer)) return { name: "budget", owner: DEFAULT_OWNER };
  return { name: `${viewer}-budget`, owner: viewer };
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
              .withIndex("by_owner_month", (q) =>
                q.eq("owner", owner).eq("month", month),
              )
              .collect()
          : ctx.db
              .query("transactions")
              .withIndex("by_owner_date", (q) => q.eq("owner", owner))
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
            .withIndex("by_owner_done", (q) =>
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
              .withIndex("by_owner_month", (q) =>
                q.eq("owner", owner).eq("month", month),
              )
              .collect()
          : ctx.db
              .query("btcBuys")
              .withIndex("by_owner_date", (q) => q.eq("owner", owner))
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
              .withIndex("by_owner_month", (q) =>
                q.eq("owner", owner).eq("month", month),
              )
              .collect()
          : ctx.db
              .query("btcBillPays")
              .withIndex("by_owner_date", (q) => q.eq("owner", owner))
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
          .withIndex("by_owner_key", (q) => q.eq("owner", owner))
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
 * Typed budget document from the still-authoritative document-shaped blob.
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
    const doc = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", source.name))
      .first();
    const raw = doc ? asRecord(doc.data) : null;
    return {
      document: raw
        ? projectBudgetDocument(raw, source.owner, doc?.updatedAt ?? 0)
        : null,
      complete: true,
    };
  },
});

/**
 * Freshness and source metadata for the document-shaped BTC snapshots.
 * Account values remain in listBtcAccounts; this query does not expose the raw
 * blob or its Convex document fields.
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
    const sources: Array<{ name: string; owner: FamilyMember }> = [];
    if (owners.some(isAdult)) {
      sources.push({ name: "btc-balance-snapshot", owner: DEFAULT_OWNER });
    }
    if (owners.includes("mason")) {
      sources.push({ name: "son-balances", owner: "mason" });
    }
    if (owners.includes("maddox")) {
      sources.push({ name: "maddox-balances", owner: "maddox" });
    }

    const rows = (
      await Promise.all(
        sources.map(async ({ name, owner }) => {
          const doc = await ctx.db
            .query("dataFiles")
            .withIndex("by_name", (q) => q.eq("name", name))
            .first();
          const raw = doc ? asRecord(doc.data) : null;
          if (!doc || !raw) return null;
          const metadata = asRecord(raw.metadata);
          return {
            owner,
            schemaVersion: BigInt(
              Math.trunc(Number(raw.schemaVersion ?? raw.schema_version ?? 0)),
            ),
            asOf: String(raw.asOf ?? raw.as_of ?? raw.lastUpdated ?? ""),
            source: metadata ? optionalText(metadata.source) : undefined,
            basis: metadata ? optionalText(metadata.basis) : undefined,
            confidence: metadata ? optionalText(metadata.confidence) : undefined,
            updatedAtMs: doc.updatedAt,
          };
        }),
      )
    ).filter((row): row is NonNullable<typeof row> => row !== null);

    rows.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
    return { rows, complete: true };
  },
});

/** Row counts per table — metadata only, including Bitcoin bill payments. */
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

  const spendIsNegative = isAdult(owner);
  const expectedNegative = kind === "spend" ? spendIsNegative : !spendIsNegative;
  if ((minor < 0n) !== expectedNegative) {
    const sourceFile = isAdult(owner) ? "transactions" : `${owner}-transactions`;
    throw new ConvexError(
      `upsertTransaction: a ${kind} for ${owner} must be ` +
        `${expectedNegative ? "negative" : "positive"} in ${sourceFile} ` +
        `(${isAdult(owner) ? "adult files sign spend negative" : "child files store spend as a positive magnitude"}), ` +
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

// ─────────────────────────────────────────────────────────────────────────────
// Source-file ownership validation for public row upserts.
// ─────────────────────────────────────────────────────────────────────────────

type BlobKind = "transactions" | "todos" | "btcBuys" | "btcAccounts";

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
