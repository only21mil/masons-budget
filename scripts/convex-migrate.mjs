#!/usr/bin/env node

/**
 * dataFiles blobs → real Convex tables.
 *
 * Drives convex/migrate.ts. Dry run by default: it prints exactly what a write
 * would do and exits without writing. Writing needs --apply, and writing to
 * production needs --apply --prod --confirm-production, spelled out in full.
 *
 *   node scripts/convex-migrate.mjs                      # dry run, dev
 *   node scripts/convex-migrate.mjs --prod               # dry run, production
 *   node scripts/convex-migrate.mjs --apply              # write, dev
 *   node scripts/convex-migrate.mjs --apply --prod --confirm-production
 *   node scripts/convex-migrate.mjs --verify --prod      # re-run the proof only
 *   node scripts/convex-migrate.mjs --only transactions --json
 *
 * WHY `npx convex run` AND NOT ConvexHttpClient: the migration functions are
 * internal, so they are unreachable with CONVEX_SYNC_TOKEN — the token the
 * clients hold. Reaching them takes deploy-key auth, which is what the CLI
 * carries. A backfill that rewrites the household ledger should need the
 * strongest credential in the building, not the one in a phone.
 *
 * `--no-push` is passed on every invocation. This script runs functions; it
 * never deploys them. Deploying is a separate, deliberate act.
 *
 * NOTHING HERE PRINTS A TOKEN. The CLI reads its own credentials from the
 * environment and this script neither reads nor forwards them.
 */

// ── Pure helpers (imported by convex/migrate.test.ts) ────────────────────────
// Kept free of node builtins on purpose so the test suite, which runs in an
// edge-runtime VM, can import this module without a shim. Everything that
// needs `node:child_process` is loaded lazily inside run().

export const USAGE = `Usage: node scripts/convex-migrate.mjs [options]

  --apply                write; without it this is a dry run
  --prod                 target the production deployment
  --confirm-production   required alongside --apply --prod
  --verify               skip migrating, just re-run the verification proof
  --only <file>          one MC2 file (repeatable)
  --batch-size <n>       rows per transaction (default 1000)
  --json                 machine-readable report on stdout
  --help
`;

export const DEFAULT_BATCH_SIZE = 1000;

export function parseArgs(argv) {
  const options = {
    apply: false,
    prod: false,
    confirmProduction: false,
    verifyOnly: false,
    only: [],
    batchSize: DEFAULT_BATCH_SIZE,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--prod" || arg === "--production") options.prod = true;
    else if (arg === "--confirm-production") options.confirmProduction = true;
    else if (arg === "--verify" || arg === "--verify-only") options.verifyOnly = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--only") options.only.push(argv[++i]);
    else if (arg.startsWith("--only=")) options.only.push(arg.slice("--only=".length));
    else if (arg === "--batch-size") options.batchSize = Number(argv[++i]);
    else if (arg.startsWith("--batch-size=")) {
      options.batchSize = Number(arg.slice("--batch-size=".length));
    } else throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
  }

  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
    throw new Error("--batch-size must be a positive integer");
  }
  if (options.only.some((name) => !name)) {
    throw new Error("--only needs a file name");
  }

  // The whole point of the flag is that nobody rewrites the family's ledger by
  // hitting up-arrow on a dry run. Two extra words is the price.
  if (options.apply && options.prod && !options.confirmProduction) {
    throw new Error(
      "Refusing to write to production without --confirm-production.\n" +
        "This rewrites the only copy of the family's financial record.\n" +
        "Run the dry run first, read the plan, then add --confirm-production.",
    );
  }
  if (options.confirmProduction && !options.prod) {
    throw new Error("--confirm-production only means something with --prod");
  }
  if (options.verifyOnly && options.apply) {
    throw new Error("--verify does not write; drop --apply");
  }

  return options;
}

/**
 * Decide whether a completed run is trustworthy.
 *
 * Pure so it can be tested without a deployment, and shared by both the applied
 * and the verify-only paths. A file is only OK if the verification actually ran
 * and passed — "we never checked" is a failure here, not a pass.
 */
export function summarise(results) {
  const failures = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const result of results) {
    inserted += result.inserted ?? 0;
    updated += result.updated ?? 0;
    unchanged += result.unchanged ?? 0;

    if (result.skipped) continue;
    const verification = result.verification;
    if (!verification) {
      failures.push(`${result.file}: never verified`);
      continue;
    }
    if (!verification.ok) {
      failures.push(`${result.file}: ${verification.problems.join("; ")}`);
      continue;
    }
    if (!verification.exactRoundTrip) {
      failures.push(`${result.file}: verified counts and sums but did not round-trip exactly`);
    }
  }

  return { ok: failures.length === 0, failures, inserted, updated, unchanged };
}

export function formatPlanLine(result) {
  const verb = result.applied ? "wrote" : "would write";
  return (
    `${result.file.padEnd(20)} → ${String(result.table).padEnd(12)} ` +
    `${String(result.blobRowCount).padStart(5)} rows  ` +
    `${verb} ${result.inserted} new, ${result.updated} changed, ` +
    `${result.unchanged} already current`
  );
}

