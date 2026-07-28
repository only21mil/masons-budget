import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The Vogel Vault — Convex Schema
//
// TWO STORAGE SHAPES LIVE HERE AT THE SAME TIME, ON PURPOSE.
//
//   `dataFiles` (legacy, still authoritative): one document per MC2 JSON file,
//   whole payload in a v.any() blob. Every shipped client reads it and
//   production is live, so it is untouched by this change and must stay that
//   way until the clients have moved.
//
//   `transactions` / `todos` / `btcBuys` / `btcBillPays` / `btcAccounts` (new):
//   one document per record. convex/tables.ts is the runtime API and
//   convex/migrate.ts provides the internal-only blob backfill. They exist
//   because MC2 died on 2026-07-18 and Convex is now the system of record rather
//   than a sync target, and the blob shape cannot carry that role:
//
//     - appendTransaction rewrites all 905 transactions to add one.
//     - every write bumps a version that forces clients to re-download the
//       whole array.
//     - there are no indexes, so every read is the entire file.
//     - whole-file replace means no per-record history on what is now the only
//       copy of the family's financial record.
//
// Conventions that apply to every new table below:
//
//   MONEY IS INTEGER MINOR UNITS — v.int64(), never v.float64(). USD is cents,
//   BTC is satoshis. v.float64() is an IEEE double and would make the ledger
//   approximate; the field names carry the unit (`amountCents`, `sats`) so a
//   later reader cannot mistake the scale. Mirrors shared/domain/src/money.ts.
//
//   `owner` IS A FIRST-CLASS INDEXED FIELD, and a closed literal union rather
//   than v.string(). Visibility is per-owner, and today it happens client-side
//   after the whole file has already been shipped. Rows let the server filter
//   instead. The closed union matters more than it looks: coerceOwner() maps any
//   unrecognised owner to "victor", who is an ADULT — so one typo'd owner string
//   ("Mason", "mason ") would promote a child's row into the adult household
//   view and into adult net worth. The schema refuses to store it at all.
//
//   THE VISIBILITY RULE ITSELF DOES NOT CHANGE. canSeeDataOwnedBy (adults see
//   everyone) is WIDER than sharesNetWorthWith (adults + adults only; a child's
//   stack never enters adult net worth). See convex/tables.ts for the mirrors
//   and the tests that pin the two apart.
//
//   `sourceFile` records which surviving blob a row came from. It is migration
//   provenance; transaction amounts use one contract for every owner: purchases
//   positive, refunds negative, and Income positive.

/**
 * The four family members, as a closed set.
 *
 * Exported so convex/tables.ts validates its `owner`/`viewer` arguments against
 * exactly the set the tables can store — one definition, not two that can drift.
 * Mirrors FAMILY_MEMBERS in shared/domain/src/family.ts and FamilyMember in
 * MasonsBudget/MasonsBudget/Models/SharedEnums.swift.
 */
export const familyMemberValidator = v.union(
  v.literal("victor"),
  v.literal("rachel"),
  v.literal("mason"),
  v.literal("maddox"),
);

/** Mirrors BTCCustody in shared/domain/src/readModel.ts. */
export const custodyValidator = v.union(
  v.literal("exchange"),
  v.literal("self_custody"),
);

const balanceAmountsSatsValidator = v.object({
  cashAppSats: v.optional(v.int64()),
  coldcardSats: v.optional(v.int64()),
  riverSats: v.optional(v.int64()),
  strikeSats: v.optional(v.int64()),
  zeusSats: v.optional(v.int64()),
  totalSats: v.optional(v.int64()),
});

const btcSyncValidator = v.object({
  anchorBalancesSats: balanceAmountsSatsValidator,
  anchorDate: v.optional(v.string()),
  anchorSource: v.optional(v.string()),
  notes: v.optional(v.any()),
  reconciledAt: v.optional(v.string()),
  reconciledFromEvents: v.optional(v.any()),
});

const budgetCategoryValidator = v.object({
  name: v.string(),
  icon: v.optional(v.string()),
  budgetCents: v.int64(),
});

