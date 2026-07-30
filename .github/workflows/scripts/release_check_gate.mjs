#!/usr/bin/env node

import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const GITHUB_ACTIONS_APP_ID = 15368

export const REQUIRED_SUCCESS_CHECKS = Object.freeze([
  "Detect changed trees",
  "Detect Apple changes",
  "actionlint + secret inventory",
  "Shared domain contract",
  "Convex functions",
  "Verify committed Xcode project",
  "Build and test the Apple client",
])

export const CONDITIONAL_CHECKS = Object.freeze([
  "Production wire golden decoders",
  "Linux client",
  "Android client",
])

function timestamp(check) {
  return check.completed_at ?? check.started_at ?? check.created_at ?? ""
}

export function conclusionOf(checks, name) {
  const matching = checks
    .filter(
      (check) =>
        check?.name === name &&
        check?.app?.id === GITHUB_ACTIONS_APP_ID,
    )
    .sort((left, right) => timestamp(left).localeCompare(timestamp(right)))
  const latest = matching.at(-1)
  if (latest == null) return "missing"
  if (latest.status !== "completed") return "pending"
  return latest.conclusion ?? "missing"
}

export function evaluateReleaseChecks(payload) {
  const checks = Array.isArray(payload?.check_runs) ? payload.check_runs : []
  const lines = []
  let passed = true

  for (const name of REQUIRED_SUCCESS_CHECKS) {
    const conclusion = conclusionOf(checks, name)
    if (conclusion === "success") {
      lines.push(`PASS  ${name}`)
    } else {
      lines.push(`FAIL  ${name} (${conclusion})`)
      passed = false
    }
  }

  for (const name of CONDITIONAL_CHECKS) {
    const conclusion = conclusionOf(checks, name)
    if (conclusion === "success") {
      lines.push(`PASS  ${name}`)
    } else if (conclusion === "skipped") {
      lines.push(`SKIP  ${name} (not applicable to this commit)`)
    } else {
      lines.push(`FAIL  ${name} (${conclusion})`)
      passed = false
    }
  }

  return { passed, lines }
}

async function main() {
  let input = ""
  for await (const chunk of process.stdin) input += chunk

  let payload
  try {
    payload = JSON.parse(input)
  } catch {
    console.error("release-check-gate: GitHub returned unreadable check-run JSON.")
    return 1
  }

  const result = evaluateReleaseChecks(payload)
  for (const line of result.lines) console.log(line)
  if (!result.passed) {
    console.error(
      "::error::The exact main release SHA does not have green required CI.",
    )
    return 1
  }
  return 0
}

const entrypoint =
  process.argv[1] == null ? null : pathToFileURL(resolve(process.argv[1])).href

if (import.meta.url === entrypoint) {
  process.exitCode = await main()
}
