#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import {
  CAPTURE_DEPLOYMENT,
  CAPTURE_ENDPOINT,
  CAPTURE_FORMATS,
  CAPTURE_QUERIES,
  captureContractDigest,
} from "./convex-wire-golden.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const goldenRoot = path.join(repoRoot, "shared/domain/fixtures/convex-wire-golden")
const provenancePath = path.join(repoRoot, "shared/domain/convex-wire-golden-provenance.json")
const provenance = JSON.parse(await readFile(provenancePath, "utf8"))
const failures = []

if (provenance.version !== 2) {
  failures.push(`unsupported provenance version ${String(provenance.version)}`)
}

const formats = provenance.attestation?.formats
const queries = provenance.attestation?.queries
const expectedQueryNames = CAPTURE_QUERIES.map(({ name }) => name)
if (
  !Array.isArray(formats)
  || formats.join(",") !== CAPTURE_FORMATS.join(",")
  || !Array.isArray(queries)
  || queries.join(",") !== expectedQueryNames.join(",")
) {
  failures.push("attestation query/format matrix differs from the capture contract")
}
if (provenance.attestation?.credentialEchoChecked !== true) {
  failures.push("attestation must confirm the credential-echo redaction check")
}
if (
  provenance.deployment !== CAPTURE_DEPLOYMENT
  || provenance.endpoint !== CAPTURE_ENDPOINT
) {
  failures.push("attestation deployment or endpoint differs from the capture target")
}

const expectedFiles = new Set()
for (const query of queries ?? []) {
  for (const format of formats ?? []) {
    expectedFiles.add(`${query}.${format}.json`)
  }
}

const captureFiles = (await readdir(goldenRoot))
  .filter((name) => name.endsWith(".json"))
  .sort()
const attestedFiles = Object.keys(provenance.captures ?? {}).sort()

for (const filename of expectedFiles) {
  if (!captureFiles.includes(filename)) {
    failures.push(`missing capture ${filename}`)
  }
}
for (const filename of captureFiles) {
  if (!expectedFiles.has(filename)) {
    failures.push(`capture is not named by the attestation: ${filename}`)
  }
}
if (captureFiles.join("\n") !== attestedFiles.join("\n")) {
  failures.push("capture files and provenance checksum entries differ")
}

for (const filename of captureFiles) {
  const bytes = await readFile(path.join(goldenRoot, filename))
  const actual = createHash("sha256").update(bytes).digest("hex")
  const expected = provenance.captures?.[filename]
  if (actual !== expected) {
    failures.push(
      `checksum mismatch for ${filename}: expected ${String(expected)}, received ${actual}`,
    )
  }
}

const contract = await captureContractDigest(repoRoot)
if (
  provenance.contract?.algorithm !== "sha256"
  || provenance.contract?.extractor !== "selected-typescript-declarations-v1"
) {
  failures.push("capture contract must use the reviewed selective SHA-256 extractor")
}
if (JSON.stringify(provenance.contract?.sources) !== JSON.stringify(contract.sources)) {
  failures.push("capture contract source declaration list differs from the reviewed scope")
}
if (provenance.contract?.sha256 !== contract.sha256) {
  failures.push(
    `capture contract checksum mismatch: expected ${String(provenance.contract?.sha256)}, `
      + `received ${contract.sha256}`,
  )
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`)
  }
  process.exit(1)
}

const capturedDate = provenance.capturedDate
if (typeof capturedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(capturedDate)) {
  console.error("FAIL: capturedDate must be an ISO calendar date (YYYY-MM-DD)")
  process.exit(1)
}

const capturedAt = new Date(`${capturedDate}T00:00:00.000Z`)
const nowInput = process.env.CONVEX_WIRE_GOLDEN_NOW
const now = nowInput === undefined ? new Date() : new Date(nowInput)
if (Number.isNaN(capturedAt.valueOf()) || Number.isNaN(now.valueOf())) {
  console.error("FAIL: capturedDate or CONVEX_WIRE_GOLDEN_NOW is not a valid date")
  process.exit(1)
}

const ageDays = Math.floor((now.valueOf() - capturedAt.valueOf()) / 86_400_000)
const warningAfterDays = provenance.freshness?.warningAfterDays
const failAfterDays = provenance.freshness?.failAfterDays
if (
  !Number.isInteger(warningAfterDays)
  || !Number.isInteger(failAfterDays)
  || warningAfterDays < 1
  || failAfterDays <= warningAfterDays
) {
  console.error("FAIL: freshness thresholds must be increasing positive integers")
  process.exit(1)
}
if (ageDays < 0) {
  console.error(`FAIL: capture date ${capturedDate} is ${Math.abs(ageDays)} days in the future`)
  process.exit(1)
}
if (ageDays >= failAfterDays) {
  console.error(
    `::error::Production wire goldens are ${ageDays} days old (captured ${capturedDate}); `
      + `the ${failAfterDays}-day freshness limit requires a new attested production capture.`,
  )
  process.exit(1)
}
if (ageDays >= warningAfterDays) {
  console.warn(
    `::warning::Production wire goldens are ${ageDays} days old (captured ${capturedDate}); `
      + `refresh before the ${failAfterDays}-day hard limit.`,
  )
}

console.log(
  `PASS: ${captureFiles.length} production wire captures match their provenance checksums `
    + `and capture contract ${provenance.contract.sha256}; age ${ageDays} days.`,
)
