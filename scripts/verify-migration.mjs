#!/usr/bin/env node

/**
 * Post-deploy, post-migration proof for the production Vogel Vault.
 *
 * Exact invocation (from the repository root):
 *   CONVEX_DEPLOYMENT=prod:keen-elephant-452 \
 *   CONVEX_READ_TOKEN="$THE_TOKEN" \
 *   node scripts/verify-migration.mjs
 *
 * This program is read-only. Public blob queries use the read token from the
 * environment through mode-0600 request bodies. The token is never accepted in
 * argv and is removed from child-process environments. The existing internal
 * migrate:status and migrate:verifyFile queries provide the row proof; no
 * server-authored row, money total, error detail, or credential is printed.
 *
 * Exit codes:
 *   0   VERIFIED
 *   10  FAILED (the deployment answered, but at least one proof failed)
 *   11  OUTAGE (transport or Convex administrative query failed)
 *   12  AUTH-REJECTED
 *   13  TOKEN-UNCONFIGURED
 *   2   INVALID (usage, local configuration, or malformed response)
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const DEFAULT_URL = "https://framework-desktop.tail69757d.ts.net";
export const EXPECTED_DATA_FILE_COUNT = 13;

export const EXIT = Object.freeze({
  VERIFIED: 0,
  FAILED: 10,
  OUTAGE: 11,
  AUTH_REJECTED: 12,
  TOKEN_UNCONFIGURED: 13,
  INVALID: 2,
});

export const SOURCES = Object.freeze([
  {
    file: "transactions",
    table: "transactions",
    moneyColumns: ["amountCents"],
  },
  {
    file: "mason-transactions",
    table: "transactions",
    moneyColumns: ["amountCents"],
  },
  {
    file: "maddox-transactions",
    table: "transactions",
    moneyColumns: ["amountCents"],
  },
  {
    file: "bitcoin-buys",
    table: "btcBuys",
    moneyColumns: ["sats", "priceUsdCents", "usdCents"],
  },
  {
    file: "mason-bitcoin-buys",
    table: "btcBuys",
    moneyColumns: ["sats", "priceUsdCents", "usdCents"],
  },
  {
    file: "bitcoin-bill-pays",
    table: "btcBillPays",
    moneyColumns: [
      "amountUsdCents",
      "btcSpentSats",
      "btcPriceCents",
      "feeUsdCents",
    ],
  },
  {
    file: "todos",
    table: "todos",
    moneyColumns: [],
  },
  {
    file: "income",
    table: "income",
    moneyColumns: ["amountCents"],
  },
  {
    file: "balances",
    table: "balanceDocuments",
    moneyColumns: [
      "cashAppSats",
      "coldcardSats",
      "riverSats",
      "strikeSats",
      "zeusSats",
      "totalSats",
      "cashAppFiatCents",
      "coldcardFiatCents",
      "riverFiatCents",
      "strikeFiatCents",
      "zeusFiatCents",
      "totalFiatCents",
      "btcSync.anchorBalancesSats.cashAppSats",
      "btcSync.anchorBalancesSats.coldcardSats",
      "btcSync.anchorBalancesSats.riverSats",
      "btcSync.anchorBalancesSats.strikeSats",
      "btcSync.anchorBalancesSats.zeusSats",
      "btcSync.anchorBalancesSats.totalSats",
    ],
  },
  {
    file: "budget",
    table: "budgetDocuments",
    moneyColumns: [
      "coinbaseOneBalanceCents",
      "categories[].budgetCents",
      "income.weeklyGrossCents",
      "income.weeklyStrikeCents",
      "income.weeklyRiverCents",
      "income.monthlyGrossCents",
      "income.mtdIncomeCents",
      "income.ytdIncomeCents",
      "income.paychecks[].amountCents",
      "income.paychecks[].netCents",
      "mtdIncomeCents",
      "ytdIncomeCents",
      "monthlyHistory[].incomeCents",
      "monthlyHistory[].expensesCents",
      "monthlyHistory[].savingsBps",
      "allowance.weeklyCents",
    ],
  },
  {
    file: "mason-budget",
    table: "budgetDocuments",
    moneyColumns: [
      "coinbaseOneBalanceCents",
      "categories[].budgetCents",
      "income.weeklyGrossCents",
      "income.weeklyStrikeCents",
      "income.weeklyRiverCents",
      "income.monthlyGrossCents",
      "income.mtdIncomeCents",
      "income.ytdIncomeCents",
      "income.paychecks[].amountCents",
      "income.paychecks[].netCents",
      "mtdIncomeCents",
      "ytdIncomeCents",
      "monthlyHistory[].incomeCents",
      "monthlyHistory[].expensesCents",
      "monthlyHistory[].savingsBps",
      "allowance.weeklyCents",
    ],
  },
  {
    file: "btc-balance-snapshot",
    table: "btcBalanceDocuments",
    targetTables: ["btcBalanceDocuments", "btcAccounts"],
    moneyColumns: [
      "schemaVersion",
      "accounts[].sats",
      "accounts[].fiatCents",
      "totals.sats",
      "totals.fiatCents",
      "totals.exchangeSats",
      "totals.selfCustodySats",
    ],
  },
  {
    file: "finances",
    table: "financeDocuments",
    moneyColumns: [
      "retirementTotalCents",
      "accounts[].totalValueCents",
      "accounts[].weeklyContributionCents",
      "accounts[].holdings[].valueCents",
      "accounts[].holdings[].costBasisCents",
      "accounts[].holdings[].gainBps",
      "accounts[].holdings[].avgCostCents",
      "accounts[].holdings[].currentPricePerShareCents",
      "accounts[].holdings[].lots[].pricePerShareCents",
      "accounts[].holdings[].lots[].amountInvestedCents",
    ],
  },
  {
    file: "son-balances",
    table: "btcBalanceDocuments",
    targetTables: ["btcBalanceDocuments", "btcAccounts"],
    moneyColumns: [
      "schemaVersion",
      "accounts[].sats",
      "accounts[].fiatCents",
      "totals.sats",
      "totals.fiatCents",
      "totals.exchangeSats",
      "totals.selfCustodySats",
    ],
  },
]);

/**
 * Preservation-only exceptions. Empty now: every authoritative dataFiles blob
 * is either a typed migration source above or an explicitly absent source.
 */