export function formatVerificationLine(verification, dryRun = false) {
  if (!verification) {
    return dryRun
      ? "    verification: deferred — a dry run writes nothing to verify"
      : "    verification: NOT RUN";
  }
  const sums = Object.entries(verification.tableSums)
    .map(([column, total]) => `${column}=${total}`)
    .join("  ");
  return (
    `    verification: ${verification.ok ? "OK" : "FAILED"}  ` +
    `${verification.tableRowCount}/${verification.blobRowCount} rows  ` +
    `round-trip ${verification.exactRoundTrip ? "exact" : "BROKEN"}` +
    (sums ? `\n    sums: ${sums}` : "") +
    (verification.problems.length ? `\n    ${verification.problems.join("\n    ")}` : "")
  );
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function convexRun(functionName, args, options) {
  const { spawnSync } = await import("node:child_process");

  const argv = ["convex", "run", "--no-push", functionName, JSON.stringify(args)];
  if (options.prod) argv.push("--prod");

  const result = spawnSync("npx", argv, {
    encoding: "utf8",
    // stderr is inherited so CLI auth prompts and errors reach the operator
    // verbatim; only stdout is captured, and only the function's JSON is on it.
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npx convex run ${functionName} exited ${result.status}`);
  }

  const text = result.stdout.trim();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${functionName} did not return JSON:\n${text}`);
  }
}

/**
 * Migrate one file, batch by batch.
 *
 * The cursor loop exists for files too large for one transaction. Prefer a
 * batch size that swallows the file whole: convex/migrate.ts verifies inside
 * the transaction in that case, so a mismatch rolls the file back instead of
 * leaving it half-written.
 */
async function migrateOneFile(file, options) {
  let cursor = 0;
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let last = null;
  let batches = 0;

  for (;;) {
    const result = await convexRun(
      "migrate:migrateFile",
      { file, apply: options.apply, cursor, batchSize: options.batchSize },
      options,
    );
    batches += 1;
    inserted += result.inserted;
    updated += result.updated;
    unchanged += result.unchanged;
    last = result;

    if (result.done || result.nextCursor === null) break;
    cursor = result.nextCursor;

    if (batches > 10_000) throw new Error(`${file}: batch loop did not terminate`);
  }

  // A single-batch applied run already verified inside its own transaction. A
  // batched run could not, so it gets the standalone proof.
  //
  // A dry run gets neither, deliberately: nothing was written, so verifying
  // would describe the tables as they already are. Printing that next to a plan
  // would read as "the plan failed" when the only true statement is "there is
  // nothing yet to check".
  let verification = last.verification ?? null;
  if (verification === null && options.apply) {
    verification = await convexRun("migrate:verifyFile", { file }, options);
  }

  return {
    file,
    table: last.table,
    applied: last.applied,
    blobPresent: last.blobPresent,
    blobRowCount: last.blobRowCount,
    skipped: !last.blobPresent,
    batches,
    inserted,
    updated,
    unchanged,
    verifiedInTransaction: last.verifiedInTransaction === true,
    verification,
  };
}

export async function run(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const options = parseArgs(argv);

  if (options.help) {
    out(USAGE);
    return 0;
  }

  const target = options.prod ? "PRODUCTION" : "the configured dev deployment";
  out(`Target: ${target}`);
  out(options.apply ? "Mode:   APPLY (writing)" : "Mode:   DRY RUN (no writes)");
  out("");

  const status = await convexRun("migrate:status", {}, options);
  const files = (options.only.length ? options.only : status.files.map((f) => f.file));

  const known = new Set(status.files.map((f) => f.file));
  for (const file of files) {
    if (!known.has(file)) {
      throw new Error(`${file} is not a migratable file. Known: ${[...known].join(", ")}`);
    }
  }

  const unreadable = status.files.filter((f) => f.blobUnreadable);
  for (const file of unreadable) {
    out(`WARNING: ${file.file} is present but is not a row collection; it will fail if migrated.`);
  }
  if (status.skippedDocumentShapedFiles.length) {
    out(
      `Left in dataFiles on purpose (document-shaped, not row collections): ` +
        status.skippedDocumentShapedFiles.join(", "),
    );
    out("");
  }

  const results = [];
  for (const file of files) {
    if (options.verifyOnly) {
      const info = status.files.find((f) => f.file === file);
      const verification = await convexRun("migrate:verifyFile", { file }, options);
      results.push({
        file,
        table: info.table,
        applied: false,
        blobPresent: info.blobPresent,
        blobRowCount: info.blobRowCount ?? 0,
        skipped: !info.blobPresent,
        batches: 0,
        inserted: 0,
        updated: 0,
        unchanged: info.migratedRowCount,
        verifiedInTransaction: false,
        verification,
      });
    } else {
      results.push(await migrateOneFile(file, options, out));
    }
  }

  for (const result of results) {
    if (result.skipped) {
      out(`${result.file.padEnd(20)} → no blob in dataFiles; nothing to migrate`);
      continue;
    }
    out(formatPlanLine(result));
    out(formatVerificationLine(result.verification, !options.apply && !options.verifyOnly));
  }
  out("");

  const summary = summarise(options.apply || options.verifyOnly ? results : []);

  if (options.json) out(JSON.stringify({ options, results, summary }, null, 2));

  if (!options.apply && !options.verifyOnly) {
    out("Dry run complete. Nothing was written. Add --apply to write.");
    return 0;
  }

  if (!summary.ok) {
    out("MIGRATION DID NOT VERIFY:");
    for (const failure of summary.failures) out(`  - ${failure}`);
    out("");
    out(
      "The dataFiles blobs were not touched and remain the source of truth. " +
        "Fix the cause and re-run — the migration is idempotent, so a re-run " +
        "repairs a partial write rather than duplicating it.",
    );
    return 1;
  }

  out(
    `Verified. ${summary.inserted} inserted, ${summary.updated} updated, ` +
      `${summary.unchanged} already current. dataFiles left untouched.`,
  );
  return 0;
}

// Entry guard without node builtins: under vitest argv[1] is the test runner,
// so importing this module for its pure helpers never starts a migration.
const entry =
  typeof process !== "undefined" && Array.isArray(process.argv)
    ? String(process.argv[1] ?? "")
    : "";

if (entry.endsWith("/scripts/convex-migrate.mjs") || entry.endsWith("\\scripts\\convex-migrate.mjs")) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
