// SAT-1328: convex/todoNormalize.ts is a hand-synced MIRROR of
// mission-control/lib/todo-normalize.js. Nothing mechanical keeps the two in
// step, so these tests pin the observable contract of the copy: the dual-field
// superset, the lane resolution order, and the LWW timestamp rules.
import { describe, expect, it } from "vitest";

import {
  canonicalTodoId,
  isAppCreatedTodo,
  mergeTodoPayload,
  normalizeTodoLane,
  normalizeTodoRecord,
  resolveTodoLane,
  todoUpdatedMs,
} from "./todoNormalize";

describe("normalizeTodoLane", () => {
  it("accepts the three known lanes", () => {
    expect(normalizeTodoLane("work")).toBe("work");
    expect(normalizeTodoLane("personal")).toBe("personal");
    expect(normalizeTodoLane("sats")).toBe("sats");
  });

  it("trims and lowercases", () => {
    expect(normalizeTodoLane("  WORK  ")).toBe("work");
    expect(normalizeTodoLane("Personal")).toBe("personal");
  });

  it("rejects anything else", () => {
    expect(normalizeTodoLane("finance")).toBeNull();
    expect(normalizeTodoLane("")).toBeNull();
    expect(normalizeTodoLane(null)).toBeNull();
    expect(normalizeTodoLane(undefined)).toBeNull();
  });
});

describe("resolveTodoLane", () => {
  it("prefers category, then type, then list", () => {
    expect(resolveTodoLane({ category: "work", type: "sats", list: "personal" })).toBe("work");
    expect(resolveTodoLane({ type: "sats", list: "personal" })).toBe("sats");
    expect(resolveTodoLane({ list: "personal" })).toBe("personal");
  });

  it("skips unrecognised values rather than failing on them", () => {
    expect(resolveTodoLane({ category: "Inbox", type: "work" })).toBe("work");
  });

  it("returns null when nothing resolves", () => {
    expect(resolveTodoLane({})).toBeNull();
    expect(resolveTodoLane({ category: "Inbox" })).toBeNull();
  });
});

describe("canonicalTodoId", () => {
  it("keeps an existing id", () => {
    expect(canonicalTodoId({ id: "vv-123" })).toBe("vv-123");
  });

  it("generates lane-initial + timestamp when the id is missing or blank", () => {
    expect(canonicalTodoId({ category: "work" }, { now: 1700000000000 })).toBe("w1700000000000");
    expect(canonicalTodoId({ id: "   " }, { now: 1700000000000 })).toBe("s1700000000000");
  });

  it("defaults the lane to sats", () => {
    expect(canonicalTodoId({}, { now: 1 })).toBe("s1");
  });

  it("resolves the lane from project when category and type are absent", () => {
    expect(canonicalTodoId({ project: "personal" }, { now: 1 })).toBe("p1");
  });
});

describe("isAppCreatedTodo", () => {
  it("recognises the three app markers", () => {
    expect(isAppCreatedTodo({ id: "vv-1" })).toBe(true);
    expect(isAppCreatedTodo({ id: "s1", created_by: "vogel-vault" })).toBe(true);
    expect(isAppCreatedTodo({ id: "s1", sync_source: "vogel-vault" })).toBe(true);
  });

  it("does not claim MC2-created todos", () => {
    expect(isAppCreatedTodo({ id: "s1" })).toBe(false);
    expect(isAppCreatedTodo({})).toBe(false);
  });
});

