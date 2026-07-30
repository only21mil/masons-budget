import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
  CONDITIONAL_CHECKS,
  REQUIRED_SUCCESS_CHECKS,
  evaluateReleaseChecks,
} from "../release_check_gate.mjs"

const SUCCESS = "success"
const SKIPPED = "skipped"

function check(name, conclusion, overrides = {}) {
  return {
    name,
    status: "completed",
    conclusion,
    completed_at: "2026-07-30T12:00:00Z",
    app: { id: 15368 },
    ...overrides,
  }
}

function payload(overrides = {}) {
  const conclusions = new Map([
    ...REQUIRED_SUCCESS_CHECKS.map((name) => [name, SUCCESS]),
    ...CONDITIONAL_CHECKS.map((name) => [name, SKIPPED]),
    ...Object.entries(overrides),
  ])
  return {
    check_runs: [...conclusions].map(([name, conclusion]) =>
      check(name, conclusion),
    ),
  }
}

test("successful Apple integrity checks allow unrelated skipped clients", () => {
  assert.equal(evaluateReleaseChecks(payload()).passed, true)
})

test("failed project consistency blocks release even when Apple build skipped", () => {
  const result = evaluateReleaseChecks(
    payload({
      "Verify committed Xcode project": "failure",
      "Build and test the Apple client": SKIPPED,
    }),
  )

  assert.equal(result.passed, false)
  assert.ok(
    result.lines.includes("FAIL  Verify committed Xcode project (failure)"),
  )
  assert.ok(result.lines.includes("FAIL  Build and test the Apple client (skipped)"))
})

test("skipped Apple checks block release until exact-SHA manual verification", () => {
  const result = evaluateReleaseChecks(
    payload({
      "Verify committed Xcode project": SKIPPED,
      "Build and test the Apple client": SKIPPED,
    }),
  )

  assert.equal(result.passed, false)
})

test("missing project consistency blocks release", () => {
  const base = payload()
  base.check_runs = base.check_runs.filter(
    (entry) => entry.name !== "Verify committed Xcode project",
  )

  const result = evaluateReleaseChecks(base)

  assert.equal(result.passed, false)
  assert.ok(
    result.lines.includes("FAIL  Verify committed Xcode project (missing)"),
  )
})

test("pending project consistency blocks release", () => {
  const base = payload()
  base.check_runs = base.check_runs.filter(
    (entry) => entry.name !== "Verify committed Xcode project",
  )
  base.check_runs.push(
    check("Verify committed Xcode project", null, {
      status: "in_progress",
      completed_at: null,
      started_at: "2026-07-30T14:00:00Z",
    }),
  )

  const result = evaluateReleaseChecks(base)

  assert.equal(result.passed, false)
  assert.ok(
    result.lines.includes("FAIL  Verify committed Xcode project (pending)"),
  )
})

test("a skipped non-Apple conditional check remains acceptable", () => {
  const result = evaluateReleaseChecks(
    payload({
      "Linux client": SKIPPED,
      "Android client": SUCCESS,
    }),
  )

  assert.equal(result.passed, true)
  assert.ok(result.lines.includes("SKIP  Linux client (not applicable to this commit)"))
})

test("external or pending lookalike checks do not satisfy the gate", () => {
  const external = check("Build and test the Apple client", SUCCESS, {
    app: { id: 999 },
    completed_at: "2026-07-30T13:00:00Z",
  })
  const pending = check("Build and test the Apple client", null, {
    status: "in_progress",
    completed_at: null,
    started_at: "2026-07-30T14:00:00Z",
  })
  const base = payload()
  base.check_runs = base.check_runs.filter(
    (entry) => entry.name !== "Build and test the Apple client",
  )
  base.check_runs.push(external, pending)

  const result = evaluateReleaseChecks(base)

  assert.equal(result.passed, false)
  assert.ok(result.lines.includes("FAIL  Build and test the Apple client (pending)"))
})

test("CLI exits successfully only when the release policy is satisfied", () => {
  const script = fileURLToPath(
    new URL("../release_check_gate.mjs", import.meta.url),
  )
  const passing = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    input: JSON.stringify(payload()),
  })
  assert.equal(passing.status, 0, passing.stderr)

  const failing = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    input: JSON.stringify(
      payload({
        "Verify committed Xcode project": "failure",
      }),
    ),
  })
  assert.equal(failing.status, 1)
  assert.match(failing.stderr, /exact main release SHA/)
  assert.match(failing.stdout, /Verify committed Xcode project \(failure\)/)
})
