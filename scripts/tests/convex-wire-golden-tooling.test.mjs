import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  CAPTURE_FORMATS,
  CAPTURE_QUERIES,
  QUERY_SHAPE_ALGORITHM,
  assertPayloadCredentialSafe,
  captureWireGoldens,
  queryShapeDigestsFromSources,
} from "../convex-wire-golden.mjs"

const repoRoot = path.resolve(import.meta.dirname, "../..")
const token = "test-read-token-that-must-never-escape"

async function temporaryCaptureRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vogel-wire-golden-"))
  await mkdir(path.join(root, "convex"), { recursive: true })
  await mkdir(path.join(root, "shared/domain/fixtures/convex-wire-golden"), {
    recursive: true,
  })
  await writeFile(
    path.join(root, "convex/tables.ts"),
    await readFile(path.join(repoRoot, "convex/tables.ts")),
  )
  await writeFile(
    path.join(root, "convex/schema.ts"),
    await readFile(path.join(repoRoot, "convex/schema.ts")),
  )
  await writeFile(
    path.join(root, "shared/domain/convex-wire-golden-provenance.json"),
    await readFile(
      path.join(repoRoot, "shared/domain/convex-wire-golden-provenance.json"),
    ),
  )
  return root
}

test("capture requests every query in both formats and writes no credential", async () => {
  const root = await temporaryCaptureRepo()
  const requests = []
  const fetchImpl = async (endpoint, init) => {
    const request = JSON.parse(init.body)
    requests.push({ endpoint, request })
    assert.equal(request.args.token, token)
    return new Response(JSON.stringify({
      status: "success",
      value: { path: request.path, format: request.format },
    }))
  }

  const result = await captureWireGoldens({
    env: { CONVEX_READ_TOKEN: token },
    fetchImpl,
    now: new Date("2026-07-28T03:04:05.000Z"),
    repoRoot: root,
  })

  assert.equal(requests.length, CAPTURE_QUERIES.length * CAPTURE_FORMATS.length)
  assert.deepEqual(
    new Set(requests.map(({ request }) => request.format)),
    new Set(CAPTURE_FORMATS),
  )
  assert.equal(result.captureCount, 14)
  assert.equal(result.queryShapeCount, 8)

  const goldenRoot = path.join(root, "shared/domain/fixtures/convex-wire-golden")
  const captureFiles = (await readdir(goldenRoot)).sort()
  assert.equal(captureFiles.length, 14)
  const provenanceText = await readFile(
    path.join(root, "shared/domain/convex-wire-golden-provenance.json"),
    "utf8",
  )
  assert.equal(provenanceText.includes(token), false)
  const provenance = JSON.parse(provenanceText)
  assert.equal(provenance.version, 2)
  assert.equal(provenance.capturedDate, "2026-07-28")
  assert.equal(provenance.contract, undefined)
  assert.equal(provenance.queryShapes.algorithm, QUERY_SHAPE_ALGORITHM)
  assert.equal(Object.keys(provenance.queryShapes.sha256).length, 8)
  assert.equal(typeof provenance.queryShapes.sha256.listIncome, "string")

  for (const filename of captureFiles) {
    const bytes = await readFile(path.join(goldenRoot, filename))
    assert.equal(bytes.includes(Buffer.from(token)), false)
    assert.equal(
      provenance.captures[filename],
      createHash("sha256").update(bytes).digest("hex"),
    )
  }
})

test("capture refuses to run without an environment credential", async () => {
  const root = await temporaryCaptureRepo()
  let fetched = false

  await assert.rejects(
    captureWireGoldens({
      env: {},
      fetchImpl: async () => {
        fetched = true
        throw new Error("must not fetch")
      },
      repoRoot: root,
    }),
    /CONVEX_READ_TOKEN must be set in the environment/,
  )

  assert.equal(fetched, false)
  assert.deepEqual(
    await readdir(path.join(root, "shared/domain/fixtures/convex-wire-golden")),
    [],
  )
})

