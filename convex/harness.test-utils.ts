// Shared harness for the convex/ test suite.
//
// Named with two dots so the Convex bundler skips it (see
// generatedServer.test-stub.ts for why that matters).
import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { afterEach, beforeEach } from "vitest";

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
  "./dataFiles.ts": () => import("./dataFiles"),
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
  listTodoTombstones: "dataFiles:listTodoTombstones" as unknown as FunctionReference<
    "query",
    "public",
    { token?: string },
    { id: string; deletedAt: number }[]
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
  appendTransaction: "dataFiles:appendTransaction" as unknown as FunctionReference<
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
  createMobilePairing: "dataFiles:createMobilePairing" as unknown as FunctionReference<
    "mutation",
    "public",
    {
      pairId: string;
      proofHash: string;
      expiresAt: number;
      createdBy?: string;
      token?: string;
    },
    { pairId: string; expiresAt: number }
  >,
  claimMobilePairing: "dataFiles:claimMobilePairing" as unknown as FunctionReference<
    "mutation",
    "public",
    {
      pairId: string;
      proofHash: string;
      deviceName: string;
      deviceId: string;
      deviceToken: string;
    },
    { ok: boolean; deviceId: string; pairedAt: number }
  >,
  upsertTodoFromMobile: "dataFiles:upsertTodoFromMobile" as unknown as FunctionReference<
    "mutation",
    "public",
    { deviceId: string; deviceToken: string; todo: TodoPayload },
    { ok: boolean; name: string; version: number; id: string; applied: boolean }
  >,
  completeTodoFromMobile: "dataFiles:completeTodoFromMobile" as unknown as FunctionReference<
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
  removeTodoFromMobile: "dataFiles:removeTodoFromMobile" as unknown as FunctionReference<
    "mutation",
    "public",
    { deviceId: string; deviceToken: string; id: string },
    { ok: boolean; name: string; version: number; removed: boolean }
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
) {
  const pairId = `pair-${crypto.randomUUID()}`;
  const proofHash = freshSecret();
  const deviceToken = freshSecret();

  await t.mutation(api.createMobilePairing, {
    pairId,
    proofHash,
    expiresAt: Date.now() + 60_000,
    token: syncToken,
  });
  await t.mutation(api.claimMobilePairing, {
    pairId,
    proofHash,
    deviceName: "Test iPhone",
    deviceId,
    deviceToken,
  });

  return { deviceId, deviceToken, pairId };
}
