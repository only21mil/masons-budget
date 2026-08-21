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
  PRESERVED_DOCUMENT_FILES,
  SOURCES,
  buildEvidence,
  canonicalJson,
  createAdminTableRead,
  createHttpQuery,
  createInternalQuery,
  captureFullLegacyWorld,
  captureLegacyWorld,
  checksum,
  discoverBlobCoverage,
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

const PRODUCTION_FILE_NAMES = Object.freeze([
  "transactions",
  "mason-transactions",
  "bitcoin-buys",
  "mason-bitcoin-buys",
  "bitcoin-bill-pays",
  "todos",
  "budget",
  "mason-budget",
  "btc-balance-snapshot",
  "finances",
  "son-balances",
  "income",
  "balances",
]);

function productionFixture(overrides = {}) {
  const data = Object.fromEntries(
    PRODUCTION_FILE_NAMES.map((name) => [name, []]),
  );
  data.income = Array.from({ length: 16 }, (_, index) => ({
    id: `income-${index}`,
    date: `2026-07-${String(index + 1).padStart(2, "0")}`,
    amount: index === 0 ? 1.005 : index + 0.25,
    source: index === 0 ? PRIVATE.merchant : "fixture",
    logged_by: "victor",
    note: index === 0 ? PRIVATE.note : "",
    archimedes_request_id: null,
  }));
  data.balances = {
    cashapp: 1,
    coldcard: 0.12345678,
    river: 0.00000001,
    strike: 2,
    zeus: 3,
    total: 0.12345679,
    cashapp_fiat: 1.005,
    coldcard_fiat: 2.675,
    river_fiat: 0.01,
    strike_fiat: 0,
    zeus_fiat: 0,
    total_fiat: 3.69,
    lastRefreshed: "2026-07-27T12:00:00Z",
    btc_sync: {
      anchor_balances: {
        cashapp: 1,
        coldcard: 0.12345678,
        river: 0.00000001,
        strike: 2,
        zeus: 3,
      },
      anchor_date: "2026-07-27",
      anchor_source: "fixture",
      notes: PRIVATE.note,
      reconciled_at: "2026-07-27T12:00:00Z",
      reconciled_from_events: true,
    },
  };
  return legacyFixture({
    metadata: PRODUCTION_FILE_NAMES.map((name, index) => ({
      name,
      version: index,
      updatedAt: 1700000000000 + index,
    })),
    data,
    versions: Object.fromEntries(
      PRODUCTION_FILE_NAMES.map((name, index) => [name, index]),
    ),
    ...overrides,
  });
}

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
          income: 0,
          budgetDocuments: 0,
          btcBalanceDocuments: 0,
          financeDocuments: 0,
          balanceDocuments: 0,
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
  const tableRowCount = overrides.tableRowCount ?? 0;
  const blobRowCount = overrides.blobRowCount ?? 0;
  const targetRowCounts = Object.fromEntries(
    (source.targetTables ?? [source.table]).map((table) => {
      const rows =
        table === source.table
          ? tableRowCount
          : blobRowCount === 0
            ? 0
            : source.file === "btc-balance-snapshot"
              ? 5
              : source.file === "son-balances"
                ? 3
                : 0;
      return [
        table,
        { expected: rows, stored: rows, matches: true },
      ];
    }),
  );
  return {
    file: source.file,
    table: source.table,
    ok: true,
    blobRowCount,
    tableRowCount,
    blobSums: sums,
    tableSums: { ...sums },
    exactRoundTrip: true,
    firstMismatchIndex: null,
    targetRowCounts,
    problems: [],
    ...overrides,
  };
}

function migratedRowsFor(source) {
  if (source.file === "income") return 16;
  if (
    source.file === "balances" ||
    source.file === "budget" ||
    source.file === "mason-budget" ||
    source.file === "btc-balance-snapshot" ||
    source.file === "finances" ||
    source.file === "son-balances"
  ) {
    return 1;
  }
  return 0;
}

const DOCUMENT_PUBLIC_COUNTS = Object.freeze({
  income: 16,
  balanceDocuments: 1,
  btcAccounts: 8,
  budgetDocuments: 2,
  btcBalanceDocuments: 2,
  financeDocuments: 1,
});

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

