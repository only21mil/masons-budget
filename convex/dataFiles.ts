import { ConvexError, v } from "convex/values";
import { query, mutation, type MutationCtx } from "./_generated/server";
import {
  authenticateDevice,
  authenticateDeviceForSelfRevoke,
  deviceCapabilityValidator,
  markDeviceSeen,
  normalizeDeviceCapabilities,
  sha256Hex,
  validateDeviceCredentialShape,
} from "./deviceAuth";
import {
  mergeTodoPayload,
  normalizeTodoRecord,
  todoUpdatedMs,
} from "./todoNormalize";

declare const process: { env: Record<string, string | undefined> };

// ─────────────────────────────────────────────────────────────────────────────
// THE ESCAPE HATCH OUTRANKS THE TOKEN. Read this before changing either gate.
//
// ALLOW_TOKENLESS_{READ,SYNC}="true" admits the call even when the matching
// token IS configured. The hatch is checked first, on purpose.
//
// Why, given that it means a configured token can sit there doing nothing: the
// two designs fail in opposite directions, and only one of them is recoverable
// by someone who is not already logged in.
//
//   hatch loses  → enforcement starts the instant CONVEX_READ_TOKEN is set, so
//                  the documented "set the token, THEN ship clients" order
//                  locks out every client mid-sequence — including the
//                  TestFlight build in Victor's pocket. Failure mode:
//                  "everybody is locked out, remotely, right now."
//   hatch wins   → setting the token is inert until the hatch is removed, so
//                  the order in the runbook actually works and removing one
//                  env var is a complete, atomic rollback. Failure mode:
//                  "enforcement quietly did not happen."
//
// The second failure is the one we can see and undo. scripts/verify-read-auth.sh
// probes the live deployment and prints OPEN vs ENFORCED, so "enforcement
// quietly did not happen" is one command away from being noticed. Nothing
// detects "everyone is locked out" except the household discovering it.
//
// ⚠️ THE HAZARD THIS BUYS, NAMED OUT LOUD: while a hatch is "true" the
// corresponding token is IGNORED. A deployment can have CONVEX_READ_TOKEN set,
// look configured in `npx convex env list`, and still be serving the family's
// finances to anyone with the URL. A set token is NOT evidence of enforcement.
// The only evidence is scripts/verify-read-auth.sh reporting ENFORCED — and the
// permissive admissions logged below. Never leave a hatch on past its soak.
//
// Cutover order (docs/convex-read-auth-cutover.md is authoritative):
//   set ALLOW_TOKENLESS_READ=true → deploy the gated code (still permissive) →
//   set CONVEX_READ_TOKEN and ship clients that send it (still permissive) →
//   confirm → remove the hatch. Removing the hatch is the enforcement flip;
//   re-setting it is the rollback.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log every permissive admission. Deliberately not throttled or sampled: a
 * hatch is a temporary cutover state measured in hours, and a line per call is
 * what makes "we are still open" impossible to miss in the deployment log. If
 * this is noisy, the hatch has outlived its purpose — remove it.
 *
 * Never logs a token, or whether the caller supplied one that matched.
 */
function warnPermissive(hatchVar: string, tokenVar: string, tokenSet: boolean) {
  console.warn(
    tokenSet
      ? `PERMISSIVE: ${hatchVar}=true is admitting this call and ${tokenVar} ` +
          `is set but IGNORED. This deployment is NOT enforcing auth. Remove ` +
          `${hatchVar} to flip enforcement on.`
      : `PERMISSIVE: ${hatchVar}=true is admitting this call unauthenticated ` +
          `(${tokenVar} is not configured). This deployment is NOT enforcing auth.`,
  );
}

