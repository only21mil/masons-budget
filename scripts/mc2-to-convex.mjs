#!/usr/bin/env node

/**
 * MC2 → Convex Sync Script
 *
 * Reads MC2 mission-control JSON files from iCloud Drive (or a local path)
 * and pushes them to the Convex backend. Run this whenever MC2 data changes.
 *
 * Usage:
 *   node scripts/mc2-to-convex.mjs                    # Uses default iCloud path
 *   node scripts/mc2-to-convex.mjs /path/to/mc2       # Custom path
 *   MC2_PATH=/custom/path node scripts/mc2-to-convex.mjs
 *
 * Requires:
 *   - CONVEX_URL env var (or .env.local with CONVEX_URL)
 *   - MC2 JSON files in the source directory
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import fs from "fs";
import path from "path";

// ── Configuration ──

const DEFAULT_MC2_PATH = path.join(
  process.env.HOME,
  "Library/Mobile Documents/com~apple~CloudDocs/MC2/mission-control"
);

const mc2Path = process.argv[2] || process.env.MC2_PATH || DEFAULT_MC2_PATH;

// Load .env.local if it exists (don't override explicit env vars)
const envLocalPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  const envContent = fs.readFileSync(envLocalPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

const convexUrl = process.env.CONVEX_URL;
if (!convexUrl) {
  console.error("Error: CONVEX_URL not set. Run 'npx convex dev' first to get your deployment URL.");
  console.error("Set it in .env.local or as an environment variable.");
  process.exit(1);
}

// ── MC2 file mapping ──
// Maps MC2 filenames to Convex data file names

const MC2_FILES = [
  { file: "transactions.json", name: "transactions" },
  { file: "budget.json", name: "budget" },
  { file: "btc-balance-snapshot.json", name: "btc-balance-snapshot" },
  { file: "bitcoin-buys.json", name: "bitcoin-buys" },
  { file: "bitcoin-bill-pays.json", name: "bitcoin-bill-pays" },
  { file: "finances.json", name: "finances" },
  { file: "son-balances.json", name: "son-balances" },
  { file: "mason-budget.json", name: "mason-budget" },
  { file: "mason-transactions.json", name: "mason-transactions" },
];

// ── Main ──

async function main() {
  console.log(`MC2 → Convex Sync`);
  console.log(`Source: ${mc2Path}`);
  console.log(`Target: ${convexUrl}`);
  console.log();

  if (!fs.existsSync(mc2Path)) {
    console.error(`Error: MC2 folder not found at ${mc2Path}`);
    process.exit(1);
  }

  const client = new ConvexHttpClient(convexUrl);
  const filesToSync = [];

  for (const { file, name } of MC2_FILES) {
    const filePath = path.join(mc2Path, file);

    if (!fs.existsSync(filePath)) {
      console.log(`  SKIP  ${file} (not found)`);
      continue;
    }

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      filesToSync.push({ name, data });
      console.log(`  READ  ${file}`);
    } catch (err) {
      console.error(`  FAIL  ${file}: ${err.message}`);
    }
  }

  if (filesToSync.length === 0) {
    console.log("\nNo files to sync.");
    return;
  }

  console.log(`\nPushing ${filesToSync.length} files to Convex...`);

  try {
    const results = await client.mutation(api.dataFiles.syncBatch, {
      files: filesToSync,
    });

    console.log("\nSync complete:");
    for (const { name, version } of results) {
      console.log(`  ✓ ${name} → v${version}`);
    }
  } catch (err) {
    console.error(`\nSync failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
