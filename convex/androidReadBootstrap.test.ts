import { createHash, randomBytes } from "node:crypto";

import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  api,
  freshProofHash,
  freshSecret,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

useIsolatedDeploymentEnv();

type T = ReturnType<typeof testConvex>;

const createAndroidReadBootstrap =
  "dataFiles:createAndroidReadBootstrap" as unknown as FunctionReference<
    "mutation",
    "public",
    {
      pairId: string;
      proofHash: string;
      expiresAt: number;
      token?: string;
    },
    { pairId: string; expiresAt: number }
  >;

const claimAndroidReadBootstrap =
  "dataFiles:claimAndroidReadBootstrap" as unknown as FunctionReference<
    "mutation",
    "public",
    { pairId: string; proof: string },
    { ok: true; readToken: string; pairedAt: number }
  >;

function newPairId(): string {
  return `android-read-${randomBytes(18).toString("base64url")}`;
}

function newProof(): string {
  return randomBytes(32).toString("base64url");
}

function proofHash(proof: string): string {
  return createHash("sha256").update(proof, "utf8").digest("hex");
}

let t: T;
let syncToken: string;

beforeEach(() => {
  t = testConvex();
  syncToken = freshSecret();
  setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
});

async function createBootstrap(
  pairId = newPairId(),
  proof = newProof(),
  expiresAt = Date.now() + 60_000,
) {
  await t.mutation(createAndroidReadBootstrap, {
    pairId,
    proofHash: proofHash(proof),
    expiresAt,
    token: syncToken,
  });
  return { pairId, proof };
}

async function storedBootstrap(pairId: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("androidReadBootstraps")
      .withIndex("by_pair_id", (q) => q.eq("pairId", pairId))
      .unique(),
  );
}

