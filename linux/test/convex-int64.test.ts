import { describe, expect, it } from "vitest"

import { decodeConvexInt64 } from "../electron/convexRows.ts"

const VECTORS = [
  ["AAAAAAAAAIA=", -(1n << 63n)],
  ["//////////8=", -1n],
  ["AAAAAAAAAAA=", 0n],
  ["AQAAAAAAAAA=", 1n],
  ["AAEAAAAAAAA=", 256n],
  ["AQAAAAAAIAA=", 9_007_199_254_740_993n],
  ["////////3/8=", -9_007_199_254_740_993n],
  ["/////////38=", (1n << 63n) - 1n],
] as const

describe("canonical Convex int64 wire decoding", () => {
  for (const [wire, value] of VECTORS) {
    it(`decodes ${value}`, () => {
      expect(decodeConvexInt64({ $integer: wire })).toBe(value)
    })
  }

  it.each([
    ["missing padding", { $integer: "AQAAAAAAAAA" }],
    ["URL-safe alphabet", { $integer: "AQAAAAAAAAA_" }],
    ["extra wrapper field", { $integer: "AQAAAAAAAAA=", other: true }],
    ["too few bytes", { $integer: "AQAAAAA=" }],
    ["too many bytes", { $integer: "AQAAAAAAAAAAAAA=" }],
    ["wrong value type", { $integer: 1 }],
    ["not a wrapper", "AQAAAAAAAAA="],
  ])("rejects %s", (_label, wire) => {
    expect(() => decodeConvexInt64(wire)).toThrow()
  })
})
