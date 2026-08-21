import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { decodeConvexInt64, encodeConvexInt64 } from "../src/convexInt64.ts"

interface ValidCase {
  name: string
  wire: unknown
  decimal: string
}

interface InvalidCase {
  name: string
  wire: unknown
}

interface FormatCase {
  name: string
  format: "json" | "convex_encoded_json"
  fieldClass: "v.int64" | "v.float64"
  wire: unknown
  validForFormat: boolean
  decimal?: string
}

interface StrictParserScope {
  format: "convex_encoded_json"
  fieldClass: "v.int64"
}

interface Fixtures {
  formatCases: FormatCase[]
  valid: ValidCase[]
  invalid: InvalidCase[]
  strictParserScope: StrictParserScope
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

test("encodes the canonical signed little-endian Convex int64 fixtures", () => {
  for (const testCase of fixtures.valid) {
    assert.deepEqual(encodeConvexInt64(BigInt(testCase.decimal)), testCase.wire, testCase.name)
  }
})

test("production format cases enforce format-specific int64 behavior", async (context) => {
  assert.deepEqual(fixtures.strictParserScope, {
    format: "convex_encoded_json",
    fieldClass: "v.int64",
  })
  assert.deepEqual(
    [
      ...new Set(
        fixtures.formatCases
          .filter((testCase) => testCase.validForFormat)
          .map(({ format, fieldClass }) => `${format}:${fieldClass}`),
      ),
    ].sort(),
    [
      "convex_encoded_json:v.float64",
      "convex_encoded_json:v.int64",
      "json:v.float64",
      "json:v.int64",
    ],
  )

  assert.deepEqual(
    fixtures.formatCases
      .filter((testCase) => !testCase.validForFormat)
      .map((testCase) => JSON.stringify(testCase.wire))
      .sort(),
    ['"1"', "1"],
  )

  for (const testCase of fixtures.formatCases) {
    await context.test(testCase.name, () => {
      if (!testCase.validForFormat) {
        assert.equal(testCase.format, "convex_encoded_json")
        assert.equal(testCase.fieldClass, "v.int64")
        assert.throws(() => decodeConvexInt64(testCase.wire), Error)
        return
      }

      if (testCase.fieldClass === "v.float64") {
        assert.equal(typeof testCase.wire, "number")
        return
      }

      const expectedDecimal = testCase.decimal
      if (expectedDecimal === undefined) {
        assert.fail(`${testCase.name} must declare its exact decimal value`)
      }
      if (testCase.format === "convex_encoded_json") {
        assert.equal(decodeConvexInt64(testCase.wire), BigInt(expectedDecimal))
        return
      }

      assert.equal(typeof testCase.wire, "string")
      assert.match(testCase.wire as string, /^-?(?:0|[1-9]\d*)$/)
      assert.equal(BigInt(testCase.wire as string), BigInt(expectedDecimal))
      assert.throws(() => decodeConvexInt64(testCase.wire), Error)
    })
  }
})

test("pins signed int64 extrema", () => {
  assert.equal(decodeConvexInt64({ $integer: "/////////38=" }), 9_223_372_036_854_775_807n)
  assert.equal(decodeConvexInt64({ $integer: "AAAAAAAAAIA=" }), -9_223_372_036_854_775_808n)
  assert.throws(() => encodeConvexInt64(9_223_372_036_854_775_808n), RangeError)
  assert.throws(() => encodeConvexInt64(-9_223_372_036_854_775_809n), RangeError)
})

test("preserves values beyond the JavaScript safe integer range", () => {
  const positive = decodeConvexInt64({ $integer: "FYHpffQQIhE=" })
  const negative = decodeConvexInt64({ $integer: "634Wggvv3e4=" })

  assert.equal(positive, 1_234_567_890_123_456_789n)
  assert.equal(negative, -1_234_567_890_123_456_789n)
  assert.equal(typeof positive, "bigint")
})

test("rejects aliases, fallback values, malformed Base64, and wrong lengths", async (context) => {
  for (const testCase of fixtures.invalid) {
    await context.test(testCase.name, () => {
      assert.throws(() => decodeConvexInt64(testCase.wire), Error)
    })
  }
})
