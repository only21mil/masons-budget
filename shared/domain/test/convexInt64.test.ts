import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { decodeConvexInt64 } from "../src/convexInt64.ts"

interface ValidCase {
  name: string
  wire: unknown
  decimal: string
}

interface InvalidCase {
  name: string
  wire: unknown
}

interface Fixtures {
  valid: ValidCase[]
  invalid: InvalidCase[]
}

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "convex-int64-wire-cases.json"), "utf8"),
) as Fixtures

test("decodes canonical signed little-endian Convex int64 fixtures", () => {
  for (const testCase of fixtures.valid) {
    assert.equal(decodeConvexInt64(testCase.wire), BigInt(testCase.decimal), testCase.name)
  }
})

test("pins signed int64 extrema", () => {
  assert.equal(decodeConvexInt64({ $integer: "/////////38=" }), 9_223_372_036_854_775_807n)
  assert.equal(decodeConvexInt64({ $integer: "AAAAAAAAAIA=" }), -9_223_372_036_854_775_808n)
})

test("preserves values beyond the JavaScript safe integer range", () => {
  const positive = decodeConvexInt64({ $integer: "FYHpffQQIhE=" })
  const negative = decodeConvexInt64({ $integer: "634Wggvv3e4=" })

  assert.equal(positive, 1_234_567_890_123_456_789n)
  assert.equal(negative, -1_234_567_890_123_456_789n)
  assert.equal(typeof positive, "bigint")
})

test("rejects aliases, fallback values, malformed Base64, and wrong lengths", () => {
  for (const testCase of fixtures.invalid) {
    assert.throws(() => decodeConvexInt64(testCase.wire), Error, testCase.name)
  }
})
