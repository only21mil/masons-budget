#!/usr/bin/env node

// Regenerates the synthetic Convex wire golden fixtures in
// shared/domain/fixtures/convex-wire-golden/ and refreshes the capture
// checksums in shared/domain/convex-wire-golden-provenance.json.
//
// These fixtures exist to pin the exact Convex HTTP wire shapes the clients
// decode (one file per tables:* query per format). They are SYNTHETIC: stable
// IDs, round-dollar amounts, generic names, no production household data. The
// 2099 dates and sample-* IDs are deliberate production-shape markers.
//
// The companion guard scripts/check-convex-wire-golden-synthetic.mjs fails CI
// if the committed fixtures ever drift back toward production-shaped values.

import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const goldenRoot = path.join(repoRoot, "shared/domain/fixtures/convex-wire-golden")
const provenancePath = path.join(repoRoot, "shared/domain/convex-wire-golden-provenance.json")

export const FORMATS = Object.freeze(["json", "convex_encoded_json"])
export const QUERIES = Object.freeze([
  "getBudgetDocument",
  "listBtcAccounts",
  "listBtcBillPays",
  "listBtcBuys",
  "listTodos",
  "listTransactions",
  "rowCounts",
])

const SYNTHETIC_TIMESTAMP_MS = 1_700_000_000_000
const SYNTHETIC_PRICE_USD_CENTS = "500000"
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

function isoDate(day) {
  return day.toISOString().slice(0, 10)
}

function monthKey(day) {
  return day.toISOString().slice(0, 7)
}

function displayMonth(index1Based) {
  const monthIndex = (index1Based - 1) % 12
  const year = 2099 + Math.floor((index1Based - 1) / 12)
  return `${MONTH_NAMES[monthIndex]} ${year}`
}

function synthPaycheck(index) {
  const day = new Date(`2098-05-08T00:00:00.000Z`)
  day.setUTCDate(day.getUTCDate() + (index - 1) * 7)
  return {
    amountCents: "200000",
    date: isoDate(day),
    netCents: "150000",
    note: `Synthetic weekly paycheck fixture row ${index}`,
    platform: "Sample",
    source: "Payroll",
  }
}

const budgetDocument = {
  complete: true,
  document: {
    categories: [
      "🛠", "🏠", "🍔", "🚗", "🎉", "💊", "🐾", "🎁",
    ].map((icon, index) => ({
      budgetCents: String((8 - index) * 50000),
      icon,
      name: `Sample Category ${index + 1}`,
    })),
    coinbaseOneBalanceCents: "0",
    income: {
      monthlyGrossCents: "800000",
      mtdIncomeCents: "0",
      payFrequency: "weekly",
      paychecks: Array.from({ length: 60 }, (_, index) => synthPaycheck(index + 1)),
      weeklyGrossCents: "200000",
      weeklyRiverCents: "0",
      weeklyStrikeCents: "0",
      ytdIncomeCents: "9600000",
    },
    month: displayMonth(6),
    monthlyHistory: [1, 2, 3, 4, 5].map((index) => ({
      expensesCents: "600000",
      incomeCents: "800000",
      month: displayMonth(index),
      savingsBps: "2500",
    })),
    mtdIncomeCents: "0",
    owner: "victor",
    updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    ytdIncomeCents: "9600000",
  },
}

const btcAccounts = {
  complete: false,
  rows: [
    {
      asOf: "2099-01-01",
      custody: "self_custody",
      fiatCents: "0",
      key: "sample-account-01",
      label: "Sample Cold Storage",
      owner: "mason",
      sats: "100000000",
      schemaVersion: "1",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    },
    {
      asOf: "2099-01-01",
      custody: "self_custody",
      fiatCents: "0",
      key: "sample-account-02",
      label: "Sample Savings",
      owner: "victor",
      sats: "200000000",
      schemaVersion: "1",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    },
    {
      asOf: "2099-01-01",
      custody: "exchange",
      fiatCents: "0",
      key: "sample-account-03",
      label: "Sample Exchange",
      owner: "rachel",
      sats: "50000000",
      schemaVersion: "1",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    },
  ],
}

