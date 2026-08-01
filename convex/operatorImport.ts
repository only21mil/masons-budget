// Admin-only, atomic typed-row import for reviewed monthly ledger batches.
//
// These functions are intentionally internal. Convex admin/deploy-key auth is
// the transport capability; app sync/read tokens are neither accepted nor
// consulted here. The surface never writes dataFiles, syncVersions, migration
// provenance, or raw source records.

import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  type CanonicalOperatorImport,
  type CanonicalOperatorImportOp,
  type ImportBtcBillPay,
  type ImportBtcBuy,
  type ImportIncome,
  type ImportKind,
  type ImportTransaction,
  OperatorImportValidationError,
  canonicalizeOperatorImportEnvelope,
  semanticFingerprintForOperatorImportOp,
  sha256Hex,
} from "./operatorImportValidation";

const CONTRACT_VERSION = 1;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const STORED_MONTH = /^(?:January|February|March|April|May|June|July|August|September|October|November|December) [0-9]{4}$/u;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

type ReadCtx = QueryCtx | MutationCtx;
type LedgerDoc =
  | Doc<"transactions">
  | Doc<"income">
  | Doc<"btcBuys">
  | Doc<"btcBillPays">;
type Receipt = Doc<"operatorBatches">;
type Counts = {
  transactions: number;
  income: number;
  btc_buys: number;
  btc_bill_pays: number;
};
type StableValue =
  | null
  | string
  | number
  | boolean
  | bigint
  | StableValue[]
  | { readonly [key: string]: StableValue | undefined };
type ExpectedRow = {
  readonly op: CanonicalOperatorImportOp;
  readonly naturalKey: string;
  readonly sourceFile: string;
  readonly content: Readonly<Record<string, StableValue | undefined>>;
  readonly existing: LedgerDoc | undefined;
};
type BudgetPlan = {
  readonly document: Doc<"budgetDocuments">;
  readonly targetFingerprint: string;
};
type Analysis = {
  readonly canonical: CanonicalOperatorImport;
  readonly counts: Counts;
  readonly rows: ExpectedRow[];
  readonly budget: BudgetPlan | undefined;
  readonly planFingerprint: string;
  readonly stateFingerprint: string;
  readonly untouchedFingerprint: string;
};

function reject(code: string): never {
  throw new ConvexError({ code });
}

function requireFingerprint(value: string): void {
  if (!FINGERPRINT.test(value)) reject("INVALID_FINGERPRINT");
}

async function canonicalizeRedacted(input: unknown) {
  try {
    return await canonicalizeOperatorImportEnvelope(input);
  } catch (error) {
    if (error instanceof OperatorImportValidationError) reject(error.code);
    reject("INVALID_MANIFEST");
  }
}