describe("createAndroidReadBootstrap", () => {
  it("is hatch-free and requires the configured sync token", async () => {
    delete process.env.CONVEX_SYNC_TOKEN;
    setDeploymentEnv({ ALLOW_TOKENLESS_SYNC: "true" });
    await expect(
      t.mutation(createAndroidReadBootstrap, {
        pairId: newPairId(),
        proofHash: freshProofHash(),
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/CONFIG_MISSING/);
  });

  it("rejects missing, wrong, blank, and malformed sync credentials", async () => {
    const base = {
      pairId: newPairId(),
      proofHash: freshProofHash(),
      expiresAt: Date.now() + 60_000,
    };
    for (const token of [undefined, freshSecret(), "", "too-short"] as const) {
      await expect(
        t.mutation(createAndroidReadBootstrap, { ...base, token }),
      ).rejects.toThrow(
        token !== undefined && token.length < 16
          ? /VALIDATION_FAILED/
          : /DEVICE_UNAUTHORIZED/,
      );
    }
    await expect(storedBootstrap(base.pairId)).resolves.toBeNull();
  });

  it("accepts only the dedicated pair id and lowercase SHA-256 shapes", async () => {
    const expiresAt = Date.now() + 60_000;
    for (const pairId of [
      "pair-generic-purpose",
      "android-read-too_short",
      `android-read-${"a".repeat(65)}`,
      "android-read-contains.dot1234",
    ]) {
      await expect(
        t.mutation(createAndroidReadBootstrap, {
          pairId,
          proofHash: freshProofHash(),
          expiresAt,
          token: syncToken,
        }),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    }

    for (const hash of ["a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
      await expect(
        t.mutation(createAndroidReadBootstrap, {
          pairId: newPairId(),
          proofHash: hash,
          expiresAt,
          token: syncToken,
        }),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    }
  });

  it("requires a future expiry no more than 30 minutes away", async () => {
    for (const expiresAt of [
      Date.now() - 1,
      Date.now(),
      Date.now() + 30 * 60 * 1000 + 1_000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      await expect(
        t.mutation(createAndroidReadBootstrap, {
          pairId: newPairId(),
          proofHash: freshProofHash(),
          expiresAt,
          token: syncToken,
        }),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    }

    const pairId = newPairId();
    const expiresAt = Date.now() + 30 * 60 * 1000 - 1_000;
    await expect(
      t.mutation(createAndroidReadBootstrap, {
        pairId,
        proofHash: freshProofHash(),
        expiresAt,
        token: syncToken,
      }),
    ).resolves.toEqual({ pairId, expiresAt });
  });

  it("refuses duplicate ids without replacing the verifier or expiry", async () => {
    const { pairId } = await createBootstrap();
    const original = await storedBootstrap(pairId);
    await expect(
      t.mutation(createAndroidReadBootstrap, {
        pairId,
        proofHash: freshProofHash(),
        expiresAt: Date.now() + 120_000,
        token: syncToken,
      }),
    ).rejects.toThrow(/PAIRING_ID_CONFLICT/);
    expect(await storedBootstrap(pairId)).toEqual(original);
  });

  it("rejects extra arguments at the Convex boundary", async () => {
    await expect(
      t.mutation(createAndroidReadBootstrap, {
        pairId: newPairId(),
        proofHash: freshProofHash(),
        expiresAt: Date.now() + 60_000,
        token: syncToken,
        purpose: "mobile-write",
      } as never),
    ).rejects.toThrow();
  });
});

describe("claimAndroidReadBootstrap", () => {
  it("returns the current read credential once and marks the bootstrap claimed", async () => {
    const readToken = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: readToken });
    const { pairId, proof } = await createBootstrap();

    const result = await t.mutation(claimAndroidReadBootstrap, {
      pairId,
      proof,
    });
    expect(Object.keys(result).sort()).toEqual(["ok", "pairedAt", "readToken"]);
    expect(result).toEqual({ ok: true, readToken, pairedAt: result.pairedAt });
    expect((await storedBootstrap(pairId))!.claimedAt).toBe(result.pairedAt);
  });

  it("requires the canonical raw 256-bit proof shape", async () => {
    setDeploymentEnv({ CONVEX_READ_TOKEN: freshSecret() });
    const { pairId } = await createBootstrap();
    for (const proof of [
      "a".repeat(42),
      "a".repeat(44),
      `${"a".repeat(42)}B`,
      `${"a".repeat(42)}=`,
      `${"a".repeat(42)}.`,
    ]) {
      await expect(
        t.mutation(claimAndroidReadBootstrap, { pairId, proof }),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    }
    expect((await storedBootstrap(pairId))!.claimedAt).toBeUndefined();
  });

  it("does not accept the stored SHA-256 verifier as the raw proof", async () => {
    setDeploymentEnv({ CONVEX_READ_TOKEN: freshSecret() });
    const { pairId, proof } = await createBootstrap();
    await expect(
      t.mutation(claimAndroidReadBootstrap, {
        pairId,
        proof: proofHash(proof),
      }),
    ).rejects.toThrow(/VALIDATION_FAILED/);
    expect((await storedBootstrap(pairId))!.claimedAt).toBeUndefined();
  });

  it("leaves a valid bootstrap unclaimed when the read credential is missing or blank", async () => {
    for (const readToken of [undefined, "   "] as const) {
      if (readToken === undefined) delete process.env.CONVEX_READ_TOKEN;
      else setDeploymentEnv({ CONVEX_READ_TOKEN: readToken });
      const { pairId, proof } = await createBootstrap();
      await expect(
        t.mutation(claimAndroidReadBootstrap, { pairId, proof }),
      ).rejects.toThrow(/CONFIG_MISSING/);
      expect((await storedBootstrap(pairId))!.claimedAt).toBeUndefined();
    }
  });

  it("uses stable structured failures for unknown, expired, wrong, and replayed claims", async () => {
    setDeploymentEnv({ CONVEX_READ_TOKEN: freshSecret() });
    await expect(
      t.mutation(claimAndroidReadBootstrap, {
        pairId: newPairId(),
        proof: newProof(),
      }),
    ).rejects.toThrow(/ANDROID_READ_BOOTSTRAP_NOT_FOUND/);

    const expired = await createBootstrap();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("androidReadBootstraps")
        .withIndex("by_pair_id", (q) => q.eq("pairId", expired.pairId))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    await expect(
      t.mutation(claimAndroidReadBootstrap, expired),
    ).rejects.toThrow(/ANDROID_READ_BOOTSTRAP_EXPIRED/);

    const wrong = await createBootstrap();
    await expect(
      t.mutation(claimAndroidReadBootstrap, {
        pairId: wrong.pairId,
        proof: newProof(),
      }),
    ).rejects.toThrow(/ANDROID_READ_BOOTSTRAP_PROOF_INVALID/);
    expect((await storedBootstrap(wrong.pairId))!.claimedAt).toBeUndefined();

    const replay = await createBootstrap();
    await t.mutation(claimAndroidReadBootstrap, replay);
    await expect(t.mutation(claimAndroidReadBootstrap, replay)).rejects.toThrow(
      /ANDROID_READ_BOOTSTRAP_ALREADY_CLAIMED/,
    );
  });

  it("allows exactly one success when two claims race", async () => {
    const readToken = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: readToken });
    const bootstrap = await createBootstrap();

    const results = await Promise.allSettled([
      t.mutation(claimAndroidReadBootstrap, bootstrap),
      t.mutation(claimAndroidReadBootstrap, bootstrap),
    ]);
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<{
        ok: true;
        readToken: string;
        pairedAt: number;
      }> => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value).toMatchObject({ ok: true, readToken });
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toMatch(
      /ANDROID_READ_BOOTSTRAP_ALREADY_CLAIMED/,
    );
  });

  it("is purpose-isolated from legacy mobile pairing in both directions", async () => {
    setDeploymentEnv({ CONVEX_READ_TOKEN: freshSecret() });
    const android = await createBootstrap();
    await expect(
      t.mutation(api.claimMobilePairing, {
        pairId: android.pairId,
        proofHash: proofHash(android.proof),
        deviceName: "Wrong protocol",
        deviceId: "wrong-protocol-device",
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/PAIRING_NOT_FOUND/);

    const mobilePairId = `pair-${randomBytes(18).toString("base64url")}`;
    const mobileProof = newProof();
    await t.mutation(api.createMobilePairing, {
      pairId: mobilePairId,
      proofHash: proofHash(mobileProof),
      expiresAt: Date.now() + 60_000,
      token: syncToken,
    });
    await expect(
      t.mutation(claimAndroidReadBootstrap, {
        pairId: `android-read-${mobilePairId.slice(5)}`,
        proof: mobileProof,
      }),
    ).rejects.toThrow(/ANDROID_READ_BOOTSTRAP_NOT_FOUND/);
  });

  it("persists and reports no sync token, read token, or raw proof", async () => {
    const readToken = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: readToken });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { pairId, proof } = await createBootstrap();
      const wrongProof = newProof();
      let rejection = "";
      try {
        await t.mutation(claimAndroidReadBootstrap, {
          pairId,
          proof: wrongProof,
        });
      } catch (caught) {
        rejection = String(caught);
      }
      expect(rejection).not.toContain(readToken);
      expect(rejection).not.toContain(syncToken);
      expect(rejection).not.toContain(proof);
      expect(rejection).not.toContain(wrongProof);

      await t.mutation(claimAndroidReadBootstrap, { pairId, proof });
      const rows = await t.run(async (ctx) =>
        ctx.db.query("androidReadBootstraps").collect(),
      );
      const persisted = JSON.stringify(rows);
      expect(persisted).not.toContain(readToken);
      expect(persisted).not.toContain(syncToken);
      expect(persisted).not.toContain(proof);
      expect(persisted).toContain(proofHash(proof));

      const logged = [
        ...log.mock.calls,
        ...warn.mock.calls,
        ...error.mock.calls,
      ]
        .flat()
        .map(String)
        .join("\n");
      expect(logged).not.toContain(readToken);
      expect(logged).not.toContain(syncToken);
      expect(logged).not.toContain(proof);
      expect(logged).not.toContain(wrongProof);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("rejects extra claim arguments and never consumes the bootstrap", async () => {
    setDeploymentEnv({ CONVEX_READ_TOKEN: freshSecret() });
    const bootstrap = await createBootstrap();
    await expect(
      t.mutation(claimAndroidReadBootstrap, {
        ...bootstrap,
        proofHash: proofHash(bootstrap.proof),
      } as never),
    ).rejects.toThrow();
    expect(
      (await storedBootstrap(bootstrap.pairId))!.claimedAt,
    ).toBeUndefined();
  });
});
