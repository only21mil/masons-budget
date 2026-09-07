#!/usr/bin/env node

import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { pathToFileURL } from "node:url"

const FULL_SHA = /^[0-9a-f]{40}$/

export function verifyReleaseQualification(env, execute = spawnSync) {
  const releaseSha = env.RELEASE_SHA ?? ""
  if (!FULL_SHA.test(releaseSha) || env.GITHUB_SHA !== releaseSha ||
      env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_REPOSITORY !== "only21mil/masons-budget") {
    return { status: 1, stderr: "Release qualification requires the actual main checkout.\n" }
  }
  // Fetch source/provider evidence inside the trusted verifier. Neither stdin
  // checks nor an operator-written JSON receipt can authorize this gate.
  return execute("python3", [fileURLToPath(new URL("./protected_ci_reuse.py", import.meta.url)),
    "--verify-landing", releaseSha], { env, encoding: "utf8" })
}

async function main() {
  const result = verifyReleaseQualification(process.env)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  return result.status === 0 ? 0 : 1
}

const entrypoint =
  process.argv[1] == null ? null : pathToFileURL(resolve(process.argv[1])).href

if (import.meta.url === entrypoint) {
  process.exitCode = await main()
}
