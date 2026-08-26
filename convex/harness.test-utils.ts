// Shared harness for the convex/ test suite.
//
// Named with two dots so the Convex bundler skips it (see
// generatedServer.test-stub.ts for why that matters).
import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { afterEach, beforeEach } from "vitest";

import type { DeviceCapability, DeviceProfile } from "./deviceAuth";
import schema from "./schema";

/**
 * Explicit module map instead of `import.meta.glob`.
 *
 * convex-test locates the function root by finding a path containing
 * `_generated`, so the stub is registered under the path codegen would have
 * produced. Nothing imports that entry at runtime — the vitest plugin already
 * rewrote the one specifier that needed it.
 */
const modules: Record<string, () => Promise<unknown>> = {
  "./_generated/server.ts": () => import("./generatedServer.test-stub"),
  "./btcLedger.ts": () => import("./btcLedger"),
  "./dataFiles.ts": () => import("./dataFiles"),
  "./dateValidation.ts": () => import("./dateValidation"),
  "./deviceAuth.ts": () => import("./deviceAuth"),
  "./marketQuoteAcquire.ts": () => import("./marketQuoteAcquire"),
  "./marketQuotes.ts": () => import("./marketQuotes"),
  "./readCanary.ts": () => import("./readCanary"),
  "./tables.ts": () => import("./tables"),
  "./todoNormalize.ts": () => import("./todoNormalize"),
};

export function testConvex() {
  return convexTest(schema, modules);
}

export type TestConvexInstance = ReturnType<typeof testConvex>;

// ── Typed function references ──
// `anyApi` is untyped by design; spelling the argument shapes out here keeps the
// tests type-checked against the real signatures without needing codegen.

type TodoPayload = Record<string, unknown>;

export const api = {
  get: "dataFiles:get" as unknown as FunctionReference<
    "query",
    "public",
    { name: string; token?: string },
    unknown
  >,
  getVersions: "dataFiles:getVersions" as unknown as FunctionReference<
    "query",
    "public",
    { token?: string },
    Record<string, number>
  >,
  list: "dataFiles:list" as unknown as FunctionReference<
    "query",
    "public",
    { token?: string },
    { name: string; version: number; updatedAt: number }[]
  >,
  listTodoTombstones:
    "dataFiles:listTodoTombstones" as unknown as FunctionReference<
      "query",
      "public",
      { token?: string },
      { id: string; deletedAt: number }[]
    >,
  getMarketQuoteSnapshot:
    "marketQuotes:getSnapshot" as unknown as FunctionReference<
      "query",
      "public",
      { token?: string },
      {
        quotes: {
          symbol: "BTC" | "VOO" | "IBIT";
          priceCents: bigint | null;
          source: string;
          fetchedAt: string | null;
          status: "live" | "stale" | "unavailable";
          lastAttemptedAt: string | null;
          errorCode:
            | "timeout"
            | "http_error"
            | "invalid_response"
            | "network_error"
            | null;
        }[];
        complete: true;
      }
    >,
  sync: "dataFiles:sync" as unknown as FunctionReference<
    "mutation",
    "public",
    { name: string; data: unknown; token?: string },
    { name: string; version: number }
  >,
  syncBatch: "dataFiles:syncBatch" as unknown as FunctionReference<
    "mutation",
    "public",
    { files: { name: string; data: unknown }[]; token?: string },
    { name: string; version: number }[]
  >,
  appendTransaction:
    "dataFiles:appendTransaction" as unknown as FunctionReference<
      "mutation",
      "public",
      {
        name?: "transactions" | "mason-transactions";
        transaction: {
          id: string;
          date: string;
          merchant: string;
          amount: number;
          category: string;
        };
        token?: string;
      },
      { name: string; version: number; id: string }
    >,
  upsertTodo: "dataFiles:upsertTodo" as unknown as FunctionReference<
    "mutation",
    "public",
    { name?: "todos"; todo: TodoPayload; token?: string },
    { name: string; version: number; id: string; applied: boolean }
  >,
  removeTodo: "dataFiles:removeTodo" as unknown as FunctionReference<
    "mutation",
    "public",
    { todoId: string; token?: string },
    { name: string; version: number; removed: boolean }
  >,
  remove: "dataFiles:remove" as unknown as FunctionReference<
    "mutation",
    "public",
    { name: string; token?: string },
    null
  >,
  createMobilePairing:
    "dataFiles:createMobilePairing" as unknown as FunctionReference<
      "mutation",
      "public",
      {
        pairId: string;
        proofHash: string;
        expiresAt: number;
        createdBy?: string;
        capabilities?: DeviceCapability[];
        profile?: DeviceProfile;
        token?: string;
      },
      { pairId: string; expiresAt: number }
    >,
  claimMobilePairing:
    "dataFiles:claimMobilePairing" as unknown as FunctionReference<
      "mutation",
      "public",
      {
        pairId: string;
        proofHash: string;
        deviceName: string;
        deviceId: string;
        deviceToken: string;
      },
      {
        ok: true;
        deviceId: string;
        pairedAt: number;
        capabilities: DeviceCapability[];
      }
    >,
  upsertTodoFromMobile:
    "dataFiles:upsertTodoFromMobile" as unknown as FunctionReference<
      "mutation",
      "public",
      { deviceId: string; deviceToken: string; todo: TodoPayload },
      {
        ok: boolean;
        name: string;
        version: number;
        id: string;
        applied: boolean;
      }
    >,
  completeTodoFromMobile:
    "dataFiles:completeTodoFromMobile" as unknown as FunctionReference<
      "mutation",
      "public",
      {
        deviceId: string;
        deviceToken: string;
        id: string;
        title?: string;
        done?: boolean;
      },
      {
        ok: boolean;
        id: string;
        done: boolean;
        completedAt: string | null;
        version: number;
        titleMatched: boolean;
      }
    >,
  removeTodoFromMobile:
    "dataFiles:removeTodoFromMobile" as unknown as FunctionReference<
      "mutation",
      "public",
      { deviceId: string; deviceToken: string; id: string },
      { ok: boolean; name: string; version: number; removed: boolean }
    >,
  revokeMobileDevice:
    "dataFiles:revokeMobileDevice" as unknown as FunctionReference<
      "mutation",
      "public",
      { deviceId: string; deviceToken: string },
      { ok: true; revoked: boolean }
    >,
};