// SAT-1326: FAIL-CLOSED token validation. Previously an unset CONVEX_SYNC_TOKEN
// silently allowed all mutations (open). Now an unset token rejects every
// mutation unless ALLOW_TOKENLESS_SYNC === "true".
//
// Every approved caller of these mutations must send CONVEX_SYNC_TOKEN before
// ALLOW_TOKENLESS_SYNC comes off, or its writes lock out.
function validateSyncToken(token?: string) {
  const expected = process.env.CONVEX_SYNC_TOKEN;
  if (process.env.ALLOW_TOKENLESS_SYNC === "true") {
    warnPermissive(
      "ALLOW_TOKENLESS_SYNC",
      "CONVEX_SYNC_TOKEN",
      Boolean(expected),
    );
    return;
  }
  if (!expected) {
    throw new Error(
      "Unauthorized: CONVEX_SYNC_TOKEN is not configured (fail-closed). " +
        "Set the token on the deployment, or set ALLOW_TOKENLESS_SYNC=true to " +
        "explicitly allow tokenless writes.",
    );
  }
  if (!token || token !== expected) {
    throw new Error("Unauthorized: invalid sync token");
  }
}

// SAT-READ-AUTH: reads were entirely unauthenticated until 2026-07-26. Anyone
// who knew the deployment URL — which is committed in this repo and baked into
// every shipped client binary — could read the family's full financial history.
// Confirmed live against production before this change.
//
// Same shape as validateSyncToken, same hatch precedence, for the reason in the
// banner above.
function validateReadToken(token?: string) {
  const expected = process.env.CONVEX_READ_TOKEN;
  if (process.env.ALLOW_TOKENLESS_READ === "true") {
    warnPermissive(
      "ALLOW_TOKENLESS_READ",
      "CONVEX_READ_TOKEN",
      Boolean(expected),
    );
    return;
  }
  if (!expected) {
    throw new ConvexError(
      "Unauthorized: CONVEX_READ_TOKEN is not configured (fail-closed). " +
        "Set the token on the deployment, or set ALLOW_TOKENLESS_READ=true to " +
        "explicitly allow unauthenticated reads during cutover.",
    );
  }
  if (!token || token !== expected) {
    throw new ConvexError("Unauthorized: invalid read token");
  }
}

// Deliberately hatch-free, unlike the two gates above. Minting a mobile pairing
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
  if (!token || token !== expected) {
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

// ── Queries (called by the iOS app) ──

/** Fetch a single data file by name. Returns the raw JSON data. */
export const get = query({
  args: { name: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { name, token }) => {
    validateReadToken(token);
    const doc = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    return doc?.data ?? null;
  },
});

/** Fetch current versions of all data files — lightweight check for changes. */
export const getVersions = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    validateReadToken(token);
    const docs = await ctx.db.query("syncVersions").collect();
    return Object.fromEntries(docs.map((d) => [d.name, d.version]));
  },
});

/** List all available data file names. */
export const list = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    validateReadToken(token);
    const docs = await ctx.db.query("dataFiles").collect();
    return docs.map((d) => ({
      name: d.name,
      version: d.version,
      updatedAt: d.updatedAt,
    }));
  },
});

// ── Mutations (called by the MC2 sync script) ──

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

/**
 * Shared todo-upsert core used by both the token-authenticated `upsertTodo`
 * and the device-token `upsertTodoFromMobile` paths (SAT-1508). Same LWW +
 * normalization semantics regardless of which auth front-door admitted the
 * write. Upsert one todo into todos.json and bump its version.
 */
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

