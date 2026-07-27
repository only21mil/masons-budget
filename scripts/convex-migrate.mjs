#!/usr/bin/env node

/**
 * dataFiles blobs → real Convex tables.
 *
 * Dry run is the default. `--json` reserves stdout for exactly one versioned
 * evidence document; all operator-facing progress goes to stderr. Child output,
 * deployment identifiers, rows, record ids, and monetary totals are never
 * relayed into either report stream.
 */

// ── Pure helpers (imported by convex/convexMigrateScript.test.ts) ─────────────
// Keep node builtins behind the runner so the edge-runtime test VM can import
// this module without a shim.

export const USAGE = `Usage: node scripts/convex-migrate.mjs [options]

  --apply                write; without it this is a dry run
  --expected-plan-fingerprint <sha256:...>
                         required with --apply; copy from the reviewed dry run
  --prod                 target the production deployment
  --confirm-production   required alongside --apply --prod
  --verify               skip migrating, just re-run the verification proof
  --only <file>          one migratable file (repeatable)
  --batch-size <n>       rows per transaction (default 1000)
  --json                 one versioned JSON evidence document on stdout
  --help
`;

export const DEFAULT_BATCH_SIZE = 1000;
export const REPORT_SCHEMA = "vogel-vault.convex-migration-evidence";
export const REPORT_VERSION = 2;

export function parseArgs(argv) {
  const options = {
    apply: false,
    expectedPlanFingerprint: null,
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
    else if (arg === "--expected-plan-fingerprint") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--expected-plan-fingerprint needs a SHA-256 fingerprint");
      }
      options.expectedPlanFingerprint = value;
      i += 1;
    } else if (arg.startsWith("--expected-plan-fingerprint=")) {
      options.expectedPlanFingerprint = arg.slice(
        "--expected-plan-fingerprint=".length,
      );
    } else if (arg === "--prod" || arg === "--production") options.prod = true;
    else if (arg === "--confirm-production") options.confirmProduction = true;
    else if (arg === "--verify" || arg === "--verify-only") options.verifyOnly = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--only") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--only needs a file name");
      options.only.push(value);
      i += 1;
    } else if (arg.startsWith("--only=")) options.only.push(arg.slice("--only=".length));
    else if (arg === "--batch-size") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--batch-size needs a positive integer");
      }
      options.batchSize = Number(value);
      i += 1;
    } else if (arg.startsWith("--batch-size=")) {
      options.batchSize = Number(arg.slice("--batch-size=".length));
    } else throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
  }

  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
    throw new Error("--batch-size must be a positive integer");
  }
  if (options.only.some((name) => !name)) {
    throw new Error("--only needs a file name");
  }
  if (
    options.expectedPlanFingerprint !== null &&
    !/^sha256:[0-9a-f]{64}$/.test(options.expectedPlanFingerprint)
  ) {
    throw new Error(
      "--expected-plan-fingerprint must be sha256: followed by 64 lowercase hex characters",
    );
  }
  if (options.apply && options.expectedPlanFingerprint === null) {
    throw new Error(
      "Refusing to apply without --expected-plan-fingerprint from the reviewed dry run.",
    );
  }
  if (!options.apply && options.expectedPlanFingerprint !== null) {
    throw new Error("--expected-plan-fingerprint is only valid with --apply");
  }
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
      failures.push(`${result.file}: verification failed`);
      continue;
    }
    if (!verification.exactRoundTrip) {
      failures.push(`${result.file}: did not round-trip exactly`);
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
  const problemCount = Array.isArray(verification.problems) ? verification.problems.length : 0;
  const countOk =
    verification.rowCountMatches ??
    verification.tableRowCount === verification.blobRowCount;
  const sumsOk = verification.moneySumsMatch ?? false;
  const rowsOk =
    verification.roundTripRowsMatch ??
    verification.exactRoundTrip;
  return (
    `    verification: ${verification.ok ? "OK" : "FAILED"}  ` +
    `count ${countOk ? "OK" : "FAILED"} (${verification.tableRowCount}/${verification.blobRowCount})  ` +
    `sums ${sumsOk ? "OK" : "FAILED"}  ` +
    `round-trip rows ${rowsOk ? "OK" : "FAILED"}  ` +
    `exact ${verification.exactRoundTrip ? "YES" : "NO"}` +
    (problemCount > 0 ? `  problems=${problemCount}` : "")
  );
}

class MigrationCliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MigrationCliError";
    this.code = code;
    this.stage = details.stage ?? "migration";
    this.writeOutcomeUnknown = details.writeOutcomeUnknown === true;
  }
}

function controlledError(code, message, details) {
  return new MigrationCliError(code, message, details);
}

function operationMode(options) {
  if (!options) return "skipped";
  if (options.verifyOnly) return "verify";
  return options.apply ? "apply" : "dry-run";
}

function safeVerification(verification) {
  if (!verification || typeof verification !== "object") return null;
  return {
    ok: verification.ok === true,
    rowCountMatches: verification.rowCountMatches === true,
    moneySumsMatch: verification.moneySumsMatch === true,
    roundTripRowsMatch: verification.roundTripRowsMatch === true,
    exactRoundTrip: verification.exactRoundTrip === true,
    blobRowCount: Number.isFinite(verification.blobRowCount) ? verification.blobRowCount : null,
    tableRowCount: Number.isFinite(verification.tableRowCount) ? verification.tableRowCount : null,
    problemCount: Array.isArray(verification.problems) ? verification.problems.length : 0,
  };
}

const PROJECTION_EVIDENCE_SCHEMA = new Map([
  ["ok", "boolean"],
  ["exactroundtrip", "boolean"],
  [
    "rowcounts",
    new Map([
      ["source", "number"],
      ["projected", "number"],
    ]),
  ],
]);

function normalizedKey(key) {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function sanitizeProjectionVerification(value, schema = PROJECTION_EVIDENCE_SCHEMA) {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "[redacted]";

  const clean = {};
  for (const [key, entry] of Object.entries(value)) {
    const rule = schema.get(normalizedKey(key));
    if (rule instanceof Map) {
      clean[key] = sanitizeProjectionVerification(entry, rule);
    } else if (rule === "boolean" && typeof entry === "boolean") {
      clean[key] = entry;
    } else if (rule === "number" && Number.isFinite(entry)) {
      clean[key] = entry;
    } else {
      // Backend evidence is serialized to stdout. New fields stay private
      // until their name, type, and nesting are deliberately reviewed here.
      clean[key] = "[redacted]";
    }
  }
  return clean;
}

/**
 * Preserve backend-owned evidence without guessing its schema. Only fingerprint
 * fields and projectionVerification pass through. Within projectionVerification,
 * only explicitly reviewed structural proof fields pass; every other field is
 * replaced with a redaction marker by default.
 */
export function extractBackendEvidence(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};

  const evidence = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "projectionVerification") {
      evidence[key] = sanitizeProjectionVerification(entry);
      continue;
    }
    if (/fingerprint/i.test(key)) {
      evidence[key] = typeof entry === "string" ? entry : "[redacted]";
      continue;
    }
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const nested = extractBackendEvidence(entry);
      if (Object.keys(nested).length > 0) evidence[key] = nested;
    }
  }
  return evidence;
}

function mergeEvidence(...values) {
  const merged = {};
  for (const value of values) {
    const evidence = extractBackendEvidence(value);
    for (const [key, entry] of Object.entries(evidence)) merged[key] = entry;
  }
  return merged;
}

