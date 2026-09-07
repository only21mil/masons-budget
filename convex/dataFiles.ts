import { ConvexError, v } from "convex/values";
import {
  query,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { isValidAndroidReadToken } from "./androidReadToken";
import {
  authenticateDeviceForRead,
  authenticateDeviceForSelfRevoke,
  deviceCapabilityValidator,
  deviceProfileValidator,
  equalSha256Hex,
  hashDeviceToken,
  normalizeDeviceCapabilities,
  sha256Hex,
  timingSafeEqualStrings,
  validateDeviceCredentialShape,
} from "./deviceAuth";
import {
  mergeTodoPayload,
  normalizeTodoRecord,
  todoUpdatedMs,
} from "./todoNormalize";
import { familyMemberValidator } from "./schema";
import { isRealIsoDate } from "./dateValidation";
import {
  executeTodoDeleteFromDevice,
  executeTodoUpsertFromDevice,
  dataFileVisibleTo,
  todoDeviceInput,
  todoWriteOperationValidator,
} from "./tables";
import { validateReadToken, validateSyncToken } from "./tokenAuth";

declare const process: { env: Record<string, string | undefined> };

// Deployment-token gates (validateReadToken / validateSyncToken) live in
// convex/tokenAuth.ts. Hatch precedence and client-visible error discipline
// are documented there.

// Deliberately hatch-free, unlike the shared gates in tokenAuth.ts. Minting a mobile pairing
// hands out a long-lived device credential; there is no legacy client to keep
// alive through a cutover, so no reason to accept an unauthenticated caller.
function validateConfiguredSyncToken(token?: string) {
  const expected = process.env.CONVEX_SYNC_TOKEN;
  if (!expected) {
    throw new ConvexError({
      code: "CONFIG_MISSING",
      message: "CONVEX_SYNC_TOKEN is required for mobile pairing",
    });
  }
  if (token !== undefined && (token.length < 16 || token.length > 512)) {
    throw new ConvexError({
      code: "VALIDATION_FAILED",
      message: "Malformed sync credential.",
    });
  }
  if (!token || !timingSafeEqualStrings(token, expected)) {
    throw new ConvexError({
      code: "DEVICE_UNAUTHORIZED",
      message: "Unauthorized: invalid sync token",
    });
  }
}

type PairingErrorCode =
  | "DEVICE_ID_CONFLICT"
  | "PAIRING_ID_CONFLICT"
  | "PAIRING_ALREADY_CLAIMED"
  | "PAIRING_EXPIRED"
  | "PAIRING_NOT_FOUND"
  | "PAIRING_PROOF_INVALID"
  | "VALIDATION_FAILED";

function pairingFailure(code: PairingErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}

function validatePairingInput(
  pairId: string,
  proofHash: string,
  createdBy?: string,
) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(pairId)) {
    pairingFailure("VALIDATION_FAILED", "pairId is malformed");
  }
  if (!/^[0-9a-f]{64}$/.test(proofHash)) {
    pairingFailure("VALIDATION_FAILED", "proofHash must be lowercase sha256");
  }
  if (createdBy !== undefined && (!createdBy.trim() || createdBy.length > 80)) {
    pairingFailure(
      "VALIDATION_FAILED",
      "createdBy must contain 1-80 characters",
    );
  }
}

const ANDROID_READ_BOOTSTRAP_MAX_TTL_MS = 30 * 60 * 1000;
const ANDROID_READ_BOOTSTRAP_PAIR_ID = /^android-read-[A-Za-z0-9_-]{16,64}$/;
// A canonical, unpadded Base64URL encoding of exactly 32 bytes is 43 characters.
// The final character has two zero padding bits, so only these 16 values are valid.
const ANDROID_READ_BOOTSTRAP_PROOF = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ANDROID_TODO_WRITE_CAPABILITY = "todos:write" as const;

type AndroidReadBootstrapErrorCode =
  | "ANDROID_READ_BOOTSTRAP_NOT_FOUND"
  | "ANDROID_READ_BOOTSTRAP_EXPIRED"
  | "ANDROID_READ_BOOTSTRAP_ALREADY_CLAIMED"
  | "ANDROID_READ_BOOTSTRAP_PROOF_INVALID"
  | "CONFIG_MISSING"
  | "DEVICE_ID_CONFLICT"
  | "DEVICE_UNAUTHORIZED"
  | "PAIRING_ID_CONFLICT"
  | "VALIDATION_FAILED";

function androidReadBootstrapFailure(
  code: AndroidReadBootstrapErrorCode,
): never {
  throw new ConvexError({
    code,
    message: "Android read bootstrap request was rejected.",
  });
}

function validateAndroidReadBootstrapPairId(pairId: string) {
  if (!ANDROID_READ_BOOTSTRAP_PAIR_ID.test(pairId)) {
    androidReadBootstrapFailure("VALIDATION_FAILED");
  }
}

function validateAndroidReadBootstrapProofHash(proofHash: string) {
  if (!SHA256_HEX.test(proofHash)) {
    androidReadBootstrapFailure("VALIDATION_FAILED");
  }
}

function validateAndroidReadBootstrapProof(proof: string) {
  if (!ANDROID_READ_BOOTSTRAP_PROOF.test(proof)) {
    androidReadBootstrapFailure("VALIDATION_FAILED");
  }
}

function validateAndroidReadBootstrapCapabilities(
  capabilities?: readonly string[],
) {
  if (
    capabilities !== undefined &&
    (capabilities.length !== 1 ||
      capabilities[0] !== ANDROID_TODO_WRITE_CAPABILITY)
  ) {
    androidReadBootstrapFailure("VALIDATION_FAILED");
  }
}

