#!/usr/bin/env node

/**
 * FD-only private operator for reviewed Vogel Vault ledger batches.
 *
 * The argv surface is deliberately limited to a command and numeric file
 * descriptors. Private rows, credentials, deployment URLs, function names,
 * reviewed fingerprints, and approval material never enter argv or output.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";

export const MAX_PRIVATE_BYTES = 256 * 1024;
export const MAX_RECORDS = 100;
export const CONTRACT_VERSION = 1;
export const MANIFEST_SCHEMA = "vogel-vault.ledger-batch/v1";
export const PLAN_SCHEMA = "vogel-vault.ledger-batch-plan/v1";
export const CAPABILITY_SCHEMA = "vogel-vault.ledger-batch-capability/v1";
export const EVIDENCE_SCHEMA = "vogel-vault.ledger-batch-evidence";
export const PRODUCTION_DEPLOYMENT = "keen-elephant-452";

const FUNCTION_REFS = Object.freeze({
  preflight: "operatorImport:preflightBatch",
  apply: "operatorImport:applyBatch",
  readback: "operatorImport:readbackBatch",
});

const COUNT_KEYS = Object.freeze([
  "transactions",
  "income",
  "btc_buys",
  "btc_bill_pays",
]);
const TYPE_TO_COUNT = Object.freeze({
  transaction: "transactions",
  income: "income",
  btc_buy: "btc_buys",
  btc_bill_pay: "btc_bill_pays",
});
const CHECK_KEYS = new Set([
  "privateFd",
  "canonicalManifest",
  "schemaValid",
  "authEnforced",
  "targetMatched",
  "contractMatched",
  "categoriesValid",
  "unitsValid",
  "datesValid",
  "idsValid",
  "duplicatesClear",
  "stateMatched",
  "planMatched",
  "receiptRecorded",
  "rowsMatched",
  "aggregatesMatched",
  "untouchedMatched",
  "completed",
]);

const ROOT_KEYS = new Set([
  "schema",
  "batch_id",
  "ops",
  "duplicate_attestations",
  "budget_advance",
]);

export class OperatorFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "OperatorFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new OperatorFailure(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("NON_CANONICAL_NUMBER");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (!isPlainObject(value)) fail("NON_CANONICAL_VALUE");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
    .join(",")}}`;
}

export function canonicalJson(value) {
  return `${canonicalValue(value)}\n`;
}

function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * An already-open fd is the capability. fstat validates the resolved object,
 * eliminating pathname TOCTOU. A maintained pathname opener must use the
 * exported O_NOFOLLOW helper; an fd receiver cannot reconstruct path history.
 */
export function assertPrivateStat(stat, { output = false } = {}) {
  if (!stat.isFile()) fail("FD_NOT_REGULAR");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail("FD_WRONG_OWNER");
  }
  if ((stat.mode & 0o077) !== 0) fail("FD_MODE_TOO_OPEN");
  if (stat.size > MAX_PRIVATE_BYTES) fail("FD_TOO_LARGE");
  if (output && stat.size !== 0) fail("OUTPUT_FD_NOT_EMPTY");
}

export function openPrivateNoFollow(path, flags = constants.O_RDONLY) {
  if (typeof constants.O_NOFOLLOW !== "number") fail("O_NOFOLLOW_UNAVAILABLE");
  let fd;
  try {
    fd = openSync(path, flags | constants.O_NOFOLLOW);
    assertPrivateStat(fstatSync(fd));
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof OperatorFailure) throw error;
    fail("PRIVATE_OPEN_REJECTED");
  }
}

function assertDataFd(fd) {
  if (!Number.isSafeInteger(fd) || fd <= 2) fail("FD_MUST_BE_NON_STDIO");
}

export function readPrivateFd(fd) {
  assertDataFd(fd);
  const before = fstatSync(fd);
  assertPrivateStat(before);
  const chunks = [];
  let total = 0;
  while (true) {
    const available = MAX_PRIVATE_BYTES + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, available));
    const count = readSync(fd, chunk, 0, chunk.length, total);
    if (count === 0) break;
    total += count;
    if (total > MAX_PRIVATE_BYTES) fail("FD_TOO_LARGE");
    chunks.push(chunk.subarray(0, count));
  }
  const after = fstatSync(fd);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    fail("FD_CHANGED_DURING_READ");
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function writePrivateFd(fd, text) {
  assertDataFd(fd);
  assertPrivateStat(fstatSync(fd), { output: true });
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_PRIVATE_BYTES) fail("OUTPUT_TOO_LARGE");
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
  }
  fsyncSync(fd);
}