function canonicalValue(value: StableValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject("NON_CANONICAL_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, StableValue] => entry[1] !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`)
    .join(",")}}`;
}

async function fingerprint(value: StableValue): Promise<string> {
  return `sha256:${await sha256Hex(`${canonicalValue(value)}\n`)}`;
}

function countsFor(canonical: CanonicalOperatorImport): Counts {
  return {
    transactions: canonical.counts.transaction,
    income: canonical.counts.income,
    btc_buys: canonical.counts.btc_buy,
    btc_bill_pays: canonical.counts.btc_bill_pay,
  };
}

function sameCounts(left: Counts, right: Counts): boolean {
  return (
    left.transactions === right.transactions &&
    left.income === right.income &&
    left.btc_buys === right.btc_buys &&
    left.btc_bill_pays === right.btc_bill_pays
  );
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function incomeSourceKey(recordId: string): string {
  // Matches the migration's stable key for an externally identified row, while
  // keeping runtime income free of fabricated raw/index provenance.
  return `id:${recordId}`;
}

function expectedContent(
  op: CanonicalOperatorImportOp,
): Readonly<Record<string, StableValue | undefined>> {
  const base = {
    owner: op.owner,
    date: op.date,
    month: monthOf(op.date),
    sourceFile: op.source_file,
  };
  if (op.kind === "transaction") {
    return {
      ...base,
      txId: op.record_id,
      merchant: op.merchant,
      amountCents: op.amount_cents,
      category: op.category,
      card: op.card,
      note: op.note,
    };
  }
  if (op.kind === "income") {
    return {
      ...base,
      sourceKey: incomeSourceKey(op.record_id),
      incomeId: op.record_id,
      amountCents: op.amount_cents,
      source: op.source,
      loggedBy: op.logged_by,
      note: op.note,
      archimedesRequestId: op.archimedes_request_id,
    };
  }
  if (op.kind === "btc_buy") {
    return {
      ...base,
      buyId: op.record_id,
      source: op.source,
      sats: op.sats,
      priceUsdCents: op.price_usd_cents,
      usdCents: op.usd_cents,
      note: op.note,
      status: op.status,
      costBasisStatus: op.cost_basis_status,
      loggedBy: op.logged_by,
      archimedesRequestId: op.archimedes_request_id,
    };
  }
  return {
    ...base,
    billPayId: op.record_id,
    merchant: op.merchant,
    category: op.category,
    amountUsdCents: op.amount_usd_cents,
    btcSpentSats: op.btc_spent_sats,
    btcPriceCents: op.btc_price_cents,
    platform: op.platform,
    note: op.note,
    feeUsdCents: op.fee_usd_cents,
    reference: op.reference,
  };
}

function storedContent(
  row: LedgerDoc,
): Readonly<Record<string, StableValue | undefined>> {
  if ("txId" in row) {
    return {
      txId: row.txId,
      owner: row.owner,
      date: row.date,
      month: row.month,
      merchant: row.merchant,
      amountCents: row.amountCents,
      category: row.category,
      card: row.card,
      note: row.note,
      sourceFile: row.sourceFile,
    };
  }
  if ("incomeId" in row) {
    return {
      sourceKey: row.sourceKey,
      incomeId: row.incomeId,
      owner: row.owner,
      date: row.date,
      month: row.month,
      amountCents: row.amountCents,
      source: row.source,
      loggedBy: row.loggedBy,
      note: row.note,
      archimedesRequestId: row.archimedesRequestId,
      sourceFile: row.sourceFile,
    };
  }
  if ("buyId" in row) {
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
      sourceFile: row.sourceFile,
    };
  }
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
    sourceFile: row.sourceFile,
  };
}

function sameStableContent(
  left: Readonly<Record<string, StableValue | undefined>>,
  right: Readonly<Record<string, StableValue | undefined>>,
): boolean {
  return canonicalValue(left) === canonicalValue(right);
}

function naturalKeyForStored(row: LedgerDoc): string {
  if ("txId" in row) return `transaction\u0000${row.sourceFile}\u0000${row.txId}`;
  if ("incomeId" in row) return `income\u0000${row.sourceFile}\u0000${row.incomeId}`;
  if ("buyId" in row) return `btc_buy\u0000${row.sourceFile}\u0000${row.buyId}`;
  return `btc_bill_pay\u0000${row.sourceFile}\u0000${row.billPayId}`;
}

function entityType(kind: ImportKind) {
  if (kind === "transaction") return "transaction" as const;
  if (kind === "btc_buy") return "btcBuy" as const;
  if (kind === "btc_bill_pay") return "btcBillPay" as const;
  // Income has no runtime delete surface or tombstone entity in the existing
  // schema. Its stable-id conflict and semantic-duplicate checks still apply.
  return undefined;
}

function putUnique(
  rows: Map<string, LedgerDoc>,
  key: string,
  row: LedgerDoc,
): void {
  if (rows.has(key)) reject("DUPLICATE_LIVE_NATURAL_KEY");
  rows.set(key, row);
}

async function loadLedgerState(ctx: ReadCtx) {
  const [transactions, income, btcBuys, btcBillPays, tombstones, budgets] =
    await Promise.all([
      ctx.db.query("transactions").collect(),
      ctx.db.query("income").collect(),
      ctx.db.query("btcBuys").collect(),
      ctx.db.query("btcBillPays").collect(),
      ctx.db.query("rowTombstones").collect(),
      ctx.db.query("budgetDocuments").collect(),
    ]);
  const ledgerRows: LedgerDoc[] = [
    ...transactions,
    ...income,
    ...btcBuys,
    ...btcBillPays,
  ];
  const byNaturalKey = new Map<string, LedgerDoc>();
  const incomeBySourceKey = new Map<string, Doc<"income">>();
  for (const row of ledgerRows) {
    putUnique(byNaturalKey, naturalKeyForStored(row), row);
  }
  for (const row of income) {
    if (incomeBySourceKey.has(row.sourceKey)) {
      reject("DUPLICATE_LIVE_SOURCE_KEY");
    }
    incomeBySourceKey.set(row.sourceKey, row);
  }
  return { ledgerRows, byNaturalKey, incomeBySourceKey, tombstones, budgets };
}

function semanticOpForStored(row: LedgerDoc):
  | ImportTransaction
  | ImportIncome
  | ImportBtcBuy
  | ImportBtcBillPay {
  const common = {
    op_id: "stored",
    record_id: "stored",
    source_locator: "stored",
    owner: row.owner,
    date: row.date,
  };
  if ("txId" in row) {
    return {
      ...common,
      kind: "transaction",
      source_file: row.sourceFile as ImportTransaction["source_file"],
      merchant: row.merchant,
      amount_cents: row.amountCents,
      transaction_kind: row.amountCents < 0n ? "credit" : "spend",
      category: row.category,
      card: row.card,
      note: row.note,
    };
  }
  if ("incomeId" in row) {
    return {
      ...common,
      kind: "income",
      source_file: "income",
      amount_cents: row.amountCents,
      source: row.source,
      logged_by: row.loggedBy,
      note: row.note,
      archimedes_request_id: row.archimedesRequestId,
    };
  }
  if ("buyId" in row) {
    return {
      ...common,
      kind: "btc_buy",
      source_file: row.sourceFile as ImportBtcBuy["source_file"],
      source: row.source,
      sats: row.sats,
      price_usd_cents: row.priceUsdCents,
      usd_cents: row.usdCents,
      note: row.note,
      status: row.status,
      cost_basis_status: row.costBasisStatus,
      logged_by: row.loggedBy,
      archimedes_request_id: row.archimedesRequestId,
    };
  }
  return {
    ...common,
    kind: "btc_bill_pay",
    source_file: "bitcoin-bill-pays",
    merchant: row.merchant,
    category: row.category,
    amount_usd_cents: row.amountUsdCents,
    btc_spent_sats: row.btcSpentSats,
    btc_price_cents: row.btcPriceCents,
    fee_usd_cents: row.feeUsdCents,
    platform: row.platform,
    note: row.note,
    reference: row.reference,
    budget_effect: "excluded_from_transactions",
  };
}

function budgetSourceForOwner(owner: string): "budget" | "mason-budget" {
  if (owner === "victor" || owner === "rachel") return "budget";
  if (owner === "mason") return "mason-budget";
  reject("LIVE_BUDGET_NOT_FOUND");
}

function budgetBySource(
  budgets: Doc<"budgetDocuments">[],
): Map<string, Doc<"budgetDocuments">> {
  const result = new Map<string, Doc<"budgetDocuments">>();
  for (const budget of budgets) {
    if (result.has(budget.sourceFile)) reject("DUPLICATE_LIVE_BUDGET");
    result.set(budget.sourceFile, budget);
  }
  return result;
}

function validateLiveCategories(
  ops: readonly CanonicalOperatorImportOp[],
  budgets: Doc<"budgetDocuments">[],
): void {
  const bySource = budgetBySource(budgets);
  const categories = new Map<string, Set<string>>();
  for (const [source, budget] of bySource) {
    const exact = new Set<string>();
    const folded = new Set<string>();
    for (const category of budget.categories) {
      const fold = category.name.toLocaleLowerCase("en-US");
      if (exact.has(category.name) || folded.has(fold)) {
        reject("AMBIGUOUS_LIVE_CATEGORY");
      }
      exact.add(category.name);
      folded.add(fold);
    }
    categories.set(source, exact);
  }
  for (const op of ops) {
    // Bill-pay categories describe the payoff ledger and intentionally do not
    // participate in budget spend. Only transaction categories must match the
    // live budget catalog.
    if (op.kind !== "transaction") continue;
    const source = budgetSourceForOwner(op.owner);
    if (!categories.get(source)?.has(op.category)) {
      reject("UNKNOWN_LIVE_CATEGORY");
    }
  }
}

function storedMonthIndex(value: string): number {
  if (!STORED_MONTH.test(value)) reject("INVALID_BUDGET_MONTH_TRANSITION");
  const [name, yearText] = value.split(" ");
  const month = MONTH_NAMES.indexOf(name as (typeof MONTH_NAMES)[number]);
  const year = Number(yearText);
  if (month < 0 || !Number.isSafeInteger(year)) {
    reject("INVALID_BUDGET_MONTH_TRANSITION");
  }
  return year * 12 + month;
}

async function assertNoProductionDuplicates(
  ops: readonly CanonicalOperatorImportOp[],
  ledgerRows: readonly LedgerDoc[],
): Promise<void> {
  const targetKeys = new Set(ops.map((op) => op.natural_key));
  const targetFingerprints = new Set(ops.map((op) => op.semantic_fingerprint));
  for (const row of ledgerRows) {
    if (targetKeys.has(naturalKeyForStored(row))) continue;
    const liveFingerprint = await semanticFingerprintForOperatorImportOp(
      semanticOpForStored(row),
    );
    if (targetFingerprints.has(liveFingerprint)) {
      reject("SEMANTIC_PRODUCTION_DUPLICATE");
    }
  }
}

function stripSystemFields(
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, StableValue | undefined>> {
  const result: Record<string, StableValue | undefined> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "_id" || key === "_creationTime") continue;
    result[key] = value as StableValue | undefined;
  }
  return result;
}

function stableBudgetTarget(
  budget: Doc<"budgetDocuments">,
  targetMonth: string,
): Readonly<Record<string, StableValue | undefined>> {
  const stable = stripSystemFields(budget);
  const income = budget.income
    ? { ...budget.income, mtdIncomeCents: 0n }
    : undefined;
  return {
    ...stable,
    month: targetMonth,
    mtdIncomeCents: 0n,
    income,
    updatedAtMs: undefined,
  };
}

async function buildBudgetPlan(
  canonical: CanonicalOperatorImport,
  budgets: Doc<"budgetDocuments">[],
): Promise<BudgetPlan | undefined> {
  const advance = canonical.envelope.budget_advance;
  if (!advance) return undefined;
  const expectedMonth = storedMonthIndex(advance.expected_month);
  const targetMonth = storedMonthIndex(advance.target_month);
  if (targetMonth <= expectedMonth || targetMonth - expectedMonth > 24) {
    reject("INVALID_BUDGET_MONTH_TRANSITION");
  }
  const budget = budgetBySource(budgets).get("budget");
  if (!budget) reject("LIVE_BUDGET_NOT_FOUND");
  if (
    budget.month !== advance.expected_month ||
    budget.updatedAtMs !== advance.expected_updated_at_ms
  ) {
    reject("BUDGET_STATE_CONFLICT");
  }
  return {
    document: budget,
    targetFingerprint: await fingerprint(
      stableBudgetTarget(budget, advance.target_month),
    ),
  };
}

function stateRows(
  rows: readonly LedgerDoc[],
): StableValue[] {
  return rows
    .map((row) => ({
      natural_key: naturalKeyForStored(row),
      row: stripSystemFields(row),
    }))
    .sort((left, right) =>
      left.natural_key < right.natural_key
        ? -1
        : left.natural_key > right.natural_key
          ? 1
          : 0,
    );
}

function stateTombstones(
  rows: readonly Doc<"rowTombstones">[],
): StableValue[] {
  return rows
    .map((row) => stripSystemFields(row))
    .sort((left, right) => {
      const leftValue = canonicalValue(left);
      const rightValue = canonicalValue(right);
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });
}

function stateBudgets(
  rows: readonly Doc<"budgetDocuments">[],
): StableValue[] {
  return rows
    .map((row) => stripSystemFields(row))
    .sort((left, right) => {
      const leftValue = canonicalValue(left);
      const rightValue = canonicalValue(right);
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });
}

async function stateFingerprintFor(
  ledgerRows: readonly LedgerDoc[],
  tombstones: readonly Doc<"rowTombstones">[],
  budgets: readonly Doc<"budgetDocuments">[],
): Promise<string> {
  return await fingerprint({
    rows: stateRows(ledgerRows),
    tombstones: stateTombstones(tombstones),
    budgets: stateBudgets(budgets),
  });
}

async function untouchedFingerprintFor(
  ledgerRows: readonly LedgerDoc[],
  tombstones: readonly Doc<"rowTombstones">[],
  budgets: readonly Doc<"budgetDocuments">[],
  targetKeys: ReadonlySet<string>,
  budgetSource: string | undefined,
): Promise<string> {
  return await fingerprint({
    rows: stateRows(
      ledgerRows.filter((row) => !targetKeys.has(naturalKeyForStored(row))),
    ),
    tombstones: stateTombstones(tombstones),
    budgets: stateBudgets(
      budgets.filter((budget) => budget.sourceFile !== budgetSource),
    ),
  });
}

async function buildAnalysis(ctx: ReadCtx, input: unknown): Promise<Analysis> {
  const canonical = await canonicalizeRedacted(input);
  const state = await loadLedgerState(ctx);
  validateLiveCategories(canonical.ops, state.budgets);

  const tombstoneKeys = new Set(
    state.tombstones.map(
      (row) => `${row.entityType}\u0000${row.sourceFile}\u0000${row.entityId}`,
    ),
  );
  const rows: ExpectedRow[] = [];
  for (const op of canonical.ops) {
    const tombstoneType = entityType(op.kind);
    if (
      tombstoneType &&
      tombstoneKeys.has(
        `${tombstoneType}\u0000${op.source_file}\u0000${op.record_id}`,
      )
    ) {
      reject("TOMBSTONED_RECORD");
    }
    const content = expectedContent(op);
    const existing = state.byNaturalKey.get(op.natural_key);
    if (op.kind === "income") {
      const sourceKeyRow = state.incomeBySourceKey.get(
        incomeSourceKey(op.record_id),
      );
      if (
        sourceKeyRow &&
        naturalKeyForStored(sourceKeyRow) !== op.natural_key
      ) {
        reject("EXISTING_SOURCE_KEY_CONFLICT");
      }
    }
    if (existing && !sameStableContent(storedContent(existing), content)) {
      reject("EXISTING_CONTENT_CONFLICT");
    }
    rows.push({
      op,
      naturalKey: op.natural_key,
      sourceFile: op.source_file,
      content,
      existing,
    });
  }
  await assertNoProductionDuplicates(canonical.ops, state.ledgerRows);
  const budget = await buildBudgetPlan(canonical, state.budgets);
  const counts = countsFor(canonical);
  const targetKeys = new Set(rows.map((row) => row.naturalKey));
  const untouchedFingerprint = await untouchedFingerprintFor(
    state.ledgerRows,
    state.tombstones,
    state.budgets,
    targetKeys,
    budget?.document.sourceFile,
  );
  const stateFingerprint = await stateFingerprintFor(
    state.ledgerRows,
    state.tombstones,
    state.budgets,
  );
  const planFingerprint = await fingerprint({
    contract_version: CONTRACT_VERSION,
    manifest_digest: `sha256:${canonical.manifest_digest}`,
    state_fingerprint: stateFingerprint,
    counts,
    rows: await Promise.all(
      rows.map(async (row) => ({
        natural_key_fingerprint: await fingerprint(row.naturalKey),
        content_fingerprint: await fingerprint(row.content),
      })),
    ),
    budget_target_fingerprint: budget?.targetFingerprint,
    untouched_fingerprint: untouchedFingerprint,
  });
  return {
    canonical,
    counts,
    rows,
    budget,
    planFingerprint,
    stateFingerprint,
    untouchedFingerprint,
  };
}

async function oneByIndex(
  ctx: ReadCtx,
  index: "by_batch_id" | "by_manifest_digest",
  value: string,
): Promise<Receipt | undefined> {
  const rows =
    index === "by_batch_id"
      ? await ctx.db
          .query("operatorBatches")
          .withIndex(index, (q) => q.eq("batchId", value))
          .take(2)
      : await ctx.db
          .query("operatorBatches")
          .withIndex(index, (q) => q.eq("manifestDigest", value))
          .take(2);
  if (rows.length > 1) reject("DUPLICATE_BATCH_RECEIPT");
  return rows[0];
}

async function findReceipt(
  ctx: ReadCtx,
  canonical: CanonicalOperatorImport,
): Promise<Receipt | undefined> {
  const digest = `sha256:${canonical.manifest_digest}`;
  const [byBatch, byDigest] = await Promise.all([
    oneByIndex(ctx, "by_batch_id", canonical.envelope.batch_id),
    oneByIndex(ctx, "by_manifest_digest", digest),
  ]);
  if (byBatch && byBatch.manifestDigest !== digest) reject("BATCH_ID_CONFLICT");
  if (byDigest && byDigest.batchId !== canonical.envelope.batch_id) {
    reject("MANIFEST_RECEIPT_CONFLICT");
  }
  if (byBatch && byDigest && byBatch._id !== byDigest._id) {
    reject("BATCH_RECEIPT_CONFLICT");
  }
  return byBatch ?? byDigest;
}

function receiptMatchesManifest(
  receipt: Receipt,
  canonical: CanonicalOperatorImport,
): void {
  if (
    receipt.contractVersion !== CONTRACT_VERSION ||
    receipt.manifestDigest !== `sha256:${canonical.manifest_digest}` ||
    !FINGERPRINT.test(receipt.manifestDigest) ||
    !FINGERPRINT.test(receipt.planFingerprint) ||
    !FINGERPRINT.test(receipt.stateFingerprint) ||
    !FINGERPRINT.test(receipt.untouchedFingerprint) ||
    (receipt.budgetTargetFingerprint !== undefined &&
      !FINGERPRINT.test(receipt.budgetTargetFingerprint)) ||
    !sameCounts(receipt.counts, countsFor(canonical))
  ) {
    reject("BATCH_RECEIPT_CONFLICT");
  }
}

async function verifyApplied(
  ctx: ReadCtx,
  canonical: CanonicalOperatorImport,
  receipt: Receipt,
): Promise<void> {
  receiptMatchesManifest(receipt, canonical);
  const state = await loadLedgerState(ctx);
  validateLiveCategories(canonical.ops, state.budgets);
  const targetKeys = new Set(canonical.ops.map((op) => op.natural_key));
  const tombstoneKeys = new Set(
    state.tombstones.map(
      (row) => `${row.entityType}\u0000${row.sourceFile}\u0000${row.entityId}`,
    ),
  );
  for (const op of canonical.ops) {
    const row = state.byNaturalKey.get(op.natural_key);
    if (!row || !sameStableContent(storedContent(row), expectedContent(op))) {
      reject("READBACK_ROW_MISMATCH");
    }
    const tombstoneType = entityType(op.kind);
    if (
      tombstoneType &&
      tombstoneKeys.has(
        `${tombstoneType}\u0000${op.source_file}\u0000${op.record_id}`,
      )
    ) {
      reject("READBACK_TOMBSTONE_CONFLICT");
    }
  }
  await assertNoProductionDuplicates(canonical.ops, state.ledgerRows);

  const advance = canonical.envelope.budget_advance;
  if (advance) {
    const budget = budgetBySource(state.budgets).get("budget");
    if (
      !budget ||
      receipt.budgetTargetFingerprint === undefined ||
      receipt.budgetExpectedUpdatedAtMs !== advance.expected_updated_at_ms ||
      receipt.budgetAppliedUpdatedAtMs === undefined ||
      budget.updatedAtMs !== receipt.budgetAppliedUpdatedAtMs ||
      budget.updatedAtMs <= advance.expected_updated_at_ms ||
      budget.month !== advance.target_month ||
      (await fingerprint(stableBudgetTarget(budget, advance.target_month))) !==
        receipt.budgetTargetFingerprint
    ) {
      reject("READBACK_BUDGET_MISMATCH");
    }
  } else if (
    receipt.budgetTargetFingerprint !== undefined ||
    receipt.budgetExpectedUpdatedAtMs !== undefined ||
    receipt.budgetAppliedUpdatedAtMs !== undefined
  ) {
    reject("BATCH_RECEIPT_CONFLICT");
  }

  const untouched = await untouchedFingerprintFor(
    state.ledgerRows,
    state.tombstones,
    state.budgets,
    targetKeys,
    advance?.source_file,
  );
  if (untouched !== receipt.untouchedFingerprint) {
    reject("READBACK_UNTOUCHED_MISMATCH");
  }
}

async function lockRuntimeSource(ctx: MutationCtx, sourceFile: string) {
  const rows = await ctx.db
    .query("runtimeSourceLocks")
    .withIndex("by_source_file", (q) => q.eq("sourceFile", sourceFile))
    .take(2);
  if (rows.length > 1) reject("DUPLICATE_RUNTIME_SOURCE_LOCK");
  if (rows.length === 0) {
    await ctx.db.insert("runtimeSourceLocks", {
      sourceFile,
      lockedAtMs: Date.now(),
    });
  }
}

async function insertExpectedRow(
  ctx: MutationCtx,
  row: ExpectedRow,
  updatedAtMs: number,
): Promise<void> {
  const op = row.op;
  if (op.kind === "transaction") {
    await ctx.db.insert("transactions", {
      txId: op.record_id,
      owner: op.owner,
      date: op.date,
      month: monthOf(op.date),
      merchant: op.merchant,
      amountCents: op.amount_cents,
      category: op.category,
      card: op.card,
      note: op.note,
      sourceFile: op.source_file,
      updatedAtMs,
    });
    return;
  }
  if (op.kind === "income") {
    await ctx.db.insert("income", {
      sourceKey: incomeSourceKey(op.record_id),
      incomeId: op.record_id,
      owner: op.owner,
      date: op.date,
      month: monthOf(op.date),
      amountCents: op.amount_cents,
      source: op.source,
      loggedBy: op.logged_by,
      note: op.note,
      archimedesRequestId: op.archimedes_request_id,
      sourceFile: "income",
      updatedAtMs,
    });
    return;
  }
  if (op.kind === "btc_buy") {
    await ctx.db.insert("btcBuys", {
      buyId: op.record_id,
      owner: op.owner,
      date: op.date,
      month: monthOf(op.date),
      source: op.source,
      sats: op.sats,
      priceUsdCents: op.price_usd_cents,
      usdCents: op.usd_cents,
      note: op.note,
      status: op.status,
      costBasisStatus: op.cost_basis_status,
      loggedBy: op.logged_by,
      archimedesRequestId: op.archimedes_request_id,
      sourceFile: op.source_file,
      updatedAtMs,
    });
    return;
  }
  await ctx.db.insert("btcBillPays", {
    billPayId: op.record_id,
    owner: op.owner,
    date: op.date,
    month: monthOf(op.date),
    merchant: op.merchant,
    category: op.category,
    amountUsdCents: op.amount_usd_cents,
    btcSpentSats: op.btc_spent_sats,
    btcPriceCents: op.btc_price_cents,
    platform: op.platform,
    note: op.note,
    feeUsdCents: op.fee_usd_cents,
    reference: op.reference,
    sourceFile: "bitcoin-bill-pays",
    updatedAtMs,
  });
}

function baseChecks() {
  return {
    authEnforced: true,
    targetMatched: true,
    contractMatched: true,
    categoriesValid: true,
    unitsValid: true,
    datesValid: true,
    idsValid: true,
    duplicatesClear: true,
  };
}

export const preflightBatch = internalQuery({
  args: { manifest: v.any() },
  handler: async (ctx, { manifest }) => {
    const canonical = await canonicalizeRedacted(manifest);
    const receipt = await findReceipt(ctx, canonical);
    if (receipt) {
      await verifyApplied(ctx, canonical, receipt);
      return {
        contract_version: CONTRACT_VERSION,
        outcome: "ready" as const,
        counts: receipt.counts,
        checks: {
          ...baseChecks(),
          receiptRecorded: true,
          rowsMatched: true,
        },
        plan_fingerprint: receipt.planFingerprint,
        state_fingerprint: receipt.stateFingerprint,
      };
    }
    const analysis = await buildAnalysis(ctx, manifest);
    return {
      contract_version: CONTRACT_VERSION,
      outcome: "ready" as const,
      counts: analysis.counts,
      checks: { ...baseChecks(), stateMatched: true },
      plan_fingerprint: analysis.planFingerprint,
      state_fingerprint: analysis.stateFingerprint,
    };
  },
});

export const applyBatch = internalMutation({
  args: {
    manifest: v.any(),
    expected_plan_fingerprint: v.string(),
    expected_state_fingerprint: v.string(),
  },
  handler: async (
    ctx,
    { manifest, expected_plan_fingerprint, expected_state_fingerprint },
  ) => {
    requireFingerprint(expected_plan_fingerprint);
    requireFingerprint(expected_state_fingerprint);
    const canonical = await canonicalizeRedacted(manifest);
    const priorReceipt = await findReceipt(ctx, canonical);
    if (priorReceipt) {
      receiptMatchesManifest(priorReceipt, canonical);
      if (
        priorReceipt.planFingerprint !== expected_plan_fingerprint ||
        priorReceipt.stateFingerprint !== expected_state_fingerprint
      ) {
        reject("REVIEWED_PLAN_MISMATCH");
      }
      await verifyApplied(ctx, canonical, priorReceipt);
      return {
        contract_version: CONTRACT_VERSION,
        outcome: "already_applied" as const,
        counts: priorReceipt.counts,
        checks: {
          ...baseChecks(),
          planMatched: true,
          receiptRecorded: true,
          rowsMatched: true,
          completed: true,
        },
      };
    }

    const analysis = await buildAnalysis(ctx, manifest);
    if (analysis.planFingerprint !== expected_plan_fingerprint) {
      reject("REVIEWED_PLAN_MISMATCH");
    }
    if (analysis.stateFingerprint !== expected_state_fingerprint) {
      reject("REVIEWED_STATE_MISMATCH");
    }

    const now = Date.now();
    const insertedSources = new Set(
      analysis.rows.filter((row) => !row.existing).map((row) => row.sourceFile),
    );
    for (const sourceFile of insertedSources) {
      await lockRuntimeSource(ctx, sourceFile);
    }
    for (const row of analysis.rows) {
      if (!row.existing) await insertExpectedRow(ctx, row, now);
    }

    let budgetAppliedUpdatedAtMs: number | undefined;
    if (analysis.budget) {
      const advance = analysis.canonical.envelope.budget_advance!;
      budgetAppliedUpdatedAtMs = Math.max(
        Date.now(),
        analysis.budget.document.updatedAtMs + 1,
      );
      await lockRuntimeSource(ctx, advance.source_file);
      await ctx.db.patch(analysis.budget.document._id, {
        month: advance.target_month,
        mtdIncomeCents: 0n,
        income: analysis.budget.document.income
          ? { ...analysis.budget.document.income, mtdIncomeCents: 0n }
          : undefined,
        updatedAtMs: budgetAppliedUpdatedAtMs,
      });
    }

    const receiptId = await ctx.db.insert("operatorBatches", {
      contractVersion: CONTRACT_VERSION,
      batchId: analysis.canonical.envelope.batch_id,
      manifestDigest: `sha256:${analysis.canonical.manifest_digest}`,
      planFingerprint: analysis.planFingerprint,
      stateFingerprint: analysis.stateFingerprint,
      untouchedFingerprint: analysis.untouchedFingerprint,
      counts: analysis.counts,
      budgetTargetFingerprint: analysis.budget?.targetFingerprint,
      budgetExpectedUpdatedAtMs:
        analysis.canonical.envelope.budget_advance?.expected_updated_at_ms,
      budgetAppliedUpdatedAtMs,
      appliedAtMs: Date.now(),
    });
    const receipt = await ctx.db.get(receiptId);
    if (!receipt) reject("RECEIPT_WRITE_FAILED");
    await verifyApplied(ctx, analysis.canonical, receipt);

    return {
      contract_version: CONTRACT_VERSION,
      outcome: "applied" as const,
      counts: analysis.counts,
      checks: {
        ...baseChecks(),
        stateMatched: true,
        planMatched: true,
        receiptRecorded: true,
        rowsMatched: true,
        completed: true,
      },
    };
  },
});

export const readbackBatch = internalQuery({
  args: {
    manifest: v.any(),
    expected_plan_fingerprint: v.string(),
  },
  handler: async (ctx, { manifest, expected_plan_fingerprint }) => {
    requireFingerprint(expected_plan_fingerprint);
    const canonical = await canonicalizeRedacted(manifest);
    const receipt = await findReceipt(ctx, canonical);
    if (!receipt) reject("BATCH_RECEIPT_NOT_FOUND");
    receiptMatchesManifest(receipt, canonical);
    if (receipt.planFingerprint !== expected_plan_fingerprint) {
      reject("REVIEWED_PLAN_MISMATCH");
    }
    await verifyApplied(ctx, canonical, receipt);
    return {
      contract_version: CONTRACT_VERSION,
      outcome: "verified" as const,
      counts: receipt.counts,
      checks: {
        ...baseChecks(),
        planMatched: true,
        receiptRecorded: true,
        rowsMatched: true,
        aggregatesMatched: true,
        untouchedMatched: true,
        completed: true,
      },
    };
  },
});
