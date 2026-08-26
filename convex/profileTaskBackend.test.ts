import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  freshSecret,
  pairMobileDevice,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";
import { sha256Hex } from "./deviceAuth";

useIsolatedDeploymentEnv();

type Member = "victor" | "rachel" | "mason" | "maddox";
type T = ReturnType<typeof testConvex>;

const api = {
  listTodos: "tables:listTodos" as unknown as FunctionReference<
    "query",
    "public",
    { viewer: Member; token: string },
    { rows: Array<{ todoId: string; owner: Member }>; complete: boolean }
  >,
  upsertTodo: "tables:upsertTodo" as unknown as FunctionReference<
    "mutation",
    "public",
    {
      activeProfile?: Member;
      todo: Record<string, unknown>;
      token: string;
    },
    { todoId: string; owner: Member; outcome: "inserted" | "updated" }
  >,
  deleteTodo: "tables:deleteTodo" as unknown as FunctionReference<
    "mutation",
    "public",
    { activeProfile?: Member; owner?: Member; todoId: string; token: string },
    { todoId: string; removed: boolean }
  >,
  upsertTodoFromDevice:
    "tables:upsertTodoFromDevice" as unknown as FunctionReference<
      "mutation",
      "public",
      Record<string, unknown>,
      { ok: true; entityId: string; outcome: "inserted" | "updated" }
    >,
  deleteTodoFromDevice:
    "tables:deleteTodoFromDevice" as unknown as FunctionReference<
      "mutation",
      "public",
      Record<string, unknown>,
      { ok: true; entityId: string; removed: boolean }
    >,
  restoreTodoFromDevice:
    "tables:restoreTodoFromDevice" as unknown as FunctionReference<
      "mutation",
      "public",
      Record<string, unknown>,
      { ok: true; entityId: string; updatedAtMs: number }
    >,
};

let t: T;
let readToken: string;
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
  readToken = freshSecret();
  syncToken = freshSecret();
  setDeploymentEnv({
    CONVEX_READ_TOKEN: readToken,
    CONVEX_SYNC_TOKEN: syncToken,
  });
});

