#!/usr/bin/env node

import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { captureWireGoldens } from "./convex-wire-golden.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

if (process.argv.length !== 2) {
  console.error(
    "FAIL: this command accepts no arguments; provide CONVEX_READ_TOKEN through the environment",
  )
  process.exit(2)
}

try {
  const result = await captureWireGoldens({ repoRoot })
  console.log(
    `PASS: wrote ${result.captureCount} credential-screened production captures `
      + `and contract ${result.contractSha256}.`,
  )
} catch (error) {
  const message = error instanceof Error ? error.message : "capture failed"
  console.error(`FAIL: ${message}`)
  process.exit(1)
}
