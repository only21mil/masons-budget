#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

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

process.exit(result.status ?? 1);