describe("normalizeTodoRecord: the dual-field superset", () => {
  const now = Date.parse("2026-07-26T10:00:00.000Z");

  it("emits both spellings of every dual-named field", () => {
    const record = normalizeTodoRecord(
      {
        id: "todo-1",
        title: "Buy milk",
        dueDate: "2026-08-01T00:00:00Z",
        createdAt: "2026-07-01T09:00:00.000Z",
        updated_at: "2026-07-20T09:00:00.000Z",
        flag: true,
      },
      { now },
    );

    expect(record.dueDate).toBe("2026-08-01");
    expect(record.due_date).toBe(record.dueDate);
    expect(record.updatedAt).toBe("2026-07-20T09:00:00.000Z");
    expect(record.updated_at).toBe(record.updatedAt);
    expect(record.flag).toBe(true);
    expect(record.flagged).toBe(record.flag);
    expect(record.createdAt).toBe("2026-07-01T09:00:00.000Z");
    // `created` is the date-only projection of createdAt.
    expect(record.created).toBe("2026-07-01");
  });

  it("accepts either spelling on the way in", () => {
    const snake = normalizeTodoRecord(
      { id: "a", due_date: "2026-08-01", updated_at: "2026-07-20T09:00:00.000Z", flagged: true },
      { now },
    );
    const camel = normalizeTodoRecord(
      { id: "a", dueDate: "2026-08-01", updatedAt: "2026-07-20T09:00:00.000Z", flag: true },
      { now },
    );
    expect(snake.dueDate).toBe(camel.dueDate);
    expect(snake.updated_at).toBe(camel.updated_at);
    expect(snake.flagged).toBe(camel.flagged);
  });

  it("mirrors title and text in both directions", () => {
    expect(normalizeTodoRecord({ id: "a", title: "Buy milk" }, { now }).text).toBe("Buy milk");
    expect(normalizeTodoRecord({ id: "a", text: "Buy milk" }, { now }).title).toBe("Buy milk");
    expect(normalizeTodoRecord({ id: "a" }, { now }).title).toBe("");
  });

  it("falls back to updatedAt then completedAt for the update timestamp", () => {
    expect(
      normalizeTodoRecord({ id: "a", updatedAt: "2026-07-20T09:00:00.000Z" }, { now }).updated_at,
    ).toBe("2026-07-20T09:00:00.000Z");
    expect(
      normalizeTodoRecord({ id: "a", completedAt: "2026-07-21T09:00:00.000Z" }, { now }).updated_at,
    ).toBe("2026-07-21T09:00:00.000Z");
  });

  it("defaults missing timestamps to now, and to empty when asked not to", () => {
    const stamped = normalizeTodoRecord({ id: "a" }, { now });
    expect(stamped.updatedAt).toBe("2026-07-26T10:00:00.000Z");
    expect(stamped.createdAt).toBe("2026-07-26T10:00:00.000Z");

    const bare = normalizeTodoRecord({ id: "a" }, { now, defaultTimestamps: false });
    expect(bare.updatedAt).toBe("");
    expect(bare.createdAt).toBe("");
    expect(bare.created).toBe("");
  });
});

describe("normalizeTodoRecord: derived fields", () => {
  const now = Date.parse("2026-07-26T10:00:00.000Z");

  it("derives status from done/completed", () => {
    expect(normalizeTodoRecord({ id: "a", done: true }, { now }).status).toBe("completed");
    expect(normalizeTodoRecord({ id: "a", completed: true }, { now }).status).toBe("completed");
    expect(normalizeTodoRecord({ id: "a" }, { now }).status).toBe("pending");
  });

  it("derives done from an explicit completed status", () => {
    expect(normalizeTodoRecord({ id: "a", status: "completed" }, { now }).done).toBe(true);
  });

  it("keeps a non-standard status verbatim", () => {
    const record = normalizeTodoRecord({ id: "a", status: "archived" }, { now });
    expect(record.status).toBe("archived");
    expect(record.done).toBe(false);
  });

  // Documented asymmetry: an explicit status wins for `status`, but `done` is
  // still true, so a `{ done: true, status: "pending" }` input round-trips as a
  // record that disagrees with itself. Faithfully mirrored from the canonical
  // normalizer; flagged rather than fixed.
  it("does not reconcile an explicit status against an explicit done", () => {
    const record = normalizeTodoRecord({ id: "a", done: true, status: "pending" }, { now });
    expect(record.status).toBe("pending");
    expect(record.done).toBe(true);
  });

  it("defaults lane, project, owner and assignee", () => {
    const record = normalizeTodoRecord({ id: "a" }, { now });
    expect(record.category).toBe("sats");
    expect(record.type).toBe("sats");
    expect(record.project).toBe("Inbox");
    expect(record.owner).toBe("victor");
    expect(record.assignee).toBe("victor");
  });

  it("lets assignee fall back to owner", () => {
    const record = normalizeTodoRecord({ id: "a", owner: "rachel" }, { now });
    expect(record.assignee).toBe("rachel");
  });

  it("coerces priority to a number", () => {
    expect(normalizeTodoRecord({ id: "a" }, { now }).priority).toBe(0);
    expect(normalizeTodoRecord({ id: "a", priority: 3 }, { now }).priority).toBe(3);
  });

  it("only emits completion fields when the input carried them", () => {
    const without = normalizeTodoRecord({ id: "a" }, { now });
    expect(without).not.toHaveProperty("completedAt");
    expect(without).not.toHaveProperty("completed_by");

    const with_ = normalizeTodoRecord(
      { id: "a", completedAt: "2026-07-20T09:00:00.000Z", completed_by: "vogel-vault-mobile" },
      { now },
    );
    expect(with_.completedAt).toBe("2026-07-20T09:00:00.000Z");
    expect(with_.completed_by).toBe("vogel-vault-mobile");
  });

  it("survives a non-object input", () => {
    const record = normalizeTodoRecord(null as unknown as Record<string, unknown>, { now });
    expect(record.title).toBe("");
    expect(record.category).toBe("sats");
  });
});

