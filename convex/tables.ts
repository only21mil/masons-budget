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
// This file is the row-shaped replacement: queries and mutations over
// `transactions`, `todos`, `btcBuys` and `btcAccounts`, plus the migration that
// fills them from the existing blobs.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//
// It does not touch `dataFiles`, `syncVersions` or `todoTombstones` — not one
// write. Every shipped client still reads the blobs and production is live, so
// the blob path has to keep working byte-for-byte throughout the migration. The
// migration functions here READ the blobs and never write them. `dataFiles` gets
// deleted in a later change, after the clients have moved, not in this one.
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

const DEFAULT_PAGE = 500;

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
 * `month` ("2026-07") is the budget path: a budget's spend is DERIVED from that
 * month's transactions and never read from a reported total, so this is the
 * query the budget screen lives on. With `month` it is one index range per
 * visible owner; without it, one date-ordered range per visible owner.
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
    const cap = limit ?? DEFAULT_PAGE;

    const perOwner = await Promise.all(
      owners.map((owner) =>
        month
          ? // A month is already bounded, so collect it whole.
            ctx.db
              .query("transactions")
              .withIndex("by_owner_month", (q) =>
                q.eq("owner", owner).eq("month", month),
              )
              .collect()
          : // Unbounded: take the newest `cap` PER OWNER off the index instead
            // of reading every row. The global newest `cap` is always inside
            // the union of the per-owner newest `cap`, so the merge below is
            // exact, not an approximation.
            ctx.db
              .query("transactions")
              .withIndex("by_owner_date", (q) => q.eq("owner", owner))
              .order("desc")
              .take(cap),
      ),
    );

    const rows = perOwner.flat();
    rows.sort(byDateDescending);
    return rows.slice(0, cap);
  },
});

/**
 * Todos a viewer may see, most recently updated first.
 *
 * `done` is part of the index rather than a filter because "my open todos" is
 * the only query the todo screen makes.
 */
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
    const cap = limit ?? DEFAULT_PAGE;

    // by_owner_done orders by (owner, done, updatedAtMs), so `done` has to be
    // pinned before updatedAtMs means anything: taking the newest N from an
    // owner-only range would hand back N done todos and no open ones. Asking
    // for both values separately and merging is what makes "newest N overall"
    // actually the newest N.
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
    return rows.slice(0, cap);
  },
});

/**
 * Bitcoin buys, newest first.
 *
 * `scope` is explicit rather than inferred. "visible" answers "show me the
 * buys" (adults see the kids' too); "netWorth" answers "what is OUR stack",
 * which must exclude a child's buys even from an adult. Naming the two rules at
 * the call site is what stops them being conflated three screens from now.
 */
export const listBtcBuys = query({
  args: {
    viewer: familyMemberValidator,
    scope: v.optional(scopeValidator),
    month: v.optional(v.string()),
    limit: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, scope, month, limit, token }) => {
    validateReadToken(token);
    const owners = ownersInScope(viewer, scope ?? "visible");
    const cap = limit ?? DEFAULT_PAGE;

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
    return rows.slice(0, cap);
  },
});

/**
 * Bitcoin accounts. Same explicit `scope` as listBtcBuys, and this is the query
 * where it bites hardest: an adult viewing "visible" sees Mason's Coldcard, and
 * the very same adult viewing "netWorth" must not, because a child's stack is
 * not part of adult net worth.
 */
