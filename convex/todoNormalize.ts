// ── Convex normalizer for the legacy dataFiles todo shape (SAT-1328) ──
//
// The retired service is unavailable. MC2TodoItem in the Apple client remains
// the compatibility authority while shipped clients consume dataFiles. A parity
// probe guards the dual-field
// emission (dueDate↔due_date, updatedAt↔updated_at, flag↔flagged, createdAt↔created).
//
// mergeTodoPayload is Convex-specific: legacy blobs represent whole documents,
// while Convex accepts one-field edits from a phone and must merge them.

/**
 * The three todo lanes — the single Convex-side source.
 *
 * Convex functions cannot import from outside convex/ at deploy time (same
 * constraint as the other mirrors), so this constant lives here. The domain
 * copy (shared/domain/src/todo.ts TODO_LANES) is the cross-runtime contract.
 */
export const TODO_LANES = ["work", "personal", "sats"] as const;

const VALID_TODO_LANES: readonly string[] = TODO_LANES;

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

/**
 * First alias that carries an actual value, as a string; null when none does.
 *
 * An empty string counts as absent, not as a value. MC2 and both clients write
 * `updated_at: ""` to mean "no timestamp", and a `??`/`!= null` chain stops
 * there — hiding a perfectly good `updatedAt` behind the blank alias in front
 * of it. A record whose real stamp is masked scores 0 and loses every
 * last-write-wins comparison it should have won.
 */
function firstNonEmpty(
  src: Record<string, any> | null | undefined,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = src == null ? null : src[key];
    if (value == null) continue;
    const text = String(value);
    if (text !== "") return text;
  }
  return null;
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
  const rawStatus = src.status != null ? String(src.status) : "";
  // `done` and `status` are two spellings of one fact, so the emitted record
  // must never carry them disagreeing: a screen reading `status` would show a
  // pending row while a screen reading `done` shows it checked off, and which
  // one the user sees becomes a coin flip per client. Either signal claiming
  // completion wins, extending the pre-existing `done` rule to `status` —
  // dropping a completion the user just made is the worse of the two errors.
  // A non-completion status ("archived") survives untouched while done is
  // false, because it contradicts nothing.
  const done = doneFlag || rawStatus === "completed";
  const status = done ? "completed" : rawStatus || "pending";

  let createdAt: string;
  if (src.createdAt != null) createdAt = String(src.createdAt);
  else if (src.created != null) createdAt = String(src.created);
  else createdAt = defaultTimestamps ? nowIso : "";
  const created = createdAt ? createdAt.slice(0, 10) : "";

  const updatedSource = firstNonEmpty(src, [
    "updated_at",
    "updatedAt",
    "completedAt",
  ]);
  const updatedAt = updatedSource ?? (defaultTimestamps ? nowIso : "");

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
 * Not part of the legacy blob decoder. Convex takes single-field edits from a
 * phone, so it needs a merge step.
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
  // leaves updated_at where it was is invisible to a strictly-newer merge — the
  // edit would apply here but lose to the unchanged timestamp later.
  // Set both spellings so the fallback chain cannot reach a stored completedAt.
  const stamp = TODO_UPDATE_STAMP_KEYS.map((key) => src[key]).find(
    (value) => value != null && String(value) !== "",
  );
  merged.updated_at = stamp != null ? String(stamp) : asIsoNow(opts.now);
  merged.updatedAt = merged.updated_at;

  return merged;
}

/**
 * Epoch-ms for an updated_at-ish value; missing/invalid → 0 (LWW honesty).
 *
 * A blank alias is skipped, not honoured — see firstNonEmpty. A present but
 * unparseable stamp still scores 0 rather than falling through: garbage is a
 * claim about the time, and a record that claims a time it cannot back up must
 * lose, not borrow a better one from the alias behind it.
 *
 * The PARSING is the domain's `isoToMillis` contract
 * (shared/domain/src/todo.ts), mirrored below: strict ISO-8601, zoneless
 * timestamps read as UTC (not server-local), and anything unrecognised scores
 * 0. It deliberately replaces `new Date(raw)`, whose zoneless parsing is local
 * time — for a sync contract the domain calls that a correctness bug, and LWW
 * here feeds on exactly those stamps.
 */
export function todoUpdatedMs(todo: Record<string, any>): number {
  const raw = firstNonEmpty(todo, ["updated_at", "updatedAt", "completedAt"]);
  if (raw == null) return 0;
  return isoToMillis(raw);
}

// ── Mirror of shared/domain/src/todo.ts isoToMillis ──
//
// Copied rather than imported because Convex functions cannot import from
// outside convex/. The server's own alias chain stays local; only the stamp
// parsing mirrors the domain implementation.

const ISO_DATE_MIRROR = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_MIRROR =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}:?\d{2})?$/;
const DAYS_IN_MONTH_MIRROR = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYearMirror(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Hinnant's civil-from-days, as in the domain: 2026-02-30 is not a date. */
function daysFromCivilMirror(
  year: number,
  month: number,
  day: number,
): number | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const monthLength =
    (DAYS_IN_MONTH_MIRROR[month - 1] as number) +
    (month === 2 && isLeapYearMirror(year) ? 1 : 0);
  if (day > monthLength) return null;

  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function offsetMillisMirror(offset: string | undefined): number {
  if (offset === undefined || offset === "Z" || offset === "z") return 0;
  const sign = offset.startsWith("-") ? -1 : 1;
  const digits = offset.slice(1).replace(":", "");
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  return sign * (hours * 3_600_000 + minutes * 60_000);
}

/**
 * Strict ISO-8601 to epoch ms; 0 for anything unrecognised. Zoneless stamps
 * mean UTC on every runtime — the domain's documented sync contract.
 */
function isoToMillis(value: string): number {
  const raw = value.trim();
  if (raw === "") return 0;

  const dateOnly = ISO_DATE_MIRROR.exec(raw);
  if (dateOnly) {
    const days = daysFromCivilMirror(
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
    );
    return days === null ? 0 : days * 86_400_000;
  }

  const match = ISO_DATETIME_MIRROR.exec(raw);
  if (!match) return 0;

  const days = daysFromCivilMirror(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  );
  if (days === null) return 0;

  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = match[6] === undefined ? 0 : Number(match[6]);
  if (hours > 23 || minutes > 59 || seconds > 59) return 0;

  const fraction = match[7] ?? "";
  const millis = fraction === "" ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"));

  const utc =
    days * 86_400_000 + hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + millis;

  return utc - offsetMillisMirror(match[8]);
}
