#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  DEFAULT_URL,
  EXIT,
  SOURCES,
  buildEvidence,
  canonicalJson,
  createAdminTableRead,
  createHttpQuery,
  createInternalQuery,
  captureFullLegacyWorld,
  captureLegacyWorld,
  checksum,
  reduceFileVerification,
  renderEvidence,
  run,
  verifyMigration,
} from "../verify-migration.mjs";

const PRIVATE = Object.freeze({
  token: "READ-TOKEN-SENTINEL",
  merchant: "MERCHANT-SENTINEL",
  note: "NOTE-SENTINEL",
  money: "-123456.78",
});

function legacyFixture(overrides = {}) {
  return {
    metadata: [
      { name: "transactions", version: 41, updatedAt: 1700000000000 },
      { name: "todos", version: 7, updatedAt: 1700000000100 },
    ],
    data: {
      transactions: [
        {
          id: "tx-private",
          merchant: PRIVATE.merchant,
          amount: -123456.78,
          note: PRIVATE.note,
        },
      ],
      todos: [{ id: "todo-private", title: "PRIVATE-TITLE" }],
    },
    versions: { transactions: 41, todos: 7 },
    tombstones: [{ id: "deleted-private", deletedAt: 1699999999999 }],
    ...overrides,
  };
}

function queryFor(fixture, rowCounts = {}) {
  return async (path, args) => {
    switch (path) {
      case "dataFiles:list":
        return fixture.metadata;
      case "dataFiles:get":
        return fixture.data[args.name] ?? null;
      case "dataFiles:getVersions":
        return fixture.versions;
      case "dataFiles:listTodoTombstones":
        return fixture.tombstones;
      case "tables:rowCounts":
        return {
          transactions: 0,
          todos: 0,
          btcBuys: 0,
          btcBillPays: 0,
          btcAccounts: 0,
          ...rowCounts,
        };
      default:
        throw new Error("unexpected fixture query");
    }
  };
}

function adminTableFor(fixture) {
  return async (table) => {
    if (table === "dataFiles") {
      return fixture.metadata.map((entry, index) => ({
        _id: `data-${index}`,
        _creationTime: 1600000000000 + index,
        ...entry,
        data: fixture.data[entry.name] ?? null,
      }));
    }
    if (table === "syncVersions") {
      return Object.entries(fixture.versions).map(
        ([name, version], index) => ({
          _id: `sync-${index}`,
          _creationTime: 1600000001000 + index,
          name,
          version,
          updatedAt: 1700000001000 + index,
        }),
      );
    }
    if (table === "todoTombstones") {
      return fixture.tombstones.map((entry, index) => ({
        _id: `tomb-${index}`,
        _creationTime: 1600000002000 + index,
        ...entry,
      }));
    }
    throw new Error("unexpected fixture table");
  };
}

function statusFixture(present = new Set()) {
  return {
    files: SOURCES.map((source) => ({
      file: source.file,
      table: source.table,
      blobPresent: present.has(source.file),
      blobRowCount: 0,
      blobUnreadable: false,
      migratedRowCount: 0,
    })),
    skippedDocumentShapedFiles: [],
  };
}

function reportFixture(source, overrides = {}) {
  const sums = Object.fromEntries(
    source.moneyColumns.map((column) => [column, PRIVATE.money]),
  );
  return {
    file: source.file,
    table: source.table,
    ok: true,
    blobRowCount: 0,
    tableRowCount: 0,
    blobSums: sums,
    tableSums: { ...sums },
    exactRoundTrip: true,
    firstMismatchIndex: null,
    problems: [],
    ...overrides,
  };
}

test("canonical JSON is stable and keeps integer types distinct", () => {
  assert.equal(
    canonicalJson({ z: 2, a: [1, { y: undefined, x: 3 }] }),
    '{"a":[1,{"x":3}],"z":2}',
  );
  assert.notEqual(canonicalJson(1n), canonicalJson(1));
  assert.equal(checksum({ b: 2, a: 1 }), checksum({ a: 1, b: 2 }));
});