function validateAndroidReadBootstrapSyncToken(token?: string) {
  const expected = process.env.CONVEX_SYNC_TOKEN;
  if (!expected || !expected.trim()) {
    androidReadBootstrapFailure("CONFIG_MISSING");
  }
  if (
    token !== undefined &&
    (token.length < 16 || token.length > 512 || !token.trim())
  ) {
    androidReadBootstrapFailure("VALIDATION_FAILED");
  }
  if (!token || !timingSafeEqualStrings(token, expected)) {
    androidReadBootstrapFailure("DEVICE_UNAUTHORIZED");
  }
}

// equalSha256Hex and timingSafeEqualStrings live in deviceAuth.ts so every
// credential comparison in the deployment shares one constant-time implementation.

/**
 * How a read call authenticated.
 *
 * - shared token: the legacy household-wide CONVEX_READ_TOKEN. Deprecated for
 *   reads; kept fully functional until every client has migrated.
 * - device credential: the authoritative scope is the paired credential's
 *   server-stored profile. Row queries validate the client-asserted viewer
 *   against it; blob queries check the named file against it.
 */
type ReadAccess =
  | { viaDevice: false }
  | { viaDevice: true; profile: typeof deviceProfileValidator.type };

async function authorizeReadAccess(
  ctx: MutationCtx | QueryCtx,
  args: { token?: string; deviceId?: string; deviceToken?: string },
): Promise<ReadAccess> {
  if (args.deviceId !== undefined || args.deviceToken !== undefined) {
    if (args.deviceId === undefined || args.deviceToken === undefined) {
      throw new ConvexError({
        code: "VALIDATION_FAILED",
        message: "Malformed device credential.",
      });
    }
    const device = await authenticateDeviceForRead(
      ctx,
      args.deviceId,
      args.deviceToken,
    );
    if (device.profile === undefined) {
      throw new ConvexError({
        code: "PROFILE_BINDING_REQUIRED",
        message: "This device credential is not bound to a profile.",
      });
    }
    return { viaDevice: true, profile: device.profile };
  }
  validateReadToken(args.token);
  return { viaDevice: false };
}

// ── Queries (called by the iOS app) ──

/** Fetch a single data file by name. Returns the raw JSON data. */
export const get = query({
  args: {
    name: v.string(),
    token: v.optional(v.string()),
    deviceId: v.optional(v.string()),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, { name, token, deviceId, deviceToken }) => {
    const access = await authorizeReadAccess(ctx, {
      token,
      deviceId,
      deviceToken,
    });
    // A device credential reads blobs through its profile: a paired child
    // credential cannot fetch an adult blob by name. The shared-token path
    // remains household-wide — that is exactly its documented limitation.
    if (access.viaDevice && !dataFileVisibleTo(access.profile, name)) {
      throw new ConvexError({
        code: "READ_FORBIDDEN",
        message: "This file is outside the credential's profile scope.",
      });
    }
    const doc = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    return doc?.data ?? null;
  },
});

/** Fetch current versions of all data files — lightweight check for changes. */
export const getVersions = query({
  args: {
    token: v.optional(v.string()),
    deviceId: v.optional(v.string()),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, { token, deviceId, deviceToken }) => {
    const access = await authorizeReadAccess(ctx, {
      token,
      deviceId,
      deviceToken,
    });
    const docs = await ctx.db.query("syncVersions").collect();
    const visible = access.viaDevice
      ? docs.filter((d) => dataFileVisibleTo(access.profile, d.name))
      : docs;
    return Object.fromEntries(visible.map((d) => [d.name, d.version]));
  },
});

/** List all available data file names. */
export const list = query({
  args: {
    token: v.optional(v.string()),
    deviceId: v.optional(v.string()),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, { token, deviceId, deviceToken }) => {
    const access = await authorizeReadAccess(ctx, {
      token,
      deviceId,
      deviceToken,
    });
    const docs = await ctx.db.query("dataFiles").collect();
    const visible = access.viaDevice
      ? docs.filter((d) => dataFileVisibleTo(access.profile, d.name))
      : docs;
    return visible.map((d) => ({
      name: d.name,
      version: d.version,
      updatedAt: d.updatedAt,
    }));
  },
});

// ── Mutations (called by the MC2 sync script) ──

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY BLOB PAYLOAD VALIDATION (L-8 of the 2026-09-02 backend audit)
//
// The MC2-era doors stay open — that is their documented purpose — but "open"
// means the shipped clients' decode contract must keep working, not that any
// payload is accepted. These append mutations are the only route that can put
// floats and arbitrary values into blobs shipped readers decode, so they
// enforce the same class of rules the validating write path (writeback.ts)
// applies one door over:
//
//   - amounts must be integer-cents-compatible exactly as the readers will
//     parse them: the JSON number's shortest representation (Number#toString,
//     which jsonNumberToMinorUnits parses lexically) may carry at most two
//     fractional digits for USD and eight for BTC. 1.005 and float noise like
//     0.1+0.2 are rejected outright — never rounded, never coerced.
//   - the same $1,000,000 typo bound writeback.ts applies.
//   - dates must be real ISO calendar dates, so a mistyped February cannot
//     silently file spend under the wrong month.
//   - signs follow the ledger convention: money out is positive, Income is
//     positive, zero is always a typo.
//
// These doors stay open for whole-record payloads; the shape (which keys
// exist) is unchanged, so every shipped decoder keeps reading what it read
// before. Only values no reader should ever have been handed are refused.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ABS_BLOB_CENTS = 100_000_000; // $1,000,000.00, writeback parity
const MAX_ABS_BLOB_SATS = 1_000_000_000; // ≈ $1M at $100k/BTC, row-layer parity

const BLOB_CENTS_RE = /^-?\d+(?:\.\d{1,2})?$/;
const BLOB_SATS_RE = /^-?\d+(?:\.\d{1,8})?$/;

