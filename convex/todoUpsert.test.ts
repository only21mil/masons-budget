// SAT-1326 last-write-wins and SAT-1327 tombstones, exercised through the real
// mutations rather than by calling the helper directly — applyTodoUpsert is
// module-private and both front doors are supposed to share its semantics.
import { beforeEach, describe, expect, it } from "vitest";

import {
  api,
  freshSecret,
  pairMobileDevice,
  readDataFile,
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
let readToken: string;

beforeEach(() => {
  t = testConvex();
  syncToken = freshSecret();
  readToken = freshSecret();
  setDeploymentEnv({
    CONVEX_SYNC_TOKEN: syncToken,
    CONVEX_READ_TOKEN: readToken,
  });
});

const STORED = {
  id: "todo-1",
  title: "Stored title",
  text: "Stored title",
  updated_at: "2026-07-10T12:00:00.000Z",
};

describe("applyTodoUpsert: last write wins", () => {
  it("applies an incoming todo that is newer", async () => {
    await seedDataFile(t, "todos", [STORED]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        title: "Newer title",
        updated_at: "2026-07-11T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo.title).toBe("Newer title");
    expect(todo.updated_at).toBe("2026-07-11T12:00:00.000Z");
  });

  it("ignores an incoming todo that is older", async () => {
    await seedDataFile(t, "todos", [STORED]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        title: "Stale title",
        updated_at: "2026-07-09T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo.title).toBe("Stored title");
  });

  it("lets the incoming write win a tie", async () => {
    await seedDataFile(t, "todos", [STORED]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        title: "Same instant",
        updated_at: STORED.updated_at,
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo.title).toBe("Same instant");
  });

  it("treats a stored todo with no timestamp as infinitely old", async () => {
    await seedDataFile(t, "todos", [{ id: "todo-1", title: "No timestamp" }]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        title: "Wins",
        updated_at: "2020-01-01T00:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo.title).toBe("Wins");
  });

  it("stamps an incoming todo with no timestamp as now, so it wins", async () => {
    await seedDataFile(t, "todos", [STORED]);
    await t.mutation(api.upsertTodo, {
      todo: { id: "todo-1", title: "Untimestamped" },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo.title).toBe("Untimestamped");
    expect(String(todo.updated_at)).not.toBe("");
  });

  it("appends a todo it has never seen", async () => {
    await seedDataFile(t, "todos", [STORED]);
    await t.mutation(api.upsertTodo, {
      todo: { id: "todo-2", title: "Brand new" },
      token: syncToken,
    });

    const todos = await readTodos(t);
    expect(todos.map((todo) => todo.id)).toEqual(["todo-1", "todo-2"]);
  });

  it("creates the todos file when none exists", async () => {
    const result = await t.mutation(api.upsertTodo, {
      todo: { id: "todo-1", title: "First ever" },
      token: syncToken,
    });

    expect(result).toMatchObject({ name: "todos", version: 1, id: "todo-1" });
    expect(await readTodos(t)).toHaveLength(1);
  });

  it("preserves the { todos: [...] } wrapper shape", async () => {
    await seedDataFile(t, "todos", { todos: [STORED], meta: { source: "mc2" } });
    await t.mutation(api.upsertTodo, {
      todo: { id: "todo-2", title: "Brand new" },
      token: syncToken,
    });

    const doc = await readDataFile(t, "todos");
    expect(doc?.data).toMatchObject({ meta: { source: "mc2" } });
    expect((doc?.data as { todos: unknown[] }).todos).toHaveLength(2);
  });

  // ⚠️ Documented current behaviour, NOT endorsed. A rejected write still
  // rewrites the payload and bumps the version, so every client re-fetches for
  // a no-op change. Harmless today, wasteful at MC2 sync frequency.
  it("bumps the version even when last-write-wins discards the write", async () => {
    await seedDataFile(t, "todos", [STORED], 7);
    const result = await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        title: "Stale title",
        updated_at: "2026-07-09T12:00:00.000Z",
      },
      token: syncToken,
    });

    expect(result.version).toBe(8);
    const versions = await t.query(api.getVersions, { token: readToken });
    expect(versions.todos).toBe(8);
  });

  // ⚠️ REAL BUG, documented here rather than fixed (see the PR).
  // applyTodoUpsert REPLACES the stored todo with the normalized incoming one
  // instead of merging, and normalizeTodoRecord fills every absent field with a
  // default. A partial upsert therefore silently destroys notes, project, area,
  // due date and owner. completeTodoFromMobile dodges this by merging with the
  // stored record first; upsertTodoFromMobile and upsertTodo do not.
  it("wipes fields absent from a partial upsert (known data-loss bug)", async () => {
    await seedDataFile(t, "todos", [
      {
        id: "todo-1",
        title: "Buy milk",
        notes: "semi-skimmed",
        project: "Errands",
        area: "Home",
        due_date: "2026-08-01",
        owner: "rachel",
        updated_at: "2026-07-10T12:00:00.000Z",
      },
    ]);

    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        title: "Buy milk",
        done: true,
        updated_at: "2026-07-11T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({
      done: true,
      notes: "",
      area: "",
      dueDate: "",
      due_date: "",
      project: "Inbox",
      owner: "victor",
    });
  });

  it("shares the same semantics through the mobile front door", async () => {
    const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
    await seedDataFile(t, "todos", [STORED]);

    await t.mutation(api.upsertTodoFromMobile, {
      deviceId,
      deviceToken,
      todo: {
        id: "todo-1",
        title: "Stale from phone",
        updated_at: "2026-07-09T12:00:00.000Z",
      },
    });

    const [todo] = await readTodos(t);
    expect(todo.title).toBe("Stored title");
  });
});

