#!/usr/bin/env node
// Mint mobile pairing slots for a Vogel Vault build (SAT-1508).
//
// Creates N one-time pairing slots in Convex (dataFiles:createMobilePairing)
// and writes the matching app pairing URLs to a private file. The URLs embed
// the pair secret; the server stores only sha256(pairId.secret). The app's
// MC2MobileWritebackClient.pairFragment parses `#pair=<pairId>.<secret>` and
// sends (pairId, sha256hex(rawPair)) to claimMobilePairing.
//
// SECURITY (audit 2026-09-02, L-10): each pairing URL is a complete claim
// credential for a 365-day slot. They are therefore minted ON DEMAND, one
// install at a time, and delivered out of band to that install only. This
// script deliberately no longer produces the base64 payload that the build
// pipeline embedded in distributable archives via MC2_BUNDLED_PAIRING_URLS_B64
// — anyone who could extract a distributed binary could claim a slot. A
// redacted manifest (pairIds, no secrets) is written for records and support.
//
// SECURITY: never print the URLs/base64 to stdout in agent sessions — they are
// claim secrets. They are written 0600 to --out.
//
// Usage:
//   node scripts/mint-mobile-pairing-slots.mjs --build 38 [--count 8] [--days 365] \
//     [--out /path/vv-build38-pairing-urls.json]

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConvexUrl = "https://keen-elephant-452.convex.cloud";
const mobileAppCapabilities = ["todos:write", "budget:write"];
const deviceProfiles = ["victor", "rachel", "mason", "maddox"];

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2]
      .replace(/\s+#.*$/, "")
      .replace(/^["']|["']$/g, "")
      .trim();
  }
  return out;
}

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
}

function usage() {
  console.log(`Usage:
  node scripts/mint-mobile-pairing-slots.mjs --build <n> [options]

Options:
  --build <n>   Build number used in pairId naming. Required.
  --count <n>   Number of one-time URLs to mint. Default: 8.
  --days <n>    Expiration window in days. Default: 365.
  --profile <p> Required credential-bound task profile.
  --out <path>  Private output JSON path. Default: ~/.openclaw/private/vogel-vault-pairing/vv-build<n>-pairing-urls.json
  --dry-run     Validate arguments and show destination paths without minting or writing files.

Requires CONVEX_SYNC_TOKEN in .env.local or env.
CONVEX_URL defaults to ${defaultConvexUrl}.
Writes the private pairing URL JSON (0600) and a redacted slot manifest (0600,
pairIds only) — pairing URLs are per-install claim secrets and are NEVER
embedded in distributable archives.
`);
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const build = argValue("--build", null);
if (!build) {
  console.error("ERROR: --build <n> is required (used in pairId naming).");
  process.exit(2);
}
if (!/^\d+$/.test(build)) {
  console.error("ERROR: --build must be a positive integer build number.");
  process.exit(2);
}
const count = Number(argValue("--count", "8"));
const days = Number(argValue("--days", "365"));
const profile = argValue("--profile", null);
const dryRun = args.includes("--dry-run");
if (!Number.isInteger(count) || count < 1 || count > 50) {
  console.error("ERROR: --count must be an integer from 1 to 50.");
  process.exit(2);
}
if (!Number.isFinite(days) || days < 1) {
  console.error("ERROR: --days must be a number >= 1.");
  process.exit(2);
}
if (profile === null || !deviceProfiles.includes(profile)) {
  console.error(`ERROR: --profile must be one of: ${deviceProfiles.join(", ")}.`);
  process.exit(2);
}
const outFile = argValue(
  "--out",
  path.join(
    process.env.HOME || "~",
    ".openclaw",
    "private",
    "vogel-vault-pairing",
    `vv-build${build}-pairing-urls.json`,
  ),
);
// Redacted manifest: identifies the slots for records and support without
// carrying any claim secret. Kept out of any distributable archive by policy.
const manifestFile = outFile.replace(/\.json$/, "-slots.json");

const env = { ...parseEnvFile(path.join(repoRoot, ".env.local")), ...process.env };
const convexUrl = (env.CONVEX_URL || defaultConvexUrl).replace(/\/$/, "");
const syncToken = env.CONVEX_SYNC_TOKEN || "";
if (!dryRun && !syncToken) {
  console.error("ERROR: CONVEX_SYNC_TOKEN required (.env.local or env).");
  process.exit(2);
}

if (dryRun) {
  console.log("DRY RUN: no Convex mutation will be sent and no files will be written.");
  console.log(`convexUrl=${convexUrl}`);
  console.log(`build=${build}`);
  console.log(`count=${count}`);
  console.log(`days=${days}`);
  console.log(`profile=${profile}`);
  console.log(`capabilities=${mobileAppCapabilities.join(",")}`);
  console.log(`out=${outFile}`);
  console.log(`redacted-manifest=${manifestFile}`);
  process.exit(0);
}

function b64url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function convexMutation(fnPath, fnArgs) {
  const resp = await fetch(`${convexUrl}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fnPath, args: fnArgs, format: "json" }),
  });
  const body = await resp.json();
  if (body.status !== "success") {
    throw new Error(`${fnPath} failed: ${body.errorMessage || resp.status}`);
  }
  return body.value;
}

const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
const urls = [];
const redactedSlots = [];

for (let i = 1; i <= count; i++) {
  const pairId = `vv${build}-slot-${i}-${b64url(crypto.randomBytes(6))}`;
  const secret = b64url(crypto.randomBytes(24));
  const rawPair = `${pairId}.${secret}`;
  const proofHash = crypto.createHash("sha256").update(rawPair, "utf8").digest("hex");

  await convexMutation("dataFiles:createMobilePairing", {
    pairId,
    proofHash,
    expiresAt,
    createdBy: `SAT-1508 build${build} slot-${i}`,
    profile,
    capabilities: mobileAppCapabilities,
    token: syncToken,
  });

  urls.push(`${convexUrl}/#pair=${rawPair}`);
  redactedSlots.push({ pairId, expiresAt });
  console.log(`minted ${pairId} (expires ${new Date(expiresAt).toISOString()})`);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
fs.writeFileSync(outFile, JSON.stringify(urls, null, 2) + "\n", { mode: 0o600 });
fs.writeFileSync(
  manifestFile,
  JSON.stringify(
    {
      build,
      profile,
      mintedAt: new Date().toISOString(),
      expiresAt,
      note: "Redacted pairing slot manifest — no claim secrets. Distributable.",
      slots: redactedSlots,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);

console.log(`wrote ${urls.length} pairing URLs -> ${outFile}`);
console.log(`wrote redacted slot manifest -> ${manifestFile}`);
console.log(
  "Deliver each URL to its install out of band (per device). Do NOT embed " +
    "pairing URLs in distributable archives or build payloads.",
);
