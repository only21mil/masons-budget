import assert from "node:assert/strict"
import { test } from "vitest"

import { FAMILY_MEMBERS, type FamilyMember } from "@vogel-vault/domain/family"

import { validateCsvRequest } from "../electron/csvExport.ts"
import {
  buildKnownSatsUnavailableFiatEnvelope,
  buildSanitizedFixtureEnvelope,
} from "../src/renderer/data/fixtures.ts"
import { PRICE_UNAVAILABLE } from "../src/renderer/data/bitcoinDisplay.ts"
import {
  EXPORT_DATASET_IDS,
  buildCsvExportRequest,
  buildExportDatasets,
} from "../src/renderer/pages/admin/index.tsx"

type Datasets = ReturnType<typeof buildExportDatasets>
type Dataset = Datasets[(typeof EXPORT_DATASET_IDS)[number]]

function datasetsFor(profile: FamilyMember): Datasets {
  return buildExportDatasets(profile, buildSanitizedFixtureEnvelope(profile))
}

function transactionExportWithCard(rowId: string, card: string | null): Dataset {
  const envelope = buildSanitizedFixtureEnvelope("victor")
  return buildExportDatasets("victor", {
    ...envelope,
    transactions: {
      ...envelope.transactions,
      value: envelope.transactions.value.map((row) =>
        row.id === rowId ? { ...row, card } : row,
      ),
    },
  }).transactions
}

function cell(dataset: Dataset, rowId: string, columnName: string): string {
  const idColumn = dataset.columns.indexOf(dataset.columns.includes("id") ? "id" : "key")
  const valueColumn = dataset.columns.indexOf(columnName)
  assert.notEqual(idColumn, -1, `missing stable id column in ${dataset.label}`)
  assert.notEqual(valueColumn, -1, `missing ${columnName} column in ${dataset.label}`)

  const row = dataset.rows.find((candidate) => candidate[idColumn] === rowId)
  assert.ok(row, `missing row ${rowId} in ${dataset.label}`)
  return row[valueColumn]!
}

test("Rachel exports exactly the same rows as Victor for every dataset", () => {
  const victor = datasetsFor("victor")
  const rachel = datasetsFor("rachel")

  for (const datasetId of EXPORT_DATASET_IDS) {
    assert.ok(victor[datasetId].rows.length > 0, `${datasetId} has no Victor control rows`)
    assert.deepEqual(rachel[datasetId].rows, victor[datasetId].rows, datasetId)
  }
})

test("child exports contain only that child's rows", () => {
  for (const child of ["mason", "maddox"] as const) {
    const datasets = datasetsFor(child)
    for (const datasetId of EXPORT_DATASET_IDS) {
      const dataset = datasets[datasetId]
      const ownerColumn = dataset.columns.indexOf("owner")
      assert.notEqual(ownerColumn, -1, `${datasetId} has no owner column`)
      assert.ok(
        dataset.rows.every((row) => row[ownerColumn] === child),
        `${datasetId} leaked another owner's row into ${child}'s export`,
      )
    }
  }
})

test("child positive spend is exported as negative signed USD", () => {
  const transactions = datasetsFor("mason").transactions
  assert.equal(cell(transactions, "tx-1001", "amount_usd"), "24.00")
  assert.equal(cell(transactions, "tx-1001", "direction"), "spend")
  assert.equal(cell(transactions, "tx-1001", "signed_usd"), "-24.00")
})

test("an income row exports direction=income with a positive signed_usd", () => {
  const transactions = datasetsFor("victor").transactions
  assert.equal(cell(transactions, "tx-0003", "direction"), "income")
  assert.equal(cell(transactions, "tx-0003", "signed_usd"), "2480.00")
})

test("a known payment-source wire exports its display label", () => {
  const transactions = transactionExportWithCard("tx-0001", "coinbase_card")
  assert.equal(cell(transactions, "tx-0001", "card"), "Coinbase Card")
})

test("an unknown legacy card exports byte-for-byte verbatim", () => {
  const transactions = transactionExportWithCard("tx-0001", " Legacy Card ")
  assert.equal(cell(transactions, "tx-0001", "card"), " Legacy Card ")
})

test("a missing payment source exports as On-chain", () => {
  const transactions = transactionExportWithCard("tx-0001", null)
  assert.equal(cell(transactions, "tx-0001", "card"), "On-chain")
})

test("adult bitcoin account exports exclude child stacks from net worth", () => {
  const accounts = datasetsFor("victor")["bitcoin-accounts"]
  assert.equal(cell(accounts, "coldcard", "in_net_worth"), "yes")
  assert.equal(cell(accounts, "mason-stack", "in_net_worth"), "no")
})