// mergeTodoPayload is Convex-only — the canonical CJS normalizer has
// no merge step — so nothing upstream pins it. These are its contract.
describe("mergeTodoPayload", () => {
  const now = Date.parse("2026-07-26T10:00:00.000Z");
  const nowIso = "2026-07-26T10:00:00.000Z";
  const STORED = {
    id: "todo-1",
    title: "Buy milk",
    text: "Buy milk",
    notes: "semi-skimmed",
    project: "Errands",
    owner: "rachel",
    dueDate: "2026-08-01",
    due_date: "2026-08-01",
    updated_at: "2026-07-10T12:00:00.000Z",
  };

  it("inherits everything the payload does not mention", () => {
    const merged = mergeTodoPayload(STORED, { id: "todo-1", done: true }, { now });
    expect(merged).toMatchObject({
      notes: "semi-skimmed",
      project: "Errands",
      owner: "rachel",
      dueDate: "2026-08-01",
      done: true,
    });
  });

  it("treats an undefined value as absence, not as a clear", () => {
    // Convex hands an omitted optional to the handler as `undefined`.
    const merged = mergeTodoPayload(STORED, { id: "todo-1", notes: undefined }, { now });
    expect(merged.notes).toBe("semi-skimmed");
  });

  it("passes an explicit null through so the normalizer can clear the field", () => {
    const merged = mergeTodoPayload(STORED, { id: "todo-1", notes: null }, { now });
    expect(merged.notes).toBeNull();
    expect(normalizeTodoRecord(merged, { now }).notes).toBe("");
  });

  it("drops every alias in a group the payload touched", () => {
    // Stored `dueDate` is read first by the normalizer, so leaving it in place
    // would silently veto an incoming `due_date`.
    const merged = mergeTodoPayload(STORED, { id: "todo-1", due_date: "2026-09-15" }, { now });
    expect(merged).not.toHaveProperty("dueDate");
    expect(normalizeTodoRecord(merged, { now }).dueDate).toBe("2026-09-15");
  });

  it("groups title with text, and done with status and the completion fields", () => {
    const stored = {
      ...STORED,
      status: "completed",
      done: true,
      completedAt: "2026-07-10T12:00:00.000Z",
      completed_by: "vogel-vault-mobile",
    };

    const reopened = mergeTodoPayload(stored, { id: "todo-1", done: false }, { now });
    expect(reopened).not.toHaveProperty("status");
    expect(reopened).not.toHaveProperty("completedAt");
    expect(reopened).not.toHaveProperty("completed_by");

    const retitled = mergeTodoPayload(stored, { id: "todo-1", text: "Buy oat milk" }, { now });
    expect(retitled).not.toHaveProperty("title");
    // An unrelated edit leaves the completion alone.
    expect(retitled.completedAt).toBe("2026-07-10T12:00:00.000Z");
  });

  it("leaves `when` alone rather than treating it as a due-date alias", () => {
    // This normalizer never reads `when`, so grouping it with dueDate would
    // erase a real due date and put nothing back.
    const merged = mergeTodoPayload(STORED, { id: "todo-1", when: "anytime" }, { now });
    expect(merged.dueDate).toBe("2026-08-01");
  });

  it("drops a stored type that merely mirrors the lane, keeps a custom one", () => {
    expect(
      mergeTodoPayload({ ...STORED, category: "personal", type: "personal" }, { id: "todo-1", category: "work" }, { now }),
    ).not.toHaveProperty("type");
    expect(
      mergeTodoPayload({ ...STORED, category: "personal", type: "reminder" }, { id: "todo-1", category: "work" }, { now })
        .type,
    ).toBe("reminder");
  });

  it("stamps the write from the payload, never from the stored record", () => {
    expect(mergeTodoPayload(STORED, { id: "todo-1", notes: "oat" }, { now }).updated_at).toBe(nowIso);
    expect(
      mergeTodoPayload(STORED, { id: "todo-1", updatedAt: "2026-07-11T12:00:00.000Z" }, { now }).updated_at,
    ).toBe("2026-07-11T12:00:00.000Z");
    // A blank stamp is not a stamp; it would lose every future LWW comparison.
    expect(mergeTodoPayload(STORED, { id: "todo-1", updated_at: "" }, { now }).updated_at).toBe(nowIso);
    // Completing carries its own instant.
    expect(
      mergeTodoPayload(STORED, { id: "todo-1", completedAt: "2026-07-12T12:00:00.000Z" }, { now }).updated_at,
    ).toBe("2026-07-12T12:00:00.000Z");
  });

  it("writes both spellings of the stamp so no stored fallback can shadow it", () => {
    const merged = mergeTodoPayload({ ...STORED, completedAt: "2030-01-01T00:00:00.000Z" }, { id: "todo-1", notes: "oat" }, { now });
    expect(merged.updated_at).toBe(nowIso);
    expect(merged.updatedAt).toBe(nowIso);
    expect(normalizeTodoRecord(merged, { now }).updatedAt).toBe(nowIso);
  });

  it("survives a missing or non-object stored record", () => {
    expect(mergeTodoPayload(null, { id: "todo-1", title: "New" }, { now })).toMatchObject({
      id: "todo-1",
      title: "New",
      updated_at: nowIso,
    });
    expect(mergeTodoPayload(STORED, null, { now }).notes).toBe("semi-skimmed");
  });
});