function findFrozenPlanFingerprint(value) {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findFrozenPlanFingerprint(entry);
      if (found !== null) return found;
    }
    return null;
  }

  for (const key of ["frozenPlanFingerprint", "planFingerprint"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  for (const entry of Object.values(value)) {
    const found = findFrozenPlanFingerprint(entry);
    if (found !== null) return found;
  }
  return null;
}

function emptyFileEvidence(file, mode) {
  return {
    file,
    table: null,
    state: mode,
    batches: [],
    counts: { blobRows: null, inserted: 0, updated: 0, unchanged: 0 },
    verifiedInTransaction: false,
    verification: null,
    backendEvidence: {},
  };
}

function completedBatchEvidence(result, index) {
  return {
    index,
    state: "completed",
    scanned: Number.isFinite(result.scanned) ? result.scanned : null,
    inserted: Number.isFinite(result.inserted) ? result.inserted : 0,
    updated: Number.isFinite(result.updated) ? result.updated : 0,
    unchanged: Number.isFinite(result.unchanged) ? result.unchanged : 0,
    done: result.done === true || result.nextCursor === null,
    backendEvidence: extractBackendEvidence(result),
  };
}

function completedWriteCount(files) {
  let count = 0;
  for (const file of files) {
    for (const batch of file.batches) count += batch.inserted + batch.updated;
  }
  return count;
}

function classifyWriteSafety(options, files, error) {
  if (!options?.apply) {
    return { classification: "none", reason: "the selected mode does not write" };
  }
  const completedWrites = completedWriteCount(files);
  if (error && completedWrites > 0) {
    return {
      classification: "writes-completed-before-failure",
      reason: "one or more completed batches reported committed inserts or updates before failure",
    };
  }
  if (error?.writeOutcomeUnknown === true) {
    return {
      classification: "possible",
      reason: "an apply transaction was attempted but its outcome was not observable",
    };
  }
  if (completedWrites > 0) {
    return {
      classification: "writes-completed",
      reason: "one or more completed batches reported committed inserts or updates",
    };
  }
  return { classification: "none", reason: "no completed batch reported a write" };
}

function reportDocument({ options, outcome, exitCode, files, status, error = null }) {
  const mode = operationMode(options);
  const selectedFiles = options?.only?.length ? [...options.only] : files.map((file) => file.file);
  const frozenPlanFingerprint = findFrozenPlanFingerprint([status, ...files.map((file) => file.backendEvidence)]);
  const successfulCounts = files.reduce(
    (totals, file) => ({
      inserted: totals.inserted + file.counts.inserted,
      updated: totals.updated + file.counts.updated,
      unchanged: totals.unchanged + file.counts.unchanged,
    }),
    { inserted: 0, updated: 0, unchanged: 0 },
  );

  return {
    schema: REPORT_SCHEMA,
    version: REPORT_VERSION,
    outcome,
    exitCode,
    operation: {
      state: mode,
      targetClass: options ? (options.prod ? "production" : "development") : "not-selected",
      selectedFiles,
      batchSize: options?.batchSize ?? null,
      frozenPlan: {
        fingerprint: frozenPlanFingerprint,
        fingerprintState: frozenPlanFingerprint === null ? "not-provided-by-backend" : "provided",
        expectedFingerprintMatched:
          options?.apply === true && frozenPlanFingerprint !== null
            ? options.expectedPlanFingerprint === frozenPlanFingerprint
            : null,
        applyOptions:
          options?.apply === true
            ? {
                state: "apply",
                targetClass: options.prod ? "production" : "development",
                selectedFiles,
                batchSize: options.batchSize,
                productionConfirmed: options.prod && options.confirmProduction,
              }
            : null,
      },
    },
    execution: {
      state: outcome === "success" ? (mode === "skipped" ? "skipped" : "completed") : "failed",
      writeSafety: classifyWriteSafety(options, files, error),
    },
    files,
    summary: {
      fileCount: files.length,
      inserted: successfulCounts.inserted,
      updated: successfulCounts.updated,
      unchanged: successfulCounts.unchanged,
    },
    backendEvidence: extractBackendEvidence(status),
    failure:
      error === null
        ? null
        : {
            code: error.code ?? "MIGRATION_FAILED",
            stage: error.stage ?? "migration",
            message: error.message,
          },
  };
}

async function convexRun(functionName, args, options) {
  const { spawnSync } = await import("node:child_process");
  const commandArgs = ["convex", "run", "--no-push", functionName, JSON.stringify(args)];
  if (options.prod) commandArgs.push("--prod");

  const result = spawnSync("npx", commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw controlledError("CONVEX_COMMAND_UNAVAILABLE", "The Convex command could not be started.", {
      stage: functionName,
      writeOutcomeUnknown: options.apply === true && functionName === "migrate:migrateFile",
    });
  }
  if (result.status !== 0) {
    throw controlledError("CONVEX_COMMAND_FAILED", "The Convex command failed; child output was redacted.", {
      stage: functionName,
      writeOutcomeUnknown: options.apply === true && functionName === "migrate:migrateFile",
    });
  }

  const text = result.stdout.trim();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw controlledError("CONVEX_RESPONSE_INVALID", "The Convex command returned invalid JSON; output was redacted.", {
      stage: functionName,
      writeOutcomeUnknown: options.apply === true && functionName === "migrate:migrateFile",
    });
  }
}

