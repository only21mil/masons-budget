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

useIsolatedDeploymentEnv();

type T = ReturnType<typeof testConvex>;

let t: T;
let syncToken: string;

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
        todo: { id: "todo-1", title: "From the phone" },
      }),
  },
  {
    name: "completeTodoFromMobile",
    call: (t: T, deviceId: string, deviceToken: string) =>
      t.mutation(api.completeTodoFromMobile, {
        deviceId,
        deviceToken,
        id: "todo-1",
      }),
  },
  {
    name: "removeTodoFromMobile",
    call: (t: T, deviceId: string, deviceToken: string) =>
      t.mutation(api.removeTodoFromMobile, {
        deviceId,
        deviceToken,
        id: "todo-1",
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
        todo: { id: "todo-1", title: "Must not land" },
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
    const existing = await pairMobileDevice(t, syncToken, "stable-device");
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
        todo: { id: "todo-1", title: "Original token still works" },
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
        todo: { id: "todo-1", title: "Must not land" },
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
  });
});

describe("mobile writeback with a live device", () => {
  it("upsertTodoFromMobile stamps the write as app-sourced", async () => {
    const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
    await t.mutation(api.upsertTodoFromMobile, {
      deviceId,
      deviceToken,
      todo: { id: "todo-1", title: "Buy milk", category: "personal" },
    });

    const todos = await readTodos(t);
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      id: "todo-1",
      title: "Buy milk",
      category: "personal",
      sync_source: "vogel-vault",
    });
  });

  it("completeTodoFromMobile marks an existing todo done and keeps its other fields", async () => {
    const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
    await seedDataFile(t, "todos", [
      {
        id: "todo-1",
        title: "Buy milk",
        notes: "semi-skimmed",
        project: "Errands",
        due_date: "2026-08-01",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
    ]);

    const result = await t.mutation(api.completeTodoFromMobile, {
      deviceId,
      deviceToken,
      id: "todo-1",
      title: "Buy milk",
    });

    expect(result.ok).toBe(true);
    expect(result.done).toBe(true);
    expect(result.titleMatched).toBe(true);

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({
      id: "todo-1",
      done: true,
      status: "completed",
      completed_by: "vogel-vault-mobile",
      sync_source: "vogel-vault",
      // Merged from the stored record rather than reset — completeTodo reads
      // the existing todo as its base.
      notes: "semi-skimmed",
      project: "Errands",
      dueDate: "2026-08-01",
    });
  });

  it("completeTodoFromMobile reopens a todo and clears the completion fields", async () => {
    const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
    await seedDataFile(t, "todos", [
      {
        id: "todo-1",
        title: "Buy milk",
        done: true,
        status: "completed",
        completedAt: "2026-07-01T00:00:00.000Z",
        completed_by: "vogel-vault-mobile",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
    ]);

    const result = await t.mutation(api.completeTodoFromMobile, {
      deviceId,
      deviceToken,
      id: "todo-1",
      done: false,
    });

    expect(result.done).toBe(false);
    expect(result.completedAt).toBeNull();

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({ done: false, status: "pending" });
    expect(todo).not.toHaveProperty("completedAt");
    expect(todo).not.toHaveProperty("completed_by");
  });

  it("completeTodoFromMobile creates a missing todo instead of failing (SAT-1508)", async () => {
    const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
    const result = await t.mutation(api.completeTodoFromMobile, {
      deviceId,
      deviceToken,
      id: "todo-ghost",
      title: "Never reached MC2",
    });

    expect(result.ok).toBe(true);
    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({
      id: "todo-ghost",
      title: "Never reached MC2",
      done: true,
      created_by: "vogel-vault",
    });
  });

  it("completeTodoFromMobile reports a title mismatch but still applies the write", async () => {
    // Documented, not endorsed: `titleMatched` is advisory. The caller is told
    // the id it completed was not the todo it thought it was, after the fact.
    const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
    await seedDataFile(t, "todos", [{ id: "todo-1", title: "Buy milk" }]);

    const result = await t.mutation(api.completeTodoFromMobile, {
      deviceId,
      deviceToken,
      id: "todo-1",
      title: "Something else entirely",
    });

    expect(result.titleMatched).toBe(false);
    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({ id: "todo-1", done: true });
  });

  it("removeTodoFromMobile deletes the todo and leaves a tombstone", async () => {
    const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
    await seedDataFile(t, "todos", [
      { id: "todo-1", title: "Buy milk" },
      { id: "todo-2", title: "Keep me" },
    ]);

    const result = await t.mutation(api.removeTodoFromMobile, {
      deviceId,
      deviceToken,
      id: "todo-1",
    });

    expect(result).toMatchObject({ ok: true, removed: true });
    expect(await readTodos(t)).toEqual([{ id: "todo-2", title: "Keep me" }]);

    const tombstones = await t.run(async (ctx) =>
      ctx.db.query("todoTombstones").collect(),
    );
    expect(tombstones.map((row) => row.id)).toEqual(["todo-1"]);
  });

  it("bumps lastSeenAt on a successful write", async () => {
    const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
    const before = await t.run(async (ctx) => {
      const device = await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
        .first();
      // Backdate so the bump is observable even inside one millisecond.
      await ctx.db.patch(device!._id, { lastSeenAt: 0 });
      return 0;
    });

    await t.mutation(api.upsertTodoFromMobile, {
      deviceId,
      deviceToken,
      todo: { id: "todo-1", title: "Buy milk" },
    });

    const after = await t.run(async (ctx) => {
      const device = await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
        .first();
      return device!.lastSeenAt;
    });
    expect(after).toBeGreaterThan(before);
  });
});
