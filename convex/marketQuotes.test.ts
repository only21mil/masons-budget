import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireFixedMarketQuotes,
  decimalUsdToCents,
  extractRootPriceDecimal,
} from "./marketQuoteAcquire";
import {
  api,
  freshSecret,
  internalApi,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

useIsolatedDeploymentEnv();

const FIXED_TIME = "2026-07-30T15:00:00.000Z";
const jsonResponse = (price: string | number, init?: ResponseInit) =>
  new Response(`{"price":${JSON.stringify(price)}}`, {
    status: 200,
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });

describe("exact quote response parsing", () => {
  it("extracts only one root price without passing through a number", () => {
    expect(
      extractRootPriceDecimal(
        '{"change24h":1.25,"price":681.795,"ticker":"VOO"}',
      ),
    ).toBe("681.795");
    expect(extractRootPriceDecimal('{"price":"36.70"}')).toBe("36.70");
  });

  it("refuses missing, duplicate, nested-only, malformed, and trailing JSON", () => {
    for (const payload of [
      "{}",
      '{"nested":{"price":1}}',
      '{"price":1,"nested":{"price":2}}',
      '{"price":1,"price":2}',
      '{"price":}',
      '{"price":1} trailing',
    ]) {
      expect(() => extractRootPriceDecimal(payload), payload).toThrow();
    }
  });

  it("converts positive decimal dollars to int64 cents with half-away rounding", () => {
    const cases: Array<[string, bigint]> = [
      ["64855", 6_485_500n],
      ["681.79", 68_179n],
      ["36.7", 3_670n],
      ["1.234", 123n],
      ["1.235", 124n],
      ["6.815e2", 68_150n],
      ["0.005", 1n],
    ];
    for (const [input, expected] of cases) {
      expect(decimalUsdToCents(input), input).toBe(expected);
    }
  });

  it("refuses zero, negative, non-decimal, extreme exponent, and int64 overflow", () => {
    for (const input of [
      "0",
      "0.004",
      "-1",
      "NaN",
      "Infinity",
      "1e19",
      "92233720368547758.08",
    ]) {
      expect(() => decimalUsdToCents(input), input).toThrow();
    }
  });
});

describe("fixed upstream acquisition boundary", () => {
  it("requests exactly the three reviewed HTTPS endpoints with bounded options", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), init });
      return jsonResponse(
        String(input).endsWith("/btc")
          ? "64855"
          : String(input).endsWith("/voo")
            ? "681.79"
            : "36.7",
      );
    };

    const results = await acquireFixedMarketQuotes(
      fakeFetch,
      () => new Date(FIXED_TIME),
    );

    expect(calls.map(({ url }) => url)).toEqual([
      "https://sats21m.com/api/price/btc",
      "https://sats21m.com/api/price/voo",
      "https://sats21m.com/api/price/ibit",
    ]);
    for (const { init } of calls) {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toEqual({ Accept: "application/json" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(results).toEqual([
      {
        symbol: "BTC",
        ok: true,
        priceCents: 6_485_500n,
        source: "Vogel Vault",
        fetchedAt: FIXED_TIME,
      },
      {
        symbol: "VOO",
        ok: true,
        priceCents: 68_179n,
        source: "Vogel Vault",
        fetchedAt: FIXED_TIME,
      },
      {
        symbol: "IBIT",
        ok: true,
        priceCents: 3_670n,
        source: "Vogel Vault",
        fetchedAt: FIXED_TIME,
      },
    ]);
  });

  it("isolates HTTP, content-type, and body-size failures by symbol", async () => {
    const fakeFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/btc")) return jsonResponse("64855");
      if (url.endsWith("/voo")) {
        return new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response('{"price":36.7}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(32 * 1024 + 1),
        },
      });
    };

    const results = await acquireFixedMarketQuotes(
      fakeFetch,
      () => new Date(FIXED_TIME),
    );
    expect(
      results.map((result) => [
        result.symbol,
        result.ok ? null : result.errorCode,
      ]),
    ).toEqual([
      ["BTC", null],
      ["VOO", "invalid_response"],
      ["IBIT", "invalid_response"],
    ]);
  });

  it("does not follow or accept redirects even if a test fetch ignores the policy", async () => {
    const results = await acquireFixedMarketQuotes(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/quote" },
        }),
      () => new Date(FIXED_TIME),
    );
    expect(
      results.map((result) => (result.ok ? null : result.errorCode)),
    ).toEqual(["http_error", "http_error", "http_error"]);
  });
});

