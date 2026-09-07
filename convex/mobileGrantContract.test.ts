import { randomBytes } from "node:crypto";
import type { FunctionReference } from "convex/server";
import { expect, it } from "vitest";
import { authenticateDevice, sha256Hex } from "./deviceAuth";
import {
  api,
  freshProofHash,
  freshSecret,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

useIsolatedDeploymentEnv();
const mutation = (name: string) =>
  name as unknown as FunctionReference<
    "mutation",
    "public",
    Record<string, unknown>,
    unknown
  >;

it("an explicitly budget-enabled Android bootstrap can copy a plan within its profile", async () => {
  const t = testConvex();
  const syncToken = freshSecret();
  setDeploymentEnv({
    CONVEX_SYNC_TOKEN: syncToken,
    CONVEX_READ_TOKEN: freshSecret(),
  });
  const pairId = `android-read-${randomBytes(18).toString("base64url")}`;
  const proof = randomBytes(32).toString("base64url");
  await t.mutation(mutation("dataFiles:createAndroidReadBootstrap"), {
    pairId,
    proofHash: await sha256Hex(proof),
    expiresAt: Date.now() + 60_000,
    capabilities: ["todos:write", "budget:write"],
    profile: "victor",
    token: syncToken,
  });
  const device = {
    deviceId: "grant-contract-device",
    deviceToken: freshSecret(),
  };
  const claimed = await t.mutation(
    mutation("dataFiles:claimAndroidReadBootstrap"),
    { pairId, proof, ...device },
  );
  expect(claimed).toMatchObject({
    capabilities: ["todos:write", "budget:write"],
    profile: "victor",
  });
  for (const capability of ["transactions:write", "bitcoin:write"] as const) {
    await expect(
      t.run((ctx) =>
        authenticateDevice(
          ctx,
          device.deviceId,
          device.deviceToken,
          capability,
        ),
      ),
    ).rejects.toThrow(/DEVICE_UNAUTHORIZED/);
  }
  await expect(
    t.mutation(mutation("tables:copyBudgetPlanForwardFromDevice"), {
      ...device,
      owner: "mason",
      sourceFile: "mason-budget",
      fromMonth: "2026-08",
      toMonth: "2026-09",
      baseUpdatedAtMs: 1,
    }),
  ).rejects.toThrow(/OWNER_MISMATCH/);
  await t.run(async (ctx) => {
    await ctx.db.insert("budgetDocuments", {
      sourceFile: "budget",
      owner: "victor",
      month: "2026-08",
      coinbaseOneBalanceCents: 0n,
      categories: [{ name: "Synthetic", budgetCents: 100n }],
      mtdIncomeCents: 0n,
      ytdIncomeCents: 0n,
      monthlyHistory: [],
      updatedAtMs: 1,
    });
  });
  await expect(
    t.mutation(mutation("tables:copyBudgetPlanForwardFromDevice"), {
      ...device,
      owner: "victor",
      sourceFile: "budget",
      fromMonth: "2026-08",
      toMonth: "2026-09",
      baseUpdatedAtMs: 1,
    }),
  ).resolves.toMatchObject({ ok: true, outcome: "copied" });
});

it("the sync guard returns a redaction-safe code for the actual rejected probe", async () => {
  const t = testConvex();
  const token = freshSecret();
  setDeploymentEnv({ CONVEX_SYNC_TOKEN: token });
  for (const supplied of [undefined, freshSecret()]) {
    await expect(
      t.mutation(api.remove, { name: "__synthetic_probe__", token: supplied }),
    ).rejects.toMatchObject({ data: { code: "SYNC_AUTH_REJECTED" } });
  }
  await expect(
    t.mutation(api.remove, { name: "__synthetic_probe__", token }),
  ).resolves.toBeNull();
  expect(await t.run((ctx) => ctx.db.query("dataFiles").collect())).toEqual([]);
});

it("legacy Android todo-only grants cannot authorize budget copy", async () => {
  const t = testConvex();
  const syncToken = freshSecret();
  setDeploymentEnv({
    CONVEX_SYNC_TOKEN: syncToken,
    CONVEX_READ_TOKEN: freshSecret(),
  });
  const pairId = `android-read-${randomBytes(18).toString("base64url")}`;
  const proof = randomBytes(32).toString("base64url");
  await t.mutation(mutation("dataFiles:createAndroidReadBootstrap"), {
    pairId,
    proofHash: await sha256Hex(proof),
    expiresAt: Date.now() + 60_000,
    capabilities: ["todos:write"],
    profile: "victor",
    token: syncToken,
  });
  const device = {
    deviceId: "legacy-grant-contract",
    deviceToken: freshSecret(),
  };
  await expect(
    t.mutation(mutation("dataFiles:claimAndroidReadBootstrap"), {
      pairId,
      proof,
      ...device,
    }),
  ).resolves.toMatchObject({ capabilities: ["todos:write"] });
  await expect(
    t.mutation(mutation("tables:copyBudgetPlanForwardFromDevice"), {
      ...device,
      owner: "victor",
      sourceFile: "budget",
      fromMonth: "2026-08",
      toMonth: "2026-09",
      baseUpdatedAtMs: 1,
    }),
  ).rejects.toThrow(/DEVICE_UNAUTHORIZED/);
});

it("a missing sync configuration has a distinct redaction-safe fail-closed code", async () => {
  const t = testConvex();
  await expect(
    t.mutation(api.remove, { name: "__synthetic_probe__" }),
  ).rejects.toMatchObject({ data: { code: "SYNC_AUTH_UNCONFIGURED" } });
});

it.each(["victor", "rachel", "mason", "maddox"] as const)(
  "mobile app grants retain the minted %s profile",
  async (profile) => {
    const t = testConvex();
    const syncToken = freshSecret();
    setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
    const pairId = `mobile-grant-${profile}`;
    const proofHash = freshProofHash();
    const capabilities = ["todos:write", "budget:write"] as const;
    await t.mutation(api.createMobilePairing, {
      pairId,
      proofHash,
      expiresAt: Date.now() + 60_000,
      capabilities: [...capabilities],
      profile,
      token: syncToken,
    });
    const deviceId = `mobile-device-${profile}`;
    const deviceToken = freshSecret();
    const claimed = await t.mutation(api.claimMobilePairing, {
      pairId,
      proofHash,
      deviceId,
      deviceToken,
      deviceName: "Synthetic test",
    });
    expect(claimed.capabilities).toEqual(capabilities);
    const device = await t.run((ctx) =>
      authenticateDevice(ctx, deviceId, deviceToken, "budget:write"),
    );
    expect(device.profile).toBe(profile);
    expect(device.capabilities).toEqual(capabilities);
  },
);
