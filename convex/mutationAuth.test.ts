// SAT-1326 regression suite: every write is fail-closed on the sync token.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  api,
  freshProofHash,
  freshSecret,
  readDataFile,
  seedDataFile,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

useIsolatedDeploymentEnv();

type T = ReturnType<typeof testConvex>;

// Keep the shared sync gate covered through the surviving admin delete route.
const TOKEN_GUARDED_MUTATIONS = [
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
        /write auth is not configured/,
      );
    });

    it(`${mutation.name} rejects a guessed token`, async () => {
      await expect(mutation.call(t, freshSecret())).rejects.toThrow(
        /write auth is not configured/,
      );
    });
  }

  it("a rejected delete preserves the existing data", async () => {
    const data = { categories: [] };
    await seedDataFile(t, "budget", data);
    await expect(
      t.mutation(api.remove, { name: "budget" }),
    ).rejects.toThrow();
    await expect(readDataFile(t, "budget")).resolves.toMatchObject({ data });
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

  it("a rejected delete preserves the existing data", async () => {
    const data = { categories: [] };
    await seedDataFile(t, "budget", data);
    await expect(
      t.mutation(api.remove, {
        name: "budget",
        token: freshSecret(),
      }),
    ).rejects.toThrow();
    await expect(readDataFile(t, "budget")).resolves.toMatchObject({ data });
  });
});

describe("mutation auth: ALLOW_TOKENLESS_SYNC cutover hatch", () => {
  it("permits tokenless writes while the hatch is on", async () => {
    setDeploymentEnv({ ALLOW_TOKENLESS_SYNC: "true" });
    await expect(
      t.mutation(api.remove, { name: "budget" }),
    ).resolves.toBeNull();
  });

  it("only the exact string \"true\" opens the hatch", async () => {
    for (const value of ["TRUE", "1", "yes", "false"]) {
      setDeploymentEnv({ ALLOW_TOKENLESS_SYNC: value });
      await expect(
        t.mutation(api.remove, { name: "budget" }),
      ).rejects.toThrow(/write auth is not configured/);
    }
  });

  // Same precedence as the read hatch, for the same reason — see the banner in
  // dataFiles.ts and readAuth.test.ts. Kept identical on purpose: two gates
  // that behave differently under the same-shaped env vars is how a cutover
  // operator gets surprised at the worst moment.
  describe("the hatch outranks a configured CONVEX_SYNC_TOKEN", () => {
    beforeEach(() => {
      setDeploymentEnv({
        CONVEX_SYNC_TOKEN: freshSecret(),
        ALLOW_TOKENLESS_SYNC: "true",
      });
    });

    for (const mutation of TOKEN_GUARDED_MUTATIONS) {
      it(`${mutation.name} admits a tokenless writer`, async () => {
        await expect(mutation.call(t)).resolves.not.toThrow();
      });

      it(`${mutation.name} admits a writer sending the wrong token`, async () => {
        await expect(mutation.call(t, freshSecret())).resolves.not.toThrow();
      });
    }
  });

  it("setting CONVEX_SYNC_TOKEN is inert until the hatch comes off", async () => {
    const syncToken = freshSecret();
    setDeploymentEnv({
      CONVEX_SYNC_TOKEN: syncToken,
      ALLOW_TOKENLESS_SYNC: "true",
    });
    await expect(
      t.mutation(api.remove, { name: "budget" }),
    ).resolves.toBeNull();

    delete process.env.ALLOW_TOKENLESS_SYNC;
    await expect(
      t.mutation(api.remove, { name: "budget" }),
    ).rejects.toThrow(/invalid sync token/);
    await expect(
      t.mutation(api.remove, {
        name: "budget",
        token: syncToken,
      }),
    ).resolves.toBeNull();
  });

  // ⚠️ A set token is not evidence of enforcement. Say so in the log.
  it("logs loudly that a set token is being ignored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setDeploymentEnv({
        CONVEX_SYNC_TOKEN: freshSecret(),
        ALLOW_TOKENLESS_SYNC: "true",
      });
      await t.mutation(api.remove, { name: "budget" });

      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toMatch(/PERMISSIVE/);
      expect(logged).toMatch(/CONVEX_SYNC_TOKEN is set but IGNORED/);
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing when the gate is actually enforcing", async () => {
    const syncToken = freshSecret();
    setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await t.mutation(api.remove, {
        name: "budget",
        token: syncToken,
      });
      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).not.toMatch(/PERMISSIVE/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("mutation auth: createMobilePairing is deliberately stricter", () => {
  it("rejects when no sync token is configured, hatch or not", async () => {
    setDeploymentEnv({ ALLOW_TOKENLESS_SYNC: "true" });
    await expect(
      t.mutation(api.createMobilePairing, {
        pairId: "pair-1",
        proofHash: freshProofHash(),
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/CONVEX_SYNC_TOKEN is required for mobile pairing/);
  });

  it("rejects an incorrect token", async () => {
    setDeploymentEnv({ CONVEX_SYNC_TOKEN: freshSecret() });
    await expect(
      t.mutation(api.createMobilePairing, {
        pairId: "pair-1",
        proofHash: freshProofHash(),
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
        proofHash: freshProofHash(),
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
        proofHash: freshProofHash(),
        expiresAt: Date.now() + 60_000,
        token: syncToken,
      }),
    ).rejects.toThrow(/pairId is malformed/);
  });

  it("caps pairing lifetime to the bounded mint policy", async () => {
    const syncToken = freshSecret();
    setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
    await expect(
      t.mutation(api.createMobilePairing, {
        pairId: "pair-too-long",
        proofHash: freshProofHash(),
        expiresAt: Date.now() + 367 * 24 * 60 * 60 * 1000,
        token: syncToken,
      }),
    ).rejects.toThrow(/within 366 days/);
  });
});