const paycheckValidator = v.object({
  date: v.string(),
  platform: v.optional(v.string()),
  source: v.optional(v.string()),
  amountCents: v.int64(),
  netCents: v.int64(),
  note: v.optional(v.string()),
});

const budgetIncomeValidator = v.object({
  weeklyGrossCents: v.int64(),
  weeklyStrikeCents: v.int64(),
  weeklyRiverCents: v.int64(),
  payFrequency: v.optional(v.string()),
  monthlyGrossCents: v.int64(),
  mtdIncomeCents: v.int64(),
  ytdIncomeCents: v.int64(),
  paychecks: v.array(paycheckValidator),
});

const monthlyHistoryValidator = v.object({
  month: v.string(),
  incomeCents: v.int64(),
  expensesCents: v.int64(),
  savingsBps: v.int64(),
});

const btcBalanceAccountValidator = v.object({
  key: v.string(),
  label: v.string(),
  custody: custodyValidator,
  sats: v.int64(),
  fiatCents: v.int64(),
});

const financeLotValidator = v.object({
  date: v.string(),
  type: v.string(),
  pricePerShareCents: v.int64(),
  // Shares are an exact quantity, not money. A decimal string preserves their
  // lexical precision without introducing a floating-point field.
  sharesDecimal: v.string(),
  amountInvestedCents: v.int64(),
  note: v.optional(v.string()),
});

const financeHoldingValidator = v.object({
  name: v.string(),
  category: v.string(),
  ticker: v.optional(v.string()),
  valueCents: v.int64(),
  costBasisCents: v.int64(),
  gainBps: v.int64(),
  sharesDecimal: v.string(),
  avgCostCents: v.int64(),
  currentPricePerShareCents: v.int64(),
  isProxy: v.boolean(),
  proxyNote: v.optional(v.string()),
  lots: v.array(financeLotValidator),
});

const financeAccountValidator = v.object({
  key: v.string(),
  owner: familyMemberValidator,
  provider: v.string(),
  totalValueCents: v.int64(),
  weeklyContributionCents: v.int64(),
  weeklyContributionDay: v.optional(v.string()),
  holdings: v.array(financeHoldingValidator),
});