test("income and balances require every exact integer money proof", () => {
  const income = SOURCES.find((entry) => entry.file === "income");
  const balances = SOURCES.find((entry) => entry.file === "balances");
  assert.deepEqual(income, {
    file: "income",
    table: "income",
    moneyColumns: ["amountCents"],
  });
  assert.deepEqual(balances.moneyColumns, [
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
  ]);

  const incomeProof = reduceFileVerification(
    income,
    { blobPresent: true },
    reportFixture(income, { blobRowCount: 16, tableRowCount: 16 }),
  );
  const balancesProof = reduceFileVerification(
    balances,
    { blobPresent: true },
    reportFixture(balances, { blobRowCount: 1, tableRowCount: 1 }),
  );
  assert.equal(incomeProof.state, "PASS");
  assert.equal(incomeProof.moneyPassed, 1);
  assert.equal(balancesProof.state, "PASS");
  assert.equal(balancesProof.moneyPassed, 18);

  const incomplete = reportFixture(balances, {
    blobRowCount: 1,
    tableRowCount: 1,
  });
  delete incomplete.tableSums["btcSync.anchorBalancesSats.totalSats"];
  assert.equal(
    reduceFileVerification(
      balances,
      { blobPresent: true },
      incomplete,
    ).state,
    "FAIL",
  );

  const oneSatoshiShort = reportFixture(balances, {
    blobRowCount: 1,
    tableRowCount: 1,
    exactRoundTrip: false,
  });
  oneSatoshiShort.blobSums.coldcardSats = "0.12345678";
  oneSatoshiShort.tableSums.coldcardSats = "0.12345677";
  oneSatoshiShort.ok = false;
  oneSatoshiShort.problems = [
    `one satoshi mismatch ${PRIVATE.merchant} ${PRIVATE.note}`,
  ];
  const failed = reduceFileVerification(
    balances,
    { blobPresent: true },
    oneSatoshiShort,
  );
  assert.equal(failed.state, "FAIL");
  assert.equal(failed.moneyPassed, 17);
  assert.equal(failed.roundTripPassed, false);
  assert.doesNotMatch(
    JSON.stringify(failed),
    /0\.12345678|0\.12345677|MERCHANT-SENTINEL|NOTE-SENTINEL/,
  );
});

test("the five atomic sources require typed-table and derived-account proof", () => {
  assert.deepEqual(PRESERVED_DOCUMENT_FILES, []);
  const atomicFiles = [
    "budget",
    "mason-budget",
    "btc-balance-snapshot",
    "finances",
    "son-balances",
  ];
  assert.deepEqual(
    SOURCES.filter((source) => atomicFiles.includes(source.file)).map(
      (source) => source.file,
    ),
    atomicFiles,
  );

  const snapshot = SOURCES.find(
    (source) => source.file === "btc-balance-snapshot",
  );
  assert.deepEqual(snapshot.targetTables, [
    "btcBalanceDocuments",
    "btcAccounts",
  ]);
  const report = reportFixture(snapshot, {
    blobRowCount: 1,
    tableRowCount: 1,
  });
  const passed = reduceFileVerification(
    snapshot,
    { blobPresent: true },
    report,
  );
  assert.equal(passed.state, "PASS");
  assert.deepEqual(passed.targetRows, {
    btcBalanceDocuments: 1,
    btcAccounts: 5,
  });

  report.targetRowCounts.btcAccounts = {
    expected: 5,
    stored: 4,
    matches: false,
  };
  assert.equal(
    reduceFileVerification(
      snapshot,
      { blobPresent: true },
      report,
    ).state,
    "FAIL",
  );
});

