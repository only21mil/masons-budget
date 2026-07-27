#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";

// SAT-READ-AUTH: no CONVEX_READ_TOKEN is threaded here on purpose. `convex
// codegen` generates types from the local convex/ sources and never calls a
// data query, so read auth does not apply to it. Checked when the read gate
// landed, so the next person tightening the gate does not re-derive it.
const APP_CONVEX_URL = "https://keen-elephant-452.convex.cloud";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;

    process.env[match[1]] = match[2]
      .replace(/\s+#.*$/, "")
      .replace(/^["']|["']$/g, "")
      .trim();
  }
}

function deploymentFromUrl(rawUrl) {
  const host = new URL(rawUrl).host;
  const deployment = host.replace(/\.convex\.cloud$/, "");
  if (!deployment || deployment === host) {
    throw new Error(`Cannot derive Convex deployment from ${host}`);
  }
  return `prod:${deployment}`;
}

loadEnvFile(path.join(process.cwd(), ".env.local"));
loadEnvFile(path.join(process.cwd(), ".env"));

const convexUrl = process.env.CONVEX_URL || APP_CONVEX_URL;
const expectedConvexUrl = process.env.EXPECTED_CONVEX_URL || APP_CONVEX_URL;
if (convexUrl !== expectedConvexUrl && process.env.ALLOW_CONVEX_TARGET_MISMATCH !== "1") {
  console.error(
    "Refusing to run Convex codegen because CONVEX_URL does not match the app deployment.",
  );
  console.error("Set ALLOW_CONVEX_TARGET_MISMATCH=1 only for explicit dev testing.");
  process.exit(1);
}

const deployment = process.env.CONVEX_DEPLOYMENT || deploymentFromUrl(convexUrl);
const result = spawnSync(
  "npx",
  ["convex", "codegen", ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    env: { ...process.env, CONVEX_DEPLOYMENT: deployment },
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// Convex's declarations can stay byte-identical across schema changes because
// dataModel.d.ts imports schema.ts by type. Record the exact schema content only
// after authenticated codegen succeeds so CI has a credential-free attestation
// to validate. This is still convention, not cryptographic proof of who ran it.
const schemaPath = path.join(process.cwd(), "convex", "schema.ts");
const attestationPath = path.join(
  process.cwd(),
  "convex",
  "_generated",
  "schema.sha256",
);
const schemaDigest = createHash("sha256")
  .update(fs.readFileSync(schemaPath))
  .digest("hex");
fs.writeFileSync(attestationPath, `${schemaDigest}  convex/schema.ts\n`);
