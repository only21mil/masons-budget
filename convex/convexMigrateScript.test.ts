// Direct tests for scripts/convex-migrate.mjs. The runner accepts an injected
// Convex executor so these tests exercise the complete CLI/report path without
// touching a deployment or spawning a child process.

import { describe, expect, test } from "vitest";

import {
  DEFAULT_BATCH_SIZE,
  REPORT_SCHEMA,
  REPORT_VERSION,
  extractBackendEvidence,
  formatPlanLine,
  formatVerificationLine,
  parseArgs,
  run,
  summarise,
} from "../scripts/convex-migrate.mjs";

const PLAN_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const DIFFERENT_PLAN_FINGERPRINT = `sha256:${"b".repeat(64)}`;

function verification(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    rowCountMatches: true,
    moneySumsMatch: true,
    roundTripRowsMatch: true,
    exactRoundTrip: true,
    problems: [],
    tableRowCount: 2,
    blobRowCount: 2,
    tableSums: { amountCents: "-123456.78" },
    blobSums: { amountCents: "-123456.78" },
    ...overrides,
  };
}

function ok(file: string) {
  return {
    file,
    table: "transactions",
    applied: true,
    skipped: false,
    inserted: 2,
    updated: 0,
    unchanged: 0,
    blobRowCount: 2,
    verification: verification(),
  };
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    files: [
      {
        file: "transactions",
        table: "transactions",
        blobPresent: true,
        blobRowCount: 2,
        blobUnreadable: false,
        migratedRowCount: 0,
        planFingerprint: `sha256:${"c".repeat(64)}`,
      },
    ],
    skippedDocumentShapedFiles: [],
    frozenPlanFingerprint: PLAN_FINGERPRINT,
    ...overrides,
  };
}

function migrationBatch(overrides: Record<string, unknown> = {}) {
  return {
    file: "transactions",
    table: "transactions",
    applied: false,
    blobPresent: true,
    blobRowCount: 2,
    scanned: 2,
    inserted: 2,
    updated: 0,
    unchanged: 0,
    cursor: 0,
    nextCursor: null,
    done: true,
    verifiedInTransaction: false,
    verification: null,
    planFingerprint: `sha256:${"c".repeat(64)}`,
    frozenPlanFingerprint: PLAN_FINGERPRINT,
    ...overrides,
  };
}

async function invoke(
  argv: string[],
  handler: (functionName: string, args: Record<string, unknown>) => unknown | Promise<unknown>,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await run(
    argv,
    {
      out: (line: string) => stdout.push(line),
      err: (line: string) => stderr.push(line),
    },
    { convexRun: handler },
  );
  return {
    exitCode,
    stdout,
    stderr,
    document: stdout.length === 1 ? JSON.parse(stdout[0]!) : null,
  };
}

