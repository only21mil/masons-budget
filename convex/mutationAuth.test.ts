// SAT-1326 regression suite: every write is fail-closed on the sync token.
import { beforeEach, describe, expect, it } from "vitest";

import {
  api,
  freshSecret,
  readDataFile,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

useIsolatedDeploymentEnv();

type T = ReturnType<typeof testConvex>;

/**
 * Every mutation guarded by validateSyncToken. Amounts are whole units on
 * purpose: the Convex layer stores the payload verbatim and does no arithmetic,
 * so no test here should imply that float money is acceptable anywhere.
 */
const TOKEN_GUARDED_MUTATIONS = [
  {
    name: "sync",
    call: (t: T, token?: string) =>
      t.mutation(api.sync, { name: "budget", data: { categories: [] }, token }),
  },
  {
    name: "syncBatch",
    call: (t: T, token?: string) =>
      t.mutation(api.syncBatch, {
        files: [{ name: "budget", data: { categories: [] } }],
        token,
      }),
  },
  {
    name: "appendTransaction",
    call: (t: T, token?: string) =>
      t.mutation(api.appendTransaction, {
        transaction: {
          id: "txn-1",
          date: "2026-07-26",
          merchant: "Test Merchant",
          amount: 12,
          category: "Groceries",
        },
        token,
      }),
  },
  {
    name: "upsertTodo",
    call: (t: T, token?: string) =>
      t.mutation(api.upsertTodo, { todo: { id: "todo-1", title: "x" }, token }),
  },
  {
    name: "removeTodo",
    call: (t: T, token?: string) =>
      t.mutation(api.removeTodo, { todoId: "todo-1", token }),
  },
  {
    name: "remove",
    call: (t: T, token?: string) =>
      t.mutation(api.remove, { name: "budget", token }),
  },
] as const;

let t: T;

beforeEach(() => {
  t = testConvex();
});

describe("mutation auth: nothing configured (fail-closed default)", () => {
  for (const mutation of TOKEN_GUARDED_MUTATIONS) {
    it(`${mutation.name} rejects without a token`, async () => {
      await expect(mutation.call(t)).rejects.toThrow(
        /CONVEX_SYNC_TOKEN is not configured/,
      );
    });

    it(`${mutation.name} rejects a guessed token`, async () => {
      await expect(mutation.call(t, freshSecret())).rejects.toThrow(
        /CONVEX_SYNC_TOKEN is not configured/,
      );
    });
  }

  it("a rejected write leaves no trace in the database", async () => {
    await expect(
      t.mutation(api.sync, { name: "budget", data: { categories: [] } }),
    ).rejects.toThrow();
    await expect(readDataFile(t, "budget")).resolves.toBeNull();
  });
});

describe("mutation auth: CONVEX_SYNC_TOKEN configured", () => {
  let syncToken: string;

  beforeEach(() => {
    syncToken = freshSecret();
    setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
  });

  for (const mutation of TOKEN_GUARDED_MUTATIONS) {
    it(`${mutation.name} rejects a missing token`, async () => {
      await expect(mutation.call(t)).rejects.toThrow(/invalid sync token/);
    });

    it(`${mutation.name} rejects an incorrect token`, async () => {
      await expect(mutation.call(t, freshSecret())).rejects.toThrow(
        /invalid sync token/,
      );
    });

    it(`${mutation.name} rejects an empty-string token`, async () => {
      await expect(mutation.call(t, "")).rejects.toThrow(/invalid sync token/);
    });

    it(`${mutation.name} accepts the correct token`, async () => {
      await expect(mutation.call(t, syncToken)).resolves.not.toThrow();
    });
  }

  it("a rejected write leaves no trace in the database", async () => {
    await expect(
      t.mutation(api.sync, {
        name: "budget",
        data: { categories: [] },
        token: freshSecret(),
      }),
    ).rejects.toThrow();
    await expect(readDataFile(t, "budget")).resolves.toBeNull();
  });
});

describe("mutation auth: ALLOW_TOKENLESS_SYNC cutover hatch", () => {
  it("permits tokenless writes while the hatch is on", async () => {
    setDeploymentEnv({ ALLOW_TOKENLESS_SYNC: "true" });
    await expect(
      t.mutation(api.sync, { name: "budget", data: { categories: [] } }),
    ).resolves.toEqual({ name: "budget", version: 1 });
  });

  it("only the exact string \"true\" opens the hatch", async () => {
    for (const value of ["TRUE", "1", "yes", "false"]) {
      setDeploymentEnv({ ALLOW_TOKENLESS_SYNC: value });
      await expect(
        t.mutation(api.sync, { name: "budget", data: { categories: [] } }),
      ).rejects.toThrow(/CONVEX_SYNC_TOKEN is not configured/);
    }
  });

  // Same precedence hazard as the read hatch — see readAuth.test.ts.
  it("the hatch is ignored once CONVEX_SYNC_TOKEN is set", async () => {
    setDeploymentEnv({
      CONVEX_SYNC_TOKEN: freshSecret(),
      ALLOW_TOKENLESS_SYNC: "true",
    });
    await expect(
      t.mutation(api.sync, { name: "budget", data: { categories: [] } }),
    ).rejects.toThrow(/invalid sync token/);
  });
});

describe("mutation auth: createMobilePairing is deliberately stricter", () => {
  it("rejects when no sync token is configured, hatch or not", async () => {
    setDeploymentEnv({ ALLOW_TOKENLESS_SYNC: "true" });
    await expect(
      t.mutation(api.createMobilePairing, {
        pairId: "pair-1",
        proofHash: freshSecret(),
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/CONVEX_SYNC_TOKEN is required for mobile pairing/);
  });

  it("rejects an incorrect token", async () => {
    setDeploymentEnv({ CONVEX_SYNC_TOKEN: freshSecret() });
    await expect(
      t.mutation(api.createMobilePairing, {
        pairId: "pair-1",
        proofHash: freshSecret(),
        expiresAt: Date.now() + 60_000,
        token: freshSecret(),
      }),
    ).rejects.toThrow(/invalid sync token/);
  });

  it("refuses a pairing that is already expired", async () => {
    const syncToken = freshSecret();
    setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
    await expect(
      t.mutation(api.createMobilePairing, {
        pairId: "pair-1",
        proofHash: freshSecret(),
        expiresAt: Date.now() - 1,
        token: syncToken,
      }),
    ).rejects.toThrow(/expiresAt must be in the future/);
  });

  it("refuses blank identifiers", async () => {
    const syncToken = freshSecret();
    setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
    await expect(
      t.mutation(api.createMobilePairing, {
        pairId: "   ",
        proofHash: freshSecret(),
        expiresAt: Date.now() + 60_000,
        token: syncToken,
      }),
    ).rejects.toThrow(/pairId and proofHash required/);
  });
});