function rejectBlobPayload(message: string): never {
  throw new ConvexError({ code: "VALIDATION_FAILED", message });
}

/** Integer-cents-compatible, bounded, and finite — the readers' own path. */
function requireBlobCentsCompatible(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new ConvexError({
      code: "VALIDATION_FAILED",
      message: `${field} must be a finite number.`,
    });
  }
  // The readers turn a stored JSON number back into cents via its shortest
  // decimal representation, so THAT spelling is the contract.
  if (!BLOB_CENTS_RE.test(value.toString())) {
    throw new ConvexError({
      code: "VALIDATION_FAILED",
      message: `${field} of ${value} is not an exact number of cents; send ` +
        `an amount that survives the cents round-trip.`,
    });
  }
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_ABS_BLOB_CENTS) {
    throw new ConvexError({
      code: "VALIDATION_FAILED",
      message: `${field} exceeds the ${MAX_ABS_BLOB_CENTS}-cent sanity limit; ` +
        "if this is real, the limit is the thing to change.",
    });
  }
  return value;
}

/** 8-dp-compatible satoshis, bounded like the row layer. */
function requireBlobSatsCompatible(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new ConvexError({
      code: "VALIDATION_FAILED",
      message: `${field} must be a finite number.`,
    });
  }
  if (!BLOB_SATS_RE.test(value.toString())) {
    throw new ConvexError({
      code: "VALIDATION_FAILED",
      message: `${field} of ${value} is not an exact satoshi quantity.`,
    });
  }
  const sats = Math.round(value * 100_000_000);
  if (!Number.isSafeInteger(sats) || Math.abs(sats) > MAX_ABS_BLOB_SATS) {
    throw new ConvexError({
      code: "VALIDATION_FAILED",
      message: `${field} exceeds the ${MAX_ABS_BLOB_SATS}-sat sanity limit; ` +
        "if this is real, the limit is the thing to change.",
    });
  }
  return value;
}

function requireBlobText(value: string, field: string, max: number): string {
  if (
    value.length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ConvexError({
      code: "VALIDATION_FAILED",
      message: `${field} must be 1-${max} characters with no control characters.`,
    });
  }
  return value;
}

function requireBlobDate(value: string, field: string): string {
  if (!isRealIsoDate(value)) {
    throw new ConvexError({
      code: "VALIDATION_FAILED",
      message: `${field} must be a real ISO calendar date (yyyy-MM-dd).`,
    });
  }
  return value;
}

const BLOB_FAMILY_MEMBERS = new Set(["victor", "rachel", "mason", "maddox"]);

function requireBlobOwner(owner: string | null | undefined): void {
  if (owner !== undefined && owner !== null && !BLOB_FAMILY_MEMBERS.has(owner)) {
    throw new ConvexError({
      code: "VALIDATION_FAILED",
      message: "owner must name a family member.",
    });
  }
}

const appTransactionValidator = v.object({
  id: v.string(),
  date: v.string(),
  merchant: v.string(),
  amount: v.float64(),
  category: v.string(),
  card: v.optional(v.union(v.string(), v.null())),
  note: v.optional(v.union(v.string(), v.null())),
});

const appTodoValidator = v.object({
  id: v.string(),
  title: v.optional(v.union(v.string(), v.null())),
  text: v.optional(v.union(v.string(), v.null())),
  project: v.optional(v.union(v.string(), v.null())),
  area: v.optional(v.union(v.string(), v.null())),
  category: v.optional(v.union(v.string(), v.null())),
  type: v.optional(v.union(v.string(), v.null())),
  due_date: v.optional(v.union(v.string(), v.null())),
  dueDate: v.optional(v.union(v.string(), v.null())),
  when: v.optional(v.union(v.string(), v.null())),
  priority: v.optional(v.float64()),
  flag: v.optional(v.boolean()),
  flagged: v.optional(v.boolean()),
  done: v.optional(v.boolean()),
  completed: v.optional(v.boolean()),
  status: v.optional(v.union(v.string(), v.null())),
  owner: v.optional(v.union(v.string(), v.null())),
  assignee: v.optional(v.union(v.string(), v.null())),
  created_by: v.optional(v.union(v.string(), v.null())),
  sync_source: v.optional(v.union(v.string(), v.null())),
  createdAt: v.optional(v.union(v.string(), v.null())),
  created: v.optional(v.union(v.string(), v.null())),
  updatedAt: v.optional(v.union(v.string(), v.null())),
  updated_at: v.optional(v.union(v.string(), v.null())),
  // SAT-1328 canonical superset additions:
  notes: v.optional(v.union(v.string(), v.null())),
  source: v.optional(v.union(v.string(), v.null())),
  completedAt: v.optional(v.union(v.string(), v.null())),
  completed_by: v.optional(v.union(v.string(), v.null())),
});

async function bumpSyncVersion(
  ctx: MutationCtx,
  name: string,
  version: number,
  updatedAt: number,
) {
  const versionDoc = await ctx.db
    .query("syncVersions")
    .withIndex("by_name", (q: any) => q.eq("name", name))
    .first();

  if (versionDoc) {
    await ctx.db.patch(versionDoc._id, {
      version,
      updatedAt,
    });
  } else {
    await ctx.db.insert("syncVersions", {
      name,
      version,
      updatedAt,
    });
  }
}

