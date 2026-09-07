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
      capabilities?: Array<"todos:write">;
      profile?: "victor" | "rachel" | "mason" | "maddox";
      token?: string;
    },
    { pairId: string; expiresAt: number }
  >;

const claimAndroidReadBootstrap =
  "dataFiles:claimAndroidReadBootstrap" as unknown as FunctionReference<
    "mutation",
    "public",
    {
      pairId: string;
      proof: string;
      deviceId?: string;
      deviceToken?: string;
    },
    {
      ok: true;
      readToken: string;
      pairedAt: number;
      deviceId?: string;
      capabilities: Array<"todos:write">;
      profile?: "victor" | "rachel" | "mason" | "maddox";
    }
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
  capabilities?: Array<"todos:write">,
  profile: "victor" | "rachel" | "mason" | "maddox" | undefined =
    capabilities?.length === 1 ? "victor" : undefined,
) {
  await t.mutation(createAndroidReadBootstrap, {
    pairId,
    proofHash: proofHash(proof),
    expiresAt,
    capabilities,
    profile,
    token: syncToken,
  });
  return { pairId, proof };
}

async function storedDevice(deviceId: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("mobileDevices")
      .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
      .unique(),
  );
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

  it("defaults to read-only and preserves explicit legacy todo-only grants", async () => {
    const readOnly = await createBootstrap();
    expect((await storedBootstrap(readOnly.pairId))!.capabilities).toBeUndefined();

    const todoWrite = await createBootstrap(
      newPairId(),
      newProof(),
      Date.now() + 60_000,
      ["todos:write"],
    );
    expect((await storedBootstrap(todoWrite.pairId))!.capabilities).toEqual([
      "todos:write",
    ]);

    for (const capabilities of [
      [],
      ["todos:write", "todos:write"],
      ["transactions:write"],
      ["todos:write", "bitcoin:write"],
    ]) {
      const pairId = newPairId();
      await expect(
        t.mutation(createAndroidReadBootstrap, {
          pairId,
          proofHash: freshProofHash(),
          expiresAt: Date.now() + 60_000,
          capabilities,
          token: syncToken,
        } as never),
      ).rejects.toThrow(/VALIDATION_FAILED/);
      await expect(storedBootstrap(pairId)).resolves.toBeNull();
    }
  });

  it("rejects a todo-write bootstrap without a bound profile and inserts nothing", async () => {
    const pairId = newPairId();
    await expect(
      t.mutation(createAndroidReadBootstrap, {
        pairId,
        proofHash: freshProofHash(),
        expiresAt: Date.now() + 60_000,
        capabilities: ["todos:write"],
        token: syncToken,
      }),
    ).rejects.toThrow(/VALIDATION_FAILED/);
    await expect(storedBootstrap(pairId)).resolves.toBeNull();
  });

  it("keeps read-only legacy bootstraps unbound", async () => {
    const pairId = newPairId();
    await expect(
      t.mutation(createAndroidReadBootstrap, {
        pairId,
        proofHash: freshProofHash(),
        expiresAt: Date.now() + 60_000,
        profile: "victor",
        token: syncToken,
      }),
    ).rejects.toThrow(/VALIDATION_FAILED/);
    await expect(storedBootstrap(pairId)).resolves.toBeNull();
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
    expect(Object.keys(result).sort()).toEqual([
      "capabilities",
      "ok",
      "pairedAt",
      "readToken",
    ]);
    expect(result).toEqual({
      ok: true,
      readToken,
      pairedAt: result.pairedAt,
      capabilities: [],
    });
    expect((await storedBootstrap(pairId))!.claimedAt).toBe(result.pairedAt);
  });

  it("atomically registers an exact todo-write device while returning the read credential", async () => {
    const readToken = freshSecret();
    const deviceId = "android-combined-device";
    const deviceToken = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: readToken });
    const { pairId, proof } = await createBootstrap(
      newPairId(),
      newProof(),
      Date.now() + 60_000,
      ["todos:write"],
    );

    const result = await t.mutation(claimAndroidReadBootstrap, {
      pairId,
      proof,
      deviceId,
      deviceToken,
    });

    expect(Object.keys(result).sort()).toEqual([
      "capabilities",
      "deviceId",
      "ok",
      "pairedAt",
      "profile",
      "readToken",
    ]);
    expect(result).toEqual({
      ok: true,
      readToken,
      pairedAt: result.pairedAt,
      deviceId,
      capabilities: ["todos:write"],
      profile: "victor",
    });
    expect((await storedBootstrap(pairId))!.claimedAt).toBe(result.pairedAt);
    const device = await storedDevice(deviceId);
    expect(device).toMatchObject({
      deviceId,
      pairId,
      pairedAt: result.pairedAt,
      lastSeenAt: result.pairedAt,
      capabilities: ["todos:write"],
      profile: "victor",
    });
    expect(device!.tokenHash).toBe(proofHash(deviceToken));
    expect(JSON.stringify(device)).not.toContain(deviceToken);
  });

  it("requires write credentials only for explicitly write-enabled bootstraps", async () => {
    setDeploymentEnv({ CONVEX_READ_TOKEN: freshSecret() });
    const readOnly = await createBootstrap();
    const todoWrite = await createBootstrap(
      newPairId(),
      newProof(),
      Date.now() + 60_000,
      ["todos:write"],
    );
    const deviceId = "android-purpose-device";
    const deviceToken = freshSecret();

    await expect(
      t.mutation(claimAndroidReadBootstrap, {
        ...readOnly,
        deviceId,
        deviceToken,
      }),
    ).rejects.toThrow(/VALIDATION_FAILED/);
    await expect(
      t.mutation(claimAndroidReadBootstrap, todoWrite),
    ).rejects.toThrow(/VALIDATION_FAILED/);

    expect((await storedBootstrap(readOnly.pairId))!.claimedAt).toBeUndefined();
    expect((await storedBootstrap(todoWrite.pairId))!.claimedAt).toBeUndefined();
    await expect(storedDevice(deviceId)).resolves.toBeNull();
  });

  it("rejects noncanonical stored capability state before claiming", async () => {
    setDeploymentEnv({ CONVEX_READ_TOKEN: freshSecret() });
    const bootstrap = await createBootstrap();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("androidReadBootstraps")
        .withIndex("by_pair_id", (q) => q.eq("pairId", bootstrap.pairId))
        .unique();
      await ctx.db.patch(row!._id, {
        capabilities: ["transactions:write"],
      });
    });

    await expect(
      t.mutation(claimAndroidReadBootstrap, bootstrap),
    ).rejects.toThrow(/VALIDATION_FAILED/);
    expect((await storedBootstrap(bootstrap.pairId))!.claimedAt).toBeUndefined();
  });

  it("rejects malformed or partial device credentials without consuming the grant", async () => {
    setDeploymentEnv({ CONVEX_READ_TOKEN: freshSecret() });
    const invalidCredentials = [
      { deviceId: "android-device" },
      { deviceToken: freshSecret() },
      { deviceId: "", deviceToken: freshSecret() },
      { deviceId: "contains space", deviceToken: freshSecret() },
      { deviceId: "android-device", deviceToken: "too-short" },
      { deviceId: "android-device", deviceToken: `${"a".repeat(32)}!` },
    ];

    for (const credential of invalidCredentials) {
      const bootstrap = await createBootstrap(
        newPairId(),
        newProof(),
        Date.now() + 60_000,
        ["todos:write"],
      );
      await expect(
        t.mutation(claimAndroidReadBootstrap, {
          ...bootstrap,
          ...credential,
        }),
      ).rejects.toThrow(/VALIDATION_FAILED/);
      expect(
        (await storedBootstrap(bootstrap.pairId))!.claimedAt,
      ).toBeUndefined();
    }
    expect(
      await t.run(async (ctx) => ctx.db.query("mobileDevices").collect()),
    ).toEqual([]);
  });

  it("leaves a write bootstrap unclaimed when the read token shape is unusable", async () => {
    const deviceId = "android-config-device";
    for (const readToken of [undefined, " ".repeat(32), "a".repeat(31)]) {
      if (readToken === undefined) delete process.env.CONVEX_READ_TOKEN;
      else setDeploymentEnv({ CONVEX_READ_TOKEN: readToken });
      const bootstrap = await createBootstrap(
        newPairId(),
        newProof(),
        Date.now() + 60_000,
        ["todos:write"],
      );
      await expect(
        t.mutation(claimAndroidReadBootstrap, {
          ...bootstrap,
          deviceId,
          deviceToken: freshSecret(),
        }),
      ).rejects.toThrow(/CONFIG_MISSING/);
      expect(
        (await storedBootstrap(bootstrap.pairId))!.claimedAt,
      ).toBeUndefined();
      await expect(storedDevice(deviceId)).resolves.toBeNull();
    }
  });

  it("rejects a device id conflict atomically and permits retry with a fresh id", async () => {
    const readToken = freshSecret();
    const conflictingId = "android-existing-device";
    setDeploymentEnv({ CONVEX_READ_TOKEN: readToken });
    await t.run(async (ctx) => {
      await ctx.db.insert("mobileDevices", {
        deviceId: conflictingId,
        name: "Existing device",
        tokenHash: proofHash(freshSecret()),
        pairedAt: 1,
        lastSeenAt: 1,
        pairId: "existing-pair",
        capabilities: ["todos:write"],
      });
    });
    const bootstrap = await createBootstrap(
      newPairId(),
      newProof(),
      Date.now() + 60_000,
      ["todos:write"],
    );

    await expect(
      t.mutation(claimAndroidReadBootstrap, {
        ...bootstrap,
        deviceId: conflictingId,
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/DEVICE_ID_CONFLICT/);
    expect((await storedBootstrap(bootstrap.pairId))!.claimedAt).toBeUndefined();

    const freshDeviceId = "android-retry-device";
    await expect(
      t.mutation(claimAndroidReadBootstrap, {
        ...bootstrap,
        deviceId: freshDeviceId,
        deviceToken: freshSecret(),
      }),
    ).resolves.toMatchObject({ deviceId: freshDeviceId });
    await expect(storedDevice(freshDeviceId)).resolves.not.toBeNull();
  });

  it("cannot create a second device by replaying a claimed write bootstrap", async () => {
    setDeploymentEnv({ CONVEX_READ_TOKEN: freshSecret() });
    const bootstrap = await createBootstrap(
      newPairId(),
      newProof(),
      Date.now() + 60_000,
      ["todos:write"],
    );
    await t.mutation(claimAndroidReadBootstrap, {
      ...bootstrap,
      deviceId: "android-first-device",
      deviceToken: freshSecret(),
    });
    await expect(
      t.mutation(claimAndroidReadBootstrap, {
        ...bootstrap,
        deviceId: "android-second-device",
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/ANDROID_READ_BOOTSTRAP_ALREADY_CLAIMED/);
    const devices = await t.run(async (ctx) =>
      ctx.db.query("mobileDevices").collect(),
    );
    expect(devices.map((device) => device.deviceId)).toEqual([
      "android-first-device",
    ]);
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
        capabilities: Array<"todos:write">;
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