test("HTTP requests keep the token out of argv and child env in mode-0600 bodies", async () => {
  const workdir = mkdtempSync(resolve(tmpdir(), "verify-migration-http-test-"));
  try {
    const query = createHttpQuery({
      url: DEFAULT_URL,
      token: PRIVATE.token,
      timeout: 3,
      workdir,
      spawn: (command, argv, options) => {
        assert.equal(command, "curl");
        assert.doesNotMatch(JSON.stringify(argv), /READ-TOKEN-SENTINEL/);
        assert.equal(options.env.CONVEX_READ_TOKEN, "");

        const requestArgument = argv[argv.indexOf("--data-binary") + 1];
        const requestPath = requestArgument.slice(1);
        const responsePath = argv[argv.indexOf("--output") + 1];
        assert.equal(statSync(requestPath).mode & 0o777, 0o600);
        assert.equal(statSync(responsePath).mode & 0o777, 0o600);
        const body = JSON.parse(readFileSync(requestPath, "utf8"));
        assert.equal(body.args.token, PRIVATE.token);
        writeFileSync(responsePath, '{"status":"success","value":{"ok":true}}');
        return { status: 0, stdout: "200", stderr: "" };
      },
    });
    assert.deepEqual(await query("tables:rowCounts", {}), { ok: true });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("administrative runners allow only read surfaces", async () => {
  const calls = [];
  const spawn = (command, argv, options) => {
    calls.push({ command, argv, options });
    return { status: 0, stdout: "[]", stderr: "" };
  };
  const adminTable = createAdminTableRead({
    deployment: "prod:keen-elephant-452",
    repoRoot: "/fixture",
    spawn,
  });
  assert.deepEqual(await adminTable("dataFiles"), []);
  assert.deepEqual(calls[0].argv.slice(0, 4), [
    "--no-install",
    "convex",
    "data",
    "dataFiles",
  ]);
  assert.equal(calls[0].options.env.CONVEX_READ_TOKEN, "");
  await assert.rejects(() => adminTable("transactions"));

  const internalQuery = createInternalQuery({
    deployment: "prod:keen-elephant-452",
    repoRoot: "/fixture",
    spawn: (command, argv) => {
      calls.push({ command, argv });
      return { status: 0, stdout: "{}", stderr: "" };
    },
  });
  assert.deepEqual(await internalQuery("migrate:status", {}), {});
  await assert.rejects(() =>
    internalQuery("migrate:migrateFile", { apply: false }),
  );
  assert.equal(
    calls.filter((entry) => entry.argv.includes("migrate:migrateFile")).length,
    0,
  );
});

test("legacy snapshot covers data, dataFile versions, sync versions, and tombstones", async () => {
  const fixture = legacyFixture();
  const baseline = await captureLegacyWorld(queryFor(fixture));

  for (const changed of [
    legacyFixture({
      metadata: fixture.metadata.map((entry) =>
        entry.name === "transactions" ? { ...entry, version: 42 } : entry,
      ),
    }),
    legacyFixture({ versions: { ...fixture.versions, transactions: 42 } }),
    legacyFixture({
      tombstones: [{ ...fixture.tombstones[0], deletedAt: 1700000000001 }],
    }),
    legacyFixture({
      data: {
        ...fixture.data,
        transactions: [{ ...fixture.data.transactions[0], note: "changed" }],
      },
    }),
  ]) {
    const snapshot = await captureLegacyWorld(queryFor(changed));
    assert.notEqual(snapshot.canonical, baseline.canonical);
    assert.notEqual(snapshot.checksum, baseline.checksum);
  }
});

test("table order does not change the legacy checksum", async () => {
  const fixture = legacyFixture();
  const reversed = legacyFixture({
    metadata: [...fixture.metadata].reverse(),
    versions: { todos: 7, transactions: 41 },
    tombstones: [...fixture.tombstones].reverse(),
  });
  const left = await captureLegacyWorld(queryFor(fixture));
  const right = await captureLegacyWorld(queryFor(reversed));
  assert.equal(left.canonical, right.canonical);
});

test("full legacy snapshot includes sync updatedAt and system fields", async () => {
  const fixture = legacyFixture();
  const baseline = await captureFullLegacyWorld(adminTableFor(fixture));
  const changedAdmin = async (table) => {
    const rows = await adminTableFor(fixture)(table);
    if (table === "syncVersions") {
      rows[0] = { ...rows[0], updatedAt: rows[0].updatedAt + 1 };
    }
    return rows;
  };
  const changed = await captureFullLegacyWorld(changedAdmin);
  assert.notEqual(changed.canonical, baseline.canonical);
  assert.notEqual(changed.checksum, baseline.checksum);
});

test("sensitive backend proof reduces to counts and pass/fail", () => {
  const source = SOURCES[0];
  const reduced = reduceFileVerification(
    source,
    { blobPresent: true },
    reportFixture(source, {
      blobRowCount: 1,
      tableRowCount: 1,
      problems: [],
      privateRow: {
        merchant: PRIVATE.merchant,
        note: PRIVATE.note,
        amountCents: PRIVATE.money,
      },
    }),
  );
  const serialized = JSON.stringify(reduced);
  assert.equal(reduced.state, "PASS");
  assert.equal(reduced.moneyPassed, 1);
  assert.doesNotMatch(serialized, /MERCHANT-SENTINEL|NOTE-SENTINEL|-123456\.78/);
});

test("one unequal money column fails without retaining either total", () => {
  const source = SOURCES.find((entry) => entry.file === "bitcoin-buys");
  const report = reportFixture(source);
  report.tableSums.usdCents = "99999999.99";
  report.ok = false;
  report.problems = [
    `money differs ${PRIVATE.merchant} ${PRIVATE.note} ${PRIVATE.money}`,
  ];
  const reduced = reduceFileVerification(
    source,
    { blobPresent: true },
    report,
  );
  assert.equal(reduced.state, "FAIL");
  assert.equal(reduced.moneyPassed, 2);
  assert.doesNotMatch(
    JSON.stringify(reduced),
    /99999999\.99|MERCHANT-SENTINEL|NOTE-SENTINEL|-123456\.78/,
  );
});

test("evidence requires exactly 13 blobs, unchanged legacy bytes, and full table coverage", () => {
  const dataFiles = Array.from({ length: 13 }, (_, index) => ({
    name: `file-${index}`,
    version: index,
    updatedAt: index,
    data: [],
  }));
  const value = { dataFiles, syncVersions: [], todoTombstones: [] };
  const snapshot = {
    value,
    canonical: canonicalJson(value),
    checksum: checksum(value),
    perFile: Object.fromEntries(
      dataFiles.map((entry) => [entry.name, checksum(entry)]),
    ),
    counts: { dataFiles: 13, syncVersions: 0, todoTombstones: 0 },
  };
  const files = SOURCES.map((source) => ({
    file: source.file,
    table: source.table,
    blobPresent: false,
    blobRows: 0,
    tableRows: 0,
    moneyPassed: source.moneyColumns.length,
    moneyExpected: source.moneyColumns.length,
    rowCountPassed: true,
    roundTripPassed: true,
    passed: true,
    state: "SKIP",
  }));
  const publicCounts = {
    transactions: 0,
    todos: 0,
    btcBuys: 0,
    btcBillPays: 0,
  };
  assert.equal(
    buildEvidence({
      before: snapshot,
      after: structuredClone(snapshot),
      files,
      publicCounts,
    }).verdict,
    "VERIFIED",
  );

  const changed = structuredClone(snapshot);
  changed.value.todoTombstones.push({ id: "private", deletedAt: 1 });
  changed.canonical = canonicalJson(changed.value);
  changed.checksum = checksum(changed.value);
  assert.equal(
    buildEvidence({
      before: snapshot,
      after: changed,
      files,
      publicCounts,
    }).verdict,
    "FAILED",
  );
});

test("full verifier uses only query functions and never relays sensitive evidence", async () => {
  const fixture = legacyFixture({
    metadata: Array.from({ length: 13 }, (_, index) => ({
      name:
        index === 0
          ? "transactions"
          : index === 1
            ? "todos"
            : `document-${index}`,
      version: index,
      updatedAt: 1700000000000 + index,
    })),
    data: Object.fromEntries(
      Array.from({ length: 13 }, (_, index) => [
        index === 0
          ? "transactions"
          : index === 1
            ? "todos"
            : `document-${index}`,
        [],
      ]),
    ),
    versions: Object.fromEntries(
      Array.from({ length: 13 }, (_, index) => [
        index === 0
          ? "transactions"
          : index === 1
            ? "todos"
            : `document-${index}`,
        index,
      ]),
    ),
  });
  const calls = [];
  const internalQuery = async (name, args) => {
    calls.push([name, args]);
    if (name === "migrate:status") {
      return statusFixture(new Set(["transactions", "todos"]));
    }
    const source = SOURCES.find((entry) => entry.file === args.file);
    return reportFixture(source, {
      serverPrivate: {
        merchant: PRIVATE.merchant,
        note: PRIVATE.note,
        amount: PRIVATE.money,
        token: PRIVATE.token,
      },
    });
  };
  const evidence = await verifyMigration({
    query: queryFor(fixture),
    internalQuery,
    adminTable: adminTableFor(fixture),
  });
  const output = renderEvidence(evidence);

  assert.equal(evidence.verdict, "VERIFIED");
  assert.deepEqual(
    calls.map(([name]) => name),
    ["migrate:status", ...SOURCES.map(() => "migrate:verifyFile")],
  );
  assert.doesNotMatch(
    output,
    /READ-TOKEN-SENTINEL|MERCHANT-SENTINEL|NOTE-SENTINEL|-123456\.78/,
  );
  assert.match(output, /^VERDICT: VERIFIED/m);
});

test("CLI maps successful and failed evidence to explicit exit codes", async () => {
  const fixture = legacyFixture({
    metadata: Array.from({ length: 13 }, (_, index) => ({
      name: `document-${index}`,
      version: index,
      updatedAt: index,
    })),
    data: Object.fromEntries(
      Array.from({ length: 13 }, (_, index) => [`document-${index}`, []]),
    ),
    versions: Object.fromEntries(
      Array.from({ length: 13 }, (_, index) => [`document-${index}`, index]),
    ),
  });
  const query = queryFor(fixture);
  const internalQuery = async (name, args) => {
    if (name === "migrate:status") return statusFixture();
    const source = SOURCES.find((entry) => entry.file === args.file);
    return reportFixture(source);
  };
  let output = "";
  let errors = "";
  const code = await run(
    [],
    {
      CONVEX_URL: DEFAULT_URL,
      CONVEX_DEPLOYMENT: "prod:keen-elephant-452",
      CONVEX_READ_TOKEN: PRIVATE.token,
    },
    {
      query,
      internalQuery,
      adminTable: adminTableFor(fixture),
      out: (text) => {
        output += text;
      },
      err: (text) => {
        errors += text;
      },
    },
  );
  assert.equal(code, EXIT.VERIFIED);
  assert.equal(errors, "");
  assert.match(output, /VERDICT: VERIFIED/);
  assert.doesNotMatch(output, /READ-TOKEN-SENTINEL/);

  const noToken = await run(
    [],
    {
      CONVEX_URL: DEFAULT_URL,
      CONVEX_DEPLOYMENT: "prod:keen-elephant-452",
    },
    {
      out: () => assert.fail("no-token case must not write stdout"),
      err: (text) => {
        errors = text;
      },
    },
  );
  assert.equal(noToken, EXIT.AUTH_REJECTED);
  assert.equal(errors, "STATE: AUTH-REJECTED\n");
});
