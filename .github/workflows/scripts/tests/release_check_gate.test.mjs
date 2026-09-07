import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { verifyReleaseQualification } from "../release_check_gate.mjs"
const RELEASE_SHA = "1234567890abcdef1234567890abcdef12345678"

test("release CLI fetches trusted source proof and binds the actual landing", () => {
  const env = { RELEASE_SHA, GITHUB_SHA: RELEASE_SHA, GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "only21mil/masons-budget" }
  let calls = 0
  const result = verifyReleaseQualification(env, (program, args, options) => {
    calls++
    assert.equal(program, "python3")
    assert.match(args[0], /protected_ci_reuse\.py$/)
    assert.deepEqual(args.slice(1), ["--verify-landing", RELEASE_SHA])
    assert.equal(options.env, env)
    return { status: 0 }
  })
  assert.equal(result.status, 0)
  assert.equal(calls, 1)
  for (const changes of [{ GITHUB_SHA: "a".repeat(40) }, { GITHUB_REF: "refs/heads/feature" },
                         { GITHUB_REPOSITORY: "attacker/budget" }]) {
    assert.equal(verifyReleaseQualification({ ...env, ...changes }, () => { throw Error("must not execute") }).status, 1)
  }
  assert.equal(verifyReleaseQualification(env, () => ({ status: 1 })).status, 1)
})

test("producer-written successful stdin checks cannot authorize the CLI", () => {
  const script = fileURLToPath(new URL("../release_check_gate.mjs", import.meta.url))
  const result = spawnSync(process.execPath, [script], { encoding: "utf8",
    env: { PATH: process.env.PATH, RELEASE_SHA, GITHUB_SHA: RELEASE_SHA,
           GITHUB_REF: "refs/heads/feature" }, input: JSON.stringify({ check_runs: [{ name: "All tests", conclusion: "success" }] }) })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /actual main checkout/)
})