export function parseCanonicalPrivate(text, expectedSchema) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("INVALID_JSON");
  }
  // Re-serialization rejects whitespace variants and duplicate JSON keys.
  if (canonicalJson(value) !== text) fail("NON_CANONICAL_JSON");
  if (!isPlainObject(value) || value.schema !== expectedSchema) {
    fail("WRONG_PRIVATE_SCHEMA");
  }
  return value;
}

function assertOnlyKeys(value, allowed, code) {
  if (!isPlainObject(value)) fail("INVALID_OBJECT");
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(code);
}

function requireText(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("INVALID_TEXT");
  }
}

function validateOp(op, seenOps, seenNaturalKeys, counts) {
  if (!isPlainObject(op) || !(op.kind in TYPE_TO_COUNT)) {
    fail("INVALID_RECORD_TYPE");
  }
  // The backend owns the closed discriminated-union validator. Keeping a
  // second field-by-field copy here caused contract drift; this boundary checks
  // only the stable envelope needed for counts, bindings, and natural keys.
  for (const field of [
    "op_id",
    "record_id",
    "source_locator",
    "owner",
    "source_file",
    "date",
  ]) {
    requireText(op[field]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(op.date)) fail("INVALID_DATE_SHAPE");
  if (seenOps.has(op.op_id)) fail("DUPLICATE_OP_ID");
  seenOps.add(op.op_id);
  const naturalKey = `${op.kind}\u0000${op.source_file}\u0000${op.record_id}`;
  if (seenNaturalKeys.has(naturalKey)) fail("DUPLICATE_NATURAL_KEY");
  seenNaturalKeys.add(naturalKey);
  counts[TYPE_TO_COUNT[op.kind]] += 1;
}

export function validateManifest(manifest) {
  assertOnlyKeys(manifest, ROOT_KEYS, "UNKNOWN_MANIFEST_FIELD");
  requireText(manifest.batch_id);
  if (!Array.isArray(manifest.ops) || manifest.ops.length === 0) {
    fail("EMPTY_MANIFEST");
  }
  if (manifest.ops.length > MAX_RECORDS) fail("TOO_MANY_RECORDS");
  if (
    manifest.duplicate_attestations !== undefined &&
    !Array.isArray(manifest.duplicate_attestations)
  ) {
    fail("INVALID_DUPLICATE_ATTESTATIONS");
  }
  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
  const seenOps = new Set();
  const seenNaturalKeys = new Set();
  for (const op of manifest.ops) {
    validateOp(op, seenOps, seenNaturalKeys, counts);
  }
  return counts;
}

function normalizedCounts(value) {
  if (!isPlainObject(value)) fail("INVALID_RECEIPT_COUNTS");
  if (Object.keys(value).some((key) => !COUNT_KEYS.includes(key))) {
    fail("INVALID_RECEIPT_COUNTS");
  }
  const counts = {};
  for (const key of COUNT_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      fail("INVALID_RECEIPT_COUNTS");
    }
    counts[key] = value[key];
  }
  return counts;
}

function sameCounts(left, right) {
  return COUNT_KEYS.every((key) => left[key] === right[key]);
}

function normalizedChecks(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    fail("INVALID_RECEIPT_CHECKS");
  }
  const checks = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!CHECK_KEYS.has(key) || typeof entry !== "boolean") {
      fail("INVALID_RECEIPT_CHECKS");
    }
    checks[key] = entry;
  }
  return checks;
}

function requireFingerprint(value) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail("INVALID_FINGERPRINT");
  }
  return value;
}

function validatePreflightReceipt(receipt, counts) {
  if (!isPlainObject(receipt) || receipt.contract_version !== CONTRACT_VERSION) {
    fail("BACKEND_CONTRACT_MISMATCH");
  }
  if (receipt.outcome !== "ready") fail("PREFLIGHT_NOT_READY");
  const receiptCounts = normalizedCounts(receipt.counts);
  if (!sameCounts(receiptCounts, counts)) fail("RECEIPT_COUNT_MISMATCH");
  const checks = normalizedChecks(receipt.checks);
  if (Object.values(checks).some((value) => !value)) fail("PREFLIGHT_CHECK_FAILED");
  return {
    counts: receiptCounts,
    checks,
    planFingerprint: requireFingerprint(receipt.plan_fingerprint),
    stateFingerprint: requireFingerprint(receipt.state_fingerprint),
  };
}