describe("argument matrix", () => {
  test.each([
    { argv: [], expected: { apply: false, prod: false, verifyOnly: false } },
    { argv: ["--prod"], expected: { apply: false, prod: true, verifyOnly: false } },
    {
      argv: ["--apply", "--expected-plan-fingerprint", PLAN_FINGERPRINT],
      expected: {
        apply: true,
        prod: false,
        verifyOnly: false,
        expectedPlanFingerprint: PLAN_FINGERPRINT,
      },
    },
    {
      argv: [
        "--apply",
        "--expected-plan-fingerprint",
        PLAN_FINGERPRINT,
        "--prod",
        "--confirm-production",
      ],
      expected: { apply: true, prod: true, confirmProduction: true, verifyOnly: false },
    },
    { argv: ["--verify"], expected: { apply: false, prod: false, verifyOnly: true } },
    { argv: ["--verify-only", "--production"], expected: { apply: false, prod: true, verifyOnly: true } },
  ])("accepts $argv", ({ argv, expected }) => {
    expect(parseArgs(argv)).toMatchObject(expected);
  });

  test.each([
    ["--apply", "--prod"],
    ["--apply"],
    ["--expected-plan-fingerprint", PLAN_FINGERPRINT],
    ["--apply", "--expected-plan-fingerprint", "not-a-fingerprint"],
    ["--apply", "--expected-plan-fingerprint"],
    ["--confirm-production"],
    ["--verify", "--apply", "--expected-plan-fingerprint", PLAN_FINGERPRINT],
    ["--batch-size", "0"],
    ["--batch-size", "1.5"],
    ["--batch-size", "nope"],
    ["--batch-size"],
    ["--only"],
    ["--only", "--json"],
    ["--force"],
  ])("rejects invalid combination %j", (...argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  test("dry run remains the default", () => {
    const options = parseArgs([]);
    expect(options.apply).toBe(false);
    expect(options.batchSize).toBe(DEFAULT_BATCH_SIZE);
  });

  test("--only is repeatable in both spellings", () => {
    expect(parseArgs(["--only", "transactions", "--only=todos"]).only).toEqual([
      "transactions",
      "todos",
    ]);
  });

  test("the expected fingerprint accepts both argument spellings", () => {
    expect(
      parseArgs([
        "--apply",
        `--expected-plan-fingerprint=${PLAN_FINGERPRINT}`,
      ]).expectedPlanFingerprint,
    ).toBe(PLAN_FINGERPRINT);
  });
});

describe("summarise", () => {
  test("all verified is a pass", () => {
    const summary = summarise([ok("transactions"), ok("todos")]);
    expect(summary.ok).toBe(true);
    expect(summary.inserted).toBe(4);
  });

  test("a file that was never verified is a failure", () => {
    expect(summarise([{ ...ok("transactions"), verification: null }])).toMatchObject({ ok: false });
  });

  test("failed and incomplete verification are failures without relaying details", () => {
    const failed = ok("transactions");
    failed.verification = verification({
      ok: false,
      problems: ["record secret-id has monetary total 123.45"],
    });
    const summary = summarise([failed]);
    expect(summary.ok).toBe(false);
    expect(summary.failures).toEqual(["transactions: verification failed"]);
    expect(JSON.stringify(summary)).not.toContain("secret-id");
    expect(JSON.stringify(summary)).not.toContain("123.45");

    const partial = ok("transactions");
    partial.verification = verification({ exactRoundTrip: false });
    expect(summarise([partial]).ok).toBe(false);
  });

  test("a file with no blob is skipped", () => {
    expect(summarise([{ ...ok("maddox-transactions"), skipped: true, verification: null }]).ok).toBe(true);
  });
});

describe("human reporting redaction", () => {
  test("plan lines distinguish dry-run from apply", () => {
    expect(formatPlanLine({ ...ok("transactions"), applied: false })).toContain("would write 2 new");
    expect(formatPlanLine(ok("transactions"))).toContain("wrote 2 new");
  });

  test("verification lines do not print monetary totals or failure text", () => {
    const line = formatVerificationLine(
      verification({ problems: ["record secret-id differs by 123.45"] }),
    );
    expect(line).toContain("OK");
    expect(line).toContain("count OK");
    expect(line).toContain("sums OK");
    expect(line).toContain("round-trip rows OK");
    expect(line).toContain("problems=1");
    expect(line).not.toContain("amountCents");
    expect(line).not.toContain("123456.78");
    expect(line).not.toContain("secret-id");
  });

  test("dry-run verification is explicitly deferred", () => {
    expect(formatVerificationLine(null, true)).toContain("deferred");
    expect(formatVerificationLine(null, true)).not.toContain("NOT RUN");
  });
});

describe("backend evidence passthrough", () => {
  test("passes fingerprint and projection fields while redacting sensitive members", () => {
    const evidence = extractBackendEvidence({
      frozenPlanFingerprint: "plan-sha256",
      legacy: { blobFingerprint: "blob-sha256", ignored: "not evidence" },
      projectionVerification: {
        ok: true,
        exactRoundTrip: true,
        rowCounts: { source: 2, projected: 2 },
        tableSums: { amountCents: "123.45" },
        rawRows: [{ id: "secret-record" }],
        deploymentId: "secret-deployment",
        readToken: "READ-TOKEN-SENTINEL",
        token: "TOKEN-SENTINEL",
        amountCents: "AMOUNT-CENTS-SENTINEL",
        usdCents: "USD-CENTS-SENTINEL",
        sats: "SATS-SENTINEL",
      },
      argv: ["--secret"],
      stdout: "secret child output",
    });

    expect(evidence).toMatchObject({
      frozenPlanFingerprint: "plan-sha256",
      legacy: { blobFingerprint: "blob-sha256" },
      projectionVerification: {
        ok: true,
        exactRoundTrip: true,
        rowCounts: { source: 2, projected: 2 },
        tableSums: "[redacted]",
        rawRows: "[redacted]",
        deploymentId: "[redacted]",
        readToken: "[redacted]",
        token: "[redacted]",
        amountCents: "[redacted]",
        usdCents: "[redacted]",
        sats: "[redacted]",
      },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("secret-record");
    expect(serialized).not.toContain("secret child output");
    expect(serialized).not.toContain("123.45");
    expect(serialized).not.toContain("READ-TOKEN-SENTINEL");
    expect(serialized).not.toContain("TOKEN-SENTINEL");
    expect(serialized).not.toContain("AMOUNT-CENTS-SENTINEL");
    expect(serialized).not.toContain("USD-CENTS-SENTINEL");
    expect(serialized).not.toContain("SATS-SENTINEL");
  });
});

describe("versioned JSON output", () => {
  test("dry run emits exactly one JSON document and sends progress to stderr", async () => {
    const result = await invoke(["--json"], (functionName) => {
      if (functionName === "migrate:status") return status();
      if (functionName === "migrate:migrateFile") return migrationBatch();
      throw new Error("unexpected function");
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(1);
    expect(result.document).toMatchObject({
      schema: REPORT_SCHEMA,
      version: REPORT_VERSION,
      outcome: "success",
      exitCode: 0,
      operation: {
        state: "dry-run",
        frozenPlan: {
          fingerprint: PLAN_FINGERPRINT,
          fingerprintState: "provided",
        },
      },
      execution: { state: "completed", writeSafety: { classification: "none" } },
      files: [{ file: "transactions", state: "dry-run", batches: [{ state: "completed" }] }],
    });
    expect(result.stderr.join("\n")).toContain("Mode: dry-run");
    expect(result.stderr.join("\n")).toContain(
      `Plan fingerprint: ${PLAN_FINGERPRINT}`,
    );
    expect(result.stdout[0]).not.toContain("Target class:");
  });

  test("apply binds options to a backend frozen-plan fingerprint", async () => {
    const result = await invoke([
      "--apply",
      "--expected-plan-fingerprint",
      PLAN_FINGERPRINT,
      "--json",
      "--batch-size",
      "50",
    ], (functionName, args) => {
      if (functionName === "migrate:status") {
        return status();
      }
      if (functionName === "migrate:migrateFile") {
        expect(args.expectedPlanFingerprint).toBe(PLAN_FINGERPRINT);
        return migrationBatch({
          applied: true,
          verifiedInTransaction: true,
          verification: verification(),
          projectionVerification: { ok: true, tableSums: { amountCents: "123.45" } },
          legacyBlobFingerprint: "legacy-sha256",
        });
      }
      throw new Error("unexpected function");
    });

    expect(result.exitCode).toBe(0);
    expect(result.document.operation.frozenPlan).toEqual({
      fingerprint: PLAN_FINGERPRINT,
      fingerprintState: "provided",
      expectedFingerprintMatched: true,
      applyOptions: {
        state: "apply",
        targetClass: "development",
        selectedFiles: ["transactions"],
        batchSize: 50,
        productionConfirmed: false,
      },
    });
    expect(result.document.files[0]).toMatchObject({
      state: "apply",
      backendEvidence: {
        legacyBlobFingerprint: "legacy-sha256",
        projectionVerification: { ok: true, tableSums: "[redacted]" },
      },
    });
    expect(result.stdout[0]).not.toContain("123.45");
  });

  test("verify and skipped files have distinct states", async () => {
    const verified = await invoke(["--verify", "--json"], (functionName) => {
      if (functionName === "migrate:status") return status();
      if (functionName === "migrate:verifyFile") return verification();
      throw new Error("unexpected function");
    });
    expect(verified.document.operation.state).toBe("verify");
    expect(verified.document.files[0].state).toBe("verify");

    const skipped = await invoke(["--json"], (functionName) => {
      if (functionName === "migrate:status") {
        return status({
          files: [
            {
              file: "transactions",
              table: "transactions",
              blobPresent: false,
              blobRowCount: 0,
              blobUnreadable: false,
              migratedRowCount: 0,
            },
          ],
        });
      }
      if (functionName === "migrate:migrateFile") {
        return migrationBatch({ blobPresent: false, blobRowCount: 0, scanned: 0, inserted: 0 });
      }
      throw new Error("unexpected function");
    });
    expect(skipped.document.files[0].state).toBe("skipped");
  });

  test("argument failure still emits one failure document and exits nonzero", async () => {
    const result = await invoke(["--json", "--only"], () => {
      throw new Error("must not execute");
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toHaveLength(1);
    expect(result.document).toMatchObject({
      outcome: "failure",
      exitCode: 1,
      operation: { state: "skipped" },
      failure: { code: "INVALID_ARGUMENTS", stage: "arguments" },
    });
    expect(result.stdout[0]).not.toContain("--only");
  });
});

describe("failure evidence and exit status", () => {
  test("a plan change during dry run invalidates the evidence document", async () => {
    const result = await invoke(["--json"], (functionName) => {
      if (functionName === "migrate:status") return status();
      if (functionName === "migrate:migrateFile") {
        return migrationBatch({
          frozenPlanFingerprint: DIFFERENT_PLAN_FINGERPRINT,
        });
      }
      throw new Error("unexpected function");
    });

    expect(result.exitCode).toBe(1);
    expect(result.document).toMatchObject({
      outcome: "failure",
      failure: { code: "PLAN_FINGERPRINT_CHANGED", stage: "plan" },
      execution: {
        writeSafety: {
          classification: "none",
        },
      },
    });
  });

  test("a changed backend plan is refused before the first apply call", async () => {
    const calls: string[] = [];
    const result = await invoke([
      "--apply",
      "--expected-plan-fingerprint",
      DIFFERENT_PLAN_FINGERPRINT,
      "--json",
    ], (functionName) => {
      calls.push(functionName);
      if (functionName === "migrate:status") return status();
      throw new Error("apply must not be attempted");
    });

    expect(result.exitCode).toBe(1);
    expect(calls).toEqual(["migrate:status"]);
    expect(result.document).toMatchObject({
      outcome: "failure",
      failure: { code: "PLAN_FINGERPRINT_MISMATCH", stage: "plan" },
      execution: {
        writeSafety: {
          classification: "none",
        },
      },
    });
  });

  test("preserves completed batch evidence and classifies committed writes", async () => {
    let batch = 0;
    const result = await invoke([
      "--apply",
      "--expected-plan-fingerprint",
      PLAN_FINGERPRINT,
      "--json",
      "--batch-size",
      "1",
    ], (functionName) => {
      if (functionName === "migrate:status") return status();
      if (functionName === "migrate:migrateFile") {
        batch += 1;
        if (batch === 1) {
          return migrationBatch({
            applied: true,
            scanned: 1,
            inserted: 1,
            nextCursor: 1,
            done: false,
          });
        }
        throw new Error("child stdout contained record id secret-123 and total 999.99");
      }
      throw new Error("unexpected function");
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toHaveLength(1);
    expect(result.document).toMatchObject({
      outcome: "failure",
      files: [
        {
          file: "transactions",
          state: "failed",
          batches: [{ index: 1, state: "completed", inserted: 1 }],
          counts: { inserted: 1 },
        },
      ],
      execution: { writeSafety: { classification: "writes-completed-before-failure" } },
      failure: { code: "MIGRATION_FAILED" },
    });
    expect(result.stdout[0]).not.toContain("secret-123");
    expect(result.stdout[0]).not.toContain("999.99");
  });

  test("classifies an unobservable first apply attempt as possible", async () => {
    const result = await invoke([
      "--apply",
      "--expected-plan-fingerprint",
      PLAN_FINGERPRINT,
      "--json",
    ], (functionName) => {
      if (functionName === "migrate:status") return status();
      throw new Error("unobservable child failure");
    });

    expect(result.exitCode).toBe(1);
    expect(result.document.execution.writeSafety.classification).toBe("possible");
    expect(result.document.files[0]).toMatchObject({ state: "failed", batches: [] });
  });

  test("verification failure is nonzero and preserves completed file evidence", async () => {
    const result = await invoke([
      "--apply",
      "--expected-plan-fingerprint",
      PLAN_FINGERPRINT,
      "--json",
    ], (functionName) => {
      if (functionName === "migrate:status") return status();
      if (functionName === "migrate:migrateFile") {
        return migrationBatch({
          applied: true,
          verifiedInTransaction: true,
          verification: verification({
            ok: false,
            exactRoundTrip: false,
            problems: ["record secret-id amount 123.45 did not match"],
          }),
        });
      }
      throw new Error("unexpected function");
    });

    expect(result.exitCode).toBe(1);
    expect(result.document.files[0]).toMatchObject({
      state: "failed",
      batches: [{ state: "completed" }],
      verification: { ok: false, exactRoundTrip: false, problemCount: 1 },
    });
    expect(result.document.failure.code).toBe("VERIFICATION_FAILED");
    expect(result.stdout[0]).not.toContain("secret-id");
    expect(result.stdout[0]).not.toContain("123.45");
  });
});