export const internalApi = {
  recordMarketQuoteSuccess:
    "marketQuotes:recordSuccess" as unknown as FunctionReference<
      "mutation",
      "internal",
      {
        symbol: "BTC" | "VOO" | "IBIT";
        priceCents: bigint;
        source: string;
        fetchedAt: string;
      },
      "live"
    >,
  recordMarketQuoteFailure:
    "marketQuotes:recordFailure" as unknown as FunctionReference<
      "mutation",
      "internal",
      {
        symbol: "BTC" | "VOO" | "IBIT";
        attemptedAt: string;
        errorCode:
          | "timeout"
          | "http_error"
          | "invalid_response"
          | "network_error";
      },
      "stale" | "unavailable"
    >,
  expireLiveMarketQuote:
    "marketQuotes:expireLiveQuote" as unknown as FunctionReference<
      "mutation",
      "internal",
      { symbol: "BTC" | "VOO" | "IBIT"; fetchedAt: string },
      boolean
    >,
  refreshMarketQuotes: "marketQuotes:refresh" as unknown as FunctionReference<
    "action",
    "internal",
    Record<string, never>,
    {
      quotes: {
        symbol: "BTC" | "VOO" | "IBIT";
        status: "live" | "stale" | "unavailable";
        errorCode:
          | "timeout"
          | "http_error"
          | "invalid_response"
          | "network_error"
          | null;
      }[];
    }
  >,
};

// ── Deployment environment ──

const DEPLOYMENT_ENV_KEYS = [
  "CONVEX_READ_TOKEN",
  "ALLOW_TOKENLESS_READ",
  "CONVEX_SYNC_TOKEN",
  "ALLOW_TOKENLESS_SYNC",
] as const;

type DeploymentEnvKey = (typeof DEPLOYMENT_ENV_KEYS)[number];

/**
 * Clear the four auth env vars before each test and restore the ambient values
 * afterwards, so a developer who happens to have real tokens exported cannot
 * change what these tests assert.
 */
export function useIsolatedDeploymentEnv() {
  let saved: Partial<Record<DeploymentEnvKey, string | undefined>> = {};

  beforeEach(() => {
    saved = {};
    for (const key of DEPLOYMENT_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of DEPLOYMENT_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

export function setDeploymentEnv(
  vars: Partial<Record<DeploymentEnvKey, string>>,
) {
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
}

/**
 * A fresh random secret per test.
 *
 * Deliberately generated rather than written down: no token literal ever lands
 * in this repository, and no test can accidentally match a real deployment
 * value. Never log the result.
 */
export function freshSecret(): string {
  return crypto.randomUUID();
}

export function freshProofHash(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ── Fixtures ──

export async function seedDataFile(
  t: TestConvexInstance,
  name: string,
  data: unknown,
  version = 1,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("dataFiles", {
      name,
      data,
      version,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("syncVersions", {
      name,
      version,
      updatedAt: Date.now(),
    });
  });
}

export async function readDataFile(t: TestConvexInstance, name: string) {
  return await t.run(async (ctx) => {
    const doc = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    return doc ?? null;
  });
}

export async function readTodos(
  t: TestConvexInstance,
  name = "todos",
): Promise<Record<string, unknown>[]> {
  const doc = await readDataFile(t, name);
  const data = doc?.data;
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object" && Array.isArray(data.todos)) {
    return data.todos as Record<string, unknown>[];
  }
  return [];
}

/** Pair a mobile device through the real pairing mutations. */
export async function pairMobileDevice(
  t: TestConvexInstance,
  syncToken: string,
  deviceId = "device-under-test",
  capabilities?: DeviceCapability[],
  profile: DeviceProfile = "victor",
) {
  const pairId = `pair-${crypto.randomUUID()}`;
  const proofHash = freshProofHash();
  const deviceToken = freshSecret();

  const createArgs = {
    pairId,
    proofHash,
    expiresAt: Date.now() + 60_000,
    token: syncToken,
    profile,
    ...(capabilities === undefined ? {} : { capabilities }),
  };
  await t.mutation(api.createMobilePairing, createArgs);
  const claim = await t.mutation(api.claimMobilePairing, {
    pairId,
    proofHash,
    deviceName: "Test iPhone",
    deviceId,
    deviceToken,
  });

  return { deviceId, deviceToken, pairId, capabilities: claim.capabilities };
}
