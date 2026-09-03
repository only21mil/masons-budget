// Unit coverage for the deployment's constant-time credential comparators.
//
// These guards exist so no comparison of a shared token or a device token hash
// can leak its content through response timing. They are pure functions, so the
// assertions here are direct and do not need the convex-test harness.
import { describe, expect, it } from "vitest";

import {
  equalSha256Hex,
  timingSafeEqualStrings,
} from "./deviceAuth";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

describe("equalSha256Hex", () => {
  it("accepts identical digests", () => {
    expect(equalSha256Hex(HEX_A, HEX_A)).toBe(true);
  });

  it("rejects any differing digest", () => {
    expect(equalSha256Hex(HEX_A, HEX_B)).toBe(false);
    expect(equalSha256Hex(HEX_A.toUpperCase(), HEX_A)).toBe(false);
  });

  it("rejects values that are not 64 hex characters", () => {
    expect(equalSha256Hex(HEX_A.slice(1), HEX_A)).toBe(false);
    expect(equalSha256Hex(HEX_A, `${HEX_A}0`)).toBe(false);
    expect(equalSha256Hex("", "")).toBe(false);
  });
});

describe("timingSafeEqualStrings", () => {
  it("accepts identical strings", () => {
    expect(timingSafeEqualStrings("secret-value", "secret-value")).toBe(true);
    expect(timingSafeEqualStrings("", "")).toBe(true);
  });

  it("rejects differing content of equal length", () => {
    expect(timingSafeEqualStrings("secret-value", "secret-valuf")).toBe(false);
    expect(timingSafeEqualStrings("secret-value", "Xecret-value")).toBe(false);
  });

  it("rejects differing lengths, including prefix relationships", () => {
    expect(timingSafeEqualStrings("secret", "secret-value")).toBe(false);
    expect(timingSafeEqualStrings("secret-value", "secret")).toBe(false);
    expect(timingSafeEqualStrings("", "x")).toBe(false);
  });

  it("never throws on mismatched lengths", () => {
    expect(() => timingSafeEqualStrings("a", "abcdefghij")).not.toThrow();
  });
});
