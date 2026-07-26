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
 *   - Convex reads are token-gated (SAT-READ-AUTH). Set CONVEX_READ_TOKEN in
 *     the environment (or .env.local, which is gitignored) to the same value
 *     the deployment uses. Never a literal in this file, never logged.
 *   - Adult app transactions are written through MC2's log_transaction.py.
 *   - Mason app transactions are written through MC2's log_mason_transaction.py.
 *   - App todos are reconciled into todos.json by id + updated_at LWW.
 *   - The bridge never full-file pushes todos; Mission Control is the single
 *     todos writer and Convex tombstones are honored on pull.
 *   - Convex versions are only bumped for files whose JSON payload changed.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

// ── Configuration ──

const APP_CONVEX_URL = "https://keen-elephant-452.convex.cloud";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MC2_PATH = path.join(
  process.env.HOME,
  "Library/Mobile Documents/com~apple~CloudDocs/MC2/mission-control",
);

function parseArgs(argv) {
  const options = {
    dryRun: process.env.DRY_RUN === "1",
    watch: false,
    allowTargetMismatch: false,
    pollIntervalMs: Number(
      process.env.POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS,
    ),
    mc2Path: process.env.MC2_PATH || DEFAULT_MC2_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--watch" || arg === "--poll") options.watch = true;
    else if (arg === "--allow-target-mismatch")
      options.allowTargetMismatch = true;
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

  if (
    !Number.isFinite(options.pollIntervalMs) ||
    options.pollIntervalMs < 5_000
  ) {
    throw new Error("--poll-interval-ms must be a number >= 5000");
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const { dryRun, mc2Path } = options;
const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function loadTodoNormalizer() {
  const candidates = [
    path.join(mc2Path, "lib", "todo-normalize.js"),
    path.resolve(scriptDir, "../../mission-control/lib/todo-normalize.js"),
    path.resolve(process.cwd(), "../mission-control/lib/todo-normalize.js"),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const mod = require(candidate);
    if (
      typeof mod.isAppCreatedTodo === "function" &&
      typeof mod.normalizeTodoRecord === "function"
    ) {
      return {
        isAppCreatedTodo: mod.isAppCreatedTodo,
        normalizeTodoRecord: mod.normalizeTodoRecord,
      };
    }
  }

  throw new Error(
    `Canonical todo normalizer not found. Expected one of: ${candidates.join(", ")}`,
  );
}

const { isAppCreatedTodo, normalizeTodoRecord } = loadTodoNormalizer();

// Load .env.local if it exists (don't override explicit env vars)
const envLocalPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  const envContent = fs.readFileSync(envLocalPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(\w+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2]
        .replace(/\s+#.*$/, "")
        .replace(/^["']|["']$/g, "");
    }
  }
}

// SAT-READ-AUTH: every Convex query is token-gated. The token stays optional on
// the wire only while the deployment still runs ALLOW_TOKENLESS_READ=true; the
// moment that hatch is removed a tokenless read is rejected. So send it
// whenever the operator has one, and explain the rejection when we don't.
// Environment only — never a literal, never a default, never logged.
const readToken = process.env.CONVEX_READ_TOKEN || "";

const convexUrl = process.env.CONVEX_URL || APP_CONVEX_URL;
const expectedConvexUrl = process.env.EXPECTED_CONVEX_URL || APP_CONVEX_URL;
if (convexUrl !== expectedConvexUrl && !options.allowTargetMismatch) {
  console.error(
    `Error: CONVEX_URL (${convexUrl}) does not match app deployment (${expectedConvexUrl}).`,
  );
  console.error(
    "Refusing to sync to avoid split-brain drift. Pass --allow-target-mismatch only for explicit dev testing.",
  );
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

const APP_TODO_FILES = [{ name: "todos", file: "todos.json" }];

const APP_TRANSACTION_FILES = [
  { name: "transactions", file: "transactions.json", owner: "victor" },
  {
    name: "mason-transactions",
    file: "mason-transactions.json",
    owner: "mason",
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Convex reads ──

/** Thrown for a read the deployment refused on auth grounds, so main() can
 *  print guidance instead of a stack trace nobody can act on. */
class ConvexReadAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConvexReadAuthError";
  }
}

/** A ConvexError surfaces its payload on `.data`; a plain Error only has a
 *  message. Check both so the classification survives either shape. */
function errorText(err) {
  const data = typeof err?.data === "string" ? err.data : "";
  return `${err?.message ?? ""}\n${data}`;
}

// The second half of the test is what keeps a sync-token failure from being
// mislabelled — and mis-explained — as a read-token problem.
function isReadAuthError(err) {
  const text = errorText(err);
  return (
    /unauthorized/i.test(text) && /read token|CONVEX_READ_TOKEN/i.test(text)
  );
}

function readAuthGuidance(err) {
  if (/not configured/i.test(errorText(err))) {
    return [
      "The deployment has no CONVEX_READ_TOKEN set and ALLOW_TOKENLESS_READ is off,",
      "so it rejects every read regardless of what this script sends.",
      "Fix on the deployment: set CONVEX_READ_TOKEN (Convex dashboard → Settings →",
      "Environment Variables), or restore ALLOW_TOKENLESS_READ=true until the cutover finishes.",
    ].join("\n");
  }
  if (!readToken) {
    return [
      "This environment has no CONVEX_READ_TOKEN and the deployment now enforces one.",
      "Fix: export CONVEX_READ_TOKEN, or add it to .env.local (gitignored), matching",
      "the value set on the deployment, then re-run.",
    ].join("\n");
  }
  return [
    "CONVEX_READ_TOKEN is set here but the deployment rejected it, so the two values differ.",
    "Fix: re-copy the deployment's CONVEX_READ_TOKEN into this environment — never into a",
    "committed file — then re-run.",
  ].join("\n");
}

/** Run a Convex query with the read token attached, converting an auth refusal
 *  into an actionable error. Omits `token` entirely when unset: the arg is
 *  optional, and an explicit empty string would read as a wrong token. */
async function readQuery(client, reference, args, label) {
  try {
    return await client.query(
      reference,
      readToken ? { ...args, token: readToken } : args,
    );
  } catch (err) {
    if (!isReadAuthError(err)) throw err;
    throw new ConvexReadAuthError(
      `Convex refused the read for ${label}.\n${readAuthGuidance(err)}`,
    );
  }
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
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
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
  const externalId = String(
    transaction?.external_id ||
      transaction?.archimedes_request_id ||
      `vogel-vault:${id}`,
  );
  return {
    id,
    date: String(
      transaction?.date || new Date().toISOString().slice(0, 10),
    ).slice(0, 10),
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
    transaction.amount > 0,
  );
}

function findTransaction(transactions, appTransaction) {
  const externalId = String(
    appTransaction.external_id || `vogel-vault:${appTransaction.id}`,
  );
  return transactions.find(
    (transaction) =>
      String(transaction?.id || "") === String(appTransaction.id) ||
      String(transaction?.external_id || "") === externalId ||
      String(transaction?.archimedes_request_id || "") === externalId,
  );
}

function todoListFromData(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray(data.todos))
    return data.todos;
  return [];
}

function withTodoList(originalData, todos) {
  if (
    originalData &&
    typeof originalData === "object" &&
    !Array.isArray(originalData) &&
    Array.isArray(originalData.todos)
  ) {
    return { ...originalData, todos };
  }
  return todos;
}

function normalizeAppTodo(todo) {
  return normalizeTodoRecord(todo, { defaultTimestamps: false });
}

function isValidAppTodo(todo) {
  return Boolean(todo.id && todo.title);
}

function findTodo(todos, appTodo) {
  return todos.find((todo) => String(todo?.id || "") === String(appTodo.id));
}

function todoUpdatedMs(todo) {
  const raw = todo?.updated_at ?? todo?.updatedAt ?? todo?.completedAt ?? null;
  if (raw == null || raw === "") return 0;
  const ms = new Date(String(raw)).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function shouldApplyRemoteTodo(localTodo, remoteTodo) {
  if (!localTodo) return true;
  return todoUpdatedMs(remoteTodo) > todoUpdatedMs(localTodo);
}

function tombstoneDeletedMs(tombstone) {
  const raw = tombstone?.deletedAt ?? tombstone?.deleted_at ?? null;
  if (raw == null || raw === "") return 0;
  if (typeof raw === "number") return raw;
  const ms = new Date(String(raw)).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function isTombstonedNewerThanTodo(tombstone, todo) {
  if (!tombstone) return false;
  return tombstoneDeletedMs(tombstone) > todoUpdatedMs(todo);
}

async function fetchTodoTombstones(client) {
  try {
    const tombstones = await readQuery(
      client,
      api.dataFiles.listTodoTombstones,
      {},
      "todo tombstones",
    );
    return Array.isArray(tombstones) ? tombstones : [];
  } catch (err) {
    // An auth refusal is not a "tombstones unavailable" condition — degrading
    // here would silently skip delete propagation and then fail on the next
    // read anyway, with a worse message.
    if (err instanceof ConvexReadAuthError) throw err;
    console.warn(
      `  WARN  todo tombstones unavailable; continuing without delete pull (${err.message})`,
    );
    return [];
  }
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

  const result = spawnSync(
    "python3",
    [path.join(mc2Path, "scripts", scriptName), payload],
    {
      cwd: mc2Path,
      encoding: "utf-8",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `${scriptName} failed for ${transaction.id}: ${result.stderr || result.stdout}`,
    );
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
    const remote = await readQuery(client, api.dataFiles.get, { name }, name);
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
        console.log(
          `  PULL  ${name}:${transaction.id} → log_mason_transaction.py`,
        );
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

async function pullAppTodosFromConvex(client) {
  console.log("Reconciling Convex todos into MC2 by id + updated_at LWW...");
  let applied = 0;
  let removed = 0;
  const tombstones = await fetchTodoTombstones(client);
  const tombstoneById = new Map(
    tombstones.map((tombstone) => [String(tombstone?.id || ""), tombstone]),
  );

  for (const { name, file } of APP_TODO_FILES) {
    const remote = await readQuery(client, api.dataFiles.get, { name }, name);
    const remoteTodos = todoListFromData(remote);
    if (remoteTodos.length === 0) continue;

    const localPath = path.join(mc2Path, file);
    const localData = readJson(localPath, []);
    const localTodos = todoListFromData(localData);
    let changed = false;

    for (let idx = localTodos.length - 1; idx >= 0; idx -= 1) {
      const localTodo = localTodos[idx];
      const tombstone = tombstoneById.get(String(localTodo?.id || ""));
      if (!isTombstonedNewerThanTodo(tombstone, localTodo)) continue;

      localTodos.splice(idx, 1);
      removed += 1;
      changed = true;
      console.log(`  DROP  ${name}:${localTodo.id} ← tombstone`);
    }

    for (const raw of remoteTodos) {
      const todo = normalizeAppTodo(raw);
      if (!isValidAppTodo(todo)) continue;
      const tombstone = tombstoneById.get(String(todo.id));
      if (isTombstonedNewerThanTodo(tombstone, todo)) continue;

      const existing = findTodo(localTodos, todo);
      if (!shouldApplyRemoteTodo(existing, todo)) continue;

      if (existing) {
        const idx = localTodos.indexOf(existing);
        localTodos[idx] = { ...existing, ...todo };
      } else {
        localTodos.push(todo);
      }
      applied += 1;
      changed = true;
      console.log(`  PULL  ${name}:${todo.id} → ${file}`);
    }

    if (changed && !dryRun) {
      fs.writeFileSync(
        localPath,
        `${JSON.stringify(withTodoList(localData, localTodos), null, 2)}\n`,
      );
    }
  }

  if (applied === 0 && removed === 0)
    console.log("  OK    no newer remote todos or tombstones to pull");
  else
    console.log(
      `  OK    pulled ${applied} newer remote todo(s), removed ${removed} tombstoned todo(s)`,
    );
  return applied + removed;
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
      const remote = await readQuery(client, api.dataFiles.get, { name }, name);
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
  const pulledTodos = await pullAppTodosFromConvex(client);
  const filesToSync = await collectChangedFiles(client);

  if (filesToSync.length === 0) {
    console.log("\nNo changed files to sync.");
    return { pulled, pulledTodos, pushed: 0 };
  }

  if (dryRun) {
    console.log(
      `\nDry run complete: would push ${filesToSync.length} changed file(s) to Convex.`,
    );
    return { pulled, pulledTodos, pushed: 0 };
  }

  console.log(`\nPushing ${filesToSync.length} changed file(s) to Convex...`);

  const token = process.env.CONVEX_SYNC_TOKEN || "";
  if (!token) {
    throw new Error(
      "CONVEX_SYNC_TOKEN is required for Convex syncBatch writes (fail-closed).",
    );
  }

  const results = await client.mutation(api.dataFiles.syncBatch, {
    files: filesToSync,
    token,
  });

  console.log("\nSync complete:");
  for (const { name, version } of results) {
    console.log(`  ✓ ${name} → v${version}`);
  }
  return { pulled, pulledTodos, pushed: results.length };
}

// ── Main ──

async function main() {
  console.log(`MC2 ↔ Convex Sync`);
  console.log(`Source: ${mc2Path}`);
  console.log(`Target: ${convexUrl}`);
  // Presence only. The value never reaches a log, a file or an argv.
  console.log(`Read token: ${readToken ? "present" : "absent"}`);
  if (options.watch)
    console.log(`Mode: watch/poll every ${options.pollIntervalMs}ms`);
  if (dryRun) console.log("Mode: dry-run");
  if (!readToken) {
    console.warn(
      "  WARN  CONVEX_READ_TOKEN is not set. Reads succeed only while the deployment\n" +
        "        still allows tokenless reads (ALLOW_TOKENLESS_READ=true) and will fail\n" +
        "        the moment that cutover hatch is removed.",
    );
  }
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
      // A read-auth refusal cannot resolve itself: the token is read once at
      // startup, so every subsequent poll would fail identically. Stop instead
      // of burying the fix instructions under a repeating error every 30s.
      if (err instanceof ConvexReadAuthError) throw err;
      console.error(`\nSync poll failed: ${err.message}`);
    }
    await sleep(options.pollIntervalMs);
  }
}

main().catch((err) => {
  if (err instanceof ConvexReadAuthError) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
