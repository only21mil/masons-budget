// ── Convex MIRROR of the canonical todo normalizer (SAT-1328) ──
//
// CANONICAL SOURCE: mission-control/lib/todo-normalize.js
//   (in this repo's sibling checkout, loaded by server.js + the MC2 sync bridge).
//
// Convex functions cannot import from outside the convex/ directory, so this is a
// DELIBERATE hand-synced copy of the minimal normalize/default logic used by
// dataFiles.ts:upsertTodo. If you change normalization in the canonical CJS
// source you MUST mirror the change here. A parity probe guards the dual-field
// emission (dueDate↔due_date, updatedAt↔updated_at, flag↔flagged, createdAt↔created).

const VALID_TODO_LANES = ["work", "personal", "sats"];

export function normalizeTodoLane(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  return VALID_TODO_LANES.includes(normalized) ? normalized : null;
}

export function resolveTodoLane(
  input: Record<string, any> = {},
): string | null {
  const { category, type, list } = input;
  return (
    normalizeTodoLane(category) ||
    normalizeTodoLane(type) ||
    normalizeTodoLane(list)
  );
}

export function canonicalTodoId(
  todo: Record<string, any>,
  opts: { now?: number | string; lane?: string } = {},
): string {
  const existing = todo == null ? null : todo.id;
  if (existing != null && String(existing).trim() !== "") {
    return String(existing);
  }

  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const lane =
    opts.lane ||
    resolveTodoLane({
      category: todo && todo.category,
      type: todo && todo.type,
      list: todo && todo.project,
    }) ||
    "sats";
  return `${lane[0]}${now}`;
}

export function isAppCreatedTodo(todo: Record<string, any>): boolean {
  const id = String((todo && todo.id) || "");
  return (
    id.startsWith("vv-") ||
    String((todo && todo.created_by) || "") === "vogel-vault" ||
    String((todo && todo.sync_source) || "") === "vogel-vault"
  );
}

function asIsoNow(now: number | string | null | undefined): string {
  if (now == null) return new Date().toISOString();
  if (typeof now === "number") return new Date(now).toISOString();
  return String(now);
}

/**
 * Canonical superset normalization for a single todo, used by upsertTodo.
 * `now` is epoch ms (Date.now()). Timestamps default to now here because the
 * Convex write path is a write (not a compare) — missing-preservation for LWW
 * happens on the bridge pull side, not here.
 */
export function normalizeTodoRecord(
  todo: Record<string, any>,
  opts: { now?: number | string; defaultTimestamps?: boolean } = {},
): Record<string, any> {
  const src = todo && typeof todo === "object" ? todo : {};
  const defaultTimestamps = opts.defaultTimestamps !== false;
  const nowIso = asIsoNow(opts.now);

  const lane =
    resolveTodoLane({
      category: src.category,
      type: src.type,
      list: src.project,
    }) || "sats";

  const id = canonicalTodoId(src, { now: opts.now, lane });

  const title = String(src.title != null ? src.title : src.text || "").trim();
  const text = String(src.text != null ? src.text : src.title || "").trim();

  const doneFlag = Boolean(src.done || src.completed);
  const status =
    src.status != null
      ? String(src.status)
      : doneFlag
        ? "completed"
        : "pending";
  const done = doneFlag || status === "completed";

  let createdAt: string;
  if (src.createdAt != null) createdAt = String(src.createdAt);
  else if (src.created != null) createdAt = String(src.created);
  else createdAt = defaultTimestamps ? nowIso : "";
  const created = createdAt ? createdAt.slice(0, 10) : "";

  let updatedAt: string;
  if (src.updated_at != null) updatedAt = String(src.updated_at);
  else if (src.updatedAt != null) updatedAt = String(src.updatedAt);
  else if (src.completedAt != null) updatedAt = String(src.completedAt);
  else updatedAt = defaultTimestamps ? nowIso : "";

  const dueDate =
    src.dueDate != null
      ? String(src.dueDate).slice(0, 10)
      : src.due_date != null
        ? String(src.due_date).slice(0, 10)
        : "";

  const flag = Boolean(src.flag || src.flagged);

  const owner = src.owner != null ? String(src.owner) : "victor";
  const assignee =
    src.assignee != null
      ? String(src.assignee)
      : src.owner != null
        ? String(src.owner)
        : "victor";

  const record: Record<string, any> = {
    id,
    title,
    text,
    category: lane,
    type: src.type != null ? String(src.type) : lane,
    status,
    done,
    priority: Number(src.priority || 0),
    dueDate,
    due_date: dueDate,
    createdAt,
    created,
    updatedAt,
    updated_at: updatedAt,
    flag,
    flagged: flag,
    project: src.project != null ? String(src.project) : "Inbox",
    area: src.area != null ? String(src.area) : "",
    assignee,
    owner,
    notes: src.notes != null ? String(src.notes) : "",
    source: src.source != null ? String(src.source) : "",
    created_by: src.created_by != null ? String(src.created_by) : "",
    sync_source: src.sync_source != null ? String(src.sync_source) : "",
  };

  if (src.completedAt != null) record.completedAt = String(src.completedAt);
  if (src.completed_by != null) record.completed_by = String(src.completed_by);

  return record;
}

/** Epoch-ms for an updated_at-ish value; missing/invalid → 0 (LWW honesty). */
export function todoUpdatedMs(todo: Record<string, any>): number {
  const raw = todo?.updated_at ?? todo?.updatedAt ?? todo?.completedAt ?? null;
  if (raw == null || raw === "") return 0;
  const ms = new Date(String(raw)).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}