/** Upsert a data file — replaces the entire payload and bumps the version. */
export const sync = mutation({
  args: {
    name: v.string(),
    data: v.any(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { name, data, token }) => {
    validateSyncToken(token);
    const now = Date.now();

    // Upsert the data file
    const existing = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();

    const nextVersion = (existing?.version ?? 0) + 1;

    if (existing) {
      await ctx.db.patch(existing._id, {
        data,
        version: nextVersion,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("dataFiles", {
        name,
        data,
        version: nextVersion,
        updatedAt: now,
      });
    }

    await bumpSyncVersion(ctx, name, nextVersion, now);

    return { name, version: nextVersion };
  },
});

/** Sync multiple files in a single transaction. */
export const syncBatch = mutation({
  args: {
    files: v.array(
      v.object({
        name: v.string(),
        data: v.any(),
      }),
    ),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { files, token }) => {
    validateSyncToken(token);
    const now = Date.now();
    const results: { name: string; version: number }[] = [];

    for (const file of files) {
      const existing = await ctx.db
        .query("dataFiles")
        .withIndex("by_name", (q) => q.eq("name", file.name))
        .first();

      const nextVersion = (existing?.version ?? 0) + 1;

      if (existing) {
        await ctx.db.patch(existing._id, {
          data: file.data,
          version: nextVersion,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("dataFiles", {
          name: file.name,
          data: file.data,
          version: nextVersion,
          updatedAt: now,
        });
      }

      await bumpSyncVersion(ctx, file.name, nextVersion, now);

      results.push({ name: file.name, version: nextVersion });
    }

    return results;
  },
});

/** Upsert one app-created transaction into transactions.json and bump its version. */
export const appendTransaction = mutation({
  args: {
    name: v.optional(
      v.union(v.literal("transactions"), v.literal("mason-transactions")),
    ),
    transaction: appTransactionValidator,
    token: v.optional(v.string()),
  },
  handler: async (ctx, { name: fileName, transaction, token }) => {
    validateSyncToken(token);
    const name = fileName ?? "transactions";
    const now = Date.now();

    // Legacy door, but not a garbage door: validate the record class the
    // shipped readers decode. Shape is unchanged; only values no reader
    // should ever have been handed are refused.
    requireBlobText(transaction.id, "transaction.id", 128);
    requireBlobText(transaction.merchant, "transaction.merchant", 200);
    requireBlobText(transaction.category, "transaction.category", 64);
    requireBlobDate(transaction.date, "transaction.date");
    if (transaction.note !== undefined && transaction.note !== null) {
      requireBlobText(transaction.note, "transaction.note", 2_000);
    }
    const amountCents = requireBlobCentsCompatible(
      transaction.amount,
      "transaction.amount",
    );
    if (amountCents === 0) {
      rejectBlobPayload(
        "transaction.amount must not be zero — a zero-value transaction " +
          "has no sign to check and is a typo in every case seen so far.",
      );
    }
    if (transaction.category === "Income" && amountCents <= 0) {
      rejectBlobPayload(
        'a transaction categorised "Income" must carry a positive amount.',
      );
    }

    const existing = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();

    const currentData = existing?.data;
    const transactions = Array.isArray(currentData) ? [...currentData] : [];
    const existingIndex = transactions.findIndex(
      (item) =>
        item &&
        typeof item === "object" &&
        "id" in item &&
        item.id === transaction.id,
    );

    if (existingIndex >= 0) {
      transactions[existingIndex] = transaction;
    } else {
      transactions.push(transaction);
    }

    const nextVersion = (existing?.version ?? 0) + 1;

    if (existing) {
      await ctx.db.patch(existing._id, {
        data: transactions,
        version: nextVersion,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("dataFiles", {
        name,
        data: transactions,
        version: nextVersion,
        updatedAt: now,
      });
    }

    await bumpSyncVersion(ctx, name, nextVersion, now);

    return { name, version: nextVersion, id: transaction.id };
  },
});

/** Token-authenticated legacy todo upsert into todos.json. */
async function applyTodoUpsert(
  ctx: MutationCtx,
  todo: Record<string, any>,
  name: string = "todos",
) {
  const now = Date.now();

  const existing = await ctx.db
    .query("dataFiles")
    .withIndex("by_name", (q: any) => q.eq("name", name))
    .first();

  const currentData = existing?.data;
  const currentTodos = Array.isArray(currentData)
    ? [...currentData]
    : currentData &&
        typeof currentData === "object" &&
        Array.isArray((currentData as any).todos)
      ? [...(currentData as any).todos]
      : [];

  const existingIndex = currentTodos.findIndex(
    (item) =>
      item && typeof item === "object" && "id" in item && item.id === todo.id,
  );

  // SAT-1328: normalize via the shared mirror (canonical: mission-control/
  // lib/todo-normalize.js). Emits the dual-field superset.
  // Tracks whether the write actually landed, so a discarded stale write does
  // not bump the version. No pre-computed `normalized` here: the update path
  // normalizes the MERGE result and the insert path normalizes the payload, and
  // sharing one value between them is what caused the data loss.
  let applied = true;
  if (existingIndex >= 0) {
    // SAT-1326 LWW: incoming applies only when its updated_at is newer (ties
    // favor the incoming write, which is the freshly stamped server edit).
    // Judged on the RAW payload, before the merge, so a timestamp inherited
    // from the stored record can never help a stale write win its own contest.
    const existingItem = currentTodos[existingIndex] as Record<string, any>;
    const existingUpdated = todoUpdatedMs(existingItem);
    const incomingUpdated = todoUpdatedMs(todo) || now;
    if (incomingUpdated >= existingUpdated) {
      // Merge into the stored record instead of replacing it.
      // normalizeTodoRecord defaults every absent field, so normalizing a
      // partial payload on its own wiped notes, project, area, due date and
      // owner — a phone toggling `done` silently destroyed the rest of the todo.
      currentTodos[existingIndex] = normalizeTodoRecord(
        mergeTodoPayload(existingItem, todo as Record<string, any>, { now }),
        { now },
      );
    } else {
      applied = false;
    }
  } else {
    currentTodos.push(
      normalizeTodoRecord(todo as Record<string, any>, { now }),
    );
  }

  // A discarded write leaves the payload identical, so bumping the version here
  // would tell every polling client to re-fetch a file that did not move. At
  // MC2 sync frequency that is a stampede for nothing. Report the version the
  // file still has, and say plainly that the write did not land.
  if (!applied) {
    return {
      name,
      version: existing?.version ?? 0,
      id: todo.id,
      applied: false,
    };
  }

  const nextData =
    currentData &&
    typeof currentData === "object" &&
    !Array.isArray(currentData) &&
    Array.isArray((currentData as any).todos)
      ? { ...(currentData as any), todos: currentTodos }
      : currentTodos;

  const nextVersion = (existing?.version ?? 0) + 1;

  if (existing) {
    await ctx.db.patch(existing._id, {
      data: nextData,
      version: nextVersion,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("dataFiles", {
      name,
      data: nextData,
      version: nextVersion,
      updatedAt: now,
    });
  }

  await bumpSyncVersion(ctx, name, nextVersion, now);

  return { name, version: nextVersion, id: todo.id, applied: true };
}

export const upsertTodo = mutation({
  args: {
    name: v.optional(v.literal("todos")),
    todo: appTodoValidator,
    token: v.optional(v.string()),
  },
  handler: async (ctx, { name: fileName, todo, token }) => {
    validateSyncToken(token);
    return await applyTodoUpsert(
      ctx,
      todo as Record<string, any>,
      fileName ?? "todos",
    );
  },
});

/**
 * Compatibility alias for clients that still call the old dataFiles path.
 * Its contract is intentionally identical to the canonical device task path.
 */
export const upsertTodoFromMobile = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    activeProfile: v.optional(familyMemberValidator),
    owner: familyMemberValidator,
    sourceFile: v.literal("todos"),
    operation: v.optional(todoWriteOperationValidator),
    baseUpdatedAtMs: v.optional(v.float64()),
    todo: todoDeviceInput,
  },
  returns: v.object({
    ok: v.literal(true),
    entityId: v.string(),
    outcome: v.union(v.literal("inserted"), v.literal("updated")),
  }),
  handler: executeTodoUpsertFromDevice,
});

/**
 * Mint one short-lived Android bootstrap.
 *
 * This is deliberately separate from mobilePairings. Read-only is the default;
 * only an explicit exact todos:write grant may also create one mobileDevices
 * row at claim time. The bootstrap stores neither its raw proof nor a token.
 */
export const createAndroidReadBootstrap = mutation({
  args: {
    pairId: v.string(),
    proofHash: v.string(),
    expiresAt: v.float64(),
    capabilities: v.optional(v.array(deviceCapabilityValidator)),
    profile: v.optional(deviceProfileValidator),
    token: v.optional(v.string()),
  },
  returns: v.object({
    pairId: v.string(),
    expiresAt: v.float64(),
  }),
  handler: async (
    ctx,
    { pairId, proofHash, expiresAt, capabilities, profile, token },
  ) => {
    validateAndroidReadBootstrapSyncToken(token);
    validateAndroidReadBootstrapPairId(pairId);
    validateAndroidReadBootstrapProofHash(proofHash);
    validateAndroidReadBootstrapCapabilities(capabilities);
    const grantsTodoWrite = capabilities?.length === 1;
    if (grantsTodoWrite !== (profile !== undefined)) {
      androidReadBootstrapFailure("VALIDATION_FAILED");
    }

    const now = Date.now();
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + ANDROID_READ_BOOTSTRAP_MAX_TTL_MS
    ) {
      androidReadBootstrapFailure("VALIDATION_FAILED");
    }

    const existing = await ctx.db
      .query("androidReadBootstraps")
      .withIndex("by_pair_id", (q) => q.eq("pairId", pairId))
      .unique();
    if (existing) {
      androidReadBootstrapFailure("PAIRING_ID_CONFLICT");
    }

    await ctx.db.insert("androidReadBootstraps", {
      pairId,
      proofHash,
      createdAt: now,
      expiresAt,
      claimedAt: undefined,
      capabilities:
        capabilities === undefined
          ? undefined
          : [ANDROID_TODO_WRITE_CAPABILITY],
      profile,
    });
    return { pairId, expiresAt };
  },
});

/**
 * Redeem a raw 256-bit Android proof for the deployment's current read token.
 *
 * A todo-write bootstrap must also present a client-generated device credential.
 * Its raw token is hashed before storage. Device creation and claim state share
 * one Convex transaction, so any failure leaves both sides unchanged.
 */
export const claimAndroidReadBootstrap = mutation({
  args: {
    pairId: v.string(),
    proof: v.string(),
    deviceId: v.optional(v.string()),
    deviceToken: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      readToken: v.string(),
      pairedAt: v.float64(),
      capabilities: v.array(deviceCapabilityValidator),
    }),
    v.object({
      ok: v.literal(true),
      readToken: v.string(),
      pairedAt: v.float64(),
      deviceId: v.string(),
      capabilities: v.array(deviceCapabilityValidator),
      profile: deviceProfileValidator,
    }),
  ),
  handler: async (ctx, { pairId, proof, deviceId, deviceToken }) => {
    validateAndroidReadBootstrapPairId(pairId);
    validateAndroidReadBootstrapProof(proof);
    if ((deviceId === undefined) !== (deviceToken === undefined)) {
      androidReadBootstrapFailure("VALIDATION_FAILED");
    }

    const bootstrap = await ctx.db
      .query("androidReadBootstraps")
      .withIndex("by_pair_id", (q) => q.eq("pairId", pairId))
      .unique();
    if (!bootstrap) {
      androidReadBootstrapFailure("ANDROID_READ_BOOTSTRAP_NOT_FOUND");
    }

    // Verify possession of the raw proof BEFORE disclosing claim state or
    // expiry. ALREADY_CLAIMED / EXPIRED reported ahead of the proof check turn
    // this mutation into a state oracle for anyone who learns a pairId.
    const suppliedProofHash = await sha256Hex(proof);
    if (!equalSha256Hex(bootstrap.proofHash, suppliedProofHash)) {
      androidReadBootstrapFailure("ANDROID_READ_BOOTSTRAP_PROOF_INVALID");
    }

    const now = Date.now();
    if (bootstrap.claimedAt !== undefined) {
      androidReadBootstrapFailure("ANDROID_READ_BOOTSTRAP_ALREADY_CLAIMED");
    }
    if (bootstrap.expiresAt <= now) {
      androidReadBootstrapFailure("ANDROID_READ_BOOTSTRAP_EXPIRED");
    }

    validateAndroidReadBootstrapCapabilities(bootstrap.capabilities);
    const capabilities = bootstrap.capabilities ?? [];
    const grantsTodoWrite = capabilities.length === 1;
    if (grantsTodoWrite) {
      if (deviceId === undefined || deviceToken === undefined) {
        androidReadBootstrapFailure("VALIDATION_FAILED");
      }
      validateDeviceCredentialShape(deviceId, deviceToken);

      const readToken = process.env.CONVEX_READ_TOKEN;
      if (!isValidAndroidReadToken(readToken)) {
        androidReadBootstrapFailure("CONFIG_MISSING");
      }

      const storedTokenHash = await hashDeviceToken(deviceToken);
      if (bootstrap.profile === undefined) {
        androidReadBootstrapFailure("VALIDATION_FAILED");
      }
      const existingDevice = await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
        .unique();
      if (existingDevice) {
        androidReadBootstrapFailure("DEVICE_ID_CONFLICT");
      }

      await ctx.db.insert("mobileDevices", {
        deviceId,
        name: "Vogel Vault Android",
        tokenHash: storedTokenHash.hash,
        pairedAt: now,
        lastSeenAt: now,
        revokedAt: undefined,
        pairId,
        capabilities: [ANDROID_TODO_WRITE_CAPABILITY],
        profile: bootstrap.profile,
      });

      await ctx.db.patch(bootstrap._id, { claimedAt: now });
      return {
        ok: true as const,
        readToken,
        pairedAt: now,
        deviceId,
        capabilities: [ANDROID_TODO_WRITE_CAPABILITY],
        profile: bootstrap.profile,
      };
    }
    if (deviceId !== undefined || deviceToken !== undefined) {
      androidReadBootstrapFailure("VALIDATION_FAILED");
    }

    const readToken = process.env.CONVEX_READ_TOKEN;
    if (!isValidAndroidReadToken(readToken)) {
      androidReadBootstrapFailure("CONFIG_MISSING");
    }
    await ctx.db.patch(bootstrap._id, { claimedAt: now });
    return { ok: true as const, readToken, pairedAt: now, capabilities: [] };
  },
});

/** Create a one-time mobile pairing for public iPhone writeback. */
export const createMobilePairing = mutation({
  args: {
    pairId: v.string(),
    proofHash: v.string(),
    expiresAt: v.float64(),
    createdBy: v.optional(v.string()),
    capabilities: v.optional(v.array(deviceCapabilityValidator)),
    profile: v.optional(deviceProfileValidator),
    token: v.optional(v.string()),
  },
  returns: v.object({
    pairId: v.string(),
    expiresAt: v.float64(),
  }),
  handler: async (
    ctx,
    { pairId, proofHash, expiresAt, createdBy, capabilities, profile, token },
  ) => {
    validateConfiguredSyncToken(token);
    const now = Date.now();
    validatePairingInput(pairId, proofHash, createdBy);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      pairingFailure("VALIDATION_FAILED", "expiresAt must be in the future");
    }
    if (expiresAt > now + 366 * 24 * 60 * 60 * 1000) {
      pairingFailure("VALIDATION_FAILED", "expiresAt must be within 366 days");
    }

    const existing = await ctx.db
      .query("mobilePairings")
      .withIndex("by_pair_id", (q) => q.eq("pairId", pairId))
      .unique();
    if (existing) {
      pairingFailure("PAIRING_ID_CONFLICT", "Pairing id is already in use");
    }
    const record = {
      pairId,
      proofHash,
      createdAt: now,
      expiresAt,
      createdBy: createdBy || "sats",
      claimedAt: undefined,
      deviceId: undefined,
      capabilities:
        capabilities === undefined
          ? undefined
          : normalizeDeviceCapabilities(capabilities),
      profile,
    };

    await ctx.db.insert("mobilePairings", record);
    return { pairId, expiresAt };
  },
});

/** Claim a pairing from the app. Public, but requires the one-time proof hash. */
export const claimMobilePairing = mutation({
  args: {
    pairId: v.string(),
    proofHash: v.string(),
    deviceName: v.string(),
    deviceId: v.string(),
    deviceToken: v.string(),
  },
  returns: v.object({
    ok: v.literal(true),
    deviceId: v.string(),
    pairedAt: v.float64(),
    capabilities: v.array(deviceCapabilityValidator),
  }),
  handler: async (
    ctx,
    { pairId, proofHash, deviceName, deviceId, deviceToken },
  ) => {
    const now = Date.now();
    validatePairingInput(pairId, proofHash);
    validateDeviceCredentialShape(deviceId, deviceToken);
    if (!deviceName.trim() || deviceName.length > 80) {
      pairingFailure(
        "VALIDATION_FAILED",
        "deviceName must contain 1-80 characters",
      );
    }
    const pairing = await ctx.db
      .query("mobilePairings")
      .withIndex("by_pair_id", (q) => q.eq("pairId", pairId))
      .unique();

    if (!pairing) {
      pairingFailure("PAIRING_NOT_FOUND", "Pairing not found");
    }
    // The proofHash IS the claim credential, so it is compared in constant time
    // and verified BEFORE claim state or expiry are disclosed. Reporting
    // ALREADY_CLAIMED / PAIRING_EXPIRED first would let anyone holding a pairId
    // probe that slot's state without ever possessing its secret.
    if (!equalSha256Hex(pairing.proofHash, proofHash)) {
      pairingFailure("PAIRING_PROOF_INVALID", "Invalid pairing proof");
    }
    if (pairing.claimedAt) {
      pairingFailure("PAIRING_ALREADY_CLAIMED", "Pairing already claimed");
    }
    if (pairing.expiresAt <= now) {
      pairingFailure("PAIRING_EXPIRED", "Pairing expired");
    }

    const tokenHash = await hashDeviceToken(deviceToken);
    const existingDevice = await ctx.db
      .query("mobileDevices")
      .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (existingDevice) {
      pairingFailure("DEVICE_ID_CONFLICT", "Device id is already paired");
    }

    const deviceRecord = {
      deviceId,
      name: deviceName.trim().slice(0, 80) || "Vogel Vault iPhone",
      tokenHash: tokenHash.hash,
      pairedAt: now,
      lastSeenAt: now,
      revokedAt: undefined,
      pairId,
      capabilities: pairing.capabilities,
      profile: pairing.profile,
    };

    await ctx.db.insert("mobileDevices", deviceRecord);

    await ctx.db.patch(pairing._id, { claimedAt: now, deviceId });
    return {
      ok: true as const,
      deviceId,
      pairedAt: now,
      capabilities: normalizeDeviceCapabilities(pairing.capabilities),
    };
  },
});

/** Revoke the calling device without requiring a household sync credential. */
export const revokeMobileDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
  },
  returns: v.object({
    ok: v.literal(true),
    revoked: v.boolean(),
  }),
  handler: async (ctx, { deviceId, deviceToken }) => {
    const device = await authenticateDeviceForSelfRevoke(
      ctx,
      deviceId,
      deviceToken,
    );
    if (device.revokedAt !== undefined) {
      return { ok: true as const, revoked: false };
    }
    await ctx.db.patch(device._id, { revokedAt: Date.now() });
    return { ok: true as const, revoked: true };
  },
});

