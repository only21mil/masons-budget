import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { custodyValidator, familyMemberValidator } from "./schema";

export type LedgerOwner = "victor" | "rachel" | "mason" | "maddox";
type BtcSourceFile = "btc-balance-snapshot" | "son-balances";

const MAX_INT64 = (1n << 63n) - 1n;
const MIN_INT64 = -(1n << 63n);

function canonicalOwner(owner: LedgerOwner): Exclude<LedgerOwner, "rachel"> {
  return owner === "rachel" ? "victor" : owner;
}

function sourceFileFor(rawOwner: LedgerOwner): BtcSourceFile {
  const owner = canonicalOwner(rawOwner);
  if (owner === "victor") return "btc-balance-snapshot";
  if (owner === "mason") return "son-balances";
  throw new ConvexError(`No Bitcoin balance document exists for ${owner}.`);
}

function mirrorKey(sourceFile: BtcSourceFile, key: string): string {
  return sourceFile === "son-balances" ? `son-${key}-mason` : key;
}

function totalsFor(
  accounts: Array<{
    custody: "exchange" | "self_custody";
    sats: bigint;
    fiatCents?: bigint;
    fiatValuation?: { cents: bigint };
  }>,
) {
  const totals = accounts.reduce(
    (current, account) => ({
      sats: current.sats + account.sats,
      exchangeSats:
        current.exchangeSats +
        (account.custody === "exchange" ? account.sats : 0n),
      selfCustodySats:
        current.selfCustodySats +
        (account.custody === "self_custody" ? account.sats : 0n),
    }),
    { sats: 0n, exchangeSats: 0n, selfCustodySats: 0n },
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

async function lockSource(ctx: MutationCtx, sourceFile: BtcSourceFile) {
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

export function addDelta(
  deltas: Map<string, bigint>,
  accountKey: string,
  delta: bigint,
) {
  const key = accountKey.trim();
  if (!key) throw new ConvexError("Bitcoin account key must not be empty.");
  const next = (deltas.get(key) ?? 0n) + delta;
  if (next < MIN_INT64 || next > MAX_INT64) {
    throw new ConvexError("Bitcoin account delta exceeds signed int64.");
  }
  deltas.set(key, next);
}

export async function riverAccountKey(
  ctx: MutationCtx,
  rawOwner: LedgerOwner,
): Promise<string> {
  const owner = canonicalOwner(rawOwner);
  const sourceFile = sourceFileFor(owner);
  const document = await ctx.db
    .query("btcBalanceDocuments")
    .withIndex("by_source_file", (q) => q.eq("sourceFile", sourceFile))
    .unique();
  if (!document || document.owner !== owner) {
    throw new ConvexError("The canonical Bitcoin balance document is unavailable.");
  }
  if (document.postingActivatedAtMs === undefined) {
    throw new ConvexError(
      "Bitcoin balance posting is not active until opening reconciliation completes.",
    );
  }
  const matches = document.accounts.filter(
    (account) =>
      account.key.toLocaleLowerCase("en-US") === "river" ||
      account.label.trim().toLocaleLowerCase("en-US") === "river",
  );
  if (matches.length !== 1) {
    throw new ConvexError("The canonical River Bitcoin account is missing or ambiguous.");
  }
  return matches[0].key;
}

export async function applyBtcAccountDeltas(
  ctx: MutationCtx,
  rawOwner: LedgerOwner,
  deltas: ReadonlyMap<string, bigint>,
): Promise<number> {
  const owner = canonicalOwner(rawOwner);
  const effective = [...deltas.entries()].filter(([, delta]) => delta !== 0n);
  if (effective.length === 0) return Date.now();

  const sourceFile = sourceFileFor(owner);
  const document = await ctx.db
    .query("btcBalanceDocuments")
    .withIndex("by_source_file", (q) => q.eq("sourceFile", sourceFile))
    .unique();
  if (!document || document.owner !== owner) {
    throw new ConvexError("The canonical Bitcoin balance document is unavailable.");
  }
  if (document.postingActivatedAtMs === undefined) {
    throw new ConvexError(
      "Bitcoin balance posting is not active until opening reconciliation completes.",
    );
  }

  const byKey = new Map(effective);
  const seen = new Set<string>();
  const accounts = document.accounts.map((account) => {
    const delta = byKey.get(account.key);
    if (delta === undefined) return account;
    seen.add(account.key);
    const sats = account.sats + delta;
    if (sats < 0n) {
      throw new ConvexError(`Bitcoin account ${account.key} has insufficient funds.`);
    }
    if (sats > MAX_INT64) {
      throw new ConvexError(`Bitcoin account ${account.key} exceeds signed int64.`);
    }
    const {
      fiatCents: _discardedFiatCents,
      fiatValuation: _discardedFiatValuation,
      ...stable
    } = account;
    return { ...stable, sats };
  });
  if (seen.size !== effective.length) {
    const missing = effective
      .map(([key]) => key)
      .filter((key) => !seen.has(key));
    throw new ConvexError(`Unknown Bitcoin account: ${missing.join(", ")}.`);
  }

  const now = Date.now();
  const asOf = new Date(now).toISOString();
  await lockSource(ctx, sourceFile);
  await ctx.db.patch(document._id, {
    accounts,
    totals: totalsFor(accounts),
    asOf,
    updatedAtMs: now,
  });

  for (const [key] of effective) {
    const account = accounts.find((candidate) => candidate.key === key);
    if (!account) throw new ConvexError(`Unknown Bitcoin account: ${key}.`);
    const mirror = await ctx.db
      .query("btcAccounts")
      .withIndex("by_owner_key", (q) =>
        q.eq("owner", owner).eq("key", mirrorKey(sourceFile, key)),
      )
      .unique();
    if (!mirror) {
      throw new ConvexError(`Bitcoin account mirror ${key} is unavailable.`);
    }
    await ctx.db.patch(mirror._id, {
      sats: account.sats,
      fiatCents: undefined,
      fiatValuation: undefined,
      asOf,
      updatedAtMs: now,
    });
  }
  return now;
}

const reconcileAccountValidator = v.object({
  key: v.string(),
  label: v.string(),
  custody: custodyValidator,
  sats: v.int64(),
});

export const reconcileBtcAccounts = internalMutation({
  args: {
    owner: familyMemberValidator,
    expectedUpdatedAtMs: v.float64(),
    asOf: v.string(),
    accounts: v.array(reconcileAccountValidator),
  },
  handler: async (ctx, args) => {
    const owner = args.owner === "rachel" ? "victor" : args.owner;
    if (owner !== "victor" && owner !== "mason" && owner !== "maddox") {
      throw new ConvexError("Unsupported Bitcoin ledger owner.");
    }
    if (!args.asOf.trim()) throw new ConvexError("asOf must not be empty.");

    const posted = await Promise.all([
      ctx.db.query("transactions").collect(),
      ctx.db.query("btcBuys").collect(),
      ctx.db.query("btcBillPays").collect(),
      ctx.db.query("btcTransfers").collect(),
    ]);
    if (
      posted.some((rows) =>
        rows.some((row) =>
          "owner" in row &&
          canonicalOwner(row.owner as LedgerOwner) === owner &&
          "balancePostingVersion" in row &&
          row.balancePostingVersion !== undefined,
        ),
      )
    ) {
      throw new ConvexError(
        "Opening balance reconciliation is closed after the first posted Bitcoin event.",
      );
    }

    const sourceFile = sourceFileFor(owner);
    const document = await ctx.db
      .query("btcBalanceDocuments")
      .withIndex("by_source_file", (q) => q.eq("sourceFile", sourceFile))
      .unique();
    if (!document || document.owner !== owner) {
      throw new ConvexError("The canonical Bitcoin balance document is unavailable.");
    }
    if (document.postingActivatedAtMs !== undefined) {
      throw new ConvexError("Opening balance reconciliation is already complete.");
    }
    if (document.updatedAtMs !== args.expectedUpdatedAtMs) {
      throw new ConvexError("The Bitcoin balance document changed before reconciliation.");
    }

    const updates = new Map(args.accounts.map((account) => [account.key, account]));
    if (updates.size !== args.accounts.length) {
      throw new ConvexError("Reconciliation account keys must be unique.");
    }
    const changedKeys = new Set<string>();
    const accounts = document.accounts.map((account) => {
      const update = updates.get(account.key);
      if (!update) return account;
      if (update.sats < 0n) throw new ConvexError("Bitcoin balances cannot be negative.");
      if (update.label !== account.label || update.custody !== account.custody) {
        throw new ConvexError(`Reconciliation metadata mismatch for ${account.key}.`);
      }
      changedKeys.add(account.key);
      const {
        fiatCents: _discardedFiatCents,
        fiatValuation: _discardedFiatValuation,
        ...stable
      } = account;
      return { ...stable, sats: update.sats };
    });
    if (changedKeys.size !== updates.size) {
      throw new ConvexError("Reconciliation may update existing accounts only.");
    }

    const now = Date.now();
    await lockSource(ctx, sourceFile);
    await ctx.db.patch(document._id, {
      accounts,
      totals: totalsFor(accounts),
      asOf: args.asOf,
      postingActivatedAtMs: now,
      updatedAtMs: now,
    });
    for (const key of changedKeys) {
      const account = accounts.find((candidate) => candidate.key === key);
      if (!account) throw new ConvexError(`Unknown Bitcoin account: ${key}.`);
      const mirror = await ctx.db
        .query("btcAccounts")
        .withIndex("by_owner_key", (q) =>
          q.eq("owner", owner).eq("key", mirrorKey(sourceFile, key)),
        )
        .unique();
      if (!mirror) throw new ConvexError(`Bitcoin account mirror ${key} is unavailable.`);
      await ctx.db.patch(mirror._id, {
        sats: account.sats,
        fiatCents: undefined,
        fiatValuation: undefined,
        asOf: args.asOf,
        updatedAtMs: now,
      });
    }
    return { updatedAccounts: changedKeys.size, updatedAtMs: now };
  },
});

export type BtcTransferRow = Omit<
  Doc<"btcTransfers">,
  "_id" | "_creationTime"
>;