export const PRESERVED_DOCUMENT_FILES = Object.freeze([]);

const USAGE = `Usage: node scripts/verify-migration.mjs

Environment:
  CONVEX_READ_TOKEN   required; never accepted in argv
  CONVEX_DEPLOYMENT   must be prod:keen-elephant-452
  CONVEX_URL          optional; defaults to ${DEFAULT_URL}
  VERIFY_MIGRATION_TIMEOUT
                      per public query timeout in seconds (default 30)

This command performs authenticated public queries and Convex internal queries.
It writes no deployment data and emits only counts, SHA-256 checksums, and
pass/fail evidence.
`;

export class VerificationError extends Error {
  constructor(state, exitCode) {
    super(state);
    this.name = "VerificationError";
    this.state = state;
    this.exitCode = exitCode;
  }
}

function invalid() {
  return new VerificationError("INVALID", EXIT.INVALID);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The same deterministic JSON shape used by convex/migrate.ts: sorted object
 * keys, stable array order, omitted undefined members, explicit bigint suffix.
 */
export function canonicalJson(value) {
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function checksum(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sortedDataFileMetadata(value) {
  if (!Array.isArray(value)) throw invalid();
  const seen = new Set();
  const rows = value.map((entry) => {
    if (
      !isPlainObject(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.version !== "number" ||
      typeof entry.updatedAt !== "number" ||
      seen.has(entry.name)
    ) {
      throw invalid();
    }
    seen.add(entry.name);
    return {
      name: entry.name,
      version: entry.version,
      updatedAt: entry.updatedAt,
    };
  });
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

function sortedSyncVersions(value) {
  if (!isPlainObject(value)) throw invalid();
  return Object.entries(value)
    .map(([name, version]) => {
      if (typeof version !== "number") throw invalid();
      return { name, version };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sortedTombstones(value) {
  if (!Array.isArray(value)) throw invalid();
  return value
    .map((entry) => {
      if (
        !isPlainObject(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.deletedAt !== "number"
      ) {
        throw invalid();
      }
      return { id: entry.id, deletedAt: entry.deletedAt };
    })
    .sort((left, right) =>
      left.id === right.id
        ? left.deletedAt - right.deletedAt
        : left.id.localeCompare(right.id),
    );
}

/**
 * Capture every application-visible field in the legacy blob path.
 *
 * Table order is not contractual, so metadata and tombstones are sorted before
 * byte comparison. Array order inside each data file remains untouched.
 */
export async function captureLegacyWorld(query) {
  const metadata = sortedDataFileMetadata(await query("dataFiles:list", {}));
  const dataFiles = [];
  for (const entry of metadata) {
    dataFiles.push({
      ...entry,
      data: await query("dataFiles:get", { name: entry.name }),
    });
  }

  const syncVersions = sortedSyncVersions(
    await query("dataFiles:getVersions", {}),
  );
  const todoTombstones = sortedTombstones(
    await query("dataFiles:listTodoTombstones", {}),
  );
  const value = { dataFiles, syncVersions, todoTombstones };
  const perFile = Object.fromEntries(
    dataFiles.map((entry) => [entry.name, checksum(entry)]),
  );

  return {
    value,
    canonical: canonicalJson(value),
    checksum: checksum(value),
    perFile,
    counts: {
      dataFiles: dataFiles.length,
      syncVersions: syncVersions.length,
      todoTombstones: todoTombstones.length,
    },
  };
}

function sortedFullTable(value) {
  if (!Array.isArray(value) || value.some((entry) => !isPlainObject(entry))) {
    throw invalid();
  }
  return [...value].sort((left, right) => {
    const leftId = String(left._id ?? "");
    const rightId = String(right._id ?? "");
    return leftId.localeCompare(rightId);
  });
}

/**
 * Administrative reads cover the complete stored documents, including
 * syncVersions.updatedAt and Convex system fields omitted by the public API.
 */
export async function captureFullLegacyWorld(adminTable) {
  const dataFiles = sortedFullTable(await adminTable("dataFiles"));
  const syncVersions = sortedFullTable(await adminTable("syncVersions"));
  const todoTombstones = sortedFullTable(await adminTable("todoTombstones"));
  const seen = new Set();
  const perFile = {};
  for (const entry of dataFiles) {
    if (typeof entry.name !== "string" || seen.has(entry.name)) throw invalid();
    seen.add(entry.name);
    perFile[entry.name] = checksum(entry);
  }
  const value = { dataFiles, syncVersions, todoTombstones };
  return {
    value,
    canonical: canonicalJson(value),
    checksum: checksum(value),
    perFile,
    counts: {
      dataFiles: dataFiles.length,
      syncVersions: syncVersions.length,
      todoTombstones: todoTombstones.length,
    },
  };
}

export function publicSnapshotMatchesFull(publicSnapshot, fullSnapshot) {
  const dataFiles = fullSnapshot.value.dataFiles
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      updatedAt: entry.updatedAt,
      data: entry.data,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const syncVersions = fullSnapshot.value.syncVersions
    .map((entry) => ({ name: entry.name, version: entry.version }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const todoTombstones = fullSnapshot.value.todoTombstones
    .map((entry) => ({ id: entry.id, deletedAt: entry.deletedAt }))
    .sort((left, right) =>
      left.id === right.id
        ? left.deletedAt - right.deletedAt
        : left.id.localeCompare(right.id),
    );
  return (
    publicSnapshot.canonical ===
    canonicalJson({ dataFiles, syncVersions, todoTombstones })
  );
}

function exactIntegerCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function statusByFile(status) {
  if (!isPlainObject(status) || !Array.isArray(status.files)) throw invalid();
  const result = new Map();
  for (const entry of status.files) {
    if (!isPlainObject(entry) || typeof entry.file !== "string") throw invalid();
    if (result.has(entry.file)) throw invalid();
    result.set(entry.file, entry);
  }
  return result;
}

/**
 * Reduce a sensitive backend report immediately. Money values and problem
 * details deliberately do not cross this function's return boundary.
 */
export function reduceFileVerification(source, status, report) {
  if (!isPlainObject(status) || !isPlainObject(report)) throw invalid();
  if (
    report.file !== source.file ||
    report.table !== source.table ||
    typeof status.blobPresent !== "boolean" ||
    !exactIntegerCount(report.blobRowCount) ||
    !exactIntegerCount(report.tableRowCount) ||
    !isPlainObject(report.blobSums) ||
    !isPlainObject(report.tableSums)
  ) {
    throw invalid();
  }

  const expectedTargetTables = source.targetTables ?? [source.table];
  if (
    !isPlainObject(report.targetRowCounts) ||
    Object.keys(report.targetRowCounts).length !== expectedTargetTables.length
  ) {
    throw invalid();
  }
  const targetRows = {};
  let targetCountsPassed = true;
  for (const table of expectedTargetTables) {
    const target = report.targetRowCounts[table];
    if (
      !isPlainObject(target) ||
      !exactIntegerCount(target.expected) ||
      !exactIntegerCount(target.stored)
    ) {
      throw invalid();
    }
    targetRows[table] = target.stored;
    if (
      target.expected !== target.stored ||
      target.matches !== true
    ) {
      targetCountsPassed = false;
    }
  }

  let moneyPassed = 0;
  for (const column of source.moneyColumns) {
    const blobValue = report.blobSums[column];
    const tableValue = report.tableSums[column];
    if (
      typeof blobValue === "string" &&
      typeof tableValue === "string" &&
      blobValue === tableValue
    ) {
      moneyPassed += 1;
    }
  }

  const noUnexpectedMoneyColumns =
    Object.keys(report.blobSums).length === source.moneyColumns.length &&
    Object.keys(report.tableSums).length === source.moneyColumns.length;
  const rowCountPassed = report.blobRowCount === report.tableRowCount;
  const roundTripPassed = report.exactRoundTrip === true;
  const backendPassed =
    report.ok === true &&
    Array.isArray(report.problems) &&
    report.problems.length === 0;
  const absentAndEmpty =
    !status.blobPresent &&
    report.blobRowCount === 0 &&
    report.tableRowCount === 0;
  const passed =
    rowCountPassed &&
    moneyPassed === source.moneyColumns.length &&
    noUnexpectedMoneyColumns &&
    targetCountsPassed &&
    roundTripPassed &&
    backendPassed;

  return {
    file: source.file,
    table: source.table,
    blobPresent: status.blobPresent,
    blobRows: report.blobRowCount,
    tableRows: report.tableRowCount,
    targetRows,
    targetCountsPassed,
    moneyPassed,
    moneyExpected: source.moneyColumns.length,
    rowCountPassed,
    roundTripPassed,
    passed,
    state: absentAndEmpty && passed ? "SKIP" : passed ? "PASS" : "FAIL",
  };
}

function tableCoverage(files, publicCounts) {
  if (!isPlainObject(publicCounts)) throw invalid();
  const expected = new Map();
  for (const file of files) {
    if (file.includeInTableCoverage === false) continue;
    if (!isPlainObject(file.targetRows)) throw invalid();
    for (const [table, rows] of Object.entries(file.targetRows)) {
      if (!exactIntegerCount(rows)) throw invalid();
      expected.set(table, (expected.get(table) ?? 0) + rows);
    }
  }

  const checks = [];
  for (const table of [
    "transactions",
    "todos",
    "btcBuys",
    "btcBillPays",
    "income",
    "balanceDocuments",
    "btcAccounts",
    "budgetDocuments",
    "btcBalanceDocuments",
    "financeDocuments",
  ]) {
    const actual = publicCounts[table];
    if (!exactIntegerCount(actual)) throw invalid();
    const wanted = expected.get(table) ?? 0;
    checks.push({ table, expected: wanted, actual, passed: wanted === actual });
  }
  return checks;
}

export function discoverBlobCoverage(
  snapshot,
  sources = SOURCES,
  preservedFiles = PRESERVED_DOCUMENT_FILES,
) {
  if (
    !isPlainObject(snapshot) ||
    !isPlainObject(snapshot.value) ||
    !Array.isArray(snapshot.value.dataFiles)
  ) {
    throw invalid();
  }

  const verificationPaths = new Set();
  for (const source of sources) {
    if (
      !isPlainObject(source) ||
      typeof source.file !== "string" ||
      verificationPaths.has(source.file)
    ) {
      throw invalid();
    }
    verificationPaths.add(source.file);
  }
  for (const file of preservedFiles) {
    if (typeof file !== "string" || verificationPaths.has(file)) {
      throw invalid();
    }
    verificationPaths.add(file);
  }

  const discovered = new Set();
  let covered = 0;
  let unknown = 0;
  for (const entry of snapshot.value.dataFiles) {
    if (
      !isPlainObject(entry) ||
      typeof entry.name !== "string" ||
      discovered.has(entry.name)
    ) {
      throw invalid();
    }
    discovered.add(entry.name);
    if (verificationPaths.has(entry.name)) covered += 1;
    else unknown += 1;
  }

  return {
    discovered: discovered.size,
    covered,
    unknown,
    passed: unknown === 0 && covered === discovered.size,
  };
}

export function buildEvidence({
  before,
  after,
  files,
  publicCounts,
  blobCoverage = discoverBlobCoverage(before),
  publicMatchesFullBefore = true,
  publicMatchesFullAfter = true,
}) {
  const legacyExact = before.canonical === after.canonical;
  const expectedFileCount =
    before.counts.dataFiles === EXPECTED_DATA_FILE_COUNT &&
    after.counts.dataFiles === EXPECTED_DATA_FILE_COUNT;
  const coverage = tableCoverage(files, publicCounts);
  const sourceChecks = files.map((file) => {
    const blobChecksum = before.perFile[file.file] ?? null;
    const blobPresenceMatches = file.blobPresent === (blobChecksum !== null);
    const blobUnchanged =
      blobChecksum !== null && blobChecksum === after.perFile[file.file];
    const blobPassed =
      blobPresenceMatches && (!file.blobPresent || blobUnchanged);
    const passed = file.passed && blobPassed;
    return {
      ...file,
      blobChecksum,
      blobPresenceMatches,
      blobUnchanged,
      passed,
      state:
        passed && file.state === "SKIP" ? "SKIP" : passed ? "PASS" : "FAIL",
    };
  });
  const allSourcesPassed = sourceChecks.every((file) => file.passed);
  const allTablesCovered = coverage.every((entry) => entry.passed);

  return {
    verdict:
      legacyExact &&
      expectedFileCount &&
      publicMatchesFullBefore &&
      publicMatchesFullAfter &&
      blobCoverage.passed &&
      allSourcesPassed &&
      allTablesCovered
        ? "VERIFIED"
        : "FAILED",
    legacyExact,
    expectedFileCount,
    blobCoverage,
    publicMatchesFull: publicMatchesFullBefore && publicMatchesFullAfter,
    legacyChecksum: before.checksum,
    legacyCounts: before.counts,
    files: sourceChecks,
    coverage,
  };
}

function passWord(value) {
  return value ? "PASS" : "FAIL";
}

function pad(value, width) {
  return String(value).padEnd(width);
}

export function renderEvidence(evidence) {
  const lines = [
    `VERDICT: ${evidence.verdict}`,
    `legacy-path ${passWord(evidence.legacyExact)} checksum=${evidence.legacyChecksum}`,
    `public/full ${passWord(evidence.publicMatchesFull)}`,
    `legacy-counts dataFiles=${evidence.legacyCounts.dataFiles} syncVersions=${evidence.legacyCounts.syncVersions} todoTombstones=${evidence.legacyCounts.todoTombstones}`,
    `blob-coverage ${passWord(evidence.blobCoverage.passed)} discovered=${evidence.blobCoverage.discovered} covered=${evidence.blobCoverage.covered} unknown=${evidence.blobCoverage.unknown}`,
    "",
    `${pad("source file", 26)} ${pad("table", 15)} ${pad("rows(table/blob)", 17)} ${pad("money", 8)} ${pad("roundtrip", 11)} ${pad("blob", 70)} result`,
  ];

  for (const file of evidence.files) {
    const blob =
      file.blobChecksum === null
        ? "ABSENT"
        : `${file.blobChecksum}:${passWord(file.blobUnchanged)}`;
    lines.push(
      `${pad(file.file, 26)} ${pad(file.table, 15)} ${pad(`${file.tableRows}/${file.blobRows}`, 17)} ${pad(`${file.moneyPassed}/${file.moneyExpected}`, 8)} ${pad(passWord(file.roundTripPassed), 11)} ${pad(blob, 70)} ${file.state}`,
    );
  }

  lines.push("", "table coverage:");
  for (const entry of evidence.coverage) {
    lines.push(
      `  ${pad(entry.table, 15)} rows=${entry.actual}/${entry.expected} ${passWord(entry.passed)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function classifyQueryFailure(httpCode, document) {
  if (httpCode !== "200" || !isPlainObject(document)) {
    throw new VerificationError("OUTAGE", EXIT.OUTAGE);
  }
  if (document.status === "success") return document.value;
  if (document.status !== "error") {
    throw new VerificationError("OUTAGE", EXIT.OUTAGE);
  }

  const combined = `${
    typeof document.errorData === "string"
      ? document.errorData
      : JSON.stringify(document.errorData ?? "")
  }\n${
    typeof document.errorMessage === "string" ? document.errorMessage : ""
  }`;
  if (/unauthorized/i.test(combined) && /not configured/i.test(combined)) {
    throw new VerificationError(
      "TOKEN-UNCONFIGURED",
      EXIT.TOKEN_UNCONFIGURED,
    );
  }
  if (/unauthorized/i.test(combined)) {
    throw new VerificationError("AUTH-REJECTED", EXIT.AUTH_REJECTED);
  }
  throw new VerificationError("OUTAGE", EXIT.OUTAGE);
}

export function createHttpQuery({
  url,
  token,
  timeout,
  workdir,
  curlBin = "curl",
  spawn = spawnSync,
}) {
  let sequence = 0;
  return async (path, args) => {
    sequence += 1;
    const requestPath = resolve(workdir, `request-${sequence}.json`);
    const responsePath = resolve(workdir, `response-${sequence}.json`);
    writeFileSync(
      requestPath,
      JSON.stringify({ path, args: { ...args, token }, format: "json" }),
      { encoding: "utf8", mode: 0o600 },
    );
    writeFileSync(responsePath, "", { encoding: "utf8", mode: 0o600 });
    chmodSync(requestPath, 0o600);
    chmodSync(responsePath, 0o600);

    const childEnv = { ...process.env, CONVEX_READ_TOKEN: "" };
    const result = spawn(
      curlBin,
      [
        "--silent",
        "--show-error",
        "--max-time",
        String(timeout),
        "--header",
        "Content-Type: application/json",
        "--data-binary",
        `@${requestPath}`,
        "--output",
        responsePath,
        "--write-out",
        "%{http_code}",
        `${url}/api/query`,
      ],
      {
        encoding: "utf8",
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.error || result.status !== 0) {
      throw new VerificationError("OUTAGE", EXIT.OUTAGE);
    }

    let document;
    try {
      document = JSON.parse(readFileSync(responsePath, "utf8"));
    } catch {
      throw new VerificationError("OUTAGE", EXIT.OUTAGE);
    }
    return classifyQueryFailure(String(result.stdout).trim(), document);
  };
}

export function createInternalQuery({
  deployment,
  repoRoot,
  spawn = spawnSync,
}) {
  return async (functionName, args) => {
    if (
      functionName !== "migrate:status" &&
      functionName !== "migrate:verifyFile"
    ) {
      throw invalid();
    }
    const childEnv = {
      ...process.env,
      CONVEX_DEPLOYMENT: deployment,
      CONVEX_READ_TOKEN: "",
    };
    const result = spawn(
      "npx",
      [
        "--no-install",
        "convex",
        "run",
        "--no-push",
        functionName,
        JSON.stringify(args),
        "--prod",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: childEnv,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.error || result.status !== 0) {
      throw new VerificationError("OUTAGE", EXIT.OUTAGE);
    }
    const text = String(result.stdout).trim();
    if (text === "") {
      throw new VerificationError("OUTAGE", EXIT.OUTAGE);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new VerificationError("OUTAGE", EXIT.OUTAGE);
    }
  };
}

export function createAdminTableRead({
  deployment,
  repoRoot,
  spawn = spawnSync,
}) {
  return async (table) => {
    if (
      table !== "dataFiles" &&
      table !== "syncVersions" &&
      table !== "todoTombstones"
    ) {
      throw invalid();
    }
    const childEnv = {
      ...process.env,
      CONVEX_DEPLOYMENT: deployment,
      CONVEX_READ_TOKEN: "",
    };
    const result = spawn(
      "npx",
      [
        "--no-install",
        "convex",
        "data",
        table,
        "--limit",
        "1000000",
        "--order",
        "asc",
        "--format",
        "json",
        "--prod",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: childEnv,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.error || result.status !== 0) {
      throw new VerificationError("OUTAGE", EXIT.OUTAGE);
    }
    const text = String(result.stdout).trim();
    // `convex data --format json` exits successfully with no stdout when the
    // selected table has no documents.
    if (text === "") return [];
    try {
      return JSON.parse(text);
    } catch {
      throw new VerificationError("OUTAGE", EXIT.OUTAGE);
    }
  };
}

export async function verifyMigration({ query, internalQuery, adminTable }) {
  const publicBefore = await captureLegacyWorld(query);
  const before = await captureFullLegacyWorld(adminTable);
  const publicMatchesFullBefore = publicSnapshotMatchesFull(
    publicBefore,
    before,
  );
  const status = await internalQuery("migrate:status", {});
  const statuses = statusByFile(status);
  const files = [];

  for (const source of SOURCES) {
    const fileStatus = statuses.get(source.file);
    if (fileStatus === undefined) throw invalid();
    const sensitiveReport = await internalQuery("migrate:verifyFile", {
      file: source.file,
    });
    files.push({
      ...reduceFileVerification(source, fileStatus, sensitiveReport),
      includeInTableCoverage: source.includeInTableCoverage,
    });
  }

  const publicCounts = await query("tables:rowCounts", {});
  const publicAfter = await captureLegacyWorld(query);
  const after = await captureFullLegacyWorld(adminTable);
  const publicMatchesFullAfter = publicSnapshotMatchesFull(publicAfter, after);
  return buildEvidence({
    before,
    after,
    files,
    publicCounts,
    blobCoverage: discoverBlobCoverage(before),
    publicMatchesFullBefore,
    publicMatchesFullAfter,
  });
}

function deploymentFromUrl(url) {
  const host = new URL(url).hostname;
  const suffix = ".convex.cloud";
  if (!host.endsWith(suffix)) throw invalid();
  const name = host.slice(0, -suffix.length);
  if (!name) throw invalid();
  return `prod:${name}`;
}

function parseRuntime(argv, env) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { help: true };
  }
  if (argv.length !== 0) throw invalid();

  const url = (env.CONVEX_URL || DEFAULT_URL).replace(/\/$/, "");
  if (url !== DEFAULT_URL) throw invalid();
  const token = env.CONVEX_READ_TOKEN ?? "";
  if (!token) {
    throw new VerificationError("AUTH-REJECTED", EXIT.AUTH_REJECTED);
  }
  const timeout = Number(env.VERIFY_MIGRATION_TIMEOUT ?? "30");
  if (!Number.isInteger(timeout) || timeout < 1) throw invalid();

  const expectedDeployment = deploymentFromUrl(url);
  const deployment = env.CONVEX_DEPLOYMENT || expectedDeployment;
  if (deployment !== expectedDeployment) throw invalid();
  return { help: false, url, token, timeout, deployment };
}

export async function run(argv, env = process.env, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(text));
  const err = io.err ?? ((text) => process.stderr.write(text));
  let runtime;
  try {
    runtime = parseRuntime(argv, env);
  } catch (caught) {
    const failure =
      caught instanceof VerificationError ? caught : invalid();
    err(`STATE: ${failure.state}\n`);
    return failure.exitCode;
  }

  if (runtime.help) {
    out(USAGE);
    return EXIT.VERIFIED;
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const workdir = mkdtempSync(resolve(tmpdir(), "verify-migration-"));
  chmodSync(workdir, 0o700);
  try {
    const query =
      io.query ??
      createHttpQuery({
        url: runtime.url,
        token: runtime.token,
        timeout: runtime.timeout,
        workdir,
      });
    const internalQuery =
      io.internalQuery ??
      createInternalQuery({
        deployment: runtime.deployment,
        repoRoot,
      });
    const adminTable =
      io.adminTable ??
      createAdminTableRead({
        deployment: runtime.deployment,
        repoRoot,
      });
    const evidence = await verifyMigration({
      query,
      internalQuery,
      adminTable,
    });
    out(renderEvidence(evidence));
    return evidence.verdict === "VERIFIED" ? EXIT.VERIFIED : EXIT.FAILED;
  } catch (caught) {
    const failure =
      caught instanceof VerificationError ? caught : invalid();
    err(`STATE: ${failure.state}\n`);
    return failure.exitCode;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