test("query-shape preflight fails before any production request", async () => {
  const root = await temporaryCaptureRepo()
  const tablesPath = path.join(root, "convex/tables.ts")
  const tables = await readFile(tablesPath, "utf8")
  const changed = tables.replace(
    "export const listTransactions = query({",
    "export const renamedTransactions = query({",
  )
  assert.notEqual(changed, tables)
  await writeFile(tablesPath, changed)
  let fetched = false

  await assert.rejects(
    captureWireGoldens({
      env: { CONVEX_READ_TOKEN: token },
      fetchImpl: async () => {
        fetched = true
        throw new Error("must not fetch")
      },
      repoRoot: root,
    }),
    /captured query listTransactions is not exported/,
  )

  assert.equal(fetched, false)
})

test("capture rejects credential-shaped response data before writing", async () => {
  const root = await temporaryCaptureRepo()
  let requestCount = 0

  await assert.rejects(
    captureWireGoldens({
      env: { CONVEX_READ_TOKEN: token },
      fetchImpl: async () => {
        requestCount += 1
        return new Response(JSON.stringify({
          status: "success",
          value: requestCount === 14
            ? { authorization: "Bearer definitely-a-credential" }
            : { rows: [], complete: true },
        }))
      },
      repoRoot: root,
    }),
    /credential-shaped data/,
  )

  assert.equal(requestCount, 14)
  assert.deepEqual(
    await readdir(path.join(root, "shared/domain/fixtures/convex-wire-golden")),
    [],
  )
})

test("capture sanitizes a transport error that contains the credential", async () => {
  const root = await temporaryCaptureRepo()
  await assert.rejects(
    captureWireGoldens({
      env: { CONVEX_READ_TOKEN: token },
      fetchImpl: async () => {
        throw new Error(`transport accidentally included ${token}`)
      },
      repoRoot: root,
    }),
    (error) => {
      assert.match(error.message, /request failed/)
      assert.equal(error.message.includes(token), false)
      return true
    },
  )
})

test("payload redaction detects the exact credential without echoing it", () => {
  assert.throws(
    () => assertPayloadCredentialSafe(
      Buffer.from(`{"value":"${token}"}`),
      token,
      "listTransactions.json",
    ),
    (error) => {
      assert.match(error.message, /contains the read credential/)
      assert.equal(error.message.includes(token), false)
      return true
    },
  )
})

test("query-shape digest ignores comments and unrelated schema but catches dependencies", async () => {
  const tablesSource = await readFile(path.join(repoRoot, "convex/tables.ts"), "utf8")
  const schemaSource = await readFile(path.join(repoRoot, "convex/schema.ts"), "utf8")
  const queryNames = CAPTURE_QUERIES.map(({ name }) => name)
  const baseline = queryShapeDigestsFromSources(
    { tablesSource, schemaSource },
    queryNames,
  )

  const unrelated = queryShapeDigestsFromSources(
    {
      tablesSource: `// comment-only edit\n${tablesSource}`,
      schemaSource: `${schemaSource}\nexport const unrelatedTableForAnotherLane = 1;\n`,
    },
    queryNames,
  )
  assert.deepEqual(unrelated, baseline)

  const relevantSchemaSource = schemaSource.replace(
    'v.literal("maddox"),',
    'v.literal("maddox-shape-change"),',
  )
  assert.notEqual(relevantSchemaSource, schemaSource)
  const relevant = queryShapeDigestsFromSources(
    { tablesSource, schemaSource: relevantSchemaSource },
    queryNames,
  )
  assert.notEqual(relevant.listTransactions, baseline.listTransactions)

  const relevantTablesSource = tablesSource.replace(
    'const spendAmount = row.category === "Income" ? 0n : row.amountCents;',
    'const spendAmount = row.category === "Income" ? 0n : -row.amountCents;',
  )
  assert.notEqual(relevantTablesSource, tablesSource)
  const relevantProjection = queryShapeDigestsFromSources(
    { tablesSource: relevantTablesSource, schemaSource },
    queryNames,
  )
  assert.notEqual(relevantProjection.listTransactions, baseline.listTransactions)
})
