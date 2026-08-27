import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
  CONDITIONAL_CHECKS,
  REQUIRED_SUCCESS_CHECKS,
  evaluateReleaseChecks,
  exactMainReleaseApplicability,
} from "../release_check_gate.mjs"

const SUCCESS = "success"
const SKIPPED = "skipped"
const RELEASE_SHA = "1234567890abcdef1234567890abcdef12345678"

function check(name, conclusion, overrides = {}) {
  return {
    name,
    status: "completed",
    conclusion,
    completed_at: "2026-07-30T12:00:00Z",
    app: { id: 15368 },
    head_sha: RELEASE_SHA,
    ...overrides,
  }
}

function payload(overrides = {}) {
  const conclusions = new Map([
    ...REQUIRED_SUCCESS_CHECKS.map((name) => [name, SUCCESS]),
    ...CONDITIONAL_CHECKS.map((name) => [name, SUCCESS]),
    ...Object.entries(overrides),
  ])
  return {
    check_runs: [...conclusions].map(([name, conclusion]) =>
      check(name, conclusion),
    ),
  }
}

function applicability(overrides = {}) {
  const evidence = exactMainReleaseApplicability({
    RELEASE_SHA,
    GITHUB_SHA: RELEASE_SHA,
    GITHUB_REF: "refs/heads/main",
  })
  assert.notEqual(evidence, null)
  return {
    ...evidence,
    checks: { ...evidence.checks, ...overrides },
  }
}

test("all successful exact-SHA checks satisfy the release gate", () => {
  assert.equal(evaluateReleaseChecks(payload(), applicability()).passed, true)
})

for (const name of CONDITIONAL_CHECKS) {
  test(`an applicable skipped ${name} check blocks release`, () => {
    const result = evaluateReleaseChecks(
      payload({ [name]: SKIPPED }),
      applicability(),
    )

    assert.equal(result.passed, false)
    assert.ok(
      result.lines.includes(`FAIL  ${name} (skipped; applicability applicable)`),
    )
  })
}

test("an exact-commit inapplicable skipped check is accepted", () => {
  const result = evaluateReleaseChecks(
    payload({ "Linux client": SKIPPED }),
    applicability({ "Linux client": false }),
  )

  assert.equal(result.passed, true)
  assert.ok(
    result.lines.includes(
      "SKIP  Linux client (exact-commit policy says inapplicable)",
    ),
  )
})

test("a skipped check without applicability evidence blocks release", () => {
  const evidence = applicability()
  delete evidence.checks["Linux client"]
  const result = evaluateReleaseChecks(
    payload({ "Linux client": SKIPPED }),
    evidence,
  )

  assert.equal(result.passed, false)
  assert.ok(
    result.lines.includes("FAIL  Linux client (skipped; applicability missing)"),
  )
})

test("applicability evidence requires the exact main checkout", () => {
  assert.equal(
    exactMainReleaseApplicability({
      RELEASE_SHA,
      GITHUB_SHA: "abcdef1234567890abcdef1234567890abcdef12",
      GITHUB_REF: "refs/heads/main",
    }),
    null,
  )
  assert.equal(
    exactMainReleaseApplicability({
      RELEASE_SHA,
      GITHUB_SHA: RELEASE_SHA,
      GITHUB_REF: "refs/heads/release-candidate",
    }),
    null,
  )
})

test("failed project consistency blocks release even when Apple build skipped", () => {
  const result = evaluateReleaseChecks(
    payload({
      "Verify committed Xcode project": "failure",
      "Build and test the Apple client": SKIPPED,
    }),
    applicability(),
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
    applicability(),
  )

  assert.equal(result.passed, false)
})

test("missing project consistency blocks release", () => {
  const base = payload()
  base.check_runs = base.check_runs.filter(
    (entry) => entry.name !== "Verify committed Xcode project",
  )

  const result = evaluateReleaseChecks(base, applicability())

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

  const result = evaluateReleaseChecks(base, applicability())

  assert.equal(result.passed, false)
  assert.ok(
    result.lines.includes("FAIL  Verify committed Xcode project (pending)"),
  )
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

  const result = evaluateReleaseChecks(base, applicability())

  assert.equal(result.passed, false)
  assert.ok(result.lines.includes("FAIL  Build and test the Apple client (pending)"))
})

test("the newest exact-SHA GitHub Actions run wins over stale duplicates", () => {
  const base = payload()
  base.check_runs = base.check_runs.filter(
    (entry) => entry.name !== "Linux client",
  )
  base.check_runs.push(
    check("Linux client", SUCCESS, {
      completed_at: "2026-07-30T11:00:00Z",
    }),
    check("Linux client", "failure", {
      completed_at: "2026-07-30T13:00:00Z",
    }),
    check("Linux client", SUCCESS, {
      app: { id: 999 },
      completed_at: "2026-07-30T14:00:00Z",
    }),
    check("Linux client", SUCCESS, {
      head_sha: "abcdef1234567890abcdef1234567890abcdef12",
      completed_at: "2026-07-30T15:00:00Z",
    }),
  )

  const result = evaluateReleaseChecks(base, applicability())

  assert.equal(result.passed, false)
  assert.ok(result.lines.includes("FAIL  Linux client (failure)"))
})

test("CLI exits successfully only when the release policy is satisfied", () => {
  const script = fileURLToPath(
    new URL("../release_check_gate.mjs", import.meta.url),
  )
  const passing = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_SHA,
      GITHUB_SHA: RELEASE_SHA,
      GITHUB_REF: "refs/heads/main",
    },
    input: JSON.stringify(payload()),
  })
  assert.equal(passing.status, 0, passing.stderr)

  const failing = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_SHA,
      GITHUB_SHA: RELEASE_SHA,
      GITHUB_REF: "refs/heads/main",
    },
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
