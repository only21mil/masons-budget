#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CAPABILITY_SCHEMA,
  CONTRACT_VERSION,
  MANIFEST_SCHEMA,
  MAX_PRIVATE_BYTES,
  OperatorFailure,
  PLAN_SCHEMA,
  assertPrivateStat,
  canonicalJson,
  createAdminTransport,
  openPrivateNoFollow,
  parseArgs,
  parseCanonicalPrivate,
  readPrivateFd,
  run,
} from "../vv-ledger-batch.mjs";

const PRIVATE = Object.freeze({
  deployKey: "prod:keen-elephant-452|TOKEN-SENTINEL",
  merchant: "MERCHANT-SENTINEL",
  category: "CATEGORY-SENTINEL",
  amount: "987654321",
  reference: "REFERENCE-SENTINEL",
  id: "ID-SENTINEL",
});
const FP_A = `sha256:${"a".repeat(64)}`;
const FP_B = `sha256:${"b".repeat(64)}`;

function manifestFixture() {
  return {
    schema: MANIFEST_SCHEMA,
    batch_id: "PRIVATE-BATCH-ID",
    ops: [
      {
        op_id: "op-1",
        kind: "transaction",
        record_id: PRIVATE.id,
        source_locator: "source-1",
        owner: "victor",
        source_file: "transactions",
        date: "2026-08-01",
        merchant: PRIVATE.merchant,
        amount_cents: PRIVATE.amount,
        transaction_kind: "spend",
        category: PRIVATE.category,
        note: "NOTE-SENTINEL",
      },
      {
        op_id: "op-2",
        kind: "income",
        record_id: "income-private",
        source_locator: "source-2",
        owner: "victor",
        source_file: "income",
        date: "2026-08-01",
        amount_cents: "10000",
        source: "SOURCE-SENTINEL",
      },
      {
        op_id: "op-3",
        kind: "btc_buy",
        record_id: "buy-private",
        source_locator: "source-3",
        owner: "victor",
        source_file: "bitcoin-buys",
        date: "2026-08-01",
        source: "river",
        sats: "12345",
        price_usd_cents: "10000000",
        usd_cents: "1234",
        linked_income_op_id: "op-2",
      },
      {
        op_id: "op-4",
        kind: "btc_bill_pay",
        record_id: "bill-private",
        source_locator: "source-4",
        owner: "victor",
        source_file: "bitcoin-bill-pays",
        date: "2026-08-01",
        merchant: PRIVATE.merchant,
        category: PRIVATE.category,
        amount_usd_cents: "5000",
        btc_spent_sats: "50000",
        btc_price_cents: "10000000",
        fee_usd_cents: "0",
        reference: PRIVATE.reference,
        budget_effect: "excluded_from_transactions",
      },
    ],
  };
}

const COUNTS = Object.freeze({
  transactions: 1,
  income: 1,
  btc_buys: 1,
  btc_bill_pays: 1,
});

function checks(overrides = {}) {
  return {
    authEnforced: true,
    targetMatched: true,
    contractMatched: true,
    categoriesValid: true,
    unitsValid: true,
    datesValid: true,
    idsValid: true,
    duplicatesClear: true,
    stateMatched: true,
    ...overrides,
  };
}

function tempRoot() {
  return mkdtempSync("/tmp/vv-ledger-batch-test-");
}

function privateFile(root, name, value, mode = 0o600) {
  const path = join(root, name);
  const text = typeof value === "string" ? value : canonicalJson(value);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
}

function openRead(path) {
  return openSync(path, constants.O_RDONLY);
}

function openOutput(path) {
  writeFileSync(path, "", { mode: 0o600 });
  chmodSync(path, 0o600);
  return openSync(path, constants.O_WRONLY);
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof OperatorFailure, true);
    assert.equal(error.code, code);
    return true;
  });
}

function safeText(value) {
  return canonicalJson(value);
}