test("all five datasets for all four profiles pass CSV request validation", () => {
  for (const profile of FAMILY_MEMBERS) {
    const datasets = datasetsFor(profile)
    for (const datasetId of EXPORT_DATASET_IDS) {
      const dataset = datasets[datasetId]
      const validation = validateCsvRequest({
        suggestedFileName: `${profile}-${datasetId}.csv`,
        columns: dataset.columns,
        rows: dataset.rows,
      })
      assert.equal(validation.ok, true, `${profile}/${datasetId}: ${validation.ok ? "" : validation.reason}`)
    }
  }
})

test("the request the Export page hands to the bridge passes validateCsvRequest, for every profile and dataset", () => {
  // buildCsvExportRequest is the object ExportPage.runExport() passes to
  // window.vogelVault.exportCsv, so page-wiring drift fails here.
  for (const profile of FAMILY_MEMBERS) {
    const envelope = buildSanitizedFixtureEnvelope(profile)
    for (const datasetId of EXPORT_DATASET_IDS) {
      const request = buildCsvExportRequest(datasetId, profile, envelope)
      assert.equal(
        request.suggestedFileName,
        `vogel-vault-${datasetId}-${profile}-${new Date(envelope.generatedAt).toISOString().slice(0, 10)}.csv`,
      )
      assert.deepEqual(request.rows, buildExportDatasets(profile, envelope)[datasetId].rows)
      const validation = validateCsvRequest(request)
      assert.equal(validation.ok, true, `${profile}/${datasetId}: ${validation.ok ? "" : validation.reason}`)
    }
  }
})

test("money and bitcoin cells retain exact decimal text", () => {
  const datasets = datasetsFor("victor")
  assert.equal(cell(datasets.transactions, "tx-0001", "signed_usd"), "-142.18")
  assert.equal(cell(datasets.transactions, "tx-0003", "amount_usd"), "2480.00")
  assert.equal(cell(datasets["bitcoin-accounts"], "mason-stack", "btc"), "0.00120000")
})

test("bitcoin account export labels unavailable fiat instead of writing a confident zero", () => {
  const accounts = buildExportDatasets(
    "victor",
    buildKnownSatsUnavailableFiatEnvelope(),
  )["bitcoin-accounts"]

  assert.equal(
    cell(accounts, "canonical-self-custody", "fiat_usd"),
    PRICE_UNAVAILABLE,
  )
})

test("dataset column order is stable and matches the declared schema per dataset", () => {
  const datasets = datasetsFor("victor")
  assert.deepEqual(
    datasets.transactions.columns,
    ["id", "date", "merchant", "category", "card", "owner", "amount_usd", "direction", "signed_usd"],
  )
  assert.deepEqual(
    datasets["bitcoin-buys"].columns,
    ["id", "date", "source", "owner", "sats", "btc", "price_usd", "cost_usd", "status"],
  )
  assert.deepEqual(
    datasets["bitcoin-accounts"].columns,
    ["key", "label", "custody", "owner", "sats", "btc", "fiat_usd", "in_net_worth"],
  )
  assert.deepEqual(
    datasets["bill-pays"].columns,
    ["id", "date", "merchant", "category", "owner", "amount_usd", "fee_usd", "btc_spent_sats", "btc_price_usd", "platform"],
  )
  assert.deepEqual(
    datasets.todos.columns,
    ["id", "title", "owner", "project", "area", "due", "flagged", "done"],
  )
})

test("every row has exactly columns.length cells, for every dataset and every profile", () => {
  for (const profile of FAMILY_MEMBERS) {
    const datasets = datasetsFor(profile)
    for (const datasetId of EXPORT_DATASET_IDS) {
      const dataset = datasets[datasetId]
      for (const row of dataset.rows) {
        assert.equal(row.length, dataset.columns.length, `${profile}/${datasetId}`)
      }
    }
  }
})

test("row order is a pinned contract per dataset, not an accident of input order", () => {
  const ids = (dataset: Dataset): readonly string[] => dataset.rows.map((row) => row[0]!)
  const victor = datasetsFor("victor")
  assert.deepEqual(ids(victor.transactions), [
    "tx-0001", "tx-0002", "tx-0003", "tx-0004", "tx-0005", "tx-0006", "tx-0007", "tx-0008",
    "tx-0009", "tx-0010", "tx-0011", "tx-0012", "tx-1001", "tx-1002", "tx-1003", "tx-2001",
    "tx-2002", "tx-0101", "tx-0102", "tx-0103", "tx-0104", "tx-0105", "tx-1101",
  ])
  assert.deepEqual(ids(victor["bitcoin-buys"]), ["buy-0001", "buy-0002", "buy-0003", "buy-0004", "buy-0005"])
  assert.deepEqual(ids(victor["bitcoin-accounts"]), ["coldcard", "lightning", "exchange-dca", "mason-stack", "maddox-stack"])
  assert.deepEqual(ids(victor["bill-pays"]), ["pay-0001", "pay-0002"])
  assert.deepEqual(
    ids(victor.todos),
    ["todo-0001", "todo-0002", "todo-0003", "todo-0004", "todo-0005", "todo-0006", "todo-0007", "todo-0008", "todo-0009", "todo-0010"],
  )

  const mason = datasetsFor("mason")
  assert.deepEqual(ids(mason.transactions), ["tx-1001", "tx-1002", "tx-1003", "tx-1101"])
  assert.deepEqual(ids(mason["bitcoin-buys"]), ["buy-0005"])
  assert.deepEqual(ids(mason["bitcoin-accounts"]), ["mason-stack"])
  assert.deepEqual(ids(mason.todos), ["todo-0007", "todo-0008"])
})

