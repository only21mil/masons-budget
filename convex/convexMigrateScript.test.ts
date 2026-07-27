// Tests for scripts/convex-migrate.mjs.
//
// Lives under convex/ because that is where the repo's vitest config points and
// where `npm run convex:test` looks; the script's pure helpers are exported
// precisely so they can be checked here without spawning a CLI or touching a
// deployment. The module deliberately keeps `node:child_process` behind a lazy
// import so this file can load it inside the edge-runtime VM.

import { describe, expect, test } from "vitest";

import {
  DEFAULT_BATCH_SIZE,
  formatPlanLine,
  formatVerificationLine,
  parseArgs,
  summarise,
} from "../scripts/convex-migrate.mjs";

function ok(file: string) {
  return {
    file,
    table: "transactions",
    applied: true,
    skipped: false,
    inserted: 905,
    updated: 0,
    unchanged: 0,
    blobRowCount: 905,
    verification: {
      ok: true,
      exactRoundTrip: true,
      problems: [],
      tableRowCount: 905,
      blobRowCount: 905,
      tableSums: { amountCents: "-123456.78" },
      blobSums: { amountCents: "-123456.78" },
    },
  };
}

describe("the write gate", () => {
  test("dry run is the default", () => {
    const options = parseArgs([]);
    expect(options.apply).toBe(false);
    expect(options.prod).toBe(false);
    expect(options.batchSize).toBe(DEFAULT_BATCH_SIZE);
  });

  test("--apply alone writes only to the dev deployment", () => {
    expect(parseArgs(["--apply"])).toMatchObject({ apply: true, prod: false });
  });

  test("writing to production needs the confirmation spelled out", () => {
    // Two extra words between a dry run and rewriting the only copy of the
    // family's financial record.
    expect(() => parseArgs(["--apply", "--prod"])).toThrow(/--confirm-production/);
    expect(parseArgs(["--apply", "--prod", "--confirm-production"])).toMatchObject({
      apply: true,
      prod: true,
      confirmProduction: true,
    });
  });

  test("a dry run against production needs no confirmation", () => {
    expect(parseArgs(["--prod"])).toMatchObject({ apply: false, prod: true });
  });

  test("a stray confirmation flag is an error, not a no-op", () => {
    expect(() => parseArgs(["--confirm-production"])).toThrow(/only means something with --prod/);
  });

  test("--verify never writes", () => {
    expect(() => parseArgs(["--verify", "--apply"])).toThrow(/does not write/);
    expect(parseArgs(["--verify"])).toMatchObject({ verifyOnly: true, apply: false });
  });
});

describe("argument parsing", () => {
  test("--only is repeatable in both spellings", () => {
    expect(parseArgs(["--only", "transactions", "--only=todos"]).only).toEqual([
      "transactions",
      "todos",
    ]);
  });

  test("a bad batch size is refused", () => {
    expect(() => parseArgs(["--batch-size", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--batch-size", "1.5"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--batch-size", "nope"])).toThrow(/positive integer/);
    expect(parseArgs(["--batch-size=250"]).batchSize).toBe(250);
  });

  test("an unknown flag stops the run rather than being ignored", () => {
    expect(() => parseArgs(["--force"])).toThrow(/Unknown argument/);
  });

  test("--only with no value is refused", () => {
    expect(() => parseArgs(["--only"])).toThrow(/--only needs a file name/);
  });
});

describe("summarise", () => {
  test("all verified is a pass", () => {
    const summary = summarise([ok("transactions"), ok("todos")]);
    expect(summary.ok).toBe(true);
    expect(summary.inserted).toBe(1810);
  });

  test("a file that was never verified is a failure, not a pass", () => {
    // "we did not check" must never read as "it is fine".
    const summary = summarise([{ ...ok("transactions"), verification: null }]);
    expect(summary.ok).toBe(false);
    expect(summary.failures[0]).toContain("never verified");
  });

  test("a failed verification carries its reason through", () => {
    const bad = ok("transactions");
    bad.verification = { ...bad.verification, ok: false, problems: ["row count 904 does not match 905"] };
    const summary = summarise([bad]);
    expect(summary.ok).toBe(false);
    expect(summary.failures[0]).toContain("row count 904");
  });

  test("counts and sums passing is not enough without an exact round trip", () => {
    const partial = ok("transactions");
    partial.verification = { ...partial.verification, exactRoundTrip: false };
    const summary = summarise([partial]);
    expect(summary.ok).toBe(false);
    expect(summary.failures[0]).toContain("did not round-trip");
  });

  test("a file with no blob is skipped rather than failed", () => {
    const skipped = { ...ok("maddox-transactions"), skipped: true, inserted: 0, verification: null };
    expect(summarise([skipped]).ok).toBe(true);
  });
});

describe("reporting", () => {
  test("a dry run says 'would write'", () => {
    const line = formatPlanLine({ ...ok("transactions"), applied: false });
    expect(line).toContain("would write 905 new");
    expect(line).not.toContain("wrote 905");
  });

  test("an unrun verification is reported as NOT RUN, never as blank", () => {
    expect(formatVerificationLine(null)).toContain("NOT RUN");
  });

  test("a dry run says the check is deferred rather than failed", () => {
    // Verifying after a dry run would describe the tables as they already are;
    // printing that under a plan reads as "the plan failed".
    expect(formatVerificationLine(null, true)).toContain("deferred");
    expect(formatVerificationLine(null, true)).not.toContain("NOT RUN");
  });

  test("sums are printed as exact decimal text", () => {
    const line = formatVerificationLine(ok("transactions").verification);
    expect(line).toContain("OK");
    expect(line).toContain("amountCents=-123456.78");
    expect(line).toContain("round-trip exact");
  });
});
