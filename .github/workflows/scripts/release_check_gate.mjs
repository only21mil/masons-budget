#!/usr/bin/env node

import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const GITHUB_ACTIONS_APP_ID = 15368
const EXACT_RELEASE_POLICY_SOURCE = "exact-main-release-commit"
const FULL_SHA = /^[0-9a-f]{40}$/

export const REQUIRED_SUCCESS_CHECKS = Object.freeze([
  "Detect changed trees",
  "Detect Apple changes",
  "actionlint + secret inventory",
  "Credential mint tooling",
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

export function conclusionOf(checks, name, releaseSha) {
  const matching = checks
    .filter(
      (check) =>
        check?.name === name &&
        check?.app?.id === GITHUB_ACTIONS_APP_ID &&
        check?.head_sha === releaseSha,
    )
    .sort((left, right) => timestamp(left).localeCompare(timestamp(right)))
  const latest = matching.at(-1)
  if (latest == null) return "missing"
  if (latest.status !== "completed") return "pending"
  return latest.conclusion ?? "missing"
}

export function exactMainReleaseApplicability(env) {
  const releaseSha = env.RELEASE_SHA ?? ""
  if (
    !FULL_SHA.test(releaseSha) ||
    env.GITHUB_SHA !== releaseSha ||
    env.GITHUB_REF !== "refs/heads/main"
  ) {
    return null
  }

  // clients.yml verifies every client tree on a main push or manual dispatch,
  // and its wire-golden job is unconditional. This policy comes from the gate
  // checked out at the exact release commit, not from a skipped check result.
  return Object.freeze({
    releaseSha,
    source: EXACT_RELEASE_POLICY_SOURCE,
    checks: Object.freeze(
      Object.fromEntries(CONDITIONAL_CHECKS.map((name) => [name, true])),
    ),
  })
}

function applicabilityOf(evidence, name) {
  if (
    evidence?.source !== EXACT_RELEASE_POLICY_SOURCE ||
    !FULL_SHA.test(evidence?.releaseSha ?? "") ||
    typeof evidence?.checks?.[name] !== "boolean"
  ) {
    return "missing"
  }
  return evidence.checks[name] ? "applicable" : "inapplicable"
}

export function evaluateReleaseChecks(payload, applicabilityEvidence) {
  const checks = Array.isArray(payload?.check_runs) ? payload.check_runs : []
  const releaseSha = applicabilityEvidence?.releaseSha ?? ""
  const lines = []
  let passed = true

  for (const name of REQUIRED_SUCCESS_CHECKS) {
    const conclusion = conclusionOf(checks, name, releaseSha)
    if (conclusion === "success") {
      lines.push(`PASS  ${name}`)
    } else {
      lines.push(`FAIL  ${name} (${conclusion})`)
      passed = false
    }
  }

  for (const name of CONDITIONAL_CHECKS) {
    const conclusion = conclusionOf(checks, name, releaseSha)
    const applicability = applicabilityOf(applicabilityEvidence, name)
    if (conclusion === "success") {
      lines.push(`PASS  ${name}`)
    } else if (conclusion === "skipped" && applicability === "inapplicable") {
      lines.push(`SKIP  ${name} (exact-commit policy says inapplicable)`)
    } else {
      const detail =
        conclusion === "skipped"
          ? `${conclusion}; applicability ${applicability}`
          : conclusion
      lines.push(`FAIL  ${name} (${detail})`)
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

  const result = evaluateReleaseChecks(
    payload,
    exactMainReleaseApplicability(process.env),
  )
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
