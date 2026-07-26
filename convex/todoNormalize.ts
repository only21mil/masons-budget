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
//
// One export is NOT mirrored and has no canonical counterpart: mergeTodoPayload.
// MC2 rewrites whole files, so it never needs a merge; Convex accepts one-field
// edits from a phone, so it does. Do not delete it during a re-sync.

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
 * Convex write path is a write (not a compare).
 *
 * This function has no memory of the stored record: every absent field lands on
 * its default. Feeding it a partial payload therefore ERASES the fields that
 * payload never mentioned, which is why applyTodoUpsert normalizes the output of
 * `mergeTodoPayload` rather than the raw payload.
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

/**
 * Field names that spell ONE underlying value.
 *
 * When an incoming payload sets any member of a group, every member is taken
 * from that payload and none is inherited from the stored record. Without this,
 * the stored spelling — which normalizeTodoRecord often reads FIRST — silently
 * vetoes the write: a stored `dueDate` beats an incoming `due_date`, a stored
 * `status: "pending"` contradicts an incoming `done: true`, and `flag` is OR-ed
 * with `flagged` so a stored `flag: true` survives an incoming `flagged: false`.
 *
 * `completedAt`/`completed_by` ride with the done group because reopening a todo
 * must drop its completion stamp, not leave a pending todo that still claims to
 * have been completed.
 *
 * `when` is deliberately NOT a due-date alias: this normalizer never reads it
 * (the canonical mirror does not either), so grouping it would let a
 * `when`-only payload erase a real due date and put nothing back.
 */
export const TODO_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["title", "text"],
  ["done", "completed", "status", "completedAt", "completed_by"],
  ["dueDate", "due_date"],
  ["flag", "flagged"],
  ["createdAt", "created"],
];

/**
 * Update-stamp aliases, highest precedence first. Unlike todoUpdatedMs this
 * chain SKIPS a blank value rather than short-circuiting on it: a merged record
 * stamped "" would lose every future last-write-wins comparison it entered.
 */
const TODO_UPDATE_STAMP_KEYS = ["updated_at", "updatedAt", "completedAt"];

/**
 * Build the normalization source for an upsert over an EXISTING todo: the
 * stored record with the incoming payload laid over it.
 *
 * NOT part of the mission-control mirror — the canonical CJS normalizer has no
 * merge step, because MC2 owns whole files. Convex takes single-field edits from
 * a phone, so it needs one.
 *
 * Absence and clearing are different intents and both are honoured:
 *   - a key missing from `incoming` (or present as `undefined`, which is how an
 *     omitted Convex optional arrives) PRESERVES the stored value;
 *   - a key present as null or "" reaches the normalizer, which resolves it to
 *     that field's default — "" for notes/area/dueDate, "Inbox" for project,
 *     "victor" for owner. Clearing means "back to the default", not "delete".
 *
 * Normalization still projects the result onto the canonical superset, so keys
 * outside it (`when`, MC2 extras) are dropped exactly as they are today.
 */
export function mergeTodoPayload(
  stored: Record<string, any> | null | undefined,
  incoming: Record<string, any> | null | undefined,
  opts: { now?: number | string } = {},
): Record<string, any> {
  const base: Record<string, any> =
    stored && typeof stored === "object" ? { ...stored } : {};
  const src: Record<string, any> =
    incoming && typeof incoming === "object" ? incoming : {};

  const touched = Object.keys(src).filter((key) => src[key] !== undefined);
  const isTouched = (key: string) => touched.includes(key);

  for (const group of TODO_ALIAS_GROUPS) {
    if (!group.some(isTouched)) continue;
    for (const key of group) delete base[key];
  }

  // A normalized record always carries `type`, mirroring its lane, so an
  // inherited one would outlive the lane it was derived from. Drop it only when
  // it IS a lane word; a custom type ("reminder") is real data and survives.
  if (
    (isTouched("category") || isTouched("type")) &&
    normalizeTodoLane(base.type) != null
  ) {
    delete base.type;
  }

  const merged: Record<string, any> = { ...base };
  for (const key of touched) merged[key] = src[key];

  // The write stamp is the writer's, never the stored record's. An edit that
  // leaves updated_at where it was is invisible to the MC2 bridge, which pulls
  // on a strictly-newer comparison — the edit would apply here and never travel.
  // Set both spellings so the fallback chain cannot reach a stored completedAt.
  const stamp = TODO_UPDATE_STAMP_KEYS.map((key) => src[key]).find(
    (value) => value != null && String(value) !== "",
  );
  merged.updated_at = stamp != null ? String(stamp) : asIsoNow(opts.now);
  merged.updatedAt = merged.updated_at;

  return merged;
}

/** Epoch-ms for an updated_at-ish value; missing/invalid → 0 (LWW honesty). */
export function todoUpdatedMs(todo: Record<string, any>): number {
  const raw = todo?.updated_at ?? todo?.updatedAt ?? todo?.completedAt ?? null;
  if (raw == null || raw === "") return 0;
  const ms = new Date(String(raw)).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}
