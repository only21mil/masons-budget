import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  CAPTURE_FORMATS,
  CAPTURE_QUERIES,
  assertPayloadCredentialSafe,
  captureContractDigestFromSources,
  captureWireGoldens,
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

test("capture rejects credential-shaped response data before writing", async () => {
  const root = await temporaryCaptureRepo()

  await assert.rejects(
    captureWireGoldens({
      env: { CONVEX_READ_TOKEN: token },
      fetchImpl: async () => new Response(JSON.stringify({
        status: "success",
        value: { authorization: "Bearer definitely-a-credential" },
      })),
      repoRoot: root,
    }),
    /credential-shaped data/,
  )

  assert.deepEqual(
    await readdir(path.join(root, "shared/domain/fixtures/convex-wire-golden")),
    [],
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

test("contract digest ignores unrelated schema edits but catches captured shape edits", async () => {
  const tablesSource = await readFile(path.join(repoRoot, "convex/tables.ts"), "utf8")
  const schemaSource = await readFile(path.join(repoRoot, "convex/schema.ts"), "utf8")
  const baseline = captureContractDigestFromSources({ tablesSource, schemaSource })

  const unrelated = captureContractDigestFromSources({
    tablesSource,
    schemaSource: `${schemaSource}\nexport const unrelatedTableForAnotherLane = 1;\n`,
  })
  assert.equal(unrelated.sha256, baseline.sha256)

  const relevantSchemaSource = schemaSource.replace(
    "amountCents: v.int64(),\n    category: v.string(),",
    "amountCents: v.float64(),\n    category: v.string(),",
  )
  assert.notEqual(relevantSchemaSource, schemaSource)
  const relevant = captureContractDigestFromSources({
    tablesSource,
    schemaSource: relevantSchemaSource,
  })
  assert.notEqual(relevant.sha256, baseline.sha256)

  const relevantTablesSource = tablesSource.replace(
    "? 0n\n      : row.amountCents;",
    "? 0n\n      : -row.amountCents;",
  )
  assert.notEqual(relevantTablesSource, tablesSource)
  const relevantProjection = captureContractDigestFromSources({
    tablesSource: relevantTablesSource,
    schemaSource,
  })
  assert.notEqual(relevantProjection.sha256, baseline.sha256)
})