describe("authenticated snapshot and cache transitions", () => {
  let t: ReturnType<typeof testConvex>;

  beforeEach(() => {
    t = testConvex();
  });

  it("fails closed and rejects caller-controlled proxy arguments", async () => {
    await expect(t.query(api.getMarketQuoteSnapshot, {})).rejects.toThrow(
      /CONVEX_READ_TOKEN is not configured/,
    );

    const token = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: token });
    await expect(
      t.query(api.getMarketQuoteSnapshot, { token: freshSecret() }),
    ).rejects.toThrow(/invalid read token/);
    await expect(
      t.query(api.getMarketQuoteSnapshot, {
        token,
        symbol: "MSTR",
        url: "https://attacker.invalid",
      } as { token: string }),
    ).rejects.toThrow();
  });

  it("returns one unavailable entry for every fixed symbol before first success", async () => {
    const token = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: token });
    await expect(
      t.query(api.getMarketQuoteSnapshot, { token }),
    ).resolves.toEqual({
      complete: true,
      quotes: [
        {
          symbol: "BTC",
          priceCents: null,
          source: "Vogel Vault",
          fetchedAt: null,
          status: "unavailable",
          lastAttemptedAt: null,
          errorCode: null,
        },
        {
          symbol: "VOO",
          priceCents: null,
          source: "Vogel Vault",
          fetchedAt: null,
          status: "unavailable",
          lastAttemptedAt: null,
          errorCode: null,
        },
        {
          symbol: "IBIT",
          priceCents: null,
          source: "Vogel Vault",
          fetchedAt: null,
          status: "unavailable",
          lastAttemptedAt: null,
          errorCode: null,
        },
      ],
    });
  });

  it("uses the existing read hatch precedence and never returns credentials", async () => {
    const readToken = freshSecret();
    const syncToken = freshSecret();
    setDeploymentEnv({
      CONVEX_READ_TOKEN: readToken,
      CONVEX_SYNC_TOKEN: syncToken,
      ALLOW_TOKENLESS_READ: "true",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snapshot = await t.query(api.getMarketQuoteSnapshot, {});
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(readToken);
      expect(serialized).not.toContain(syncToken);
      expect(warn.mock.calls.join("\n")).toMatch(/PERMISSIVE/);
      expect(warn.mock.calls.join("\n")).toMatch(/IGNORED/);
    } finally {
      warn.mockRestore();
    }
  });

  it("preserves a failed symbol as stale without changing other successes", async () => {
    const token = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: token });
    const initial = "2026-07-30T14:45:00.000Z";
    for (const [symbol, priceCents] of [
      ["BTC", 6_485_500n],
      ["VOO", 68_179n],
      ["IBIT", 3_670n],
    ] as const) {
      await t.mutation(internalApi.recordMarketQuoteSuccess, {
        symbol,
        priceCents,
        source: "Vogel Vault",
        fetchedAt: initial,
      });
    }

    await expect(
      t.mutation(internalApi.recordMarketQuoteFailure, {
        symbol: "VOO",
        attemptedAt: FIXED_TIME,
        errorCode: "http_error",
      }),
    ).resolves.toBe("stale");
    await t.mutation(internalApi.recordMarketQuoteSuccess, {
      symbol: "BTC",
      priceCents: 6_500_000n,
      source: "Vogel Vault",
      fetchedAt: FIXED_TIME,
    });

    const snapshot = await t.query(api.getMarketQuoteSnapshot, { token });
    expect(snapshot.quotes).toEqual([
      {
        symbol: "BTC",
        priceCents: 6_500_000n,
        source: "Vogel Vault",
        fetchedAt: FIXED_TIME,
        status: "live",
        lastAttemptedAt: FIXED_TIME,
        errorCode: null,
      },
      {
        symbol: "VOO",
        priceCents: 68_179n,
        source: "Vogel Vault",
        fetchedAt: initial,
        status: "stale",
        lastAttemptedAt: FIXED_TIME,
        errorCode: "http_error",
      },
      {
        symbol: "IBIT",
        priceCents: 3_670n,
        source: "Vogel Vault",
        fetchedAt: initial,
        status: "live",
        lastAttemptedAt: initial,
        errorCode: null,
      },
    ]);
  });

  it("marks a never-successful failed symbol unavailable", async () => {
    const token = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: token });
    await expect(
      t.mutation(internalApi.recordMarketQuoteFailure, {
        symbol: "IBIT",
        attemptedAt: FIXED_TIME,
        errorCode: "network_error",
      }),
    ).resolves.toBe("unavailable");

    const snapshot = await t.query(api.getMarketQuoteSnapshot, { token });
    expect(snapshot.quotes[2]).toEqual({
      symbol: "IBIT",
      priceCents: null,
      source: "Vogel Vault",
      fetchedAt: null,
      status: "unavailable",
      lastAttemptedAt: FIXED_TIME,
      errorCode: "network_error",
    });
  });

  it("expires only the unchanged live observation without inventing an error", async () => {
    const token = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: token });
    await t.mutation(internalApi.recordMarketQuoteSuccess, {
      symbol: "BTC",
      priceCents: 6_485_500n,
      source: "Vogel Vault",
      fetchedAt: FIXED_TIME,
    });

    await expect(
      t.mutation(internalApi.expireLiveMarketQuote, {
        symbol: "BTC",
        fetchedAt: "2026-07-30T14:59:00.000Z",
      }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(internalApi.expireLiveMarketQuote, {
        symbol: "BTC",
        fetchedAt: FIXED_TIME,
      }),
    ).resolves.toBe(true);

    const snapshot = await t.query(api.getMarketQuoteSnapshot, { token });
    expect(snapshot.quotes[0]).toMatchObject({
      symbol: "BTC",
      priceCents: 6_485_500n,
      fetchedAt: FIXED_TIME,
      status: "stale",
      errorCode: null,
    });
  });

  it("runs the internal refresh end to end and reports a preserved stale quote", async () => {
    const token = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: token });
    await t.mutation(internalApi.recordMarketQuoteSuccess, {
      symbol: "VOO",
      priceCents: 67_000n,
      source: "Vogel Vault",
      fetchedAt: "2026-07-30T14:00:00.000Z",
    });

    vi.stubGlobal("fetch", async (input: string | URL | Request) =>
      String(input).endsWith("/voo")
        ? new Response(null, { status: 503 })
        : jsonResponse(String(input).endsWith("/btc") ? "64855" : "36.7"),
    );
    try {
      await expect(
        t.action(internalApi.refreshMarketQuotes, {}),
      ).resolves.toEqual({
        quotes: [
          { symbol: "BTC", status: "live", errorCode: null },
          { symbol: "VOO", status: "stale", errorCode: "http_error" },
          { symbol: "IBIT", status: "live", errorCode: null },
        ],
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const snapshot = await t.query(api.getMarketQuoteSnapshot, { token });
    expect(snapshot.quotes[0]).toMatchObject({
      symbol: "BTC",
      priceCents: 6_485_500n,
      status: "live",
    });
    expect(snapshot.quotes[1]).toEqual({
      symbol: "VOO",
      priceCents: 67_000n,
      source: "Vogel Vault",
      fetchedAt: "2026-07-30T14:00:00.000Z",
      status: "stale",
      lastAttemptedAt: expect.any(String),
      errorCode: "http_error",
    });
    expect(snapshot.quotes[2]).toMatchObject({
      symbol: "IBIT",
      priceCents: 3_670n,
      status: "live",
    });
  });

  it("refuses invalid internal observations", async () => {
    await expect(
      t.mutation(internalApi.recordMarketQuoteSuccess, {
        symbol: "BTC",
        priceCents: 0n,
        source: "Vogel Vault",
        fetchedAt: FIXED_TIME,
      }),
    ).rejects.toThrow(/positive/);
    await expect(
      t.mutation(internalApi.recordMarketQuoteSuccess, {
        symbol: "BTC",
        priceCents: 1n,
        source: " ",
        fetchedAt: FIXED_TIME,
      }),
    ).rejects.toThrow(/source/);
  });

  it("stores only canonical UTC success timestamps", async () => {
    await expect(
      t.mutation(internalApi.recordMarketQuoteSuccess, {
        symbol: "BTC",
        priceCents: 1n,
        source: "Vogel Vault",
        fetchedAt: "2026-07-30T15:00:00Z",
      }),
    ).resolves.toBe("live");

    for (const fetchedAt of [
      "2026-07-30T10:00:00-05:00",
      "2026-07-30T15:00:00.0Z",
      "2026-07-30T15:00:00.0000Z",
      "2026-02-30T15:00:00Z",
    ]) {
      await expect(
        t.mutation(internalApi.recordMarketQuoteSuccess, {
          symbol: "BTC",
          priceCents: 1n,
          source: "Vogel Vault",
          fetchedAt,
        }),
        fetchedAt,
      ).rejects.toThrow(/canonical UTC/);
    }
  });

  it("does not emit a noncanonical cached success as a usable quote", async () => {
    const token = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: token });
    await t.run(async (ctx) => {
      await ctx.db.insert("marketQuoteCache", {
        symbol: "BTC",
        priceCents: 6_485_500n,
        source: "Vogel Vault",
        fetchedAt: "2026-07-30T10:00:00-05:00",
        status: "live",
        lastAttemptedAt: FIXED_TIME,
      });
    });

    const snapshot = await t.query(api.getMarketQuoteSnapshot, { token });
    expect(snapshot.quotes[0]).toMatchObject({
      symbol: "BTC",
      priceCents: null,
      fetchedAt: null,
      status: "unavailable",
    });
  });
});
