import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  freshSecret,
  pairMobileDevice,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

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
      activeProfile: Member;
      todo: Record<string, unknown>;
      token: string;
    },
    { todoId: string; owner: Member; outcome: "inserted" | "updated" }
  >,
  deleteTodo: "tables:deleteTodo" as unknown as FunctionReference<
    "mutation",
    "public",
    { activeProfile: Member; owner: Member; todoId: string; token: string },
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
  it("requires an exact active profile and owner on sync-token task writes", async () => {
    await expect(
      t.mutation(api.upsertTodo, {
        activeProfile: "victor",
        todo: { id: "private-rachel", title: "Rachel private" },
        token: syncToken,
      }),
    ).rejects.toThrow(/owner must be one of/);

    await expect(
      t.mutation(api.upsertTodo, {
        activeProfile: "victor",
        todo: {
          id: "private-rachel",
          title: "Rachel private",
          owner: "rachel",
        },
        token: syncToken,
      }),
    ).rejects.toThrow(/Active profile victor may not access todos owned by rachel/);

    await expect(
      t.mutation(api.upsertTodo, {
        activeProfile: "rachel",
        todo: {
          id: "private-rachel",
          title: "Rachel private",
          owner: "rachel",
        },
        token: syncToken,
      }),
    ).resolves.toMatchObject({ owner: "rachel", outcome: "inserted" });

    const [rachel, victor] = await Promise.all([
      t.query(api.listTodos, { viewer: "rachel", token: readToken }),
      t.query(api.listTodos, { viewer: "victor", token: readToken }),
    ]);
    expect(rachel.rows.map((row) => row.todoId)).toEqual(["private-rachel"]);
    expect(victor.rows).toEqual([]);

    await expect(
      t.mutation(api.deleteTodo, {
        activeProfile: "victor",
        owner: "rachel",
        todoId: "private-rachel",
        token: syncToken,
      }),
    ).rejects.toThrow(/Active profile victor may not access todos owned by rachel/);
    await expect(
      t.mutation(api.deleteTodo, {
        activeProfile: "rachel",
        owner: "rachel",
        todoId: "private-rachel",
        token: syncToken,
      }),
    ).resolves.toEqual({ todoId: "private-rachel", removed: true });
  });

  it("authenticates the device before enforcing exact-profile task ownership", async () => {
    const device = await pairMobileDevice(t, syncToken, "profile-task-device", [
      "todos:write",
    ]);
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
    ).rejects.toThrow(/Active profile victor may not access todos owned by mason/);
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
    ).rejects.toThrow(/Active profile victor may not access todos owned by mason/);
    await t.mutation(api.deleteTodoFromDevice, deleteRequest);
    await expect(
      t.mutation(api.deleteTodoFromDevice, {
        ...deleteRequest,
        activeProfile: "victor",
        owner: "victor",
      }),
    ).rejects.toThrow(/Deleted todo mason-private belongs to mason, not victor/);

    await expect(
      t.mutation(api.restoreTodoFromDevice, {
        ...request,
        activeProfile: "victor",
        baseUpdatedAtMs: revision,
      }),
    ).rejects.toThrow(/Active profile victor may not access todos owned by mason/);
    await expect(
      t.mutation(api.restoreTodoFromDevice, {
        ...request,
        baseUpdatedAtMs: revision,
      }),
    ).resolves.toMatchObject({ entityId: todo.id });
  });
});
