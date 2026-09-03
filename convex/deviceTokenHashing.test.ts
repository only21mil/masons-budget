// L-7 regression: device credentials are stored peppered for new pairings,
// legacy rows migrate by rehash-on-use, and nothing about the wire changes.
// No token value is ever printed or stored in plaintext.
import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  freshSecret,
  pairMobileDevice,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

const mutation = <Args extends Record<string, unknown>, Result>(path: string) =>
  path as unknown as FunctionReference<"mutation", "public", Args, Result>;

type UpsertResult = { ok: true; entityId: string; outcome: string };

const api = {
  upsertTodo: mutation<
    Record<string, unknown>,
    UpsertResult
  >("tables:upsertTodoFromDevice"),
  revokeMobileDevice: mutation<
    { deviceId: string; deviceToken: string },
    { ok: true; revoked: boolean }
  >("dataFiles:revokeMobileDevice"),
};

useIsolatedDeploymentEnv();

type T = ReturnType<typeof testConvex>;

let t: T;
let syncToken: string;

beforeEach(() => {
  t = testConvex();
  syncToken = freshSecret();
  setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
});

async function storedDevice(deviceId: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("mobileDevices")
      .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
      .unique(),
  );
}

function todoWrite(
  device: { deviceId: string; deviceToken: string },
  todoId: string,
) {
  return {
    deviceId: device.deviceId,
    deviceToken: device.deviceToken,
    activeProfile: "victor" as const,
    owner: "victor" as const,
    sourceFile: "todos" as const,
    operation: "create" as const,
    todo: {
      id: todoId,
      owner: "victor" as const,
      title: "Peppered credential write",
      done: false,
      flagged: false,
    },
  };
}

describe("peppered device-token storage", () => {
  it("stores new credentials peppered and keeps them working", async () => {
    const pepper = freshSecret();
    setDeploymentEnv({ DEVICE_TOKEN_PEPPER: pepper });
    const device = await pairMobileDevice(t, syncToken, "pepper-new-device");

    const stored = await storedDevice(device.deviceId);
    expect(stored!.tokenHash).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(device.deviceToken);

    await expect(
      t.mutation(api.upsertTodo, todoWrite(device, "pepper-todo-1")),
    ).resolves.toMatchObject({ ok: true });
  });

  it("migrates a legacy unsalted row on first successful use", async () => {
    const device = await pairMobileDevice(t, syncToken, "pepper-legacy-device");
    const before = await storedDevice(device.deviceId);
    expect(before!.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // The pepper arrives after the credential was minted — the production
    // sequence for existing devices.
    const pepper = freshSecret();
    setDeploymentEnv({ DEVICE_TOKEN_PEPPER: pepper });

    await expect(
      t.mutation(api.upsertTodo, todoWrite(device, "pepper-todo-2")),
    ).resolves.toMatchObject({ ok: true });

    const migrated = await storedDevice(device.deviceId);
    expect(migrated!.tokenHash).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(migrated!.tokenHash).not.toBe(before!.tokenHash);

    // The same credential keeps working after the migration.
    await expect(
      t.mutation(api.upsertTodo, todoWrite(device, "pepper-todo-3")),
    ).resolves.toMatchObject({ ok: true });
  });

  it("never migrates or admits a wrong token", async () => {
    const device = await pairMobileDevice(t, syncToken, "pepper-wrong-device");
    const before = (await storedDevice(device.deviceId))!.tokenHash;
    setDeploymentEnv({ DEVICE_TOKEN_PEPPER: freshSecret() });

    await expect(
      t.mutation(api.upsertTodo, {
        ...todoWrite(device, "pepper-todo-4"),
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);

    const stored = await storedDevice(device.deviceId);
    expect(stored!.tokenHash).toBe(before);
  });

  it("fails closed when a peppered row outlives its pepper", async () => {
    const pepper = freshSecret();
    setDeploymentEnv({ DEVICE_TOKEN_PEPPER: pepper });
    const device = await pairMobileDevice(t, syncToken, "pepper-lost-device");
    expect(((await storedDevice(device.deviceId))!).tokenHash).toMatch(/^v1:/);

    delete process.env.DEVICE_TOKEN_PEPPER;
    await expect(
      t.mutation(api.upsertTodo, todoWrite(device, "pepper-todo-5")),
    ).rejects.toThrow(/Unauthorized mobile device/);
  });

  it("keeps self-revocation working across the migration", async () => {
    const device = await pairMobileDevice(t, syncToken, "pepper-revoke-device");
    setDeploymentEnv({ DEVICE_TOKEN_PEPPER: freshSecret() });

    await expect(
      t.mutation(api.revokeMobileDevice, {
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
      }),
    ).resolves.toMatchObject({ ok: true, revoked: true });

    expect(((await storedDevice(device.deviceId))!.tokenHash).startsWith("v1:")).toBe(
      true,
    );
    await expect(
      t.mutation(api.upsertTodo, todoWrite(device, "pepper-todo-6")),
    ).rejects.toThrow(/Unauthorized mobile device/);
  });
});
