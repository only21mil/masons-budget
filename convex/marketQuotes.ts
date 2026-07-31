import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, internalMutation, query } from "./_generated/server";
import {
  MARKET_SYMBOLS,
  acquireFixedMarketQuotes,
  type MarketQuoteErrorCode,
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
const marketQuoteErrorCodeValidator = v.union(
  v.literal("timeout"),
  v.literal("http_error"),
  v.literal("invalid_response"),
  v.literal("network_error"),
);
type MarketQuoteStatus = "live" | "stale" | "unavailable";
const LIVE_WINDOW_MS = 30 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const CANONICAL_QUOTE_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
type RefreshSummary = {
  quotes: Array<{
    symbol: MarketSymbol;
    status: MarketQuoteStatus;
    errorCode: MarketQuoteErrorCode | null;
  }>;
};
const snapshotQuoteValidator = v.object({
  symbol: marketSymbolValidator,
  priceCents: v.union(v.int64(), v.null()),
  source: v.string(),
  fetchedAt: v.union(v.string(), v.null()),
  status: marketQuoteStatusValidator,
  lastAttemptedAt: v.union(v.string(), v.null()),
  errorCode: v.union(marketQuoteErrorCodeValidator, v.null()),
});

/** Parse canonical UTC whole seconds or exactly three millisecond digits. */
function canonicalQuoteInstantMillis(value: string): number | null {
  if (!CANONICAL_QUOTE_INSTANT.test(value)) return null;

  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  const normalized = new Date(millis).toISOString();
  return value === normalized || value === normalized.replace(".000Z", "Z")
    ? millis
    : null;
}

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

function unavailableQuote(
  symbol: MarketSymbol,
  lastAttemptedAt: string | null = null,
  errorCode: MarketQuoteErrorCode | null = null,
) {
  return {
    symbol,
    priceCents: null,
    source: "Vogel Vault",
    fetchedAt: null,
    status: "unavailable" as const,
    lastAttemptedAt,
    errorCode,
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
    const nowMs = Date.now();
    for (const symbol of MARKET_SYMBOLS) {
      const cached = await ctx.db
        .query("marketQuoteCache")
        .withIndex("by_symbol", (q) => q.eq("symbol", symbol))
        .unique();
      const fetchedAt = cached?.fetchedAt;
      const fetchedAtMs =
        fetchedAt === undefined ? null : canonicalQuoteInstantMillis(fetchedAt);
      if (
        !cached ||
        cached.status === "unavailable" ||
        cached.priceCents === undefined ||
        cached.priceCents <= 0n ||
        fetchedAt === undefined ||
        fetchedAtMs === null ||
        fetchedAtMs > nowMs + MAX_FUTURE_SKEW_MS ||
        cached.source.trim() === ""
      ) {
        quotes.push(
          unavailableQuote(
            symbol,
            cached?.lastAttemptedAt ?? null,
            cached?.lastErrorCode ?? null,
          ),
        );
      } else {
        const effectiveStatus: "live" | "stale" =
          cached.status === "stale" ||
          nowMs >= fetchedAtMs + LIVE_WINDOW_MS
            ? "stale"
            : "live";
        quotes.push({
          symbol,
          priceCents: cached.priceCents,
          source: cached.source,
          fetchedAt,
          status: effectiveStatus,
          lastAttemptedAt: cached.lastAttemptedAt,
          errorCode: cached.lastErrorCode ?? null,
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
    const fetchedAtMs = canonicalQuoteInstantMillis(args.fetchedAt);
    if (fetchedAtMs === null) {
      throw new Error("Quote success timestamp must be canonical UTC");
    }
    if (fetchedAtMs > Date.now() + MAX_FUTURE_SKEW_MS) {
      throw new Error("Quote success timestamp must not be materially future");
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
      lastErrorCode: undefined,
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else
      await ctx.db.insert("marketQuoteCache", {
        symbol: args.symbol,
        ...value,
      });
    // Read-time freshness is authoritative; this scheduled mutation keeps the
    // stored status useful for reactive clients and operational inspection.
    await ctx.scheduler.runAt(
      fetchedAtMs + LIVE_WINDOW_MS,
      internal.marketQuotes.expireLiveQuote,
      { symbol: args.symbol, fetchedAt: args.fetchedAt },
    );
    return "live" as const;
  },
});

/** Mark only the unchanged observation stale when its live window expires. */
export const expireLiveQuote = internalMutation({
  args: {
    symbol: marketSymbolValidator,
    fetchedAt: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("marketQuoteCache")
      .withIndex("by_symbol", (q) => q.eq("symbol", args.symbol))
      .unique();
    if (existing?.status !== "live" || existing.fetchedAt !== args.fetchedAt) {
      return false;
    }
    await ctx.db.patch(existing._id, { status: "stale" });
    return true;
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
    errorCode: marketQuoteErrorCodeValidator,
  },
  returns: v.union(v.literal("stale"), v.literal("unavailable")),
  handler: async (ctx, args) => {
    if (canonicalQuoteInstantMillis(args.attemptedAt) === null) {
      throw new Error("Quote attempt timestamp must be canonical UTC");
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
        lastErrorCode: args.errorCode,
      });
      return "stale" as const;
    } else if (existing) {
      await ctx.db.patch(existing._id, {
        priceCents: undefined,
        fetchedAt: undefined,
        source: "Vogel Vault",
        status: "unavailable",
        lastAttemptedAt: args.attemptedAt,
        lastErrorCode: args.errorCode,
      });
    } else {
      await ctx.db.insert("marketQuoteCache", {
        symbol: args.symbol,
        source: "Vogel Vault",
        status: "unavailable",
        lastAttemptedAt: args.attemptedAt,
        lastErrorCode: args.errorCode,
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
        errorCode: v.union(marketQuoteErrorCodeValidator, v.null()),
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
          return { symbol: result.symbol, status, errorCode: null };
        }
        const status: "stale" | "unavailable" = await ctx.runMutation(
          internal.marketQuotes.recordFailure,
          {
            symbol: result.symbol,
            attemptedAt: result.attemptedAt,
            errorCode: result.errorCode,
          },
        );
        return { symbol: result.symbol, status, errorCode: result.errorCode };
      }),
    );
    return { quotes };
  },
});