function validatePlan(plan, manifestDigest = null, expectedCounts = null) {
  const allowed = new Set([
    "schema",
    "version",
    "manifest_sha256",
    "plan_fingerprint",
    "state_fingerprint",
    "counts",
    "checks",
  ]);
  assertOnlyKeys(plan, allowed, "UNKNOWN_PLAN_FIELD");
  if (plan.version !== CONTRACT_VERSION) fail("PLAN_VERSION_MISMATCH");
  requireFingerprint(plan.manifest_sha256);
  requireFingerprint(plan.plan_fingerprint);
  requireFingerprint(plan.state_fingerprint);
  if (manifestDigest !== null && plan.manifest_sha256 !== manifestDigest) {
    fail("PLAN_MANIFEST_MISMATCH");
  }
  const counts = normalizedCounts(plan.counts);
  if (expectedCounts !== null && !sameCounts(counts, expectedCounts)) {
    fail("PLAN_COUNT_MISMATCH");
  }
  const checks = normalizedChecks(plan.checks);
  if (Object.values(checks).some((value) => !value)) fail("PLAN_CHECK_FAILED");
  return { ...plan, counts, checks };
}

function validateCapability(capability, plan, nowMs) {
  const allowed = new Set([
    "schema",
    "version",
    "manifest_sha256",
    "plan_fingerprint",
    "state_fingerprint",
    "approved",
    "expires_at",
  ]);
  assertOnlyKeys(capability, allowed, "UNKNOWN_CAPABILITY_FIELD");
  if (capability.version !== CONTRACT_VERSION || capability.approved !== true) {
    fail("CAPABILITY_NOT_APPROVED");
  }
  if (
    capability.manifest_sha256 !== plan.manifest_sha256 ||
    capability.plan_fingerprint !== plan.plan_fingerprint ||
    capability.state_fingerprint !== plan.state_fingerprint
  ) {
    fail("CAPABILITY_BINDING_MISMATCH");
  }
  const expires = Date.parse(capability.expires_at);
  if (!Number.isFinite(expires) || expires <= nowMs) fail("CAPABILITY_EXPIRED");
}

export function parseArgs(argv) {
  const result = {
    command: "dry-run",
    manifestFd: null,
    planFd: null,
    capabilityFd: null,
  };
  let index = 0;
  if (argv[0] && !argv[0].startsWith("--")) {
    result.command = argv[0];
    index = 1;
  }
  if (!["validate", "dry-run", "apply", "readback"].includes(result.command)) {
    fail("UNKNOWN_COMMAND");
  }
  const destinations = new Map([
    ["--manifest-fd", "manifestFd"],
    ["--plan-fd", "planFd"],
    ["--capability-fd", "capabilityFd"],
  ]);
  for (; index < argv.length; index += 2) {
    const destination = destinations.get(argv[index]);
    const raw = argv[index + 1];
    if (!destination || raw === undefined || !/^\d+$/.test(raw)) {
      fail("INVALID_ARGUMENT");
    }
    if (result[destination] !== null) fail("DUPLICATE_ARGUMENT");
    const fd = Number(raw);
    assertDataFd(fd);
    result[destination] = fd;
  }
  const requirements = {
    validate: ["manifestFd"],
    "dry-run": ["manifestFd", "planFd"],
    apply: ["manifestFd", "planFd", "capabilityFd"],
    readback: ["manifestFd", "planFd"],
  };
  if (requirements[result.command].some((field) => result[field] === null)) {
    fail("MISSING_FD");
  }
  return result;
}

function evidence(command, outcome, counts, checks, writes = "none") {
  return {
    schema: EVIDENCE_SCHEMA,
    version: CONTRACT_VERSION,
    command,
    outcome,
    counts: normalizedCounts(counts),
    checks: normalizedChecks(checks),
    writes,
  };
}

function deploymentFromAdminKey(key) {
  if (typeof key !== "string") fail("ADMIN_KEY_MISSING");
  const separator = key.indexOf("|");
  if (separator < 1 || separator === key.length - 1) fail("ADMIN_KEY_INVALID");
  const match = /^prod:([a-z0-9-]+)$/.exec(key.slice(0, separator));
  if (!match || match[1] !== PRODUCTION_DEPLOYMENT) {
    fail("ADMIN_KEY_WRONG_TARGET");
  }
  return match[1];
}

/** ConvexHttpClient.setAdminAuth explicitly supports internal functions. */
export async function createAdminTransport(env = process.env) {
  const key = env.CONVEX_DEPLOY_KEY;
  const deployment = deploymentFromAdminKey(key);
  let ConvexHttpClient;
  let makeFunctionReference;
  try {
    ({ ConvexHttpClient } = await import("convex/browser"));
    ({ makeFunctionReference } = await import("convex/server"));
  } catch {
    fail("CONVEX_SDK_UNAVAILABLE");
  }
  const client = new ConvexHttpClient(`https://${deployment}.convex.cloud`, {
    logger: false,
  });
  client.setAdminAuth(key);
  return {
    preflight: (args) =>
      client.query(makeFunctionReference(FUNCTION_REFS.preflight), args),
    apply: (args) =>
      client.mutation(makeFunctionReference(FUNCTION_REFS.apply), args),
    readback: (args) =>
      client.query(makeFunctionReference(FUNCTION_REFS.readback), args),
  };
}

