import assert from "node:assert/strict"
import { test } from "vitest"

import { FAMILY_MEMBERS, type FamilyMember } from "@vogel-vault/domain/family"

import { validateCsvRequest } from "../electron/csvExport.ts"
import {
  buildKnownSatsUnavailableFiatEnvelope,
  buildSanitizedFixtureEnvelope,
} from "../src/renderer/data/fixtures.ts"
import { PRICE_UNAVAILABLE } from "../src/renderer/data/bitcoinDisplay.ts"
import { EXPORT_DATASET_IDS, buildExportDatasets } from "../src/renderer/pages/admin/index.tsx"

type Datasets = ReturnType<typeof buildExportDatasets>
type Dataset = Datasets[(typeof EXPORT_DATASET_IDS)[number]]

function datasetsFor(profile: FamilyMember): Datasets {
  return buildExportDatasets(profile, buildSanitizedFixtureEnvelope(profile))
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

test("the exact request shape the admin Export page sends passes validateCsvRequest, for every profile and dataset", () => {
  // Mirrors pages/admin/index.tsx's ExportPage.runExport() exactly: it calls
  // exporter({ suggestedFileName: exportFileName(datasetId, activeProfile,
  // data.generatedAt), columns: dataset.columns, rows: dataset.rows }), and
  // the private exportFileName() builds
  // `vogel-vault-${dataset}-${viewer}-${isoDate}.csv` from the same envelope
  // clock the page reads off useAppState(). Reproduced here (exportFileName
  // is not exported) rather than the placeholder file name the acceptance
  // loop above used.
  for (const profile of FAMILY_MEMBERS) {
    const envelope = buildSanitizedFixtureEnvelope(profile)
    const datasets = buildExportDatasets(profile, envelope)
    for (const datasetId of EXPORT_DATASET_IDS) {
      const dataset = datasets[datasetId]
      const suggestedFileName =
        `vogel-vault-${datasetId}-${profile}-${new Date(envelope.generatedAt).toISOString().slice(0, 10)}.csv`
      const validation = validateCsvRequest({
        suggestedFileName,
        columns: dataset.columns,
        rows: dataset.rows,
      })
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

test("row ordering is deterministic across two independent builds", () => {
  for (const profile of FAMILY_MEMBERS) {
    const first = buildExportDatasets(profile, buildSanitizedFixtureEnvelope(profile))
    const second = buildExportDatasets(profile, buildSanitizedFixtureEnvelope(profile))
    for (const datasetId of EXPORT_DATASET_IDS) {
      assert.deepEqual(second[datasetId].rows, first[datasetId].rows, `${profile}/${datasetId}`)
    }
  }
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
