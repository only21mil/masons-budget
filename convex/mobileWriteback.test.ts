// Mobile pairing, capability grants, and self-revocation.
// Check retained credentials against the device row write route.
import { beforeEach, describe, expect, it } from "vitest";

import {
  api,
  freshProofHash,
  freshSecret,
  pairMobileDevice,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";
import { api as generatedApi } from "./_generated/api";
import { sha256Hex } from "./deviceAuth";

useIsolatedDeploymentEnv();

type T = ReturnType<typeof testConvex>;

let t: T;
let syncToken: string;

beforeEach(() => {
  t = testConvex();
  syncToken = freshSecret();
  setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
});

describe("pairing", () => {
  it("refuses a duplicate pair id without replacing the original proof or grant", async () => {
    const pairId = `pair-${crypto.randomUUID()}`;
    const proofHash = freshProofHash();
    await t.mutation(api.createMobilePairing, {
      pairId,
      proofHash,
      expiresAt: Date.now() + 60_000,
      token: syncToken,
    });

    await expect(
      t.mutation(api.createMobilePairing, {
        pairId,
        proofHash: freshProofHash(),
        expiresAt: Date.now() + 120_000,
        capabilities: ["bitcoin:write"],
        token: syncToken,
      }),
    ).rejects.toThrow(/PAIRING_ID_CONFLICT/);

    const claimed = await t.mutation(api.claimMobilePairing, {
      pairId,
      proofHash,
      deviceName: "Original pairing",
      deviceId: "original-pairing-device",
      deviceToken: freshSecret(),
    });
    expect(claimed.capabilities).toEqual(["todos:write"]);
  });

  it("keeps legacy pairings exactly todo-only", async () => {
    const paired = await pairMobileDevice(t, syncToken);
    expect(paired.capabilities).toEqual(["todos:write"]);
    const device = await t.run(async (ctx) =>
      ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", paired.deviceId))
        .unique(),
    );
    expect(device!.capabilities).toBeUndefined();
  });

  it("preserves an explicit empty grant and refuses todo writes", async () => {
    const paired = await pairMobileDevice(t, syncToken, "no-capabilities", []);
    expect(paired.capabilities).toEqual([]);
    await expect(
      t.mutation(generatedApi.tables.upsertTodoFromDevice, {
        deviceId: paired.deviceId,
        deviceToken: paired.deviceToken,
        activeProfile: "mason",
        owner: "mason",
        sourceFile: "todos",
        operation: "create",
        todo: {
          id: "todo-1",
          owner: "mason",
          title: "Must not land",
          done: false,
          flagged: false,
        },
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
  });

  it("copies and normalizes only the four server-minted capabilities", async () => {
    const paired = await pairMobileDevice(t, syncToken, "full-device", [
      "bitcoin:write",
      "todos:write",
      "todos:write",
      "budget:write",
      "transactions:write",
      "bitcoin:write",
    ]);
    expect(paired.capabilities).toEqual([
      "todos:write",
      "transactions:write",
      "budget:write",
      "bitcoin:write",
    ]);
  });

  it("does not let a claimant add capabilities to a todo-only pairing", async () => {
    const pairId = `pair-${crypto.randomUUID()}`;
    const proofHash = freshProofHash();
    await t.mutation(api.createMobilePairing, {
      pairId,
      proofHash,
      expiresAt: Date.now() + 60_000,
      token: syncToken,
    });
    await expect(
      t.mutation(api.claimMobilePairing, {
        pairId,
        proofHash,
        deviceName: "Phone",
        deviceId: "self-escalation",
        deviceToken: freshSecret(),
        capabilities: ["bitcoin:write"],
      } as never),
    ).rejects.toThrow();
  });

  it("stores only a hash of the device token, never the token", async () => {
    const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
    const device = await t.run(async (ctx) =>
      ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
        .first(),
    );
    expect(device).not.toBeNull();
    expect(device!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(device!.tokenHash).not.toBe(deviceToken);
    expect(JSON.stringify(device)).not.toContain(deviceToken);
  });

  it("refuses to claim a pairing twice", async () => {
    const pairId = `pair-${crypto.randomUUID()}`;
    const proofHash = freshProofHash();
    await t.mutation(api.createMobilePairing, {
      pairId,
      proofHash,
      expiresAt: Date.now() + 60_000,
      token: syncToken,
    });
    await t.mutation(api.claimMobilePairing, {
      pairId,
      proofHash,
      deviceName: "Phone",
      deviceId: "device-a",
      deviceToken: freshSecret(),
    });
    await expect(
      t.mutation(api.claimMobilePairing, {
        pairId,
        proofHash,
        deviceName: "Phone",
        deviceId: "device-b",
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/already claimed/);
  });

  it("does not let a new pairing take over an existing device id", async () => {
    const existing = await pairMobileDevice(
      t,
      syncToken,
      "stable-device",
      ["todos:write"],
      "mason",
    );
    const pairId = `pair-${crypto.randomUUID()}`;
    const proofHash = freshProofHash();
    await t.mutation(api.createMobilePairing, {
      pairId,
      proofHash,
      expiresAt: Date.now() + 60_000,
      capabilities: ["bitcoin:write"],
      token: syncToken,
    });
    await expect(
      t.mutation(api.claimMobilePairing, {
        pairId,
        proofHash,
        deviceName: "Attacker",
        deviceId: existing.deviceId,
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/already paired/);
    await expect(
      t.mutation(generatedApi.tables.upsertTodoFromDevice, {
        deviceId: existing.deviceId,
        deviceToken: existing.deviceToken,
        activeProfile: "mason",
        owner: "mason",
        sourceFile: "todos",
        operation: "create",
        todo: {
          id: "todo-1",
          owner: "mason",
          title: "Original token still works",
          done: false,
          flagged: false,
        },
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("refuses a claim with the wrong proof", async () => {
    const pairId = `pair-${crypto.randomUUID()}`;
    await t.mutation(api.createMobilePairing, {
      pairId,
      proofHash: freshProofHash(),
      expiresAt: Date.now() + 60_000,
      token: syncToken,
    });
    await expect(
      t.mutation(api.claimMobilePairing, {
        pairId,
        proofHash: freshProofHash(),
        deviceName: "Phone",
        deviceId: "device-a",
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/Invalid pairing proof/);
  });

  it("verifies the pairing proof before disclosing claim state or expiry", async () => {
    // The proofHash IS the claim credential. A caller without it must learn
    // nothing about a slot — not whether it was claimed, not whether it
    // expired — even when it already knows the pairId.
    const proofHash = freshProofHash();
    const claimedPair = `pair-${crypto.randomUUID()}`;
    await t.mutation(api.createMobilePairing, {
      pairId: claimedPair,
      proofHash,
      expiresAt: Date.now() + 60_000,
      token: syncToken,
    });
    await t.mutation(api.claimMobilePairing, {
      pairId: claimedPair,
      proofHash,
      deviceName: "Phone",
      deviceId: "state-probe-claimed",
      deviceToken: freshSecret(),
    });

    const expiredPair = `pair-${crypto.randomUUID()}`;
    await t.mutation(api.createMobilePairing, {
      pairId: expiredPair,
      proofHash: freshProofHash(),
      expiresAt: Date.now() + 60_000,
      token: syncToken,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("mobilePairings")
        .withIndex("by_pair_id", (q) => q.eq("pairId", expiredPair))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });

    const wrongProof = freshProofHash();
    for (const pairId of [claimedPair, expiredPair]) {
      await expect(
        t.mutation(api.claimMobilePairing, {
          pairId,
          proofHash: wrongProof,
          deviceName: "Phone",
          deviceId: `state-probe-${pairId}`,
          deviceToken: freshSecret(),
        }),
      ).rejects.toThrow(/Invalid pairing proof/);
    }
    await expect(
      t.mutation(api.claimMobilePairing, {
        pairId: claimedPair,
        proofHash,
        deviceName: "Phone",
        deviceId: "state-probe-replay",
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/already claimed/);
    await expect(
      t.mutation(api.claimMobilePairing, {
        pairId: expiredPair,
        proofHash: await (async () => {
          const row = await t.run(async (ctx) => {
            const record = await ctx.db
              .query("mobilePairings")
              .withIndex("by_pair_id", (q) => q.eq("pairId", expiredPair))
              .unique();
            return record!.proofHash;
          });
          return row;
        })(),
        deviceName: "Phone",
        deviceId: "state-probe-expired",
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/expired/);
  });

  it("rejects oversized or malformed claim credentials before pairing", async () => {
    const pairId = `pair-${crypto.randomUUID()}`;
    const proofHash = freshProofHash();
    await t.mutation(api.createMobilePairing, {
      pairId,
      proofHash,
      expiresAt: Date.now() + 60_000,
      token: syncToken,
    });
    for (const invalid of [
      {
        deviceName: "Phone",
        deviceId: "contains spaces",
        deviceToken: freshSecret(),
      },
      {
        deviceName: "Phone",
        deviceId: "device-a",
        deviceToken: "too-short",
      },
      {
        deviceName: "x".repeat(81),
        deviceId: "device-a",
        deviceToken: freshSecret(),
      },
    ]) {
      await expect(
        t.mutation(api.claimMobilePairing, {
          pairId,
          proofHash,
          ...invalid,
        }),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    }
  });

  it("refuses an unknown pairing", async () => {
    await expect(
      t.mutation(api.claimMobilePairing, {
        pairId: "no-such-pair",
        proofHash: freshProofHash(),
        deviceName: "Phone",
        deviceId: "device-a",
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/PAIRING_NOT_FOUND/);
  });

  it("lets a device revoke itself idempotently and rejects later writes", async () => {
    const paired = await pairMobileDevice(t, syncToken);
    await expect(
      t.mutation(api.revokeMobileDevice, {
        deviceId: paired.deviceId,
        deviceToken: paired.deviceToken,
      }),
    ).resolves.toEqual({ ok: true, revoked: true });
    await expect(
      t.mutation(api.revokeMobileDevice, {
        deviceId: paired.deviceId,
        deviceToken: paired.deviceToken,
      }),
    ).resolves.toEqual({ ok: true, revoked: false });
    await expect(
      t.mutation(generatedApi.tables.upsertTodoFromDevice, {
        deviceId: paired.deviceId,
        deviceToken: paired.deviceToken,
        activeProfile: "mason",
        owner: "mason",
        sourceFile: "todos",
        operation: "create",
        todo: {
          id: "todo-1",
          owner: "mason",
          title: "Must not land",
          done: false,
          flagged: false,
        },
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
  });
});
