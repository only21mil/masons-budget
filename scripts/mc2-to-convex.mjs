#!/usr/bin/env node

/**
 * MC2 ↔ Convex Sync Script
 *
 * Reads MC2 mission-control JSON files from iCloud Drive (or a local path),
 * reconciles Vogel Vault app-created transactions from Convex back into MC2 via
 * MC2 helper scripts, then pushes changed MC2 files to the Convex backend.
 *
 * Defaults to the same production Convex deployment used by the app:
 *   https://keen-elephant-452.convex.cloud
 *
 * Usage:
 *   node scripts/mc2-to-convex.mjs                         # one-shot sync
 *   node scripts/mc2-to-convex.mjs --dry-run               # read + compare only
 *   node scripts/mc2-to-convex.mjs --watch                 # poll continuously
 *   node scripts/mc2-to-convex.mjs --poll-interval-ms 60000
 *   node scripts/mc2-to-convex.mjs --mc2-path /path/to/mc2
 *   MC2_PATH=/custom/path node scripts/mc2-to-convex.mjs
 *
 * Safety:
 *   - CONVEX_URL must match the app's production deployment unless
 *     --allow-target-mismatch is explicitly passed.
 *   - Adult app transactions are written through MC2's log_transaction.py.
 *   - Mason app transactions are written through MC2's log_mason_transaction.py.
 *   - Convex versions are only bumped for files whose JSON payload changed.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

// ── Configuration ──

const APP_CONVEX_URL = "https://keen-elephant-452.convex.cloud";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MC2_PATH = path.join(
  process.env.HOME,
  "Library/Mobile Documents/com~apple~CloudDocs/MC2/mission-control"
);

function parseArgs(argv) {
  const options = {
    dryRun: process.env.DRY_RUN === "1",
    watch: false,
    allowTargetMismatch: false,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS),
    mc2Path: process.env.MC2_PATH || DEFAULT_MC2_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--watch" || arg === "--poll") options.watch = true;
    else if (arg === "--allow-target-mismatch") options.allowTargetMismatch = true;
    else if (arg === "--poll-interval-ms" || arg === "--interval-ms") {
      options.pollIntervalMs = Number(argv[++i]);
    } else if (arg.startsWith("--poll-interval-ms=")) {
      options.pollIntervalMs = Number(arg.split("=")[1]);
    } else if (arg === "--mc2-path") {
      options.mc2Path = argv[++i];
    } else if (arg.startsWith("--mc2-path=")) {
      options.mc2Path = arg.slice("--mc2-path=".length);
    } else if (!arg.startsWith("--")) {
      options.mc2Path = arg;
    }
  }

  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 5_000) {
    throw new Error("--poll-interval-ms must be a number >= 5000");
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const { dryRun, mc2Path } = options;

// Load .env.local if it exists (don't override explicit env vars)
const envLocalPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  const envContent = fs.readFileSync(envLocalPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(\w+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
    }
  }
}

const convexUrl = process.env.CONVEX_URL || APP_CONVEX_URL;
const expectedConvexUrl = process.env.EXPECTED_CONVEX_URL || APP_CONVEX_URL;
if (convexUrl !== expectedConvexUrl && !options.allowTargetMismatch) {
  console.error(`Error: CONVEX_URL (${convexUrl}) does not match app deployment (${expectedConvexUrl}).`);
  console.error("Refusing to sync to avoid split-brain drift. Pass --allow-target-mismatch only for explicit dev testing.");
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
  { file: "mason-bitcoin-buys.json", name: "mason-bitcoin-buys" },
];

const APP_TRANSACTION_FILES = [
  { name: "transactions", file: "transactions.json", owner: "victor" },
  { name: "mason-transactions", file: "mason-transactions.json", owner: "mason" },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isAppCreatedTransaction(transaction) {
  const id = String(transaction?.id || "");
  return (
    id.startsWith("manual-") ||
    id.startsWith("voice-") ||
    String(transaction?.logged_by || "") === "vogel-vault" ||
    String(transaction?.sync_source || "") === "vogel-vault" ||
    String(transaction?.external_id || "").startsWith("vogel-vault:") ||
    String(transaction?.archimedes_request_id || "").startsWith("vogel-vault:")
  );
}

function normalizeAppTransaction(transaction) {
  const amount = Number(transaction?.amount);
  const id = String(transaction?.id || "");
  const externalId = String(transaction?.external_id || transaction?.archimedes_request_id || `vogel-vault:${id}`);
  return {
    id,
    date: String(transaction?.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    merchant: String(transaction?.merchant || "").trim(),
    amount,
    category: String(transaction?.category || "").trim(),
    card: transaction?.card == null ? "" : String(transaction.card),
    note: transaction?.note == null ? "" : String(transaction.note),
    logged_by: "vogel-vault",
    external_id: externalId,
    sync_source: "vogel-vault",
  };
}

function isValidAppTransaction(transaction) {
  return Boolean(
    transaction.id &&
    transaction.merchant &&
    transaction.category &&
    Number.isFinite(transaction.amount) &&
    transaction.amount > 0
  );
}

function findTransaction(transactions, appTransaction) {
  const externalId = String(appTransaction.external_id || `vogel-vault:${appTransaction.id}`);
  return transactions.find((transaction) =>
    String(transaction?.id || "") === String(appTransaction.id) ||
    String(transaction?.external_id || "") === externalId ||
    String(transaction?.archimedes_request_id || "") === externalId
  );
}

function runHelper(scriptName, transaction, payloadOverrides = {}) {
  const payload = JSON.stringify({
    id: transaction.id,
    date: transaction.date,
    merchant: transaction.merchant,
    amount: transaction.amount,
    category: transaction.category,
    card: transaction.card,
    note: transaction.note,
    external_id: transaction.external_id,
    archimedes_request_id: transaction.external_id,
    ...payloadOverrides,
  });

  if (dryRun) return { ok: true, stdout: "dry-run" };

  const result = spawnSync("python3", [path.join(mc2Path, "scripts", scriptName), payload], {
    cwd: mc2Path,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    throw new Error(`${scriptName} failed for ${transaction.id}: ${result.stderr || result.stdout}`);
  }
  return { ok: true, stdout: result.stdout };
}

function applyAdultTransactionViaHelper(transaction) {
  return runHelper("log_transaction.py", transaction);
}

function applyMasonTransactionViaHelper(transaction) {
  return runHelper("log_mason_transaction.py", transaction);
}

async function pullAppTransactionsFromConvex(client) {
  console.log("Reconciling app-created Convex transactions into MC2...");
  let applied = 0;

  for (const { name, file, owner } of APP_TRANSACTION_FILES) {
    const remote = await client.query(api.dataFiles.get, { name });
    if (!Array.isArray(remote)) continue;

    const localPath = path.join(mc2Path, file);
    const local = readJson(localPath, []);
    if (!Array.isArray(local)) throw new Error(`${file} is not an array`);

    for (const raw of remote) {
      if (!isAppCreatedTransaction(raw)) continue;
      const transaction = normalizeAppTransaction(raw);
      if (!isValidAppTransaction(transaction)) continue;
      if (findTransaction(local, transaction)) continue;

      if (owner === "mason") {
        applyMasonTransactionViaHelper(transaction);
        local.push(transaction);
        applied += 1;
        console.log(`  PULL  ${name}:${transaction.id} → log_mason_transaction.py`);
      } else {
        applyAdultTransactionViaHelper(transaction);
        local.push(transaction);
        applied += 1;
        console.log(`  PULL  ${name}:${transaction.id} → log_transaction.py`);
      }
    }
  }

  if (applied === 0) console.log("  OK    no app-created transactions to pull");
  else console.log(`  OK    pulled ${applied} app-created transaction(s)`);
  return applied;
}

async function collectChangedFiles(client) {
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
      const remote = await client.query(api.dataFiles.get, { name });
      if (canonicalJson(remote) === canonicalJson(data)) {
        console.log(`  SAME  ${file}`);
      } else {
        filesToSync.push({ name, data });
        console.log(`  READ  ${file}`);
      }
    } catch (err) {
      console.error(`  FAIL  ${file}: ${err.message}`);
    }
  }

  return filesToSync;
}

async function runSyncOnce(client) {
  const pulled = await pullAppTransactionsFromConvex(client);
  const filesToSync = await collectChangedFiles(client);

  if (filesToSync.length === 0) {
    console.log("\nNo changed files to sync.");
    return { pulled, pushed: 0 };
  }

  if (dryRun) {
    console.log(`\nDry run complete: would push ${filesToSync.length} changed file(s) to Convex.`);
    return { pulled, pushed: 0 };
  }

  console.log(`\nPushing ${filesToSync.length} changed file(s) to Convex...`);

  const results = await client.mutation(api.dataFiles.syncBatch, {
    files: filesToSync,
  });

  console.log("\nSync complete:");
  for (const { name, version } of results) {
    console.log(`  ✓ ${name} → v${version}`);
  }
  return { pulled, pushed: results.length };
}

// ── Main ──

async function main() {
  console.log(`MC2 ↔ Convex Sync`);
  console.log(`Source: ${mc2Path}`);
  console.log(`Target: ${convexUrl}`);
  if (options.watch) console.log(`Mode: watch/poll every ${options.pollIntervalMs}ms`);
  if (dryRun) console.log("Mode: dry-run");
  console.log();

  if (!fs.existsSync(mc2Path)) {
    console.error(`Error: MC2 folder not found at ${mc2Path}`);
    process.exit(1);
  }

  const client = new ConvexHttpClient(convexUrl);

  if (!options.watch) {
    await runSyncOnce(client);
    return;
  }

  while (true) {
    const startedAt = new Date().toISOString();
    console.log(`\n[${startedAt}] Polling sync bridge...`);
    try {
      await runSyncOnce(client);
    } catch (err) {
      console.error(`\nSync poll failed: ${err.message}`);
    }
    await sleep(options.pollIntervalMs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