async function migrateOneFile(
  file,
  options,
  execute,
  evidence,
  frozenPlanFingerprint,
) {
  let cursor = 0;
  let last = null;

  for (;;) {
    const result = await execute(
      "migrate:migrateFile",
      {
        file,
        apply: options.apply,
        expectedPlanFingerprint:
          options.apply ? options.expectedPlanFingerprint : undefined,
        cursor,
        batchSize: options.batchSize,
      },
      options,
    );
    if (result === null || typeof result !== "object") {
      throw controlledError("MIGRATION_RESPONSE_INVALID", "A migration batch returned no structured result.", {
        stage: "migrate:migrateFile",
        writeOutcomeUnknown: options.apply,
      });
    }
    if (result.frozenPlanFingerprint !== frozenPlanFingerprint) {
      throw controlledError(
        "PLAN_FINGERPRINT_CHANGED",
        "The backend plan changed during migration; refusing to continue.",
        {
          stage: "plan",
          writeOutcomeUnknown: options.apply,
        },
      );
    }

    const batch = completedBatchEvidence(result, evidence.batches.length + 1);
    evidence.batches.push(batch);
    evidence.table = typeof result.table === "string" ? result.table : evidence.table;
    evidence.counts.blobRows = Number.isFinite(result.blobRowCount) ? result.blobRowCount : null;
    evidence.counts.inserted += batch.inserted;
    evidence.counts.updated += batch.updated;
    evidence.counts.unchanged += batch.unchanged;
    evidence.verifiedInTransaction ||= result.verifiedInTransaction === true;
    evidence.backendEvidence = mergeEvidence(evidence.backendEvidence, result);
    last = result;

    if (result.done === true || result.nextCursor === null) break;
    if (!Number.isInteger(result.nextCursor) || result.nextCursor < 0) {
      throw controlledError("MIGRATION_CURSOR_INVALID", "A migration batch returned an invalid cursor.", {
        stage: "migrate:migrateFile",
        writeOutcomeUnknown: options.apply,
      });
    }
    cursor = result.nextCursor;
    if (evidence.batches.length > 10_000) {
      throw controlledError("MIGRATION_BATCH_LIMIT", "The migration batch loop did not terminate.", {
        stage: "migrate:migrateFile",
        writeOutcomeUnknown: options.apply,
      });
    }
  }

  let verification = last.verification ?? null;
  if (verification === null && options.apply) {
    verification = await execute("migrate:verifyFile", { file }, options);
    evidence.backendEvidence = mergeEvidence(evidence.backendEvidence, verification);
  }

  evidence.verification = safeVerification(verification);
  const skipped = last.blobPresent === false;
  evidence.state = skipped
    ? "skipped"
    : options.apply
      ? verification?.ok === true && verification?.exactRoundTrip === true
        ? "apply"
        : "failed"
      : "dry-run";

  return {
    file,
    table: last.table,
    applied: last.applied,
    blobPresent: last.blobPresent,
    blobRowCount: last.blobRowCount,
    skipped,
    batches: evidence.batches.length,
    inserted: evidence.counts.inserted,
    updated: evidence.counts.updated,
    unchanged: evidence.counts.unchanged,
    verifiedInTransaction: evidence.verifiedInTransaction,
    verification,
  };
}

function emitReport(out, report) {
  out(JSON.stringify(report, null, 2));
}