test("blob discovery fails closed without retaining an unknown file name", async () => {
  const fixture = productionFixture();
  const known = await captureFullLegacyWorld(adminTableFor(fixture));
  assert.deepEqual(discoverBlobCoverage(known), {
    discovered: 13,
    covered: 13,
    unknown: 0,
    passed: true,
  });

  const unknownName = "PRIVATE-UNKNOWN-BLOB";
  const changedFixture = productionFixture({
    metadata: fixture.metadata.map((entry, index) =>
      index === 0 ? { ...entry, name: unknownName } : entry,
    ),
    data: {
      ...fixture.data,
      [unknownName]: [{ note: PRIVATE.note, amount: PRIVATE.money }],
    },
    versions: {
      ...fixture.versions,
      [unknownName]: fixture.versions.transactions,
    },
  });
  delete changedFixture.data.transactions;
  delete changedFixture.versions.transactions;
  const unknown = await captureFullLegacyWorld(adminTableFor(changedFixture));
  const coverage = discoverBlobCoverage(unknown);
  assert.deepEqual(coverage, {
    discovered: 13,
    covered: 12,
    unknown: 1,
    passed: false,
  });
  assert.doesNotMatch(
    JSON.stringify(coverage),
    /PRIVATE-UNKNOWN-BLOB|NOTE-SENTINEL|-123456\.78/,
  );
  const internalQuery = async (name, args) => {
    if (name === "migrate:status") {
      return statusFixture(
        new Set(
          SOURCES.map((source) => source.file).filter(
            (file) => file !== "transactions",
          ),
        ),
      );
    }
    const source = SOURCES.find((entry) => entry.file === args.file);
    const rows = migratedRowsFor(source);
    return reportFixture(source, {
      blobRowCount: rows,
      tableRowCount: rows,
    });
  };
  const evidence = await verifyMigration({
    query: queryFor(changedFixture, DOCUMENT_PUBLIC_COUNTS),
    internalQuery,
    adminTable: adminTableFor(changedFixture),
  });
  const output = renderEvidence(evidence);
  assert.equal(evidence.verdict, "FAILED");
  assert.match(output, /blob-coverage FAIL .*unknown=1/);
  assert.doesNotMatch(
    output,
    /PRIVATE-UNKNOWN-BLOB|NOTE-SENTINEL|-123456\.78/,
  );
  assert.equal(
    new Set([
      ...SOURCES.map((source) => source.file),
      ...PRESERVED_DOCUMENT_FILES,
    ]).size,
    SOURCES.length + PRESERVED_DOCUMENT_FILES.length,
  );
});

test("evidence requires exactly 13 blobs, unchanged legacy bytes, and full table coverage", () => {
  const dataFiles = PRODUCTION_FILE_NAMES.map((name, index) => ({
    name,
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
    blobPresent: PRODUCTION_FILE_NAMES.includes(source.file),
    blobRows: 0,
    tableRows: 0,
    moneyPassed: source.moneyColumns.length,
    moneyExpected: source.moneyColumns.length,
    rowCountPassed: true,
    roundTripPassed: true,
    passed: true,
    state: "PASS",
    targetRows: Object.fromEntries(
      (source.targetTables ?? [source.table]).map((table) => [table, 0]),
    ),
    includeInTableCoverage: source.includeInTableCoverage,
  }));
  const publicCounts = {
    transactions: 0,
    todos: 0,
    btcBuys: 0,
    btcBillPays: 0,
    income: 0,
    balanceDocuments: 0,
    btcAccounts: 0,
    budgetDocuments: 0,
    btcBalanceDocuments: 0,
    financeDocuments: 0,
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
  const fixture = productionFixture();
  const calls = [];
  const internalQuery = async (name, args) => {
    calls.push([name, args]);
    if (name === "migrate:status") {
      return statusFixture(new Set(PRODUCTION_FILE_NAMES));
    }
    const source = SOURCES.find((entry) => entry.file === args.file);
    const rows = migratedRowsFor(source);
    return reportFixture(source, {
      blobRowCount: rows,
      tableRowCount: rows,
      serverPrivate: {
        merchant: PRIVATE.merchant,
        note: PRIVATE.note,
        amount: PRIVATE.money,
        token: PRIVATE.token,
      },
    });
  };
  const evidence = await verifyMigration({
    query: queryFor(fixture, DOCUMENT_PUBLIC_COUNTS),
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
  const fixture = productionFixture({
    data: Object.fromEntries(
      PRODUCTION_FILE_NAMES.map((name) => [
        name,
        name === "balances" ? {} : [],
      ]),
    ),
  });
  const query = queryFor(fixture, { balanceDocuments: 0 });
  const internalQuery = async (name, args) => {
    if (name === "migrate:status") {
      return statusFixture(new Set(PRODUCTION_FILE_NAMES));
    }
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