test("fstat accepts only owner-private regular files", () => {
  const root = tempRoot();
  try {
    const path = privateFile(root, "private.json", manifestFixture());
    const fd = openRead(path);
    assert.doesNotThrow(() => assertPrivateStat(fstatSync(fd)));
    closeSync(fd);

    chmodSync(path, 0o640);
    const openFd = openRead(path);
    expectCode(() => assertPrivateStat(fstatSync(openFd)), "FD_MODE_TOO_OPEN");
    closeSync(openFd);

    const realFd = openRead(path);
    const real = fstatSync(realFd);
    expectCode(
      () =>
        assertPrivateStat({
          ...real,
          uid: typeof process.getuid === "function" ? process.getuid() + 1 : 1,
          isFile: () => true,
        }),
      "FD_WRONG_OWNER",
    );
    closeSync(realFd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maintained pathname opener rejects symlinks with O_NOFOLLOW", () => {
  const root = tempRoot();
  try {
    const target = privateFile(root, "target.json", manifestFixture());
    const link = join(root, "link.json");
    symlinkSync(target, link);
    expectCode(() => openPrivateNoFollow(link), "PRIVATE_OPEN_REJECTED");
    const fd = openPrivateNoFollow(target);
    assert.equal(readPrivateFd(fd), canonicalJson(manifestFixture()));
    closeSync(fd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fd reader rejects FIFO and oversized input", () => {
  const root = tempRoot();
  try {
    const fifo = join(root, "private.fifo");
    const made = spawnSync("mkfifo", [fifo]);
    assert.equal(made.status, 0);
    chmodSync(fifo, 0o600);
    const fifoFd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    expectCode(() => readPrivateFd(fifoFd), "FD_NOT_REGULAR");
    closeSync(fifoFd);

    const huge = privateFile(root, "huge.json", "x");
    truncateSync(huge, MAX_PRIVATE_BYTES + 1);
    const hugeFd = openRead(huge);
    expectCode(() => readPrivateFd(hugeFd), "FD_TOO_LARGE");
    closeSync(hugeFd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical parser rejects formatting variants and duplicate keys", () => {
  const manifest = manifestFixture();
  assert.deepEqual(
    parseCanonicalPrivate(canonicalJson(manifest), MANIFEST_SCHEMA),
    manifest,
  );
  expectCode(
    () => parseCanonicalPrivate(`${JSON.stringify(manifest, null, 2)}\n`, MANIFEST_SCHEMA),
    "NON_CANONICAL_JSON",
  );
  expectCode(
    () =>
      parseCanonicalPrivate(
        `{"batch_id":"x","ops":[],"schema":"${MANIFEST_SCHEMA}","schema":"${MANIFEST_SCHEMA}"}\n`,
        MANIFEST_SCHEMA,
      ),
    "NON_CANONICAL_JSON",
  );
});

test("argv accepts only commands and numeric non-stdio fd flags", () => {
  assert.deepEqual(parseArgs(["validate", "--manifest-fd", "3"]), {
    command: "validate",
    manifestFd: 3,
    planFd: null,
    capabilityFd: null,
  });
  for (const argv of [
    ["validate", "--manifest-fd", "0"],
    ["dry-run", "--url", "https://private.invalid"],
    ["apply", "--token", PRIVATE.deployKey],
    ["apply", "--function", "operatorImport:applyBatch"],
    ["apply", PRIVATE.merchant],
  ]) {
    assert.throws(() => parseArgs(argv), OperatorFailure);
  }
});

test("admin transport rejects missing, non-production, and wrong deployment keys before SDK use", async () => {
  for (const env of [
    {},
    { CONVEX_DEPLOY_KEY: "dev:keen-elephant-452|secret" },
    { CONVEX_DEPLOY_KEY: "prod:wrong-deployment|secret" },
    { CONVEX_DEPLOY_KEY: "project:team:project|secret" },
  ]) {
    await assert.rejects(createAdminTransport(env), OperatorFailure);
  }
});

test("validate emits structural evidence without private manifest data", async () => {
  const root = tempRoot();
  try {
    const fd = openRead(privateFile(root, "manifest.json", manifestFixture()));
    const result = await run(["validate", "--manifest-fd", String(fd)]);
    closeSync(fd);
    assert.deepEqual(result.counts, COUNTS);
    const output = safeText(result);
    for (const sentinel of Object.values(PRIVATE)) {
      assert.equal(output.includes(sentinel), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real CLI keeps private argv and output boundaries", () => {
  const root = tempRoot();
  try {
    const fd = openRead(privateFile(root, "manifest.json", manifestFixture()));
    const cli = new URL("../vv-ledger-batch.mjs", import.meta.url);
    const argv = [cli.pathname, "validate", "--manifest-fd", "3"];
    const result = spawnSync(process.execPath, argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", fd],
    });
    closeSync(fd);
    assert.equal(result.status, 0);
    const combined = `${result.stdout}\n${result.stderr}\n${JSON.stringify(argv)}`;
    for (const sentinel of Object.values(PRIVATE)) {
      assert.equal(combined.includes(sentinel), false);
    }
    assert.equal(argv.includes("--manifest-fd"), true);
    assert.equal(argv.includes("3"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run sends rows in memory, writes private plan, and redacts output", async () => {
  const root = tempRoot();
  try {
    const manifest = manifestFixture();
    const manifestFd = openRead(privateFile(root, "manifest.json", manifest));
    const planPath = join(root, "plan.json");
    const planFd = openOutput(planPath);
    let observed;
    const transportFactory = async (env) => {
      assert.equal(env.CONVEX_DEPLOY_KEY, PRIVATE.deployKey);
      return {
        preflight: async (args) => {
          observed = args;
          return {
            contract_version: CONTRACT_VERSION,
            outcome: "ready",
            counts: COUNTS,
            checks: checks(),
            plan_fingerprint: FP_A,
            state_fingerprint: FP_B,
          };
        },
      };
    };
    const result = await run(
      ["dry-run", "--manifest-fd", String(manifestFd), "--plan-fd", String(planFd)],
      { env: { CONVEX_DEPLOY_KEY: PRIVATE.deployKey }, transportFactory },
    );
    closeSync(manifestFd);
    closeSync(planFd);
    assert.deepEqual(observed, { manifest });
    const planText = readFileSync(planPath, "utf8");
    assert.equal(planText.includes(FP_A), true);
    assert.equal(planText.includes(PRIVATE.merchant), false);
    const output = safeText(result);
    for (const sentinel of Object.values(PRIVATE)) {
      assert.equal(output.includes(sentinel), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply requires fd-only plan and unexpired matching capability", async () => {
  const root = tempRoot();
  try {
    const manifestText = canonicalJson(manifestFixture());
    const digest = `sha256:${await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(manifestText).digest("hex"))}`;
    const plan = {
      schema: PLAN_SCHEMA,
      version: CONTRACT_VERSION,
      manifest_sha256: digest,
      plan_fingerprint: FP_A,
      state_fingerprint: FP_B,
      counts: COUNTS,
      checks: checks(),
    };
    const capability = {
      schema: CAPABILITY_SCHEMA,
      version: CONTRACT_VERSION,
      manifest_sha256: digest,
      plan_fingerprint: FP_A,
      state_fingerprint: FP_B,
      approved: true,
      expires_at: "2030-01-01T00:00:00.000Z",
    };
    const manifestFd = openRead(privateFile(root, "manifest.json", manifestText));
    const planFd = openRead(privateFile(root, "plan.json", plan));
    const capabilityFd = openRead(privateFile(root, "capability.json", capability));
    let observed;
    const result = await run(
      [
        "apply",
        "--manifest-fd",
        String(manifestFd),
        "--plan-fd",
        String(planFd),
        "--capability-fd",
        String(capabilityFd),
      ],
      {
        now: () => Date.parse("2029-01-01T00:00:00.000Z"),
        transportFactory: async () => ({
          apply: async (args) => {
            observed = args;
            return {
              contract_version: CONTRACT_VERSION,
              outcome: "applied",
              counts: COUNTS,
              checks: checks({ planMatched: true, receiptRecorded: true }),
            };
          },
        }),
      },
    );
    for (const fd of [manifestFd, planFd, capabilityFd]) closeSync(fd);
    assert.deepEqual(observed, {
      manifest: manifestFixture(),
      expected_plan_fingerprint: FP_A,
      expected_state_fingerprint: FP_B,
    });
    assert.equal(result.outcome, "applied");
    assert.equal(result.writes, "completed");
    const output = safeText(result);
    assert.equal(output.includes(FP_A), false);
    assert.equal(output.includes(PRIVATE.merchant), false);

    const expiredFd = openRead(
      privateFile(root, "expired.json", {
        ...capability,
        expires_at: "2020-01-01T00:00:00.000Z",
      }),
    );
    const manifestFd2 = openRead(privateFile(root, "manifest2.json", manifestText));
    const planFd2 = openRead(privateFile(root, "plan2.json", plan));
    await assert.rejects(
      run(
        [
          "apply",
          "--manifest-fd",
          String(manifestFd2),
          "--plan-fd",
          String(planFd2),
          "--capability-fd",
          String(expiredFd),
        ],
        { now: () => Date.parse("2029-01-01T00:00:00.000Z") },
      ),
      (error) => error instanceof OperatorFailure && error.code === "CAPABILITY_EXPIRED",
    );
    for (const fd of [expiredFd, manifestFd2, planFd2]) closeSync(fd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readback revalidates the private manifest and emits booleans/counts", async () => {
  const root = tempRoot();
  try {
    const manifest = manifestFixture();
    const manifestText = canonicalJson(manifest);
    const manifestSha256 = `sha256:${createHash("sha256").update(manifestText).digest("hex")}`;
    const plan = {
      schema: PLAN_SCHEMA,
      version: CONTRACT_VERSION,
      manifest_sha256: manifestSha256,
      plan_fingerprint: FP_A,
      state_fingerprint: FP_B,
      counts: COUNTS,
      checks: checks(),
    };
    const manifestFd = openRead(privateFile(root, "manifest.json", manifest));
    const planFd = openRead(privateFile(root, "plan.json", plan));
    let observed;
    const result = await run([
      "readback",
      "--manifest-fd",
      String(manifestFd),
      "--plan-fd",
      String(planFd),
    ], {
      transportFactory: async () => ({
        readback: async (args) => {
          observed = args;
          return {
            contract_version: CONTRACT_VERSION,
            outcome: "verified",
            counts: COUNTS,
            checks: checks({
              rowsMatched: true,
              aggregatesMatched: true,
              untouchedMatched: true,
            }),
          };
        },
      }),
    });
    closeSync(manifestFd);
    closeSync(planFd);
    assert.deepEqual(observed, {
      manifest,
      expected_plan_fingerprint: FP_A,
    });
    assert.equal(result.outcome, "verified");
    assert.equal(safeText(result).includes(FP_A), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