const btcBillPays = {
  complete: false,
  rows: [
    {
      amountUsdCents: "120000",
      billPayId: "sample-billpay-000000001",
      btcPriceCents: SYNTHETIC_PRICE_USD_CENTS,
      btcSpentSats: "24000000",
      budgetEffect: "credit_card_payment",
      category: "Credit Card Payment",
      date: "2099-01-10",
      feeUsdCents: "0",
      merchant: "Example Merchant",
      month: "2099-01",
      note: "Synthetic bill pay fixture row 1",
      owner: "victor",
      platform: "Sample",
      reference: "sample-ref-000001",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    },
    {
      amountUsdCents: "300000",
      billPayId: "sample-billpay-000000002",
      btcPriceCents: SYNTHETIC_PRICE_USD_CENTS,
      btcSpentSats: "60000000",
      budgetEffect: "budget_category",
      category: "Sample Category D",
      date: "2099-01-11",
      feeUsdCents: "0",
      merchant: "Example Merchant Two",
      month: "2099-01",
      note: "Synthetic bill pay fixture row 2",
      owner: "rachel",
      platform: "Sample",
      reference: "sample-ref-000002",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    },
    {
      amountUsdCents: "150000",
      billPayId: "sample-billpay-000000003",
      btcPriceCents: SYNTHETIC_PRICE_USD_CENTS,
      btcSpentSats: "30000000",
      budgetEffect: "budget_category",
      category: "Sample Category E",
      date: "2099-01-12",
      feeUsdCents: "0",
      merchant: "Example Merchant Three",
      month: "2099-01",
      note: "Synthetic bill pay fixture row 3",
      owner: "victor",
      platform: "Sample",
      reference: "sample-ref-000003",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    },
  ],
}

const btcBuys = {
  complete: false,
  rows: [
    {
      archimedesRequestId: "sample-req-000001",
      buyId: "sample-buy-0000000001",
      costBasisStatus: "sample",
      date: "2099-01-05",
      month: "2099-01",
      owner: "victor",
      priceUsdCents: SYNTHETIC_PRICE_USD_CENTS,
      sats: "100000",
      source: "Sample",
      status: "sample",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
      usdCents: "500000",
    },
    {
      archimedesRequestId: "sample-req-000002",
      buyId: "sample-buy-0000000002",
      costBasisStatus: "sample",
      date: "2099-01-06",
      month: "2099-01",
      owner: "rachel",
      priceUsdCents: SYNTHETIC_PRICE_USD_CENTS,
      sats: "200000",
      source: "Sample",
      status: "sample",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
      usdCents: "1000000",
    },
    {
      archimedesRequestId: "sample-req-000003",
      buyId: "sample-buy-0000000003",
      costBasisStatus: "sample",
      date: "2099-01-07",
      month: "2099-01",
      owner: "mason",
      priceUsdCents: SYNTHETIC_PRICE_USD_CENTS,
      sats: "50000",
      source: "Sample",
      status: "sample",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
      usdCents: "250000",
    },
  ],
}

const todos = {
  complete: false,
  rows: [
    {
      completedAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2099-01-01T00:00:00.000Z",
      done: true,
      flagged: false,
      lane: "home",
      owner: "victor",
      priority: "0",
      project: "Sample",
      title: "Sample task one",
      todoId: "00000000-0000-4000-8000-000000000001",
      updatedAt: "2099-01-01T00:00:00.000Z",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    },
    {
      completedAt: "2099-01-02T00:00:00.000Z",
      createdAt: "2099-01-02T00:00:00.000Z",
      done: false,
      flagged: true,
      lane: "work",
      owner: "victor",
      priority: "1",
      project: "Sample",
      title: "Sample task two",
      todoId: "00000000-0000-4000-8000-000000000002",
      updatedAt: "2099-01-02T00:00:00.000Z",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    },
    {
      completedAt: "2099-01-03T00:00:00.000Z",
      createdAt: "2099-01-03T00:00:00.000Z",
      done: false,
      flagged: false,
      lane: "home",
      owner: "victor",
      priority: "2",
      project: "Sample",
      title: "Sample task three",
      todoId: "00000000-0000-4000-8000-000000000003",
      updatedAt: "2099-01-03T00:00:00.000Z",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    },
  ],
}