export default defineSchema({
  // ── Core data store ──
  // Each MC2 JSON file maps to one document.
  // The `data` field holds the raw JSON payload (array or object).
  dataFiles: defineTable({
    name: v.string(), // e.g. "transactions", "budget", "btc-balance-snapshot"
    data: v.any(), // Raw JSON — decoded client-side by Swift DTOs
    version: v.float64(), // Monotonically increasing — triggers client re-fetch
    updatedAt: v.float64(), // Unix timestamp (ms)
  }).index("by_name", ["name"]),

  // ── Sync metadata ──
  // Lightweight table the app polls to detect changes.
  // One document per data file tracks its current version.
  syncVersions: defineTable({
    name: v.string(),
    version: v.float64(),
    updatedAt: v.float64(),
  }).index("by_name", ["name"]),

  // ── Todo delete tombstones (SAT-1327) ──
  // A deleted todo is recorded here so the MC2 sync bridge can remove it locally
  // and a later pull cannot resurrect it. Kept in a SEPARATE table (not in the
  // todos payload) so the app-facing `get("todos")` response stays clean.
  todoTombstones: defineTable({
    id: v.string(), // the deleted todo's id
    deletedAt: v.float64(), // Unix timestamp (ms) of the delete
  }).index("by_todo_id", ["id"]),

  // ── Mobile writeback pairing (SAT-1429) ──
  // Public iPhones cannot reach DGX/Tailscale, so they complete existing MC2
  // todos through Convex using per-device tokens. Pairings are one-time secrets
  // created by an authenticated server/agent flow; devices store only their own
  // token, and Convex stores only token hashes.
  mobilePairings: defineTable({
    pairId: v.string(),
    proofHash: v.string(),
    createdAt: v.float64(),
    expiresAt: v.float64(),
    createdBy: v.string(),
    claimedAt: v.optional(v.float64()),
    deviceId: v.optional(v.string()),
  }).index("by_pair_id", ["pairId"]),

  mobileDevices: defineTable({
    deviceId: v.string(),
    name: v.string(),
    tokenHash: v.string(),
    pairedAt: v.float64(),
    lastSeenAt: v.float64(),
    revokedAt: v.optional(v.float64()),
    pairId: v.string(),
  }).index("by_device_id", ["deviceId"]),

  // ══════════════════════════════════════════════════════════════════════════
  // ROW TABLES — see the banner at the top of this file. Nothing reads these
  // yet; `dataFiles` above stays authoritative until the clients move.
  // ══════════════════════════════════════════════════════════════════════════

  // ── Transactions ──
  // Today: 905 of these inside one dataFiles document.
  transactions: defineTable({
    // MC2's stable record id. Named `txId` because `_id` is Convex's own.
    txId: v.string(),
    owner: familyMemberValidator,
    // ISO `yyyy-MM-dd`, verbatim from MC2. Not a timestamp: a transaction dated
    // 2026-07-01 belongs to July in every timezone, which is what a ledger needs.
    date: v.string(),
    // `yyyy-MM`, derived from `date` at write time by exactly one helper
    // (monthOf in tables.ts). Denormalised so "this month, this owner" is a
    // single index range instead of a scan; a budget's spend is derived from
    // that month's transactions, so this is the hot path, not a convenience.
    month: v.string(),
    merchant: v.string(),
    // SIGNED: purchases are positive for every owner; refunds are negative.
    amountCents: v.int64(),
    category: v.string(),
    // Absent rather than null. MC2 writes null and "" interchangeably for
    // "nothing here"; collapsing both to absent means one shape reaches clients.
    card: v.optional(v.string()),
    note: v.optional(v.string()),
    // "transactions" | "mason-transactions" | "maddox-transactions".
    // Carries the sign convention, and pairs with txId as the natural key —
    // record ids are only unique within their own file.
    sourceFile: v.string(),
    updatedAtMs: v.float64(), // Unix ms of the last write to THIS row
    migrationRaw: v.optional(v.any()),
    migrationSourceIndex: v.optional(v.float64()),
  })
    .index("by_source_tx_id", ["sourceFile", "txId"]) // upsert / dedupe
    .index("by_owner_month", ["owner", "month"]) // budget month, one owner
    .index("by_owner_month_date", ["owner", "month", "date"])
    .index("by_owner_date", ["owner", "date"]) // activity feed, one owner
    .index("by_month", ["month"]) // budget month, whole household
    .index("by_date", ["date"]), // activity feed, whole household

  // ── Income ──
  // The legacy `income` blob is a row collection, not a budget document. Its
  // records use the same source-key/provenance treatment as transactions while
  // keeping USD as integer cents.
  income: defineTable({
    sourceKey: v.string(),
    incomeId: v.string(),
    owner: familyMemberValidator,
    date: v.string(),
    month: v.string(),
    amountCents: v.int64(),
    source: v.string(),
    loggedBy: v.optional(v.string()),
    note: v.optional(v.string()),
    archimedesRequestId: v.optional(v.string()),
    sourceFile: v.literal("income"),
    updatedAtMs: v.float64(),
    // Required, not optional: this is the canonical round-trip proof.
    raw: v.any(),
    migrationSourceIndex: v.float64(),
  })
    .index("by_source_key", ["sourceFile", "sourceKey"])
    .index("by_owner_month", ["owner", "month"])
    .index("by_owner_month_date", ["owner", "month", "date"])
    .index("by_owner_date", ["owner", "date"])
    .index("by_date", ["date"]),

  // ── Todos ──
  todos: defineTable({
    // Globally unique: there is one todos file, unlike the per-member
    // transaction files, so no sourceFile component is needed in the key.
    todoId: v.string(),
    owner: familyMemberValidator,
    title: v.string(),
    done: v.boolean(),
    flagged: v.boolean(),
    lane: v.optional(v.string()), // "work" | "personal" | "sats"
    project: v.optional(v.string()),
    area: v.optional(v.string()),
    due: v.optional(v.string()),
    notes: v.optional(v.string()),
    priority: v.optional(v.int64()), // integral, so int64 rather than a double
    // ISO strings exactly as the source carries them, kept so a row can be
    // written back to MC2's shape without inventing a format.
    createdAt: v.optional(v.string()),
    updatedAt: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    // Numeric mirror of `updatedAt`, derived by todoUpdatedMs() — the same
    // function dataFiles.ts already uses to decide last-write-wins. Sortable and
    // indexable, which an ISO string with mixed formats is not.
    updatedAtMs: v.float64(),
    sourceFile: v.string(),
    migrationRaw: v.optional(v.any()),
    migrationSourceIndex: v.optional(v.float64()),
  })
    .index("by_todo_id", ["todoId"])
    .index("by_owner_done", ["owner", "done", "updatedAtMs"])
    .index("by_done_updated", ["done", "updatedAtMs"])
    .index("by_updated", ["updatedAtMs"]),

  // ── Bitcoin buys ──
  btcBuys: defineTable({
    buyId: v.string(),
    owner: familyMemberValidator,
    date: v.string(), // ISO yyyy-MM-dd
    month: v.string(), // yyyy-MM, derived from date
    source: v.string(), // "strike", "river", …
    // Satoshis. MC2 carries both amount_sats and amount_btc; amount_sats is
    // authoritative and amount_btc is a lossy mirror, so only sats is stored.
    sats: v.int64(),
    priceUsdCents: v.int64(), // BTC price at purchase
    usdCents: v.int64(), // fiat spent
    note: v.optional(v.string()),
    status: v.optional(v.string()),
    costBasisStatus: v.optional(v.string()),
    loggedBy: v.optional(v.string()),
    archimedesRequestId: v.optional(v.string()),
    sourceFile: v.string(), // "bitcoin-buys" | "mason-bitcoin-buys"
    updatedAtMs: v.float64(),
    migrationRaw: v.optional(v.any()),
    migrationSourceIndex: v.optional(v.float64()),
  })
    .index("by_source_buy_id", ["sourceFile", "buyId"])
    .index("by_owner_date", ["owner", "date"])
    .index("by_owner_month", ["owner", "month"])
    .index("by_owner_month_date", ["owner", "month", "date"])
    .index("by_date", ["date"]),

  // ── Bitcoin bill payments ──
  // Same row/provenance pattern as btcBuys. Financial values are exact integer
  // minor units: USD cents and satoshis, never floats.
  btcBillPays: defineTable({
    billPayId: v.string(),
    owner: familyMemberValidator,
    date: v.string(),
    month: v.string(),
    merchant: v.string(),
    category: v.string(),
    amountUsdCents: v.int64(),
    btcSpentSats: v.int64(),
    btcPriceCents: v.int64(),
    platform: v.optional(v.string()),
    note: v.optional(v.string()),
    feeUsdCents: v.int64(),
    reference: v.optional(v.string()),
    sourceFile: v.string(),
    updatedAtMs: v.float64(),
    migrationRaw: v.optional(v.any()),
    migrationSourceIndex: v.optional(v.float64()),
  })
    .index("by_source_bill_pay_id", ["sourceFile", "billPayId"])
    .index("by_owner_date", ["owner", "date"])
    .index("by_owner_month", ["owner", "month"])
    .index("by_owner_month_date", ["owner", "month", "date"])
    .index("by_date", ["date"]),

  // ── Bitcoin accounts (balance snapshot) ──
  // The blob keys these by account name inside one snapshot object. As rows the
  // identity is (owner, key), NOT key alone — Mason has a "strike" account and
  // so do the adults, and merging them would put a child's stack in adult
  // net worth, which sharesNetWorthWith exists to prevent.
  btcAccounts: defineTable({
    key: v.string(), // "strike", "river", "coldcard", …
    owner: familyMemberValidator,
    label: v.string(),
    custody: custodyValidator,
    sats: v.int64(),
    fiatCents: v.int64(),
    asOf: v.string(), // snapshot timestamp, verbatim from MC2
    schemaVersion: v.int64(),
    sourceFile: v.string(),
    updatedAtMs: v.float64(),
    migrationSourceIndex: v.optional(v.float64()),
  })
    .index("by_owner_key", ["owner", "key"]) // upsert / dedupe
    .index("by_owner_custody", ["owner", "custody"])
    .index("by_key", ["key"]),

  // ── Legacy balances document ──
  // Unlike btcAccounts, `balances` is one adult-household document with
  // reconciliation state. The indexed owner is the visibility boundary: adult
  // viewers share it, while child rows (if a separate source is ever modelled)
  // cannot enter an adult net-worth query.
  balanceDocuments: defineTable({
    sourceFile: v.literal("balances"),
    owner: familyMemberValidator,
    cashAppSats: v.int64(),
    coldcardSats: v.int64(),
    riverSats: v.int64(),
    strikeSats: v.int64(),
    zeusSats: v.int64(),
    totalSats: v.int64(),
    cashAppFiatCents: v.optional(v.int64()),
    coldcardFiatCents: v.optional(v.int64()),
    riverFiatCents: v.optional(v.int64()),
    strikeFiatCents: v.optional(v.int64()),
    zeusFiatCents: v.optional(v.int64()),
    totalFiatCents: v.optional(v.int64()),
    lastRefreshed: v.string(),
    btcSync: btcSyncValidator,
    updatedAtMs: v.float64(),
    // Carries every source field byte-for-byte at the decoded JSON boundary.
    raw: v.any(),
    migrationSourceIndex: v.float64(),
  })
    .index("by_source_file", ["sourceFile"])
    .index("by_owner", ["owner"]),

  // ── Atomic budget documents ──
  // `budget` and `mason-budget` are single objects, not row collections. One
  // typed table row therefore replaces one complete source object. Reported
  // category spend is intentionally absent: spend is derived from the matching
  // month's transaction rows.
  budgetDocuments: defineTable({
    sourceFile: v.union(v.literal("budget"), v.literal("mason-budget")),
    owner: familyMemberValidator,
    month: v.string(),
    coinbaseOneBalanceCents: v.int64(),
    categories: v.array(budgetCategoryValidator),
    effectiveApr: v.optional(v.string()),
    strategyNote: v.optional(v.string()),
    income: v.optional(budgetIncomeValidator),
    mtdIncomeCents: v.int64(),
    ytdIncomeCents: v.int64(),
    monthlyHistory: v.array(monthlyHistoryValidator),
    allowance: v.optional(
      v.object({
        weeklyCents: v.int64(),
        source: v.string(),
      }),
    ),
    updatedAtMs: v.float64(),
    migrationRawJson: v.optional(v.string()),
    migrationSourceIndex: v.optional(v.float64()),
  })
    .index("by_source_file", ["sourceFile"])
    .index("by_owner", ["owner"]),

  // ── Atomic BTC balance documents ──
  // The adult snapshot and Mason's son-balances object share one normalized
  // typed shape, but remain separate rows with closed owners. Query scope can
  // therefore make Mason visible to adults without ever including him in an
  // adult net-worth response.
  btcBalanceDocuments: defineTable({
    sourceFile: v.union(
      v.literal("btc-balance-snapshot"),
      v.literal("son-balances"),
    ),
    owner: familyMemberValidator,
    schemaVersion: v.int64(),
    asOf: v.string(),
    accounts: v.array(btcBalanceAccountValidator),
    totals: v.object({
      sats: v.int64(),
      fiatCents: v.int64(),
      exchangeSats: v.int64(),
      selfCustodySats: v.int64(),
    }),
    source: v.optional(v.string()),
    basis: v.optional(v.string()),
    confidence: v.optional(v.string()),
    updatedAtMs: v.float64(),
    migrationRawJson: v.optional(v.string()),
    migrationSourceIndex: v.optional(v.float64()),
  })
    .index("by_source_file", ["sourceFile"])
    .index("by_owner", ["owner"]),

  // ── Atomic finances document ──
  // `finances` is one source object containing accounts owned by more than one
  // family member. Owners stay on the nested accounts as the closed union; the
  // public query filters those accounts before returning the document.
  financeDocuments: defineTable({
    sourceFile: v.literal("finances"),
    lastUpdated: v.string(),
    retirementTotalCents: v.optional(v.int64()),
    accounts: v.array(financeAccountValidator),
    updatedAtMs: v.float64(),
    migrationRawJson: v.optional(v.string()),
    migrationSourceIndex: v.optional(v.float64()),
  }).index("by_source_file", ["sourceFile"]),
});
