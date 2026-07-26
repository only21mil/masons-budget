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

  // A discarded write moves nothing, so the version must not move either —
  // every client polls getVersions, and a bump would send all of them back for
  // a byte-identical file at MC2 sync frequency.
  it("leaves the version alone when last-write-wins discards the write", async () => {
    await seedDataFile(t, "todos", [STORED], 7);
    const result = await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        title: "Stale title",
        updated_at: "2026-07-09T12:00:00.000Z",
      },
      token: syncToken,
    });

    expect(result).toMatchObject({ version: 7, applied: false });
    const versions = await t.query(api.getVersions, { token: readToken });
    expect(versions.todos).toBe(7);
    const doc = await readDataFile(t, "todos");
    expect(doc?.version).toBe(7);
  });

  it("reports applied and a bumped version when the write lands", async () => {
    await seedDataFile(t, "todos", [STORED], 7);
    const result = await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        title: "Newer title",
        updated_at: "2026-07-11T12:00:00.000Z",
      },
      token: syncToken,
    });

    expect(result).toMatchObject({ version: 8, applied: true });
    const versions = await t.query(api.getVersions, { token: readToken });
    expect(versions.todos).toBe(8);
  });

  it("bumps the version for a todo it has never seen", async () => {
    await seedDataFile(t, "todos", [STORED], 7);
    const result = await t.mutation(api.upsertTodo, {
      todo: { id: "todo-2", title: "Brand new" },
      token: syncToken,
    });

    expect(result).toMatchObject({ version: 8, applied: true });
  });

  it("does not bump the version for a stale write through the mobile door", async () => {
    const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
    await seedDataFile(t, "todos", [STORED], 7);

    const result = await t.mutation(api.upsertTodoFromMobile, {
      deviceId,
      deviceToken,
      todo: {
        id: "todo-1",
        title: "Stale from phone",
        updated_at: "2026-07-09T12:00:00.000Z",
      },
    });

    expect(result).toMatchObject({ ok: true, version: 7, applied: false });
    const versions = await t.query(api.getVersions, { token: readToken });
    expect(versions.todos).toBe(7);
  });

  // The blank-alias fix, exercised end to end: the stored record's real stamp
  // is behind an empty updated_at, and it must still beat an older write.
  it("does not let a blank updated_at hand the write to an older record", async () => {
    await seedDataFile(t, "todos", [
      {
        id: "todo-1",
        title: "Stored title",
        updated_at: "",
        updatedAt: "2026-07-10T12:00:00.000Z",
      },
    ]);

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

  it("never stores a todo whose done and status disagree", async () => {
    await t.mutation(api.upsertTodo, {
      todo: { id: "todo-1", title: "Checked off", done: true, status: "pending" },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({ done: true, status: "completed" });
  });

  // ⚠️ REAL BUG, documented here rather than fixed (see the PR).
  // applyTodoUpsert REPLACES the stored todo with the normalized incoming one
  // instead of merging, and normalizeTodoRecord fills every absent field with a
  // default. A partial upsert therefore silently destroys notes, project, area,
  // due date and owner. completeTodoFromMobile dodges this by merging with the
  // stored record first; upsertTodoFromMobile and upsertTodo do not.

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

// The bug these pin: applyTodoUpsert used to REPLACE the stored todo
// with the normalized incoming one, and normalizeTodoRecord defaults every
// absent field, so a phone toggling `done` reset notes, project, area, due date
// and owner. Merging fixes that without turning the record into a write-only
// accumulator: an explicit null or "" still clears.
describe("applyTodoUpsert: merges a partial payload", () => {
  const RICH = {
    id: "todo-1",
    title: "Buy milk",
    text: "Buy milk",
    notes: "semi-skimmed",
    project: "Errands",
    area: "Home",
    category: "personal",
    due_date: "2026-08-01",
    dueDate: "2026-08-01",
    owner: "rachel",
    assignee: "rachel",
    priority: 2,
    source: "things",
    createdAt: "2026-06-01T09:00:00.000Z",
    updated_at: "2026-07-10T12:00:00.000Z",
  };

  it("preserves every field the payload never mentioned", async () => {
    await seedDataFile(t, "todos", [RICH]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        done: true,
        updated_at: "2026-07-11T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({
      done: true,
      status: "completed",
      title: "Buy milk",
      notes: "semi-skimmed",
      project: "Errands",
      area: "Home",
      category: "personal",
      dueDate: "2026-08-01",
      due_date: "2026-08-01",
      owner: "rachel",
      assignee: "rachel",
      priority: 2,
      source: "things",
      // Creation is not re-stamped by an edit either.
      createdAt: "2026-06-01T09:00:00.000Z",
      created: "2026-06-01",
    });
  });

  it("clears a field the payload explicitly nulls", async () => {
    await seedDataFile(t, "todos", [RICH]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        notes: null,
        area: null,
        due_date: null,
        updated_at: "2026-07-11T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({
      notes: "",
      area: "",
      dueDate: "",
      due_date: "",
      // Untouched neighbours still survive the clear.
      project: "Errands",
      owner: "rachel",
    });
  });

  it("clears a field the payload explicitly empties", async () => {
    await seedDataFile(t, "todos", [RICH]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        notes: "",
        project: "",
        updated_at: "2026-07-11T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({ notes: "", project: "", area: "Home" });
  });

  // Clearing means "back to this field's default", which for project and owner
  // is not empty. Nulling them hands the todo back to Inbox/victor rather than
  // leaving it ownerless — the visibility layer has no answer for ownerless.
  it("resolves a nulled project and owner to their defaults", async () => {
    await seedDataFile(t, "todos", [RICH]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        project: null,
        owner: null,
        assignee: null,
        updated_at: "2026-07-11T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({
      project: "Inbox",
      owner: "victor",
      assignee: "victor",
    });
  });

  it("lets the incoming spelling of a dual-named field win over the stored one", async () => {
    await seedDataFile(t, "todos", [RICH]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        // Stored record has BOTH spellings; the normalizer reads dueDate first,
        // so an inherited dueDate would veto this write.
        due_date: "2026-09-15",
        text: "Buy oat milk",
        updated_at: "2026-07-11T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({
      dueDate: "2026-09-15",
      due_date: "2026-09-15",
      title: "Buy oat milk",
      text: "Buy oat milk",
    });
  });

  it("lets an incoming done override a contradicting stored status", async () => {
    await seedDataFile(t, "todos", [
      { ...RICH, status: "pending", done: false },
    ]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        done: true,
        updated_at: "2026-07-11T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({ done: true, status: "completed" });
  });

  it("lets an incoming flagged:false unflag a stored flag:true", async () => {
    // `flag` is OR-ed with `flagged`, so an inherited flag can never be cleared.
    await seedDataFile(t, "todos", [{ ...RICH, flag: true, flagged: true }]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        flagged: false,
        updated_at: "2026-07-11T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({ flag: false, flagged: false });
  });

  it("keeps the completion stamp through an unrelated edit", async () => {
    await seedDataFile(t, "todos", [
      {
        ...RICH,
        done: true,
        status: "completed",
        completedAt: "2026-07-10T12:00:00.000Z",
        completed_by: "vogel-vault-mobile",
      },
    ]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        notes: "oat, not semi-skimmed",
        updated_at: "2026-07-11T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({
      done: true,
      status: "completed",
      completedAt: "2026-07-10T12:00:00.000Z",
      completed_by: "vogel-vault-mobile",
      notes: "oat, not semi-skimmed",
    });
  });

  it("drops the completion stamp when the payload reopens the todo", async () => {
    await seedDataFile(t, "todos", [
      {
        ...RICH,
        done: true,
        status: "completed",
        completedAt: "2026-07-10T12:00:00.000Z",
        completed_by: "vogel-vault-mobile",
      },
    ]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        done: false,
        updated_at: "2026-07-11T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({ done: false, status: "pending" });
    expect(todo).not.toHaveProperty("completedAt");
    expect(todo).not.toHaveProperty("completed_by");
  });

  // An edit that inherits the stored updated_at is invisible to the MC2 bridge,
  // which pulls on a strictly-newer comparison. The merge must not make a write
  // look like it never happened.
  it("advances the update stamp even when the payload carries none", async () => {
    await seedDataFile(t, "todos", [RICH]);
    await t.mutation(api.upsertTodo, {
      todo: { id: "todo-1", notes: "oat" },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo.notes).toBe("oat");
    expect(Date.parse(String(todo.updated_at))).toBeGreaterThan(
      Date.parse(RICH.updated_at),
    );
    expect(todo.updatedAt).toBe(todo.updated_at);
  });

  it("does not let an inherited timestamp rescue a stale write", async () => {
    await seedDataFile(t, "todos", [RICH]);
    await t.mutation(api.upsertTodo, {
      todo: {
        id: "todo-1",
        notes: "stale note",
        updated_at: "2026-07-09T12:00:00.000Z",
      },
      token: syncToken,
    });

    const [todo] = await readTodos(t);
    expect(todo.notes).toBe("semi-skimmed");
    expect(todo.updated_at).toBe(RICH.updated_at);
  });

  it("refreshes a derived lane type but keeps a custom one", async () => {
    await seedDataFile(t, "todos", [
      { ...RICH, category: "personal", type: "personal" },
      { ...RICH, id: "todo-2", category: "personal", type: "reminder" },
    ]);
    for (const id of ["todo-1", "todo-2"]) {
      await t.mutation(api.upsertTodo, {
        todo: { id, category: "work", updated_at: "2026-07-11T12:00:00.000Z" },
        token: syncToken,
      });
    }

    const [derived, custom] = await readTodos(t);
    expect(derived).toMatchObject({ category: "work", type: "work" });
    expect(custom).toMatchObject({ category: "work", type: "reminder" });
  });

  it("merges through the mobile front door too", async () => {
    const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
    await seedDataFile(t, "todos", [RICH]);

    await t.mutation(api.upsertTodoFromMobile, {
      deviceId,
      deviceToken,
      todo: {
        id: "todo-1",
        done: true,
        updated_at: "2026-07-11T12:00:00.000Z",
      },
    });

    const [todo] = await readTodos(t);
    expect(todo).toMatchObject({
      done: true,
      notes: "semi-skimmed",
      project: "Errands",
      owner: "rachel",
      sync_source: "vogel-vault",
    });
  });

  it("still defaults every field for a todo it has never seen", async () => {
    await seedDataFile(t, "todos", [RICH]);
    await t.mutation(api.upsertTodo, {
      todo: { id: "todo-2", title: "Brand new" },
      token: syncToken,
    });

    const todo = (await readTodos(t)).find((item) => item.id === "todo-2");
    expect(todo).toMatchObject({
      title: "Brand new",
      notes: "",
      area: "",
      dueDate: "",
      project: "Inbox",
      owner: "victor",
      category: "sats",
    });
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

    // The version is reported even though nothing moved, so a caller can tell
    // "tombstone only, you are already current" from "you are behind".
    expect(result).toMatchObject({ removed: false, version: 3 });
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

    // No file is version 0, not an absent field — the caller should not have to
    // treat "missing version" as a third case.
    expect(result).toMatchObject({ removed: false, version: 0 });
    await expect(
      t.query(api.listTodoTombstones, { token: readToken }),
    ).resolves.toMatchObject([{ id: "todo-ghost" }]);
  });

  it("reports the version through the mobile door too", async () => {
    const { deviceId, deviceToken } = await pairMobileDevice(t, syncToken);
    await seedDataFile(t, "todos", [{ id: "todo-2", title: "Kept" }], 3);

    const result = await t.mutation(api.removeTodoFromMobile, {
      deviceId,
      deviceToken,
      id: "todo-ghost",
    });

    expect(result).toMatchObject({ ok: true, removed: false, version: 3 });
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
