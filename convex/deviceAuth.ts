import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export const DEVICE_CAPABILITIES = [
  "todos:write",
  "transactions:write",
  "budget:write",
  "bitcoin:write",
] as const;

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
    tokenHash !== device.tokenHash ||
    !normalizeDeviceCapabilities(device.capabilities).includes(capability)
  ) {
    throw new ConvexError({
      code: "DEVICE_UNAUTHORIZED",
      message: "Unauthorized mobile device",
    });
  }
  return device;
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
  if (!device || tokenHash !== device.tokenHash) {
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
