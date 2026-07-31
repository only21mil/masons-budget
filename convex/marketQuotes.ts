import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, internalMutation, query } from "./_generated/server";
import {
  MARKET_SYMBOLS,
  acquireFixedMarketQuotes,
  type MarketSymbol,
} from "./marketQuoteAcquire";

declare const process: { env: Record<string, string | undefined> };

const marketSymbolValidator = v.union(
  v.literal("BTC"),
  v.literal("VOO"),
  v.literal("IBIT"),
);
const marketQuoteStatusValidator = v.union(
  v.literal("live"),
  v.literal("stale"),
  v.literal("unavailable"),
);
type MarketQuoteStatus = "live" | "stale" | "unavailable";
type RefreshSummary = {
  quotes: Array<{ symbol: MarketSymbol; status: MarketQuoteStatus }>;
};
const snapshotQuoteValidator = v.object({
  symbol: marketSymbolValidator,
  priceCents: v.union(v.int64(), v.null()),
  source: v.string(),
  fetchedAt: v.union(v.string(), v.null()),
  status: marketQuoteStatusValidator,
});

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

// Mirrors the existing runtime-injected read boundary in dataFiles.ts. Keep the
// hatch precedence and error text aligned so clients cannot distinguish which
// authenticated read surface answered them.
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

function unavailableQuote(symbol: MarketSymbol) {
  return {
    symbol,
    priceCents: null,
    source: "Vogel Vault",
    fetchedAt: null,
    status: "unavailable" as const,
  };
}

/** Authenticated, structurally complete snapshot for Linux and Android. */
export const getSnapshot = query({
  args: { token: v.optional(v.string()) },
  returns: v.object({
    quotes: v.array(snapshotQuoteValidator),
    complete: v.literal(true),
  }),
  handler: async (ctx, { token }) => {
    validateReadToken(token);
    const quotes = [];
    for (const symbol of MARKET_SYMBOLS) {
      const cached = await ctx.db
        .query("marketQuoteCache")
        .withIndex("by_symbol", (q) => q.eq("symbol", symbol))
        .unique();
      if (
        !cached ||
        cached.status === "unavailable" ||
        cached.priceCents === undefined ||
        cached.priceCents <= 0n ||
        cached.fetchedAt === undefined ||
        cached.fetchedAt.trim() === "" ||
        cached.source.trim() === ""
      ) {
        quotes.push(unavailableQuote(symbol));
      } else {
        quotes.push({
          symbol,
          priceCents: cached.priceCents,
          source: cached.source,
          fetchedAt: cached.fetchedAt,
          status: cached.status,
        });
      }
    }
    return { quotes, complete: true as const };
  },
});

/** Record one successful observation without touching any household table. */
export const recordSuccess = internalMutation({
  args: {
    symbol: marketSymbolValidator,
    priceCents: v.int64(),
    source: v.string(),
    fetchedAt: v.string(),
  },
  returns: v.literal("live"),
  handler: async (ctx, args) => {
    if (args.priceCents <= 0n) throw new Error("Quote price must be positive");
    if (args.source.trim() === "") throw new Error("Quote source is required");
    if (args.fetchedAt.trim() === "") {
      throw new Error("Quote success timestamp is required");
    }
    const existing = await ctx.db
      .query("marketQuoteCache")
      .withIndex("by_symbol", (q) => q.eq("symbol", args.symbol))
      .unique();
    const value = {
      priceCents: args.priceCents,
      source: args.source,
      fetchedAt: args.fetchedAt,
      status: "live" as const,
      lastAttemptedAt: args.fetchedAt,
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else
      await ctx.db.insert("marketQuoteCache", {
        symbol: args.symbol,
        ...value,
      });
    return "live" as const;
  },
});

/**
 * Mark only the failed symbol. A prior successful observation stays intact and
 * becomes stale; a never-successful symbol remains explicitly unavailable.
 */
export const recordFailure = internalMutation({
  args: {
    symbol: marketSymbolValidator,
    attemptedAt: v.string(),
  },
  returns: v.union(v.literal("stale"), v.literal("unavailable")),
  handler: async (ctx, args) => {
    if (args.attemptedAt.trim() === "") {
      throw new Error("Quote attempt timestamp is required");
    }
    const existing = await ctx.db
      .query("marketQuoteCache")
      .withIndex("by_symbol", (q) => q.eq("symbol", args.symbol))
      .unique();
    if (
      existing?.priceCents !== undefined &&
      existing.priceCents > 0n &&
      existing.fetchedAt !== undefined &&
      existing.fetchedAt.trim() !== "" &&
      existing.source.trim() !== ""
    ) {
      await ctx.db.patch(existing._id, {
        status: "stale",
        lastAttemptedAt: args.attemptedAt,
      });
      return "stale" as const;
    } else if (existing) {
      await ctx.db.patch(existing._id, {
        priceCents: undefined,
        fetchedAt: undefined,
        source: "Vogel Vault",
        status: "unavailable",
        lastAttemptedAt: args.attemptedAt,
      });
    } else {
      await ctx.db.insert("marketQuoteCache", {
        symbol: args.symbol,
        source: "Vogel Vault",
        status: "unavailable",
        lastAttemptedAt: args.attemptedAt,
      });
    }
    return "unavailable" as const;
  },
});

/**
 * Internal-only bounded refresh. Acquisition has a fixed symbol/URL catalogue,
 * timeout, redirect refusal, response-size cap, and independent outcomes.
 */
export const refresh = internalAction({
  args: {},
  returns: v.object({
    quotes: v.array(
      v.object({
        symbol: marketSymbolValidator,
        status: marketQuoteStatusValidator,
      }),
    ),
  }),
  handler: async (ctx): Promise<RefreshSummary> => {
    const acquisitions = await acquireFixedMarketQuotes();
    const quotes: RefreshSummary["quotes"] = await Promise.all(
      acquisitions.map(async (result) => {
        if (result.ok) {
          const status: "live" = await ctx.runMutation(
            internal.marketQuotes.recordSuccess,
            {
              symbol: result.symbol,
              priceCents: result.priceCents,
              source: result.source,
              fetchedAt: result.fetchedAt,
            },
          );
          return { symbol: result.symbol, status };
        }
        const status: "stale" | "unavailable" = await ctx.runMutation(
          internal.marketQuotes.recordFailure,
          {
            symbol: result.symbol,
            attemptedAt: result.attemptedAt,
          },
        );
        return { symbol: result.symbol, status };
      }),
    );
    return { quotes };
  },
});
