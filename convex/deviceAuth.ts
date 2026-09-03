import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export const DEVICE_CAPABILITIES = [
  "todos:write",
  "transactions:write",
  "budget:write",
  "bitcoin:write",
] as const;

export const DEVICE_PROFILES = ["victor", "rachel", "mason", "maddox"] as const;

export type DeviceProfile = (typeof DEVICE_PROFILES)[number];

export const deviceProfileValidator = v.union(
  v.literal("victor"),
  v.literal("rachel"),
  v.literal("mason"),
  v.literal("maddox"),
);

export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];

export const deviceCapabilityValidator = v.union(
  v.literal("todos:write"),
  v.literal("transactions:write"),
  v.literal("budget:write"),
  v.literal("bitcoin:write"),
);

/**
 * Legacy pairings and devices predate capability storage and remain todo-only.
 * An explicit empty array is deliberately different: it grants nothing.
 */
export function normalizeDeviceCapabilities(
  capabilities?: readonly DeviceCapability[],
): DeviceCapability[] {
  if (capabilities === undefined) return ["todos:write"];
  const requested = new Set(capabilities);
  return DEVICE_CAPABILITIES.filter((capability) => requested.has(capability));
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time equality of two 64-character lowercase sha256 hex digests. */
export function equalSha256Hex(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Constant-time equality for two secret strings of arbitrary length.
 *
 * Every byte position of BOTH inputs is folded into one accumulator, and the
 * length difference is folded in as well, so the observable work does not
 * depend on where (or whether) the inputs agree. Reading `left` past its own
 * length yields NaN, normalised to 0, so a length mismatch cannot throw and
 * the accumulator still settles on a non-zero value.
 */
export function timingSafeEqualStrings(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const longest = Math.max(left.length, right.length);
  for (let index = 0; index < longest; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function validateDeviceCredentialShape(
  deviceId: string,
  deviceToken: string,
) {
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId) ||
    !/^[A-Za-z0-9._-]{32,256}$/.test(deviceToken)
  ) {
    throw new ConvexError({
      code: "VALIDATION_FAILED",
      message: "Malformed device credential.",
    });
  }
}

/**
 * Authenticate by the indexed device id and require one server-minted
 * capability. Capability failures intentionally share the generic auth error:
 * callers must not be able to enumerate a device's grants.
 */
export async function authenticateDevice(
  ctx: MutationCtx,
  deviceId: string,
  deviceToken: string,
  capability: DeviceCapability,
) {
  validateDeviceCredentialShape(deviceId, deviceToken);
  const device = await ctx.db
    .query("mobileDevices")
    .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
    .unique();
  const tokenHash = await sha256Hex(deviceToken);
  if (
    !device ||
    device.revokedAt !== undefined ||
    !equalSha256Hex(tokenHash, device.tokenHash) ||
    !normalizeDeviceCapabilities(device.capabilities).includes(capability)
  ) {
    throw new ConvexError({
      code: "DEVICE_UNAUTHORIZED",
      message: "Unauthorized mobile device",
    });
  }
  return device;
}

/** Task authority comes from the credential's server-stored profile. */
export function requireTaskProfileBinding(
  device: { profile?: DeviceProfile },
  activeProfile: DeviceProfile | undefined,
  owner: DeviceProfile,
  todoId: string,
): DeviceProfile {
  if (device.profile === undefined) {
    throw new ConvexError({
      code: "PROFILE_BINDING_REQUIRED",
      message: "This device credential is not bound to a task profile.",
      entityType: "todo",
      entityId: todoId,
    });
  }
  if (activeProfile !== device.profile || owner !== device.profile) {
    throw new ConvexError({
      code: "OWNER_MISMATCH",
      message: `Task request profile and owner must match credential profile ${device.profile}.`,
      entityType: "todo",
      entityId: todoId,
    });
  }
  return device.profile;
}

/** Authenticate the device token without granting any data capability. */
export async function authenticateDeviceForSelfRevoke(
  ctx: MutationCtx,
  deviceId: string,
  deviceToken: string,
) {
  validateDeviceCredentialShape(deviceId, deviceToken);
  const device = await ctx.db
    .query("mobileDevices")
    .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
    .unique();
  const tokenHash = await sha256Hex(deviceToken);
  if (!device || !equalSha256Hex(tokenHash, device.tokenHash)) {
    throw new ConvexError({
      code: "DEVICE_UNAUTHORIZED",
      message: "Unauthorized mobile device",
    });
  }
  return device;
}

/** Call only after an authorized mutation has completed successfully. */
export async function markDeviceSeen(
  ctx: MutationCtx,
  device: { _id: Id<"mobileDevices"> },
) {
  await ctx.db.patch(device._id, { lastSeenAt: Date.now() });
}