/** Compatibility alias for an exact-revision canonical task update. */
export const completeTodoFromMobile = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    activeProfile: v.optional(familyMemberValidator),
    owner: familyMemberValidator,
    sourceFile: v.literal("todos"),
    baseUpdatedAtMs: v.optional(v.float64()),
    todo: todoDeviceInput,
  },
  returns: v.object({
    ok: v.literal(true),
    entityId: v.string(),
    outcome: v.union(v.literal("inserted"), v.literal("updated")),
  }),
  handler: (ctx, args) =>
    executeTodoUpsertFromDevice(ctx, { ...args, operation: "update" }),
});

async function removeTodoById(ctx: MutationCtx, todoId: string) {
  const name = "todos";
  const now = Date.now();

  // 1. Upsert the tombstone first (separate table; out of the app payload).
  const tombstone = await ctx.db
    .query("todoTombstones")
    .withIndex("by_todo_id", (q) => q.eq("id", todoId))
    .first();
  if (tombstone) {
    await ctx.db.patch(tombstone._id, { deletedAt: now });
  } else {
    await ctx.db.insert("todoTombstones", { id: todoId, deletedAt: now });
  }

  // 2. Remove from the todos payload if present, bumping the version so the
  //    app re-fetches the cleaned list.
  const existing = await ctx.db
    .query("dataFiles")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();

  // Every branch below reports the version the todos file now carries, so a
  // caller can compare it against what it holds instead of having to infer
  // "unchanged" from a missing field. No file at all is version 0, which is
  // what getVersions effectively reports for a name it has never seen.
  if (!existing) return { name, version: 0, removed: false };

  const currentData = existing.data;
  const currentTodos = Array.isArray(currentData)
    ? [...currentData]
    : currentData &&
        typeof currentData === "object" &&
        Array.isArray((currentData as any).todos)
      ? [...(currentData as any).todos]
      : [];

  const beforeCount = currentTodos.length;
  const filtered = currentTodos.filter(
    (item) =>
      !(item && typeof item === "object" && "id" in item && item.id === todoId),
  );

  if (filtered.length === beforeCount) {
    // Tombstone written, but nothing to strip from the payload, so the version
    // stays put — `removed: false` plus an unchanged version is "tombstone only".
    return { name, version: existing.version ?? 0, removed: false };
  }

  const nextData =
    currentData &&
    typeof currentData === "object" &&
    !Array.isArray(currentData) &&
    Array.isArray((currentData as any).todos)
      ? { ...(currentData as any), todos: filtered }
      : filtered;

  const nextVersion = (existing.version ?? 0) + 1;
  await ctx.db.patch(existing._id, {
    data: nextData,
    version: nextVersion,
    updatedAt: now,
  });

  await bumpSyncVersion(ctx, name, nextVersion, now);
  return { name, version: nextVersion, removed: true };
}