function validateOperationReceipt(receipt, expectedCounts, outcomes) {
  if (!isPlainObject(receipt) || receipt.contract_version !== CONTRACT_VERSION) {
    fail("BACKEND_CONTRACT_MISMATCH");
  }
  if (!outcomes.includes(receipt.outcome)) fail("BACKEND_OUTCOME_REJECTED");
  const counts = normalizedCounts(receipt.counts);
  if (!sameCounts(counts, expectedCounts)) fail("RECEIPT_COUNT_MISMATCH");
  const checks = normalizedChecks(receipt.checks);
  if (Object.values(checks).some((value) => !value)) fail("BACKEND_CHECK_FAILED");
  return { outcome: receipt.outcome, counts, checks };
}

export async function run(
  argv,
  {
    env = process.env,
    now = () => Date.now(),
    transportFactory = createAdminTransport,
  } = {},
) {
  const options = parseArgs(argv);

  if (options.command === "validate") {
    const manifest = parseCanonicalPrivate(
      readPrivateFd(options.manifestFd),
      MANIFEST_SCHEMA,
    );
    const counts = validateManifest(manifest);
    return evidence("validate", "valid", counts, {
      canonicalManifest: true,
      privateFd: true,
      schemaValid: true,
    });
  }

  if (options.command === "dry-run") {
    const manifestText = readPrivateFd(options.manifestFd);
    const manifest = parseCanonicalPrivate(manifestText, MANIFEST_SCHEMA);
    const counts = validateManifest(manifest);
    const receipt = validatePreflightReceipt(
      await (await transportFactory(env)).preflight({ manifest }),
      counts,
    );
    writePrivateFd(
      options.planFd,
      canonicalJson({
        schema: PLAN_SCHEMA,
        version: CONTRACT_VERSION,
        manifest_sha256: sha256(manifestText),
        plan_fingerprint: receipt.planFingerprint,
        state_fingerprint: receipt.stateFingerprint,
        counts,
        checks: receipt.checks,
      }),
    );
    return evidence("dry-run", "ready", counts, receipt.checks);
  }

  if (options.command === "apply") {
    const manifestText = readPrivateFd(options.manifestFd);
    const manifest = parseCanonicalPrivate(manifestText, MANIFEST_SCHEMA);
    const counts = validateManifest(manifest);
    const plan = validatePlan(
      parseCanonicalPrivate(readPrivateFd(options.planFd), PLAN_SCHEMA),
      sha256(manifestText),
      counts,
    );
    validateCapability(
      parseCanonicalPrivate(
        readPrivateFd(options.capabilityFd),
        CAPABILITY_SCHEMA,
      ),
      plan,
      now(),
    );
    const receipt = validateOperationReceipt(
      await (await transportFactory(env)).apply({
        manifest,
        expected_plan_fingerprint: plan.plan_fingerprint,
        expected_state_fingerprint: plan.state_fingerprint,
      }),
      counts,
      ["applied", "already_applied"],
    );
    return evidence(
      "apply",
      receipt.outcome,
      receipt.counts,
      receipt.checks,
      receipt.outcome === "applied" ? "completed" : "none",
    );
  }

  const manifestText = readPrivateFd(options.manifestFd);
  const manifest = parseCanonicalPrivate(manifestText, MANIFEST_SCHEMA);
  const counts = validateManifest(manifest);
  const plan = validatePlan(
    parseCanonicalPrivate(readPrivateFd(options.planFd), PLAN_SCHEMA),
    sha256(manifestText),
    counts,
  );
  const receipt = validateOperationReceipt(
    await (await transportFactory(env)).readback({
      manifest,
      expected_plan_fingerprint: plan.plan_fingerprint,
    }),
    plan.counts,
    ["verified"],
  );
  return evidence("readback", "verified", receipt.counts, receipt.checks);
}

function failureEvidence() {
  return {
    schema: EVIDENCE_SCHEMA,
    version: CONTRACT_VERSION,
    command: "failed",
    outcome: "failure",
    counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])),
    checks: { completed: false },
    writes: "unknown",
  };
}

async function main() {
  try {
    process.stdout.write(canonicalJson(await run(process.argv.slice(2))));
  } catch (error) {
    const code = error instanceof OperatorFailure ? error.code : "UNEXPECTED_FAILURE";
    process.stderr.write(`ERROR ${code}\n`);
    process.stdout.write(canonicalJson(failureEvidence()));
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