test("Mason's export contains only Mason-owned rows and never an adult household row", () => {
  const mason = datasetsFor("mason")
  const masonTransactionIds = mason.transactions.rows.map((row) => row[0])
  // tx-0001 is Victor's, tx-0002 is Rachel's, tx-2001 is Maddox's; none belong
  // to Mason, so none may appear in his export.
  assert.ok(!masonTransactionIds.includes("tx-0001"))
  assert.ok(!masonTransactionIds.includes("tx-0002"))
  assert.ok(!masonTransactionIds.includes("tx-2001"))
  // Mason's own rows are present.
  assert.ok(masonTransactionIds.includes("tx-1001"))
  assert.ok(masonTransactionIds.includes("tx-1101"))

  // Every dataset is Mason-only, not just transactions. Bill pays live in the
  // adult-only ledger, so Mason's bill-pay export is empty rather than leaking.
  for (const datasetId of EXPORT_DATASET_IDS) {
    const dataset = mason[datasetId]
    const ownerColumn = dataset.columns.indexOf("owner")
    assert.notEqual(ownerColumn, -1, `${datasetId} has no owner column`)
    for (const row of dataset.rows) {
      assert.equal(row[ownerColumn], "mason", `${datasetId} row ${row[0]} leaked into Mason's export`)
    }
  }
  assert.equal(mason["bill-pays"].rows.length, 0)
  assert.ok(mason["bitcoin-buys"].rows.length > 0)
  assert.ok(mason["bitcoin-accounts"].rows.length > 0)
})

test("Maddox's rows are present in Maddox's export and in no other child's", () => {
  const maddox = datasetsFor("maddox")
  assert.deepEqual(maddox.transactions.rows.map((row) => row[0]), ["tx-2001", "tx-2002"])
  assert.deepEqual(maddox["bitcoin-accounts"].rows.map((row) => row[0]), ["maddox-stack"])
  assert.equal(cell(maddox.transactions, "tx-2001", "owner"), "maddox")
  assert.equal(cell(maddox["bitcoin-accounts"], "maddox-stack", "in_net_worth"), "yes")
  for (const datasetId of EXPORT_DATASET_IDS) {
    const ownerColumn = maddox[datasetId].columns.indexOf("owner")
    for (const row of maddox[datasetId].rows) {
      assert.equal(row[ownerColumn], "maddox", `${datasetId} row ${row[0]} leaked into Maddox's export`)
    }
  }

  const mason = datasetsFor("mason")
  assert.ok(!mason.transactions.rows.some((row) => row[0] === "tx-2001"), "Maddox's row leaked into Mason's export")
  assert.ok(!mason["bitcoin-accounts"].rows.some((row) => row[0] === "maddox-stack"), "Maddox's stack leaked into Mason's export")
})

test("an adult's export includes the household plus every child's rows, not just their own", () => {
  const victor = datasetsFor("victor")
  const transactionIds = victor.transactions.rows.map((row) => row[0])
  assert.ok(transactionIds.includes("tx-0001"), "missing Victor's own row")
  assert.ok(transactionIds.includes("tx-0002"), "missing Rachel's row (shared household)")
  assert.ok(transactionIds.includes("tx-1001"), "missing Mason's row")
  assert.ok(transactionIds.includes("tx-2001"), "missing Maddox's row")

  const accounts = victor["bitcoin-accounts"]
  const accountKeys = accounts.rows.map((row) => row[0])
  assert.ok(accountKeys.includes("mason-stack"), "adult export should still see Mason's stack")
  assert.ok(accountKeys.includes("maddox-stack"), "adult export should still see Maddox's stack")
})

test("sats and BTC formatting for a known bitcoin-buys fixture row", () => {
  const buys = datasetsFor("victor")["bitcoin-buys"]
  assert.equal(cell(buys, "buy-0001", "sats"), "210000")
  assert.equal(cell(buys, "buy-0001", "btc"), "0.00210000")
  assert.equal(cell(buys, "buy-0001", "price_usd"), "93500.00")
  assert.equal(cell(buys, "buy-0001", "cost_usd"), "196.35")
})

test("sats formatting for a known bitcoin-accounts fixture row (raw integer alongside 8dp BTC)", () => {
  const accounts = datasetsFor("victor")["bitcoin-accounts"]
  assert.equal(cell(accounts, "mason-stack", "sats"), "120000")
  assert.equal(cell(accounts, "mason-stack", "btc"), "0.00120000")
})