/** Upsert one todo from a paired public iPhone. */
export const upsertTodoFromMobile = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    todo: appTodoValidator,
  },
  returns: v.object({
    ok: v.literal(true),
    name: v.string(),
    version: v.float64(),
    id: v.string(),
    applied: v.boolean(),
  }),
  handler: async (ctx, { deviceId, deviceToken, todo }) => {
    const device = await authenticateDevice(
      ctx,
      deviceId,
      deviceToken,
      "todos:write",
    );

    const record: Record<string, any> = {
      ...(todo as Record<string, any>),
      sync_source: "vogel-vault",
    };
    const result = await applyTodoUpsert(ctx, record, "todos");
    await markDeviceSeen(ctx, device);
    return { ok: true as const, ...result };
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
    token: v.optional(v.string()),
  },
  returns: v.object({
    pairId: v.string(),
    expiresAt: v.float64(),
  }),
  handler: async (
    ctx,
    { pairId, proofHash, expiresAt, createdBy, capabilities, token },
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
    if (pairing.claimedAt) {
      pairingFailure("PAIRING_ALREADY_CLAIMED", "Pairing already claimed");
    }
    if (pairing.expiresAt <= now) {
      pairingFailure("PAIRING_EXPIRED", "Pairing expired");
    }
    if (pairing.proofHash !== proofHash) {
      pairingFailure("PAIRING_PROOF_INVALID", "Invalid pairing proof");
    }

    const tokenHash = await sha256Hex(deviceToken);
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
      tokenHash,
      pairedAt: now,
      lastSeenAt: now,
      revokedAt: undefined,
      pairId,
      capabilities: pairing.capabilities,
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

/** Complete or reopen an existing todo from a paired public iPhone. */
export const completeTodoFromMobile = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    id: v.string(),
    title: v.optional(v.string()),
    done: v.optional(v.boolean()),
  },
  returns: v.object({
    ok: v.literal(true),
    id: v.string(),
    done: v.boolean(),
    completedAt: v.union(v.string(), v.null()),
    version: v.float64(),
    titleMatched: v.boolean(),
  }),
  handler: async (ctx, { deviceId, deviceToken, id, title, done }) => {
    const device = await authenticateDevice(
      ctx,
      deviceId,
      deviceToken,
      "todos:write",
    );

    const name = "todos";
    const now = Date.now();
    const updatedAt = new Date(now).toISOString();
    const isDone = done ?? true;
    const completedAt = isDone ? updatedAt : null;
    const existing = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();

    const currentData = existing?.data;
    const currentTodos: any[] = Array.isArray(currentData)
      ? currentData
      : currentData &&
          typeof currentData === "object" &&
          Array.isArray((currentData as any).todos)
        ? (currentData as any).todos
        : [];

    const idx = currentTodos.findIndex(
      (item) =>
        item && typeof item === "object" && "id" in item && item.id === id,
    );

    // SAT-1508: tolerate ids missing from the todos file (e.g. an app-created
    // todo that never reached MC2) by upserting a fresh record instead of
    // throwing Not-found — completion is an authoritative user action.
    const base: Record<string, any> =
      idx >= 0
        ? { ...(currentTodos[idx] as Record<string, any>) }
        : { id, title: title ?? "", created_by: "vogel-vault" };

    const titleMatched =
      idx === -1 ||
      title == null ||
      !title.trim() ||
      String(base.title || base.text || "").trim() === title.trim();

    const record: Record<string, any> = {
      ...base,
      done: isDone,
      completed: isDone,
      status: isDone ? "completed" : "pending",
      completedAt,
      updatedAt,
      updated_at: updatedAt,
      completed_by: isDone ? "vogel-vault-mobile" : undefined,
      sync_source: "vogel-vault",
    };
    if (!isDone) {
      delete record.completedAt;
      delete record.completed_by;
    }

    const result = await applyTodoUpsert(ctx, record, name);
    await markDeviceSeen(ctx, device);

    return {
      ok: true as const,
      id,
      done: isDone,
      completedAt,
      version: result.version,
      titleMatched,
    };
  },
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

/** Remove an existing todo from a paired public iPhone. */
export const removeTodoFromMobile = mutation({
  args: {
    deviceId: v.string(),
    deviceToken: v.string(),
    id: v.string(),
  },
  returns: v.object({
    ok: v.literal(true),
    name: v.string(),
    version: v.float64(),
    removed: v.boolean(),
  }),
  handler: async (ctx, { deviceId, deviceToken, id }) => {
    const device = await authenticateDevice(
      ctx,
      deviceId,
      deviceToken,
      "todos:write",
    );

    const result = await removeTodoById(ctx, id);
    await markDeviceSeen(ctx, device);
    return { ok: true as const, ...result };
  },
});

/**
 * List all todo delete tombstones (SAT-1327). Retained for compatibility
 * readers that must reject a blob todo whose updated_at predates its tombstone.
 */
export const listTodoTombstones = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    validateReadToken(token);
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