export const listBtcAccounts = query({
  args: {
    viewer: familyMemberValidator,
    scope: v.optional(scopeValidator),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { viewer, scope, token }) => {
    validateReadToken(token);
    const owners = ownersInScope(viewer, scope ?? "visible");

    const perOwner = await Promise.all(
      owners.map((owner) =>
        ctx.db
          .query("btcAccounts")
          .withIndex("by_owner_key", (q) => q.eq("owner", owner))
          .collect(),
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
    return rows;
  },
});

/**
 * Row counts per table — the migration's progress readout.
 *
 * Exists so the runbook can compare against the known-good backup (905
 * transactions, 31 BTC buys, 25 todos) without a client and without reading a
 * single financial value out of the deployment.
 */
export const rowCounts = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    validateReadToken(token);
    return {
      transactions: (await ctx.db.query("transactions").collect()).length,
      todos: (await ctx.db.query("todos").collect()).length,
      btcBuys: (await ctx.db.query("btcBuys").collect()).length,
      btcAccounts: (await ctx.db.query("btcAccounts").collect()).length,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Row builders
//
// One builder per table, shared by the direct-write mutations and the migration
// so a migrated row and a client-written row are byte-identical. If they were
// built in two places, a re-run of the migration would silently rewrite every
// row the clients had touched.
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
// Natural-key upserts, so every write path and the migration itself are
// idempotent. Re-running a migration must never duplicate a financial record.
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
// The migration is the only place that parses decimals, because the blobs it
// reads are the only place decimals exist.
// ─────────────────────────────────────────────────────────────────────────────

const transactionInput = v.object({
  id: v.string(),
  date: v.string(),
  merchant: v.string(),
  amountCents: v.int64(),
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
    const row = {
      txId: transaction.id,
      owner: resolveOwner(transaction.owner, fileOwner),
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
 * migration were re-run from a blob that still contains it, so migrateFromBlob
 * skips ids that already have a tombstone and this mutation is for rows that
 * originated here. Row-native deletes get their own tombstone table when
 * `dataFiles` is retired.
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
    const row = {
      ...account,
      schemaVersion: account.schemaVersion ?? 0n,
      sourceFile: sourceFile ?? "btc-balance-snapshot",
      updatedAtMs: Date.now(),
    };
    const outcome = await upsertBtcAccountRow(ctx, row);
    return { key: row.key, owner: row.owner, outcome };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration: dataFiles blob → rows
//
// READ-ONLY against `dataFiles`. One entry point, one file per call, resumable
// via offset/limit, and idempotent — re-running it converges on the same rows
// rather than duplicating them.
//
// Batched on purpose. 905 transactions is more than one Convex mutation should
// write in a single transaction, and a migration that can only run all-or-
// nothing on the family's only financial record is not a migration, it is a
// coin toss. Run it as: migrateFromBlob({sourceFile}) → repeat with the returned
// nextOffset until done === true.
// ─────────────────────────────────────────────────────────────────────────────

type BlobKind = "transactions" | "todos" | "btcBuys" | "btcAccounts";

/**
 * Every blob this migration understands, and the owner its records belong to
 * when the record itself does not say.
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

/**
 * Mason's balances file is a flat object, not an accounts map, so it gets its
 * own shape. Keys and labels match MC2Mapper.mapSonBalances exactly, so a row
 * built here and a BTCAccount the iOS app builds from the same file are the same
 * account and not two. `fiat` is 0 there and 0 here — the file carries BTC only.
 */
const SON_BALANCE_ACCOUNTS = [
  { field: "strike", key: "son-strike-mason", label: "Strike", custody: "exchange" },
  { field: "river", key: "son-river-mason", label: "River", custody: "exchange" },
  {
    field: "coldcard",
    key: "son-coldcard-mason",
    label: "Coldcard",
    custody: "self_custody",
  },
] as const;

/**
 * Migrate one page of one blob into rows.
 *
 * Returns what it did, in counts only — never a financial value, so the output
 * is safe to paste into a runbook or an issue.
 */
export const migrateFromBlob = mutation({
  args: {
    sourceFile: v.string(),
    offset: v.optional(v.float64()),
    limit: v.optional(v.float64()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { sourceFile, offset, limit, token }) => {
    validateSyncToken(token);
    const { kind, owner: fileOwner } = blobSource(sourceFile);
    const start = Math.max(0, Math.trunc(offset ?? 0));
    const size = Math.max(1, Math.trunc(limit ?? 200));
    const now = Date.now();

    // READ ONLY. Nothing below writes to dataFiles, syncVersions or
    // todoTombstones; the blob path has to keep serving live clients unchanged.
    const doc = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", sourceFile))
      .first();

    if (!doc) {
      return {
        sourceFile,
        kind,
        total: 0,
        scanned: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        nextOffset: start,
        done: true,
      };
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let total = 0;
    let scanned = 0;

    const count = (outcome: UpsertOutcome) => {
      if (outcome === "inserted") inserted += 1;
      else updated += 1;
    };

    if (kind === "btcAccounts") {
      // Snapshots are small and indivisible — one object, a handful of accounts.
      // Paging them would buy nothing and risk a half-written snapshot.
      const rows = buildAccountRows(doc.data, sourceFile, fileOwner, now);
      total = rows.length;
      scanned = rows.length;
      for (const row of rows) count(await upsertBtcAccountRow(ctx, row));
      return {
        sourceFile,
        kind,
        total,
        scanned,
        inserted,
        updated,
        skipped,
        nextOffset: total,
        done: true,
      };
    }

    const entries = todoOrArrayEntries(doc.data);
    total = entries.length;
    const page = entries.slice(start, start + size);
    scanned = page.length;

    for (const entry of page) {
      const id = String(entry.id ?? "");
      if (id === "") {
        // A record with no id has no natural key, so it cannot be upserted
        // idempotently — a re-run would duplicate it. Counted, not silently
        // dropped, so the runbook can see it did not land.
        skipped += 1;
        continue;
      }

      if (kind === "transactions") {
        count(
          await upsertTransactionRow(
            ctx,
            buildTransactionRow(entry, fileOwner, sourceFile, now),
          ),
        );
      } else if (kind === "btcBuys") {
        count(
          await upsertBtcBuyRow(
            ctx,
            buildBtcBuyRow(entry, fileOwner, sourceFile, now),
          ),
        );
      } else {
        // A todo the blob path has already deleted must not be resurrected as a
        // row. Reading the tombstone table is a read — nothing here writes it.
        const tombstone = await ctx.db
          .query("todoTombstones")
          .withIndex("by_todo_id", (q) => q.eq("id", id))
          .first();
        if (tombstone) {
          skipped += 1;
          continue;
        }
        count(
          await upsertTodoRow(ctx, buildTodoRow(entry, fileOwner, sourceFile, now)),
        );
      }
    }

    const nextOffset = start + page.length;
    return {
      sourceFile,
      kind,
      total,
      scanned,
      inserted,
      updated,
      skipped,
      nextOffset,
      done: nextOffset >= total,
    };
  },
});

/** Todos have been stored both as a bare array and as `{ todos: [...] }`. */
function todoOrArrayEntries(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return asRecordArray(data);
  const record = asRecord(data);
  if (record && Array.isArray(record.todos)) return asRecordArray(record.todos);
  return [];
}

function buildAccountRows(
  data: unknown,
  sourceFile: string,
  fileOwner: FamilyMember,
  now: number,
) {
  const record = asRecord(data);
  if (!record) return [];

  const asOf = String(record.asOf ?? record.lastUpdated ?? record.last_updated ?? "");
  const schemaVersion = BigInt(Math.trunc(Number(record.schemaVersion ?? 0)) || 0);

  if (sourceFile === "son-balances") {
    return SON_BALANCE_ACCOUNTS.map((account) => ({
      key: account.key,
      owner: fileOwner,
      label: account.label,
      custody: account.custody as "exchange" | "self_custody",
      sats: parseBtcToSats(record[account.field]),
      // The file carries BTC only; MC2Mapper.mapSonBalances uses 0 fiat too.
      fiatCents: 0n,
      asOf,
      schemaVersion,
      sourceFile,
      updatedAtMs: now,
    }));
  }

  const accounts = asRecord(record.accounts) ?? {};
  return Object.entries(accounts).flatMap(([key, value]) => {
    const entry = asRecord(value);
    if (!entry) return [];
    return [
      {
        key,
        owner: resolveOwner(entry.owner, fileOwner),
        label: String(entry.label ?? key),
        custody: (entry.custody === "self_custody" ? "self_custody" : "exchange") as
          | "exchange"
          | "self_custody",
        sats: parseBtcToSats(entry.btc),
        fiatCents: parseCents(entry.fiat),
        asOf,
        schemaVersion,
        sourceFile,
        updatedAtMs: now,
      },
    ];
  });
}