describe("removeTodo: tombstones", () => {
  it("removes the todo and records a tombstone", async () => {
    await seedDataFile(t, "todos", [
      { id: "todo-1", title: "Gone" },
      { id: "todo-2", title: "Kept" },
    ]);

    const result = await t.mutation(api.removeTodo, {
      todoId: "todo-1",
      token: syncToken,
    });

    expect(result).toMatchObject({ name: "todos", removed: true });
    expect(await readTodos(t)).toEqual([{ id: "todo-2", title: "Kept" }]);
    await expect(
      t.query(api.listTodoTombstones, { token: readToken }),
    ).resolves.toMatchObject([{ id: "todo-1" }]);
  });

  it("still records a tombstone for a todo that is not in the payload", async () => {
    // The bridge has to learn about deletes for todos that only ever existed
    // locally, so the tombstone is written before the payload is touched.
    await seedDataFile(t, "todos", [{ id: "todo-2", title: "Kept" }], 3);

    const result = await t.mutation(api.removeTodo, {
      todoId: "todo-ghost",
      token: syncToken,
    });

    expect(result).toMatchObject({ removed: false });
    expect(result.version).toBeUndefined();
    const doc = await readDataFile(t, "todos");
    expect(doc?.version).toBe(3);
    await expect(
      t.query(api.listTodoTombstones, { token: readToken }),
    ).resolves.toMatchObject([{ id: "todo-ghost" }]);
  });

  it("records a tombstone even when no todos file exists at all", async () => {
    const result = await t.mutation(api.removeTodo, {
      todoId: "todo-ghost",
      token: syncToken,
    });

    expect(result).toMatchObject({ removed: false });
    await expect(
      t.query(api.listTodoTombstones, { token: readToken }),
    ).resolves.toMatchObject([{ id: "todo-ghost" }]);
  });

  it("keeps one tombstone row per id and refreshes deletedAt", async () => {
    await seedDataFile(t, "todos", [{ id: "todo-1", title: "Gone" }]);
    await t.mutation(api.removeTodo, { todoId: "todo-1", token: syncToken });

    const first = await t.run(async (ctx) =>
      ctx.db.query("todoTombstones").collect(),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(first[0]._id, { deletedAt: 0 });
    });

    await t.mutation(api.removeTodo, { todoId: "todo-1", token: syncToken });

    const second = await t.run(async (ctx) =>
      ctx.db.query("todoTombstones").collect(),
    );
    expect(second).toHaveLength(1);
    expect(second[0].deletedAt).toBeGreaterThan(0);
  });

  it("bumps the version so clients re-fetch the cleaned list", async () => {
    await seedDataFile(t, "todos", [{ id: "todo-1", title: "Gone" }], 4);
    const result = await t.mutation(api.removeTodo, {
      todoId: "todo-1",
      token: syncToken,
    });

    expect(result.version).toBe(5);
    const versions = await t.query(api.getVersions, { token: readToken });
    expect(versions.todos).toBe(5);
  });

  it("preserves the { todos: [...] } wrapper on delete", async () => {
    await seedDataFile(t, "todos", {
      todos: [{ id: "todo-1" }, { id: "todo-2" }],
      meta: { source: "mc2" },
    });

    await t.mutation(api.removeTodo, { todoId: "todo-1", token: syncToken });

    const doc = await readDataFile(t, "todos");
    expect(doc?.data).toMatchObject({ meta: { source: "mc2" } });
    expect((doc?.data as { todos: { id: string }[] }).todos).toEqual([
      { id: "todo-2" },
    ]);
  });

  // Documented: the tombstone is advisory for the MC2 bridge, it does not fence
  // future writes. A re-upsert of the same id resurrects the todo in Convex.
  it("does not block a later upsert of the same id", async () => {
    await seedDataFile(t, "todos", [{ id: "todo-1", title: "Gone" }]);
    await t.mutation(api.removeTodo, { todoId: "todo-1", token: syncToken });
    await t.mutation(api.upsertTodo, {
      todo: { id: "todo-1", title: "Back again" },
      token: syncToken,
    });

    const todos = await readTodos(t);
    expect(todos.map((todo) => todo.id)).toEqual(["todo-1"]);
    await expect(
      t.query(api.listTodoTombstones, { token: readToken }),
    ).resolves.toMatchObject([{ id: "todo-1" }]);
  });
});
