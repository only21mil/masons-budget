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