export async function run(argv, io = {}, dependencies = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  const execute = dependencies.convexRun ?? convexRun;
  const jsonRequested = argv.includes("--json");
  let options = null;
  let status = null;
  const filesEvidence = [];

  try {
    options = parseArgs(argv);
  } catch {
    const failure = controlledError("INVALID_ARGUMENTS", "Arguments were invalid; no migration was attempted.", {
      stage: "arguments",
    });
    err(`${failure.message}\n${USAGE}`);
    if (jsonRequested) {
      emitReport(
        out,
        reportDocument({ options, outcome: "failure", exitCode: 1, files: filesEvidence, status, error: failure }),
      );
    }
    return 1;
  }

  if (options.help) {
    err(USAGE);
    if (options.json) {
      emitReport(
        out,
        reportDocument({ options: null, outcome: "success", exitCode: 0, files: filesEvidence, status }),
      );
    }
    return 0;
  }

  const mode = operationMode(options);
  err(`Target class: ${options.prod ? "production" : "development"}`);
  err(`Mode: ${mode}`);

  try {
    status = await execute("migrate:status", {}, options);
    if (status === null || typeof status !== "object" || !Array.isArray(status.files)) {
      throw controlledError("STATUS_RESPONSE_INVALID", "Migration status returned no structured file list.", {
        stage: "migrate:status",
      });
    }
    if (
      typeof status.frozenPlanFingerprint !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(status.frozenPlanFingerprint)
    ) {
      throw controlledError(
        "PLAN_FINGERPRINT_MISSING",
        "The backend did not return a valid frozen plan fingerprint; refusing to continue.",
        { stage: "plan" },
      );
    }
    err(`Plan fingerprint: ${status.frozenPlanFingerprint}`);
    if (
      options.apply &&
      options.expectedPlanFingerprint !== status.frozenPlanFingerprint
    ) {
      throw controlledError(
        "PLAN_FINGERPRINT_MISMATCH",
        "The current backend plan does not match the reviewed dry-run fingerprint; no write was attempted.",
        { stage: "plan" },
      );
    }

    const files = options.only.length ? options.only : status.files.map((file) => file.file);
    const known = new Set(status.files.map((file) => file.file));
    if (files.some((file) => !known.has(file))) {
      throw controlledError("UNKNOWN_MIGRATION_FILE", "A requested file is not migratable.", {
        stage: "selection",
      });
    }

    const unreadableCount = status.files.filter((file) => file.blobUnreadable).length;
    if (unreadableCount > 0) err(`Warning: ${unreadableCount} migratable blob(s) are not row collections.`);
    if (status.skippedDocumentShapedFiles?.length > 0) {
      err(`${status.skippedDocumentShapedFiles.length} document-shaped blob(s) remain intentionally skipped.`);
    }

    const rawResults = [];
    for (const file of files) {
      const evidence = emptyFileEvidence(file, mode);
      filesEvidence.push(evidence);
      err(`${mode === "verify" ? "Verifying" : "Processing"} ${file}.`);

      if (options.verifyOnly) {
        const info = status.files.find((entry) => entry.file === file);
        const verification = await execute("migrate:verifyFile", { file }, options);
        evidence.table = typeof info?.table === "string" ? info.table : null;
        evidence.counts.blobRows = Number.isFinite(info?.blobRowCount) ? info.blobRowCount : null;
        evidence.counts.unchanged = Number.isFinite(info?.migratedRowCount) ? info.migratedRowCount : 0;
        evidence.verification = safeVerification(verification);
        evidence.backendEvidence = mergeEvidence(info, verification);
        evidence.state =
          info?.blobPresent === false
            ? "skipped"
            : verification?.ok === true && verification?.exactRoundTrip === true
              ? "verify"
              : "failed";
        rawResults.push({
          file,
          table: info?.table,
          applied: false,
          blobPresent: info?.blobPresent,
          blobRowCount: info?.blobRowCount ?? 0,
          skipped: info?.blobPresent === false,
          batches: 0,
          inserted: 0,
          updated: 0,
          unchanged: evidence.counts.unchanged,
          verifiedInTransaction: false,
          verification,
        });
      } else {
        rawResults.push(
          await migrateOneFile(
            file,
            options,
            execute,
            evidence,
            status.frozenPlanFingerprint,
          ),
        );
      }
    }

    for (const result of rawResults) {
      if (result.skipped) {
        err(`${result.file}: skipped because no source blob is present.`);
      } else {
        err(formatPlanLine(result));
        err(formatVerificationLine(result.verification, !options.apply && !options.verifyOnly));
      }
    }

    const summary = summarise(options.apply || options.verifyOnly ? rawResults : []);
    if ((options.apply || options.verifyOnly) && !summary.ok) {
      throw controlledError("VERIFICATION_FAILED", "Migration verification failed; sensitive details were redacted.", {
        stage: "verification",
      });
    }

    if (!options.apply && !options.verifyOnly) {
      err("Dry run complete. Nothing was written.");
    } else {
      err("Migration evidence completed successfully; source blobs were left untouched.");
    }

    if (options.json) {
      emitReport(
        out,
        reportDocument({ options, outcome: "success", exitCode: 0, files: filesEvidence, status }),
      );
    }
    return 0;
  } catch (caught) {
    const failure =
      caught instanceof MigrationCliError
        ? caught
        : controlledError("MIGRATION_FAILED", "Migration failed; sensitive error details were redacted.", {
            stage: "migration",
            writeOutcomeUnknown: options.apply,
          });
    const active = filesEvidence.at(-1);
    if (active && active.state !== "skipped") active.state = "failed";
    err(`${failure.code}: ${failure.message}`);
    if (options.json) {
      emitReport(
        out,
        reportDocument({ options, outcome: "failure", exitCode: 1, files: filesEvidence, status, error: failure }),
      );
    }
    return 1;
  }
}

const entry =
  typeof process !== "undefined" && Array.isArray(process.argv)
    ? String(process.argv[1] ?? "")
    : "";

if (entry.endsWith("/scripts/convex-migrate.mjs") || entry.endsWith("\\scripts\\convex-migrate.mjs")) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
