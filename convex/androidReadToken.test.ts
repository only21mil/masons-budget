import { describe, expect, it } from "vitest";

import { isValidAndroidReadToken } from "./androidReadToken";

describe("isValidAndroidReadToken", () => {
  it("accepts exactly the supported 32 through 512 byte lengths", () => {
    for (let length = 0; length <= 513; length += 1) {
      expect(isValidAndroidReadToken("A".repeat(length)), `length ${length}`).toBe(
        length >= 32 && length <= 512,
      );
    }
    expect(isValidAndroidReadToken("A".repeat(1_024))).toBe(false);
  });

  it("accepts exactly printable non-space ASCII", () => {
    for (let code = 0x00; code <= 0x7f; code += 1) {
      const token = "A".repeat(31) + String.fromCharCode(code);
      expect(isValidAndroidReadToken(token), `ASCII 0x${code.toString(16)}`).toBe(
        code >= 0x21 && code <= 0x7e,
      );
    }
  });

  it("rejects non-ASCII code points", () => {
    for (const character of ["\u0080", "é", "\u2028", "💩"]) {
      expect(isValidAndroidReadToken("A".repeat(31) + character)).toBe(false);
    }
  });

  it("fails closed for missing and non-string values", () => {
    for (const value of [undefined, null, 42, true, {}, []]) {
      expect(isValidAndroidReadToken(value)).toBe(false);
    }
  });
});