describe("profile-private task backend", () => {
  it("accepts the shipped Swift sync-token todo payloads", async () => {
    await expect(
      t.mutation(api.upsertTodo, {
        todo: {
          id: "swift-missing-owner",
          title: "Must not default to an adult",
        },
        token: syncToken,
      }),
    ).rejects.toThrow(/owner must be one of/);

    await expect(
      t.mutation(api.upsertTodo, {
        todo: {
          id: "swift-todo",
          title: "Shipped Swift payload",
          owner: "mason",
        },
        token: syncToken,
      }),
    ).resolves.toMatchObject({ owner: "mason", outcome: "inserted" });

    await expect(
      t.mutation(api.deleteTodo, {
        todoId: "swift-todo",
        token: syncToken,
      }),
    ).resolves.toEqual({ todoId: "swift-todo", removed: true });

    await expect(
      t.mutation(api.deleteTodo, {
        todoId: "swift-todo",
        token: syncToken,
      }),
    ).resolves.toEqual({ todoId: "swift-todo", removed: false });

    await expect(
      t.mutation(api.deleteTodo, {
        todoId: "swift-never-created",
        token: syncToken,
      }),
    ).resolves.toEqual({ todoId: "swift-never-created", removed: false });
    const tombstones = await t.run(async (ctx) =>
      ctx.db.query("rowTombstones").collect(),
    );
    expect(tombstones).toEqual([
      expect.objectContaining({ entityId: "swift-todo", owner: "mason" }),
      expect.objectContaining({
        entityId: "swift-never-created",
        owner: "victor",
      }),
    ]);
  });

  it("keeps sync-token task writes on the non-interactive admin surface", async () => {
    await expect(
      t.mutation(api.upsertTodo, {
        activeProfile: "victor",
        todo: {
          id: "interactive-admin-write",
          title: "Must use a profile-bound device route",
          owner: "rachel",
        },
        token: syncToken,
      }),
    ).rejects.toThrow();

    await expect(
      t.mutation(api.deleteTodo, {
        activeProfile: "victor",
        owner: "rachel",
        todoId: "interactive-admin-write",
        token: syncToken,
      }),
    ).rejects.toThrow();

    await expect(
      t.query(api.listTodos, { viewer: "rachel", token: readToken }),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("keeps another profile's tombstone while allowing same-owner legacy recreation", async () => {
    const todoId = "legacy-recreated-todo";
    await t.mutation(api.upsertTodo, {
      todo: { id: todoId, title: "Mason private", owner: "mason" },
      token: syncToken,
    });
    await t.mutation(api.deleteTodo, {
      todoId,
      token: syncToken,
    });
    const deletedState = await t.run(async (ctx) => ({
      rowTombstones: await ctx.db.query("rowTombstones").collect(),
      legacyTombstones: await ctx.db.query("todoTombstones").collect(),
      runtimeSourceLocks: await ctx.db.query("runtimeSourceLocks").collect(),
    }));

    await expect(
      t.mutation(api.upsertTodo, {
        todo: { id: todoId, title: "Victor reuse", owner: "victor" },
        token: syncToken,
      }),
    ).rejects.toThrow(/Deleted todo legacy-recreated-todo belongs to mason, not victor/);

    const rejectedState = await t.run(async (ctx) => ({
      row: await ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", todoId))
        .unique(),
      rowTombstones: await ctx.db.query("rowTombstones").collect(),
      legacyTombstones: await ctx.db.query("todoTombstones").collect(),
      runtimeSourceLocks: await ctx.db.query("runtimeSourceLocks").collect(),
    }));
    expect(rejectedState.row).toBeNull();
    expect(rejectedState.rowTombstones).toEqual(deletedState.rowTombstones);
    expect(rejectedState.legacyTombstones).toEqual(deletedState.legacyTombstones);
    expect(rejectedState.runtimeSourceLocks).toEqual(
      deletedState.runtimeSourceLocks,
    );

    await expect(
      t.mutation(api.upsertTodo, {
        todo: { id: todoId, title: "Mason recreated", owner: "mason" },
        token: syncToken,
      }),
    ).resolves.toMatchObject({ owner: "mason", outcome: "inserted" });
    const recreatedState = await t.run(async (ctx) => ({
      row: await ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", todoId))
        .unique(),
      rowTombstones: await ctx.db.query("rowTombstones").collect(),
      legacyTombstones: await ctx.db.query("todoTombstones").collect(),
    }));
    expect(recreatedState.row).toMatchObject({
      todoId,
      owner: "mason",
      title: "Mason recreated",
    });
    expect(recreatedState.rowTombstones).toEqual([]);
    expect(recreatedState.legacyTombstones).toEqual([]);
  });

  it("binds task authority to the credential and fences every state transition", async () => {
    const legacyToken = freshSecret();
    await t.run(async (ctx) => {
      await ctx.db.insert("mobileDevices", {
        deviceId: "legacy-unbound-task-device",
        name: "Legacy device",
        tokenHash: await sha256Hex(legacyToken),
        pairedAt: 1,
        lastSeenAt: 1,
        pairId: "legacy-unbound-task-pairing",
        capabilities: ["todos:write"],
      });
    });
    const todo = {
      id: "fenced-profile-task",
      owner: "mason" as const,
      title: "Authoritative",
      done: false,
      flagged: false,
    };
    const legacyRequest = {
      deviceId: "legacy-unbound-task-device",
      deviceToken: legacyToken,
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      operation: "create",
      todo,
    };
    await expectCode(
      t.mutation(api.upsertTodoFromDevice, legacyRequest),
      "PROFILE_BINDING_REQUIRED",
    );

    const device = await pairMobileDevice(
      t,
      syncToken,
      "bound-task-device",
      ["todos:write"],
      "mason",
    );
    expect(
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("mobileDevices")
          .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
          .unique();
        return row!.profile;
      }),
    ).toBe("mason");
    const create = {
      ...legacyRequest,
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
    };
    await expect(
      t.mutation(api.upsertTodoFromDevice, create),
    ).resolves.toMatchObject({ outcome: "inserted" });
    await expectCode(
      t.mutation(api.upsertTodoFromDevice, create),
      "ENTITY_CONFLICT",
    );
    await expectCode(
      t.mutation(api.upsertTodoFromDevice, {
        ...create,
        operation: "update",
      }),
      "REVISION_REQUIRED",
    );
    await expectCode(
      t.mutation(api.upsertTodoFromDevice, {
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
        activeProfile: "mason",
        owner: "mason",
        sourceFile: "todos",
        todo,
      }),
      "REVISION_REQUIRED",
    );

    const revision = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", todo.id))
        .unique();
      return row!.updatedAtMs;
    });
    await expect(
      t.mutation(api.upsertTodoFromDevice, {
        ...create,
        operation: "update",
        baseUpdatedAtMs: revision,
        todo: { ...todo, title: "Updated" },
      }),
    ).resolves.toMatchObject({ outcome: "updated" });
    await expectCode(
      t.mutation(api.upsertTodoFromDevice, {
        ...create,
        operation: "update",
        baseUpdatedAtMs: revision,
      }),
      "ENTITY_CONFLICT",
    );

    const updatedRevision = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", todo.id))
        .unique();
      return row!.updatedAtMs;
    });
    const deleteRequest = {
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      entityId: todo.id,
    };
    await expectCode(
      t.mutation(api.deleteTodoFromDevice, deleteRequest),
      "REVISION_REQUIRED",
    );
    await expect(
      t.mutation(api.deleteTodoFromDevice, {
        ...deleteRequest,
        baseUpdatedAtMs: updatedRevision,
      }),
    ).resolves.toMatchObject({ removed: true });
    await expectCode(
      t.mutation(api.upsertTodoFromDevice, create),
      "ENTITY_DELETED",
    );

    const restoreRequest = { ...deleteRequest };
    await expectCode(
      t.mutation(api.restoreTodoFromDevice, restoreRequest),
      "REVISION_REQUIRED",
    );
    await expect(
      t.mutation(api.restoreTodoFromDevice, {
        ...restoreRequest,
        baseUpdatedAtMs: updatedRevision,
      }),
    ).resolves.toMatchObject({ entityId: todo.id });
  });

  it("authenticates the device before enforcing exact-profile task ownership", async () => {
    const device = await pairMobileDevice(t, syncToken, "profile-task-device", [
      "todos:write",
    ], "mason");
    const todo = {
      id: "mason-private",
      owner: "mason",
      title: "Mason private",
      done: false,
      flagged: false,
    };
    const request = {
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      operation: "create",
      todo,
    };

    await expect(
      t.mutation(api.upsertTodoFromDevice, {
        ...request,
        deviceToken: freshSecret(),
        activeProfile: "victor",
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);

    await t.run(async (ctx) => {
      const stored = await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique();
      await ctx.db.patch(stored!._id, { lastSeenAt: 0 });
    });
    await expect(
      t.mutation(api.upsertTodoFromDevice, {
        ...request,
        activeProfile: "victor",
      }),
    ).rejects.toThrow(/must match credential profile mason/);
    expect(
      await t.run(async (ctx) => {
        const stored = await ctx.db
          .query("mobileDevices")
          .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
          .unique();
        return stored!.lastSeenAt;
      }),
    ).toBe(0);

    await t.mutation(api.upsertTodoFromDevice, request);
    const revision = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", todo.id))
        .unique();
      return row!.updatedAtMs;
    });

    const deleteRequest = {
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      entityId: todo.id,
      baseUpdatedAtMs: revision,
    };
    await expect(
      t.mutation(api.deleteTodoFromDevice, {
        ...deleteRequest,
        activeProfile: "victor",
      }),
    ).rejects.toThrow(/must match credential profile mason/);
    await t.mutation(api.deleteTodoFromDevice, deleteRequest);
    await expect(
      t.mutation(api.deleteTodoFromDevice, {
        ...deleteRequest,
        activeProfile: "victor",
        owner: "victor",
      }),
    ).rejects.toThrow(/must match credential profile mason/);

    await expect(
      t.mutation(api.restoreTodoFromDevice, {
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
        activeProfile: "victor",
        owner: "mason",
        sourceFile: "todos",
        entityId: todo.id,
        baseUpdatedAtMs: revision,
      }),
    ).rejects.toThrow(/must match credential profile mason/);
    await expect(
      t.mutation(api.restoreTodoFromDevice, {
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
        activeProfile: "mason",
        owner: "mason",
        sourceFile: "todos",
        entityId: todo.id,
        baseUpdatedAtMs: revision,
      }),
    ).resolves.toMatchObject({ entityId: todo.id });
  });

  it.each(["Linux", "Android"])(
    "accepts profile-bound %s device upsert, delete, and restore payloads",
    async (client) => {
      const device = await pairMobileDevice(
        t,
        syncToken,
        `${client.toLowerCase()}-wire-device`,
        ["todos:write"],
        "mason",
      );
      const todo = {
        id: `${client.toLowerCase()}-wire-todo`,
        owner: "mason",
        title: `${client} shipped payload`,
        done: false,
        flagged: false,
      };
      const request = {
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
        activeProfile: "mason",
        owner: "mason",
        sourceFile: "todos",
        operation: "create",
        todo,
      };

      await expect(
        t.mutation(api.upsertTodoFromDevice, request),
      ).resolves.toMatchObject({ entityId: todo.id, outcome: "inserted" });
      const revision = await t.run(async (ctx) => {
        const row = await ctx.db
          .query("todos")
          .withIndex("by_todo_id", (q) => q.eq("todoId", todo.id))
          .unique();
        return row!.updatedAtMs;
      });

      await expect(
        t.mutation(api.deleteTodoFromDevice, {
          deviceId: device.deviceId,
          deviceToken: device.deviceToken,
          activeProfile: "mason",
          owner: "mason",
          sourceFile: "todos",
          entityId: todo.id,
          baseUpdatedAtMs: revision,
        }),
      ).resolves.toMatchObject({ entityId: todo.id, removed: true });

      await expect(
        t.mutation(api.restoreTodoFromDevice, {
          deviceId: device.deviceId,
          deviceToken: device.deviceToken,
          activeProfile: "mason",
          owner: "mason",
          sourceFile: "todos",
          entityId: todo.id,
          baseUpdatedAtMs: revision,
        }),
      ).resolves.toMatchObject({ entityId: todo.id });
    },
  );
});