const transactions = {
  complete: false,
  rows: [
    {
      amountCents: "1000",
      card: "0000",
      category: "Sample Category A",
      date: "2099-01-02",
      displaySpendAmount: "1000",
      hasOppositeSpendSign: false,
      merchant: "Sample Merchant One",
      month: "2099-01",
      note: "Synthetic transaction fixture row 1",
      owner: "victor",
      spendAmount: "1000",
      txId: "synthetic-tx-0000000001",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    },
    {
      amountCents: "250000",
      card: "0000",
      category: "Sample Category B",
      date: "2099-01-03",
      displaySpendAmount: "250000",
      hasOppositeSpendSign: false,
      merchant: "Sample Merchant Two",
      month: "2099-01",
      note: "Synthetic transaction fixture row 2",
      owner: "rachel",
      spendAmount: "250000",
      txId: "synthetic-tx-0000000002",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    },
    {
      amountCents: "500",
      card: "0000",
      category: "Sample Category C",
      date: "2099-01-04",
      displaySpendAmount: "500",
      hasOppositeSpendSign: false,
      merchant: "Sample Merchant Three",
      month: "2099-01",
      note: "Synthetic transaction fixture row 3",
      owner: "mason",
      spendAmount: "500",
      txId: "synthetic-tx-0000000003",
      updatedAtMs: SYNTHETIC_TIMESTAMP_MS,
    },
  ],
}

const rowCounts = {
  balanceDocuments: 1,
  btcAccounts: 3,
  btcBalanceDocuments: 1,
  btcBillPays: 5,
  btcBuys: 5,
  btcTransfers: 0,
  budgetDocuments: 1,
  financeDocuments: 1,
  income: 2,
  todos: 3,
  transactions: 10,
}

export const SYNTHETIC_DOCUMENTS = Object.freeze({
  getBudgetDocument: budgetDocument,
  listBtcAccounts: btcAccounts,
  listBtcBillPays: btcBillPays,
  listBtcBuys: btcBuys,
  listTodos: todos,
  listTransactions: transactions,
  rowCounts,
})

// Fields carried on the wire as tagged v.int64() in convex_encoded_json format
// and as decimal strings in json format. Everything else is unchanged between
// formats (v.float64 updatedAtMs stays a plain number; counts stay numbers).
function isInt64Field(key) {
  return key.endsWith("Cents")
    || key === "sats"
    || key === "btcSpentSats"
    || key === "spendAmount"
    || key === "displaySpendAmount"
    || key === "schemaVersion"
    || key === "priority"
    || key === "savingsBps"
}

function encodeInt64(decimalString) {
  const value = BigInt(decimalString)
  if (
    value < -(2n ** 63n) || value >= 2n ** 63n
    || decimalString !== value.toString()
  ) {
    throw new Error(`not a canonical int64 decimal string: ${decimalString}`)
  }
  const bytes = new Uint8Array(8)
  let remaining = value
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return Buffer.from(bytes).toString("base64")
}

function toEncoded(value, key) {
  if (Array.isArray(value)) return value.map((entry) => toEncoded(entry, key))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        toEncoded(childValue, childKey),
      ]),
    )
  }
  if (isInt64Field(key) && typeof value === "string") {
    return { $integer: encodeInt64(value) }
  }
  return value
}

function sortedKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortedKeysDeep)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortedKeysDeep(value[key])]),
    )
  }
  return value
}

export function wireFiles() {
  const files = []
  for (const query of QUERIES) {
    const wire = { status: "success", value: SYNTHETIC_DOCUMENTS[query] }
    files.push([`${query}.json.json`, sortedKeysDeep(wire)])
    files.push([`${query}.convex_encoded_json.json`, sortedKeysDeep(toEncoded(wire))])
  }
  return files
}

function serialise(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export async function writeWireFixtures({ repoRoot: root = repoRoot, now = new Date() } = {}) {
  const writes = []
  const checksums = {}
  for (const [filename, document] of wireFiles()) {
    const bytes = Buffer.from(serialise(document), "utf8")
    writes.push([path.join(goldenRoot, filename), bytes])
    checksums[filename] = createHash("sha256").update(bytes).digest("hex")
  }
  const provenanceBytes = Buffer.from(
    await readFile(path.join(root, "shared/domain/convex-wire-golden-provenance.json"), "utf8"),
  )
  const provenance = JSON.parse(provenanceBytes.toString("utf8"))
  if (provenance.version !== 3 || provenance.origin !== "synthetic") {
    throw new Error(
      "provenance is not synthetic (version 3); refusing to refresh it with generated fixtures",
    )
  }
  provenance.generatedDate = now.toISOString().slice(0, 10)
  provenance.captures = Object.fromEntries(
    Object.entries(checksums).sort(([left], [right]) => left.localeCompare(right)),
  )
  writes.push([provenancePath, Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`)])
  for (const [target, bytes] of writes) {
    await writeFile(target, bytes)
  }
  return checksums
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const checksums = await writeWireFixtures()
  process.stdout.write(
    `Wrote ${Object.keys(checksums).length} synthetic wire fixtures and refreshed provenance checksums.\n`,
  )
}