/**
 * Atomically remove a todo by ID from todos AND write a delete tombstone
 * (SAT-1327) so a later legacy blob replay cannot resurrect it. The tombstone
 * always gets (re)written even if the todo was not
 * present in the payload, so a delete for a todo that only exists locally still
 * propagates. Returns `{ removed, version }` on every branch: `removed` says
 * whether the payload lost a row, `version` says which payload the caller is
 * now behind.
 */
export const removeTodo = mutation({
  args: {
    todoId: v.string(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { todoId, token }) => {
    validateSyncToken(token);
    return removeTodoById(ctx, todoId);
  },
});

/** Compatibility alias for canonical exact-revision task deletion. */
export const removeTodoFromMobile = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    activeProfile: v.optional(familyMemberValidator),
    owner: familyMemberValidator,
    sourceFile: v.literal("todos"),
    entityId: v.string(),
    baseUpdatedAtMs: v.optional(v.float64()),
  },
  returns: v.object({
    ok: v.literal(true),
    entityId: v.string(),
    removed: v.boolean(),
  }),
  handler: executeTodoDeleteFromDevice,
});

/**
 * List all todo delete tombstones (SAT-1327). Retained for compatibility
 * readers that must reject a blob todo whose updated_at predates its tombstone.
 *
 * A device credential authenticates this query but no per-profile filtering is
 * possible: tombstones carry only an id and a timestamp, never todo content.
 * That id-level residual is accepted while shipped clients converge through
 * the blob; the row layer's tombstones are owner-checked.
 */