describe("todoUpdatedMs", () => {
  it("prefers updated_at, then updatedAt, then completedAt", () => {
    expect(todoUpdatedMs({ updated_at: "2026-07-20T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" }))
      .toBe(Date.parse("2026-07-20T00:00:00.000Z"));
    expect(todoUpdatedMs({ updatedAt: "2026-07-20T00:00:00.000Z" }))
      .toBe(Date.parse("2026-07-20T00:00:00.000Z"));
    expect(todoUpdatedMs({ completedAt: "2026-07-20T00:00:00.000Z" }))
      .toBe(Date.parse("2026-07-20T00:00:00.000Z"));
  });

  it("returns 0 for missing or unparseable timestamps (LWW honesty)", () => {
    expect(todoUpdatedMs({})).toBe(0);
    expect(todoUpdatedMs({ updated_at: null })).toBe(0);
    expect(todoUpdatedMs({ updated_at: "" })).toBe(0);
    expect(todoUpdatedMs({ updated_at: "not a date" })).toBe(0);
  });

  // Documented sharp edge: the fallback chain uses `??`, so an EMPTY-STRING
  // updated_at short-circuits the chain and hides a perfectly good updatedAt.
  // Such a record always loses LWW.
  it("an empty updated_at masks a valid updatedAt", () => {
    expect(todoUpdatedMs({ updated_at: "", updatedAt: "2026-07-20T00:00:00.000Z" })).toBe(0);
  });

  it("accepts a date-only string", () => {
    expect(todoUpdatedMs({ updated_at: "2026-07-20" })).toBe(Date.parse("2026-07-20"));
  });
});
