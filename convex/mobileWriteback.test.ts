// SAT-1429 / SAT-1508: the public-iPhone writeback path.
//
// These mutations carry no sync token — a per-device token is the entire
// authorisation story, so "unknown device" and "revoked device" have to stay
// hard failures.
import { beforeEach, describe, expect, it } from "vitest";

import {
  api,
  freshProofHash,
  freshSecret,
  pairMobileDevice,
  readTodos,
  seedDataFile,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";
import { sha256Hex } from "./deviceAuth";

useIsolatedDeploymentEnv();

type T = ReturnType<typeof testConvex>;

let t: T;
let syncToken: string;

async function expectCode(request: Promise<unknown>, code: string) {
  try {
    await request;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect((error as { data?: { code?: string } }).data?.code).toBe(code);
  }
}

beforeEach(() => {
  t = testConvex();
  syncToken = freshSecret();
  setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
});

const MOBILE_MUTATIONS = [
  {
    name: "upsertTodoFromMobile",
    call: (t: T, deviceId: string, deviceToken: string) =>
      t.mutation(api.upsertTodoFromMobile, {
        deviceId,
        deviceToken,
        activeProfile: "mason",
        owner: "mason",
        sourceFile: "todos",
        operation: "create",
        todo: {
          id: "todo-1",
          owner: "mason",
          title: "From the phone",
          done: false,
          flagged: false,
        },
      }),
  },
  {
    name: "completeTodoFromMobile",
    call: (t: T, deviceId: string, deviceToken: string) =>
      t.mutation(api.completeTodoFromMobile, {
        deviceId,
        deviceToken,
        activeProfile: "mason",
        owner: "mason",
        sourceFile: "todos",
        baseUpdatedAtMs: 0,
        todo: {
          id: "todo-1",
          owner: "mason",
          title: "From the phone",
          done: true,
          flagged: false,
        },
      }),
  },
  {
    name: "removeTodoFromMobile",
    call: (t: T, deviceId: string, deviceToken: string) =>
      t.mutation(api.removeTodoFromMobile, {
        deviceId,
        deviceToken,
        activeProfile: "mason",
        owner: "mason",
        sourceFile: "todos",
        entityId: "todo-1",
        baseUpdatedAtMs: 0,
      }),
  },
] as const;

describe("mobile writeback rejects anything but a live paired device", () => {
  for (const mutation of MOBILE_MUTATIONS) {
    it(`${mutation.name} rejects a device that was never paired`, async () => {
      await expect(
        mutation.call(t, "never-seen-device", freshSecret()),
      ).rejects.toThrow(/Unauthorized mobile device/);
    });

    it(`${mutation.name} rejects a wrong token for a real device`, async () => {
      const { deviceId } = await pairMobileDevice(t, syncToken);
      await expect(mutation.call(t, deviceId, freshSecret())).rejects.toThrow(
        /Unauthorized mobile device/,
      );
    });

    it(`${mutation.name} rejects a revoked device`, async () => {
      const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
      await t.run(async (ctx) => {
        const device = await ctx.db
          .query("mobileDevices")
          .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
          .first();
        await ctx.db.patch(device!._id, { revokedAt: Date.now() });
      });
      await expect(mutation.call(t, deviceId, deviceToken)).rejects.toThrow(
        /Unauthorized mobile device/,
      );
    });

    it(`${mutation.name} rejects another device's token`, async () => {
      await pairMobileDevice(t, syncToken, "device-a");
      const other = await pairMobileDevice(t, syncToken, "device-b");
      await expect(
        mutation.call(t, "device-a", other.deviceToken),
      ).rejects.toThrow(/Unauthorized mobile device/);
    });

    it(`${mutation.name} writes nothing when it rejects`, async () => {
      await seedDataFile(t, "todos", [{ id: "todo-1", title: "Untouched" }]);
      await expect(
        mutation.call(t, "never-seen-device", freshSecret()),
      ).rejects.toThrow();
      await expect(readTodos(t)).resolves.toEqual([
        { id: "todo-1", title: "Untouched" },
      ]);
      await expect(
        t.run(async (ctx) => await ctx.db.query("todoTombstones").collect()),
      ).resolves.toEqual([]);
    });
  }
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
      t.mutation(api.upsertTodoFromMobile, {
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
      t.mutation(api.upsertTodoFromMobile, {
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
      t.mutation(api.upsertTodoFromMobile, {
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

describe("mobile compatibility task authority", () => {
  const todo = {
    id: "compat-task",
    owner: "mason" as const,
    title: "Mason private",
    done: false,
    flagged: false,
  };

  async function state() {
    return t.run(async (ctx) => ({
      rows: await ctx.db.query("todos").collect(),
      rowTombstones: await ctx.db.query("rowTombstones").collect(),
      legacyTombstones: await ctx.db.query("todoTombstones").collect(),
      locks: await ctx.db.query("runtimeSourceLocks").collect(),
    }));
  }

  async function boundDevice() {
    return pairMobileDevice(
      t,
      syncToken,
      `compat-${crypto.randomUUID()}`,
      ["todos:write"],
      "mason",
    );
  }

  function createRequest(device: { deviceId: string; deviceToken: string }) {
    return {
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      operation: "create",
      todo,
    } as const;
  }

  it("rejects a credential without a server profile and writes nothing", async () => {
    const deviceToken = freshSecret();
    await t.run(async (ctx) => {
      await ctx.db.insert("mobileDevices", {
        deviceId: "legacy-unbound-compat",
        name: "Legacy",
        tokenHash: await sha256Hex(deviceToken),
        pairedAt: 1,
        lastSeenAt: 1,
        pairId: "legacy-unbound-compat-pair",
        capabilities: ["todos:write"],
      });
    });
    const before = await state();
    const credential = {
      deviceId: "legacy-unbound-compat",
      deviceToken,
    };
    const requests = [
      () => t.mutation(api.upsertTodoFromMobile, createRequest(credential)),
      () =>
        t.mutation(api.completeTodoFromMobile, {
          ...credential,
          activeProfile: "mason",
          owner: "mason",
          sourceFile: "todos",
          baseUpdatedAtMs: 0,
          todo,
        }),
      () =>
        t.mutation(api.removeTodoFromMobile, {
          ...credential,
          activeProfile: "mason",
          owner: "mason",
          sourceFile: "todos",
          entityId: todo.id,
          baseUpdatedAtMs: 0,
        }),
    ];
    for (const request of requests) {
      await expectCode(request(), "PROFILE_BINDING_REQUIRED");
    }
    expect(await state()).toEqual(before);
  });

  it("rejects a wrong active profile or owner before mutation", async () => {
    const device = await boundDevice();
    const before = await state();
    const { activeProfile: _activeProfile, ...missingProfile } =
      createRequest(device);
    await expectCode(
      t.mutation(api.upsertTodoFromMobile, missingProfile),
      "OWNER_MISMATCH",
    );
    await expectCode(
      t.mutation(api.upsertTodoFromMobile, {
        ...createRequest(device),
        activeProfile: "victor",
      }),
      "OWNER_MISMATCH",
    );
    await expectCode(
      t.mutation(api.completeTodoFromMobile, {
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
        activeProfile: "victor",
        owner: "mason",
        sourceFile: "todos",
        baseUpdatedAtMs: 0,
        todo,
      }),
      "OWNER_MISMATCH",
    );
    await expectCode(
      t.mutation(api.removeTodoFromMobile, {
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
        activeProfile: "victor",
        owner: "mason",
        sourceFile: "todos",
        entityId: todo.id,
        baseUpdatedAtMs: 0,
      }),
      "OWNER_MISMATCH",
    );
    await expectCode(
      t.mutation(api.upsertTodoFromMobile, {
        ...createRequest(device),
        owner: "victor",
      }),
      "OWNER_MISMATCH",
    );
    expect(await state()).toEqual(before);
  });

  it("requires a server-fresh id and exact revision for every update", async () => {
    const device = await boundDevice();
    const create = createRequest(device);
    await expect(
      t.mutation(api.upsertTodoFromMobile, create),
    ).resolves.toMatchObject({
      entityId: todo.id,
      outcome: "inserted",
    });
    const revision = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", todo.id))
        .unique();
      return row!.updatedAtMs;
    });
    const afterCreate = await state();
    await expectCode(
      t.mutation(api.upsertTodoFromMobile, create),
      "ENTITY_CONFLICT",
    );
    await expectCode(
      t.mutation(api.completeTodoFromMobile, {
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
        activeProfile: "mason",
        owner: "mason",
        sourceFile: "todos",
        todo: { ...todo, done: true },
      }),
      "REVISION_REQUIRED",
    );
    expect(await state()).toEqual(afterCreate);

    const update = {
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      baseUpdatedAtMs: revision,
      todo: { ...todo, done: true },
    } as const;
    await expect(
      t.mutation(api.completeTodoFromMobile, update),
    ).resolves.toMatchObject({
      outcome: "updated",
    });
    const afterUpdate = await state();
    await expectCode(
      t.mutation(api.completeTodoFromMobile, update),
      "ENTITY_CONFLICT",
    );
    expect(await state()).toEqual(afterUpdate);
  });

  it("requires an exact delete revision and makes replay a no-op", async () => {
    const device = await boundDevice();
    await t.mutation(api.upsertTodoFromMobile, createRequest(device));
    const revision = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", todo.id))
        .unique();
      return row!.updatedAtMs;
    });
    const request = {
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      entityId: todo.id,
    } as const;
    const before = await state();
    await expectCode(
      t.mutation(api.removeTodoFromMobile, request),
      "REVISION_REQUIRED",
    );
    await expectCode(
      t.mutation(api.removeTodoFromMobile, {
        ...request,
        baseUpdatedAtMs: revision + 1,
      }),
      "ENTITY_CONFLICT",
    );
    expect(await state()).toEqual(before);

    await expect(
      t.mutation(api.removeTodoFromMobile, {
        ...request,
        baseUpdatedAtMs: revision,
      }),
    ).resolves.toMatchObject({ removed: true });
    const afterDelete = await state();
    await expect(
      t.mutation(api.removeTodoFromMobile, {
        ...request,
        baseUpdatedAtMs: revision,
      }),
    ).resolves.toMatchObject({ removed: false });
    expect(await state()).toEqual(afterDelete);

    await expectCode(
      t.mutation(api.upsertTodoFromMobile, createRequest(device)),
      "ENTITY_DELETED",
    );
    await expect(
      t.mutation(api.upsertTodoFromMobile, {
        ...createRequest(device),
        restoreCapsule: { todo },
      } as never),
    ).rejects.toThrow();
    expect(await state()).toEqual(afterDelete);
  });
});