export const listTodoTombstones = query({
  args: {
    token: v.optional(v.string()),
    deviceId: v.optional(v.string()),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, { token, deviceId, deviceToken }) => {
    await authorizeReadAccess(ctx, { token, deviceId, deviceToken });
    const docs = await ctx.db.query("todoTombstones").collect();
    return docs.map((d) => ({ id: d.id, deletedAt: d.deletedAt }));
  },
});

/** Upsert one app-created BTC bill pay into bitcoin-bill-pays and bump its version. */
export const appendBillPay = mutation({
  args: {
    billPay: v.object({
      id: v.string(),
      date: v.string(),
      merchant: v.string(),
      category: v.string(),
      amount_usd: v.float64(),
      btc_spent: v.float64(),
      btc_price: v.optional(v.union(v.float64(), v.null())),
      platform: v.optional(v.union(v.string(), v.null())),
      note: v.optional(v.union(v.string(), v.null())),
      fee_usd: v.optional(v.union(v.float64(), v.null())),
      reference: v.optional(v.union(v.string(), v.null())),
      owner: v.optional(v.union(v.string(), v.null())),
    }),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { billPay, token }) => {
    validateSyncToken(token);
    const name = "bitcoin-bill-pays";
    const now = Date.now();

    // Same legacy-door validation as appendTransaction: shape unchanged,
    // garbage refused. A bill payment is money leaving in both currencies,
    // so the principal amounts are positive and a fee is never negative.
    requireBlobText(billPay.id, "billPay.id", 128);
    requireBlobText(billPay.merchant, "billPay.merchant", 200);
    requireBlobText(billPay.category, "billPay.category", 64);
    requireBlobDate(billPay.date, "billPay.date");
    requireBlobOwner(billPay.owner ?? null);
    if (billPay.note !== undefined && billPay.note !== null) {
      requireBlobText(billPay.note, "billPay.note", 2_000);
    }
    if (billPay.reference !== undefined && billPay.reference !== null) {
      requireBlobText(billPay.reference, "billPay.reference", 256);
    }
    if (requireBlobCentsCompatible(billPay.amount_usd, "billPay.amount_usd") <= 0) {
      rejectBlobPayload("billPay.amount_usd must be positive (a bill payment is a spend).");
    }
    if (requireBlobSatsCompatible(billPay.btc_spent, "billPay.btc_spent") <= 0) {
      rejectBlobPayload("billPay.btc_spent must be positive (a bill payment is a spend).");
    }
    if (
      billPay.btc_price !== undefined &&
      billPay.btc_price !== null &&
      requireBlobCentsCompatible(billPay.btc_price, "billPay.btc_price") <= 0
    ) {
      rejectBlobPayload("billPay.btc_price must be positive when supplied.");
    }
    if (
      billPay.fee_usd !== undefined &&
      billPay.fee_usd !== null &&
      requireBlobCentsCompatible(billPay.fee_usd, "billPay.fee_usd") < 0
    ) {
      rejectBlobPayload("billPay.fee_usd must not be negative.");
    }

    const existing = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();

    const currentData = existing?.data;
    // bill pays file has { bill_pays: [...] } structure
    let wrapper: any =
      currentData &&
      typeof currentData === "object" &&
      !Array.isArray(currentData)
        ? { ...currentData }
        : { bill_pays: [] };

    const billPays = Array.isArray(wrapper.bill_pays)
      ? [...wrapper.bill_pays]
      : [];
    const existingIndex = billPays.findIndex(
      (item: any) =>
        item &&
        typeof item === "object" &&
        "id" in item &&
        item.id === billPay.id,
    );

    if (existingIndex >= 0) {
      billPays[existingIndex] = billPay;
    } else {
      billPays.push(billPay);
    }
    wrapper.bill_pays = billPays;

    const nextVersion = (existing?.version ?? 0) + 1;

    if (existing) {
      await ctx.db.patch(existing._id, {
        data: wrapper,
        version: nextVersion,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("dataFiles", {
        name,
        data: wrapper,
        version: nextVersion,
        updatedAt: now,
      });
    }

    await bumpSyncVersion(ctx, name, nextVersion, now);

    return { name, version: nextVersion, id: billPay.id };
  },
});

/** Delete a data file. */
export const remove = mutation({
  args: { name: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { name, token }) => {
    validateSyncToken(token);
    const doc = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (doc) {
      await ctx.db.delete(doc._id);
    }

    const versionDoc = await ctx.db
      .query("syncVersions")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (versionDoc) {
      await ctx.db.delete(versionDoc._id);
    }
  },
});
